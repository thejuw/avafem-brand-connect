import { randomBytes } from 'node:crypto';
import { id, first, rows, fail, text, int, keyring, DAY } from './util.mjs';
import { cyclePhase } from './health.mjs';

/** Cross-brand subscriptions / auto-replenish. One subscription can hold items from several
 * brands; each run creates one canonical sandbox order (split into per-brand Bags by the core)
 * and a mocked Stripe charge. Failures retry each day; 3 failures -> past_due + notice. */
export function createSubscriptions(db, { clock, domain, crm, health, bank, secret, charge }) {
  const now = () => clock();
  const pii = keyring(secret, 'shopper-pii');
  const defaultCharge = async ({ amountCents, paymentRef }) => paymentRef.endsWith('_fail') ? { ok: false, error: 'card_declined' } : { ok: true, ref: `pi_sim_${randomBytes(8).toString('hex')}`, amountCents };
  const subs = {
    charge: charge || defaultCharge,
    async create(shopperId, input = {}) {
      await crm.summary(shopperId);
      const items = (Array.isArray(input.items) ? input.items : []).slice(0, 20).map(i => ({ brandId: text(i.brandId, 100), sku: text(i.sku, 120), qty: int(i.qty ?? 1, 'qty', 1, 20) }));
      if (!items.length) fail('A subscription needs at least one item.');
      for (const i of items) if (!await first(db, "SELECT id FROM products WHERE brand_id=$1 AND sku=$2 AND status='approved'", [i.brandId, i.sku])) fail(`Approved product ${i.sku} not found.`, 409, 'PRODUCT_UNAVAILABLE');
      const interval = int(input.intervalDays ?? 28, 'intervalDays', 7, 180);
      const shipTo = input.shipTo || fail('shipTo is required.');
      for (const k of ['name', 'line1', 'city', 'region', 'postal', 'country']) if (!text(shipTo[k])) fail(`shipTo.${k} is required.`);
      const paymentRef = text(input.paymentMethod, 100) || 'pm_card_visa';
      if (!/^pm_[A-Za-z0-9_]+$/.test(paymentRef)) fail('paymentMethod must be a Stripe test PaymentMethod id (pm_…).');
      const first_ = input.startAt ? new Date(input.startAt) : now();
      const sub = await first(db, `INSERT INTO subscriptions(id,shopper_id,status,interval_days,align_to_cycle,items,ship_to_enc,payment_ref,provider_ref,next_run_at,created_at,updated_at)
        VALUES($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [id('sub'), shopperId, interval, input.alignToCycle === true, JSON.stringify(items), pii.encrypt(shipTo), paymentRef, `sub_sim_${randomBytes(6).toString('hex')}`, first_, now()]);
      return subs.view(sub);
    },
    view(s) { const { shipToEnc, ...rest } = s; return { ...rest, shipToCity: shipToEnc ? pii.decrypt(shipToEnc).city : null }; },
    async list(shopperId) { return (await rows(db, `SELECT * FROM subscriptions${shopperId ? ' WHERE shopper_id=$1' : ''} ORDER BY created_at`, shopperId ? [shopperId] : [])).map(subs.view); },
    async setStatus(subId, status) {
      if (!['active', 'paused', 'cancelled'].includes(status)) fail('status must be active, paused or cancelled.');
      const s = await first(db, 'SELECT * FROM subscriptions WHERE id=$1', [subId]); if (!s) fail('Subscription not found.', 404, 'NOT_FOUND');
      if (s.status === 'cancelled') fail('Subscription is cancelled.', 409, 'SUBSCRIPTION_CANCELLED');
      return subs.view(await first(db, 'UPDATE subscriptions SET status=$2,failures=CASE WHEN $2=\'active\' THEN 0 ELSE failures END,updated_at=$3 WHERE id=$1 RETURNING *', [subId, status, now()]));
    },
    async nextRun(s, from) {
      let next = new Date(from.getTime() + s.intervalDays * DAY);
      if (s.alignToCycle) {
        const h = await health.read(s.shopperId, { actor: `subscription:${s.id}`, purpose: 'campaign' });
        const c = h ? cyclePhase(h.cycle, from) : null;
        if (c) { const aligned = new Date(Date.parse(c.nextPeriodStart) - 3 * DAY); if (aligned > from) next = aligned; }
      }
      return next;
    },
    async runDue() {
      const due = await rows(db, "SELECT * FROM subscriptions WHERE status IN ('active','past_due') AND next_run_at<=$1 ORDER BY next_run_at", [now()]);
      const results = [];
      for (const s of due) {
        if (s.status === 'past_due') continue;
        const cycle = s.cycleCount + 1;
        let order = null;
        try {
          order = await domain.createSandboxOrder({ externalId: `SUB-${s.id}-${cycle}`, currency: 'USD', shipTo: pii.decrypt(s.shipToEnc), items: s.items });
        } catch (error) {
          await subs.failure(s, cycle, error.code || 'ORDER_FAILED', null); results.push({ subscriptionId: s.id, cycle, status: 'failed', error: error.code || 'ORDER_FAILED' }); continue;
        }
        const paid = await subs.charge({ amountCents: order.totalCents, paymentRef: s.paymentRef, subscriptionId: s.id, cycle, idempotencyKey: `sub:${s.id}:${cycle}` });
        if (!paid.ok) {
          // Release the reserved Bags so a declined renewal never reaches a brand.
          for (const bag of order.bags) { try { const r = await domain.requestRefund(bag.id, { reason: 'Subscription charge declined' }); await domain.approveSandboxRefund(r.id); } catch { /* left for operator review */ } }
          await subs.failure(s, cycle, paid.error || 'charge_failed', order.id); results.push({ subscriptionId: s.id, cycle, status: 'failed', error: paid.error }); continue;
        }
        await crm.linkOrder(s.shopperId, order.id);
        if (bank) await bank.earnForOrder(s.shopperId, order.id);
        await db.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,charge_ref,amount_cents,created_at) VALUES($1,$2,$3,'paid',$4,$5,$6,$7) ON CONFLICT DO NOTHING", [id('subrun'), s.id, cycle, order.id, paid.ref, order.totalCents, now()]);
        await db.query("UPDATE subscriptions SET cycle_count=$2,failures=0,last_error=NULL,next_run_at=$3,updated_at=$4 WHERE id=$1", [s.id, cycle, await subs.nextRun(s, now()), now()]);
        results.push({ subscriptionId: s.id, cycle, status: 'paid', orderId: order.id, bags: order.bags.length, amountCents: order.totalCents });
      }
      return results;
    },
    async failure(s, cycle, error, orderId) {
      const failures = s.failures + 1;
      await db.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,error,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [id('subrun'), s.id, cycle, `failed_${failures}`, orderId, text(error, 200), now()]);
      const pastDue = failures >= 3;
      await db.query('UPDATE subscriptions SET failures=$2,last_error=$3,status=$4,next_run_at=$5,updated_at=$6 WHERE id=$1', [s.id, failures, text(error, 200), pastDue ? 'past_due' : s.status, new Date(now().getTime() + DAY), now()]);
      if (pastDue) await crm.sendTransactional(s.shopperId, { subject: 'Your Avafem subscription needs attention', body: 'We could not process your auto-replenish order. Update your payment method to resume.', dedupeKey: `sub-past-due:${s.id}:${cycle}` });
    },
    async runs(subId) { return rows(db, 'SELECT * FROM subscription_runs WHERE subscription_id=$1 ORDER BY created_at', [subId]); },
  };
  return subs;
}

/** Free-shipping threshold funded from commission. The core order math is unchanged (brands
 * still receive their shipping); the shopper discount is applied at charge time and the cost is
 * booked against Avafem's commission, capped at the Bag's commission (excess is absorbed). */
export function createShipping(db, { clock }) {
  const now = () => clock();
  const ship = {
    async rule() { return await first(db, "SELECT * FROM shipping_rules WHERE id='default'") || { id: 'default', freeThresholdCents: 5000, enabled: true, updatedAt: null }; },
    async setRule(input = {}) {
      const threshold = int(input.freeThresholdCents, 'freeThresholdCents', 0, 1_000_000);
      return first(db, `INSERT INTO shipping_rules(id,free_threshold_cents,enabled,updated_at) VALUES('default',$1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET free_threshold_cents=EXCLUDED.free_threshold_cents,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at RETURNING *`, [threshold, input.enabled !== false, now()]);
    },
    async quote(items = []) {
      if (!Array.isArray(items) || !items.length) fail('Provide cart items.');
      const rule = await ship.rule(); const groups = new Map();
      for (const line of items.slice(0, 100)) {
        const p = await first(db, "SELECT p.price_cents,p.title,b.commission_bps,b.shipping_table,b.id AS brand_id FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.brand_id=$1 AND p.sku=$2 AND p.status='approved'", [line.brandId, line.sku]);
        if (!p) fail(`Approved product ${line.sku} not found.`, 409, 'PRODUCT_UNAVAILABLE');
        const qty = int(line.qty ?? 1, 'qty', 1, 1000);
        const g = groups.get(p.brandId) || { brandId: p.brandId, subtotalCents: 0, commissionBps: p.commissionBps, shippingCents: (p.shippingTable?.find(r => r.method === 'standard') || p.shippingTable?.[0] || {}).priceCents ?? 0 };
        g.subtotalCents += p.priceCents * qty; groups.set(p.brandId, g);
      }
      const bags = [...groups.values()].map(g => ({ ...g, commissionCents: Math.round(g.subtotalCents * g.commissionBps / 10_000) }));
      const subtotal = bags.reduce((s, b) => s + b.subtotalCents, 0); const shipping = bags.reduce((s, b) => s + b.shippingCents, 0);
      const free = rule.enabled && subtotal >= rule.freeThresholdCents;
      for (const b of bags) { const funded = free ? Math.min(b.shippingCents, b.commissionCents) : 0; Object.assign(b, { shopperShippingCents: free ? 0 : b.shippingCents, fundedFromCommissionCents: funded, absorbedCents: free ? b.shippingCents - funded : 0, netCommissionCents: b.commissionCents - funded }); }
      return { freeShipping: free, thresholdCents: rule.freeThresholdCents, remainingForFreeShippingCents: free ? 0 : Math.max(0, rule.freeThresholdCents - subtotal), subtotalCents: subtotal,
        shippingCents: shipping, shopperShippingCents: free ? 0 : shipping, bags };
    },
    /** Book the subsidy for an existing order (idempotent per Bag). */
    async applyToOrder(orderId) {
      const bags = await rows(db, 'SELECT * FROM bags WHERE order_id=$1', [orderId]); if (!bags.length) fail('Order not found.', 404, 'NOT_FOUND');
      const rule = await ship.rule(); const subtotal = bags.reduce((s, b) => s + b.subtotalCents, 0);
      if (!rule.enabled || subtotal < rule.freeThresholdCents) return { orderId, freeShipping: false, subsidies: [] };
      for (const b of bags) {
        const funded = Math.min(b.shippingCents, b.commissionCents);
        await db.query('INSERT INTO shipping_subsidies(bag_id,order_id,brand_id,shipping_cents,funded_from_commission_cents,absorbed_cents,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [b.id, orderId, b.brandId, b.shippingCents, funded, b.shippingCents - funded, now()]);
      }
      return { orderId, freeShipping: true, subsidies: await rows(db, 'SELECT * FROM shipping_subsidies WHERE order_id=$1 ORDER BY bag_id', [orderId]) };
    },
    async subsidyReport() {
      return first(db, 'SELECT COUNT(*)::int AS bags, COALESCE(SUM(shipping_cents),0)::int AS shipping_cents, COALESCE(SUM(funded_from_commission_cents),0)::int AS funded_from_commission_cents, COALESCE(SUM(absorbed_cents),0)::int AS absorbed_cents FROM shipping_subsidies');
    },
  };
  return ship;
}

/** DSAR: export everything held about a shopper, or erase personal/health data while keeping
 * de-identified financial records required for tax and accounting. Every step is audited. */
export function createPrivacy(db, { clock, crm, health, bank, secret }) {
  const now = () => clock();
  const pii = keyring(secret, 'shopper-pii');
  return {
    async export(shopperId, actor) {
      await crm.summary(shopperId);
      const profile = await crm.profile(shopperId, { actor });
      const healthData = await health.read(shopperId, { actor, purpose: 'dsar_export', bypassConsent: true });
      const out = { generatedAt: now().toISOString(), profile: { ...profile, phone: (pii.decrypt((await first(db, 'SELECT profile_enc FROM shoppers WHERE id=$1', [shopperId])).profileEnc) || {}).phone || null },
        health: healthData, healthAccessLog: await health.accessLog(shopperId),
        reviews: await rows(db, 'SELECT id,bag_id,product_id,rating,body,photo_url,created_at FROM reviews WHERE shopper_id=$1', [shopperId]),
        tickets: await rows(db, 'SELECT id,subject,status,messages,created_at FROM support_tickets WHERE shopper_id=$1', [shopperId]),
        messages: await crm.outbox({ shopperId }), beautyBank: { lots: await bank.lots(shopperId), history: await bank.history(shopperId) },
        subscriptions: (await rows(db, 'SELECT id,status,interval_days,items,cycle_count,created_at FROM subscriptions WHERE shopper_id=$1', [shopperId])) };
      const req = await first(db, "INSERT INTO privacy_requests(id,shopper_id,kind,status,result,requested_by,created_at,completed_at) VALUES($1,$2,'export','completed',$3,$4,$5,$5) RETURNING id", [id('dsar'), shopperId, JSON.stringify({ sections: Object.keys(out) }), actor, now()]);
      return { requestId: req.id, ...out };
    },
    async erase(shopperId, actor, { confirm } = {}) {
      if (confirm !== 'DELETE') fail('Confirm erasure with confirm: "DELETE".', 422, 'CONFIRMATION_REQUIRED');
      await crm.summary(shopperId);
      const counts = {};
      await db.transaction(async tx => {
        counts.health = (await tx.query('DELETE FROM health_records WHERE shopper_id=$1', [shopperId])).rowCount;
        counts.swipes = (await tx.query('DELETE FROM swipe_likes WHERE shopper_id=$1', [shopperId])).rowCount;
        counts.reviews = (await tx.query("UPDATE reviews SET body='',photo_url=NULL,status='hidden' WHERE shopper_id=$1", [shopperId])).rowCount;
        await tx.query("DELETE FROM brand_sync_feed WHERE kind='review' AND resource_id IN (SELECT id FROM reviews WHERE shopper_id=$1)", [shopperId]);
        counts.tickets = (await tx.query(`UPDATE support_tickets SET messages=(SELECT COALESCE(jsonb_agg(jsonb_set(m,'{body}','"[erased]"')),'[]'::jsonb) FROM jsonb_array_elements(messages) m) WHERE shopper_id=$1`, [shopperId])).rowCount;
        counts.messages = (await tx.query("UPDATE message_outbox SET recipient_enc='erased',recipient_hint='erased',body='[erased]' WHERE shopper_id=$1", [shopperId])).rowCount;
        counts.subscriptions = (await tx.query("UPDATE subscriptions SET status='cancelled',ship_to_enc=NULL,updated_at=$2 WHERE shopper_id=$1 AND status<>'cancelled'", [shopperId, now()])).rowCount;
        const open = (await tx.query("SELECT id,state,remaining_cents FROM bank_lots WHERE shopper_id=$1 AND state IN ('LAB','VAULT') FOR UPDATE", [shopperId])).rows;
        for (const lot of open) {
          await tx.query("UPDATE bank_lots SET state='EXPIRED',remaining_cents=0,note='Forfeited on erasure request',updated_at=$2 WHERE id=$1", [lot.id, now()]);
          await tx.query("INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at) VALUES($1,$2,'expired',$3,'EXPIRED',$4,'dsar_delete',$5)", [lot.id, shopperId, lot.state, lot.remaining_cents, now()]);
        }
        counts.creditsForfeited = open.length;
        await tx.query(`UPDATE shoppers SET email_hash=NULL,email_enc=NULL,profile_enc=NULL,consent='{"email":false,"sms":false,"marketing":false,"health":false}',deleted_at=$2,updated_at=$2 WHERE id=$1`, [shopperId, now()]);
        await tx.query('INSERT INTO health_access_log(shopper_id,actor,purpose,action,created_at) VALUES($1,$2,$3,$4,$5)', [shopperId, actor, 'dsar_delete', 'erase', now()]);
      });
      const req = await first(db, "INSERT INTO privacy_requests(id,shopper_id,kind,status,result,requested_by,created_at,completed_at) VALUES($1,$2,'delete','completed',$3,$4,$5,$5) RETURNING id", [id('dsar'), shopperId, JSON.stringify({ ...counts, retained: ['orders and Bags (tax/accounting, address encrypted)', 'health access log (no health content)', 'Beauty Bank ledger amounts'] }), actor, now()]);
      return { requestId: req.id, shopperId, erased: true, counts };
    },
    async list(shopperId) { return rows(db, `SELECT * FROM privacy_requests${shopperId ? ' WHERE shopper_id=$1' : ''} ORDER BY created_at`, shopperId ? [shopperId] : []); },
  };
}
