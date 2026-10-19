import { id, first, rows, fail, text, int, DAY } from './util.mjs';

/** Beauty Bank closed-loop credits. Lots move LAB (pending) -> VAULT (spendable) once the
 * earning Bag is delivered and its return window has passed; REVERSED on refund; EXPIRED
 * after expiry. Redemptions consume VAULT lots soonest-to-expire first. Integer cents. */
export function createBeautyBank(db, { clock, earnBps = 300, expiryDays = 365 }) {
  const now = () => clock();
  const ev = (q, lot, kind, from, to, amount, ref = null) => q.query('INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [lot.id, lot.shopperId, kind, from, to, amount, ref, now()]);
  const bank = {
    async balance(shopperId) {
      const r = await first(db, `SELECT COALESCE(SUM(remaining_cents) FILTER (WHERE state='LAB'),0)::int AS lab, COALESCE(SUM(remaining_cents) FILTER (WHERE state='VAULT'),0)::int AS vault FROM bank_lots WHERE shopper_id=$1`, [shopperId]);
      return { labCents: r.lab, vaultCents: r.vault };
    },
    async lots(shopperId) { return rows(db, 'SELECT * FROM bank_lots WHERE shopper_id=$1 ORDER BY created_at,id', [shopperId]); },
    async history(shopperId) { return rows(db, 'SELECT * FROM bank_events WHERE shopper_id=$1 ORDER BY id', [shopperId]); },
    /** Credits earned on each linked Bag (earnBps of merchandise subtotal), pending in LAB. */
    async earnForOrder(shopperId, orderId) {
      const bags = await rows(db, 'SELECT b.* FROM bags b JOIN shopper_orders so ON so.bag_id=b.id WHERE so.shopper_id=$1 AND b.order_id=$2', [shopperId, orderId]);
      if (!bags.length) fail('No linked Bags for this shopper and order.', 404, 'NOT_FOUND');
      const created = [];
      for (const bag of bags) {
        const amount = Math.floor(bag.subtotalCents * earnBps / 10_000);
        if (amount <= 0 || ['refunded', 'cancelled'].includes(bag.status)) continue;
        const r = await first(db, `INSERT INTO bank_lots(id,shopper_id,bag_id,source,state,amount_cents,remaining_cents,source_key,created_at,updated_at)
          VALUES($1,$2,$3,'purchase','LAB',$4,$4,$5,$6,$6) ON CONFLICT(source_key) DO NOTHING RETURNING *`, [id('lot'), shopperId, bag.id, amount, `earn:${bag.id}`, now()]);
        if (r) { await ev(db, r, 'earned', null, 'LAB', amount, bag.id); created.push(r); }
      }
      return created;
    },
    async grantGoodwill(shopperId, { amountCents, reason, ticketId }) {
      const amount = int(amountCents, 'amountCents', 1, 50_000);
      const key = ticketId ? `goodwill:${ticketId}` : `goodwill:${id('g')}`;
      const lot = await first(db, `INSERT INTO bank_lots(id,shopper_id,source,state,amount_cents,remaining_cents,expires_at,source_key,note,created_at,updated_at)
        VALUES($1,$2,'goodwill','VAULT',$3,$3,$4,$5,$6,$7,$7) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
        [id('lot'), shopperId, amount, new Date(now().getTime() + expiryDays * DAY), key, text(reason, 300), now()]);
      if (!lot) return { ...(await first(db, 'SELECT * FROM bank_lots WHERE source_key=$1', [key])), replayed: true };
      await ev(db, lot, 'granted', null, 'VAULT', amount, ticketId || null);
      return { ...lot, status: lot.state };
    },
    async redeem(shopperId, { amountCents, idempotencyKey, orderRef }) {
      const amount = int(amountCents, 'amountCents', 1, 1_000_000);
      const key = text(idempotencyKey, 200) || fail('An idempotency key is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
      return db.transaction(async tx => {
        const prior = await first(tx, 'SELECT * FROM bank_redemptions WHERE idempotency_key=$1', [key]);
        if (prior) { if (prior.amountCents !== amount || prior.shopperId !== shopperId) fail('Key reused with a different redemption.', 422, 'IDEMPOTENCY_CONFLICT'); return { ...prior, replayed: true }; }
        const lots = await rows(tx, "SELECT * FROM bank_lots WHERE shopper_id=$1 AND state='VAULT' AND remaining_cents>0 AND (expires_at IS NULL OR expires_at>$2) ORDER BY expires_at NULLS LAST,created_at FOR UPDATE", [shopperId, now()]);
        if (lots.reduce((s, l) => s + l.remainingCents, 0) < amount) fail('Insufficient VAULT balance.', 409, 'INSUFFICIENT_CREDIT');
        let left = amount; const allocations = [];
        for (const lot of lots) {
          if (!left) break; const take = Math.min(left, lot.remainingCents); left -= take;
          await tx.query('UPDATE bank_lots SET remaining_cents=remaining_cents-$2,updated_at=$3 WHERE id=$1', [lot.id, take, now()]);
          await ev(tx, lot, 'redeemed', 'VAULT', 'VAULT', -take, key); allocations.push({ lotId: lot.id, amountCents: take });
        }
        return first(tx, 'INSERT INTO bank_redemptions(id,shopper_id,amount_cents,idempotency_key,allocations,order_ref,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [id('redeem'), shopperId, amount, key, JSON.stringify(allocations), text(orderRef, 100) || null, now()]);
      });
    },
    /** LAB -> VAULT when the Bag is delivered and its return window is over. */
    async mature() {
      return db.transaction(async tx => {
        const due = await rows(tx, `SELECT l.*, b.delivered_at, b.return_window_days, b.payout_due_at,
          br.return_window_days AS current_return_window_days,t.due_at AS transfer_due_at,j.due_at AS job_due_at
          FROM bank_lots l JOIN bags b ON b.id=l.bag_id JOIN brands br ON br.id=b.brand_id
          LEFT JOIN transfers t ON t.bag_id=b.id LEFT JOIN jobs j ON j.bag_id=b.id AND j.kind='sandbox_payout'
          WHERE l.state='LAB' AND b.status='delivered' AND b.delivered_at IS NOT NULL
          AND COALESCE(t.status,'')<>'held' AND COALESCE(j.status,'')<>'held'
          AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.bag_id=b.id AND r.status='proposed')
          AND NOT EXISTS(SELECT 1 FROM disputes d WHERE d.bag_id=b.id AND d.status IN ('needs_response','under_review','lost'))
          FOR UPDATE OF l`);
        let moved = 0;
        for (const lot of due) {
          const days = Math.max(7,lot.returnWindowDays ?? 30,lot.currentReturnWindowDays ?? 30);
          const matures = new Date(Math.max(Date.parse(lot.deliveredAt) + days * DAY,
            ...[lot.maturesAt,lot.payoutDueAt,lot.transferDueAt,lot.jobDueAt].filter(Boolean).map(Date.parse)));
          if (!Number.isFinite(matures.getTime()) || matures > now()) continue;
          const r = await tx.query("UPDATE bank_lots SET state='VAULT',matures_at=$2,expires_at=$3,updated_at=$4 WHERE id=$1 AND state='LAB' RETURNING id", [lot.id, matures, new Date(now().getTime() + expiryDays * DAY), now()]);
          if (r.rows.length) { await ev(tx, lot, 'matured', 'LAB', 'VAULT', lot.remainingCents); moved++; }
        }
        return moved;
      });
    },
    async expire() {
      return db.transaction(async tx => {
        const due = await rows(tx, "SELECT * FROM bank_lots WHERE state='VAULT' AND expires_at IS NOT NULL AND expires_at<=$1 FOR UPDATE", [now()]);
        let expired = 0;
        for (const lot of due) {
          const r = await tx.query("UPDATE bank_lots SET state='EXPIRED',remaining_cents=0,updated_at=$2 WHERE id=$1 AND state='VAULT' RETURNING id", [lot.id, now()]);
          if (r.rows.length) { await ev(tx, lot, 'expired', 'VAULT', 'EXPIRED', lot.remainingCents); expired++; }
        }
        return expired;
      });
    },
    /** Reverse unspent LAB/VAULT credit for refunded/cancelled Bags (idempotent). */
    async reverseRefunded(bagId) {
      return db.transaction(async tx => {
        const lots = await rows(tx, `SELECT l.* FROM bank_lots l JOIN bags b ON b.id=l.bag_id WHERE l.state IN ('LAB','VAULT') AND b.status IN ('refunded','cancelled')${bagId ? ' AND b.id=$1' : ''} FOR UPDATE OF l`, bagId ? [bagId] : []);
        let reversed = 0;
        for (const lot of lots) {
          const spent = lot.amountCents - lot.remainingCents;
          const r = await tx.query("UPDATE bank_lots SET state='REVERSED',remaining_cents=0,note=$2,updated_at=$3 WHERE id=$1 AND state IN ('LAB','VAULT') RETURNING id", [lot.id, spent ? `Refunded after ${spent} cents were redeemed; review clawback.` : 'Earning Bag refunded.', now()]);
          if (r.rows.length) { await ev(tx, lot, 'reversed', lot.state, 'REVERSED', lot.remainingCents, lot.bagId); reversed++; }
        }
        return reversed;
      });
    },
    async run() { return { reversed: await bank.reverseRefunded(), matured: await bank.mature(), expired: await bank.expire() }; },
    async liabilityReport() {
      const s = await first(db, `SELECT
        COALESCE(SUM(remaining_cents) FILTER (WHERE state='LAB'),0)::int AS lab,
        COALESCE(SUM(remaining_cents) FILTER (WHERE state='VAULT'),0)::int AS vault,
        COALESCE(SUM(amount_cents) FILTER (WHERE state='REVERSED'),0)::int AS reversed_issued,
        COALESCE(SUM(amount_cents),0)::int AS issued, COUNT(*)::int AS lots FROM bank_lots`);
      const ev2 = await first(db, `SELECT COALESCE(-SUM(amount_cents) FILTER (WHERE kind='redeemed'),0)::int AS redeemed,
        COALESCE(SUM(amount_cents) FILTER (WHERE kind='expired'),0)::int AS expired, COALESCE(SUM(amount_cents) FILTER (WHERE kind='reversed'),0)::int AS reversed FROM bank_events`);
      const expiringSoon = (await first(db, "SELECT COALESCE(SUM(remaining_cents),0)::int AS c FROM bank_lots WHERE state='VAULT' AND expires_at<=$1", [new Date(now().getTime() + 30 * DAY)])).c;
      return { asOf: now().toISOString(), issuedCents: s.issued, pendingLabCents: s.lab, spendableVaultCents: s.vault,
        // Accounting view: VAULT is a current liability; LAB is contingent until the return window closes.
        liabilityCents: s.vault, contingentLiabilityCents: s.lab, redeemedCents: ev2.redeemed, expiredBreakageCents: ev2.expired, reversedCents: ev2.reversed,
        expiringWithin30DaysCents: expiringSoon, lots: s.lots,
        balanced: s.issued === s.lab + s.vault + ev2.redeemed + ev2.expired + ev2.reversed, sandbox: true };
    },
  };
  return bank;
}

/** Rule-based risk scoring for checkouts and pre-payout brand checks. */
export function createRisk(db, { clock }) {
  const now = () => clock();
  const save = (type, subject, score, signals) => {
    const decision = score >= 70 ? 'block' : score >= 40 ? 'review' : 'allow';
    return first(db, 'INSERT INTO risk_assessments(id,subject_type,subject_id,score,decision,signals,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [id('risk'), type, subject || null, Math.min(100, score), decision, JSON.stringify(signals), now()]);
  };
  return {
    async scoreCheckout(input = {}) {
      const signals = []; let score = 0;
      const add = (code, points) => { signals.push({ code, points }); score += points; };
      const amount = Number.isSafeInteger(input.amountCents) ? input.amountCents : 0;
      if (amount >= 50_000) add('HIGH_AMOUNT', 25); else if (amount >= 25_000) add('ELEVATED_AMOUNT', 10);
      if (input.billingCountry && input.shipCountry && input.billingCountry !== input.shipCountry) add('BILLING_SHIPPING_COUNTRY_MISMATCH', 25);
      if (input.ipCountry && input.shipCountry && input.ipCountry !== input.shipCountry) add('IP_COUNTRY_MISMATCH', 15);
      if (Number.isInteger(input.accountAgeDays) && input.accountAgeDays < 1) add('NEW_ACCOUNT', 10);
      if (Number.isInteger(input.attemptsLastHour) && input.attemptsLastHour >= 3) add('CARD_VELOCITY', 30);
      if (Number.isInteger(input.maxQtyPerSku) && input.maxQtyPerSku >= 10) add('BULK_QUANTITY', 15);
      if (/^[^@]+@(mailinator|tempmail|10minutemail)\./i.test(String(input.email || ''))) add('DISPOSABLE_EMAIL', 20);
      if (input.shopperId) {
        const prior = await first(db, "SELECT COUNT(*)::int AS c FROM shopper_orders so JOIN bags b ON b.id=so.bag_id WHERE so.shopper_id=$1 AND b.status='delivered'", [input.shopperId]);
        if (prior.c > 0) add('RETURNING_CUSTOMER', -15);
      }
      return save('checkout', input.reference || input.shopperId, Math.max(0, score), signals);
    },
    async brandPayoutCheck(brandId) {
      const brand = await first(db, 'SELECT * FROM brands WHERE id=$1', [brandId]); if (!brand) fail('Brand not found.', 404, 'NOT_FOUND');
      const stats = await first(db, `SELECT COUNT(*)::int AS bags, COUNT(*) FILTER (WHERE status='refunded')::int AS refunded,
        COUNT(*) FILTER (WHERE status='awaiting_shipment' AND ship_by<$2)::int AS late FROM bags WHERE brand_id=$1`, [brandId, now()]);
      const disputes = await first(db, "SELECT COUNT(*) FILTER (WHERE status IN ('needs_response','under_review'))::int AS open, COUNT(*) FILTER (WHERE status='lost')::int AS lost FROM disputes WHERE brand_id=$1", [brandId]);
      const reasons = [];
      if (!brand.payoutsEnabled || !brand.stripeAccountId) reasons.push('PAYOUTS_NOT_ENABLED');
      if (['paused', 'disconnected'].includes(brand.status)) reasons.push('BRAND_UNAVAILABLE');
      if (stats.bags >= 5 && stats.refunded / stats.bags > 0.2) reasons.push('HIGH_REFUND_RATE');
      if (disputes.open > 0) reasons.push('OPEN_DISPUTE');
      if (disputes.lost >= 2) reasons.push('REPEATED_LOST_DISPUTES');
      if (stats.late >= 3) reasons.push('LATE_SHIPMENTS');
      const score = reasons.length * 30;
      const saved = await save('brand_payout', brandId, score, reasons.map(code => ({ code })));
      return { brandId, pass: reasons.length === 0, reasons, stats: { ...stats, openDisputes: disputes.open, lostDisputes: disputes.lost }, assessmentId: saved.id };
    },
    async list(type) { return rows(db, `SELECT * FROM risk_assessments${type ? ' WHERE subject_type=$1' : ''} ORDER BY created_at DESC LIMIT 200`, type ? [type] : []); },
  };
}

/** Operator console: disputes, holds, stuck transfers, reconciliation alerts. */
export function createConsole(db, { clock, domain, risk }) {
  const now = () => clock();
  const alert = (kind, severity, resourceId, message, key) => db.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING`,
    [id('alert'), kind, severity, resourceId, message, key, now()]);
  const con = {
    async openDispute(input = {}) {
      const ext = text(input.externalId, 100) || fail('externalId is required (the simulated Stripe dispute id).');
      const existing = await first(db, 'SELECT * FROM disputes WHERE external_id=$1', [ext]); if (existing) return { ...existing, replayed: true };
      const bag = await first(db, 'SELECT * FROM bags WHERE id=$1', [input.bagId]); if (!bag) fail('Bag not found.', 404, 'NOT_FOUND');
      const amount = int(input.amountCents ?? bag.totalCents, 'amountCents', 1, bag.totalCents);
      return db.transaction(async tx => {
        const d = await first(tx, `INSERT INTO disputes(id,external_id,bag_id,brand_id,amount_cents,reason,status,respond_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'needs_response',$7,$8,$8) RETURNING *`,
          [id('dp'), ext, bag.id, bag.brandId, amount, text(input.reason, 100) || 'general', new Date(now().getTime() + 7 * DAY), now()]);
        await tx.query("UPDATE transfers SET status='held' WHERE bag_id=$1 AND status='scheduled'", [bag.id]);
        await tx.query("UPDATE jobs SET status='held' WHERE bag_id=$1 AND status='scheduled' AND kind='sandbox_payout'", [bag.id]);
        await tx.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,'dispute','high',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id('alert'), d.id, `Dispute opened on Bag ${bag.id}; payout held.`, `dispute:${d.id}`, now()]);
        return d;
      });
    },
    async listDisputes(brandId) { return rows(db, `SELECT * FROM disputes${brandId ? ' WHERE brand_id=$1' : ''} ORDER BY created_at DESC`, brandId ? [brandId] : []); },
    async submitEvidence(disputeId, evidence = {}) {
      const d = await first(db, 'SELECT * FROM disputes WHERE id=$1', [disputeId]); if (!d) fail('Dispute not found.', 404, 'NOT_FOUND');
      if (!['needs_response', 'under_review'].includes(d.status)) fail('Dispute is closed.', 409, 'DISPUTE_CLOSED');
      const bag = await domain.getBag(d.bagId);
      const packet = { note: text(evidence.note, 4000), trackingNumbers: bag.shipments.map(s => s.trackingNumber), deliveredAt: bag.deliveredAt || null, submittedAt: now().toISOString(), simulated: true };
      return first(db, "UPDATE disputes SET evidence=$2,status='under_review',updated_at=$3 WHERE id=$1 RETURNING *", [disputeId, JSON.stringify(packet), now()]);
    },
    async resolveDispute(disputeId, outcome) {
      if (!['won', 'lost'].includes(outcome)) fail('outcome must be won or lost.');
      return db.transaction(async tx => {
        const d = await first(tx, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [disputeId]); if (!d) fail('Dispute not found.', 404, 'NOT_FOUND');
        if (['won', 'lost'].includes(d.status)) return d;
        const r = await first(tx, "UPDATE disputes SET status=$2,updated_at=$3 WHERE id=$1 RETURNING *", [disputeId, outcome, now()]);
        const blockers = await first(tx, "SELECT (SELECT COUNT(*) FROM refunds WHERE bag_id=$1 AND status='proposed')::int + (SELECT COUNT(*) FROM disputes WHERE bag_id=$1 AND status IN ('needs_response','under_review','lost'))::int AS c", [d.bagId]);
        if (outcome === 'won' && blockers.c === 0) {
          await tx.query("UPDATE transfers SET status='scheduled' WHERE bag_id=$1 AND status='held'", [d.bagId]);
          await tx.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1 AND status='held' AND kind='sandbox_payout'", [d.bagId]);
        }
        if (outcome === 'lost') await tx.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,'dispute_lost','high',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id('alert'), d.id, `Dispute lost (${d.amountCents} cents). Payout stays held; decide brand recovery via refund workflow.`, `dispute-lost:${d.id}`, now()]);
        return r;
      });
    },
    async holds() {
      return rows(db, `SELECT t.id AS transfer_id,t.bag_id,t.brand_id,t.amount_cents,t.due_at,
        (SELECT COUNT(*) FROM refunds r WHERE r.bag_id=t.bag_id AND r.status='proposed')::int AS open_refunds,
        (SELECT COUNT(*) FROM disputes d WHERE d.bag_id=t.bag_id AND d.status IN ('needs_response','under_review'))::int AS open_disputes,
        (SELECT COUNT(*) FROM disputes d WHERE d.bag_id=t.bag_id AND d.status='lost')::int AS lost_disputes
        FROM transfers t WHERE t.status='held' ORDER BY t.due_at NULLS LAST`);
    },
    async releaseHold(transferId) {
      return db.transaction(async tx => {
        const t = await first(tx, "SELECT * FROM transfers WHERE id=$1 FOR UPDATE", [transferId]); if (!t) fail('Transfer not found.', 404, 'NOT_FOUND');
        if (t.status !== 'held') fail('Transfer is not held.', 409, 'NOT_HELD');
        const b = await first(tx, "SELECT (SELECT COUNT(*) FROM refunds WHERE bag_id=$1 AND status='proposed')::int AS r, (SELECT COUNT(*) FROM disputes WHERE bag_id=$1 AND status IN ('needs_response','under_review','lost'))::int AS d", [t.bagId]);
        if (b.r || b.d) fail('Resolve refund proposals and dispute recovery before releasing this hold.', 409, 'HOLD_BLOCKED');
        await tx.query("UPDATE transfers SET status='scheduled' WHERE id=$1", [transferId]);
        await tx.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1 AND status='held' AND kind='sandbox_payout'", [t.bagId]);
        return { transferId, status: 'scheduled' };
      });
    },
    async stuckTransfers() {
      const cutoff = new Date(now().getTime() - DAY);
      return rows(db, `SELECT t.id AS transfer_id,t.bag_id,t.brand_id,t.amount_cents,t.status,t.due_at,j.status AS job_status,j.attempts,j.last_error
        FROM transfers t LEFT JOIN jobs j ON j.bag_id=t.bag_id AND j.kind='sandbox_payout'
        WHERE (t.status='scheduled' AND t.due_at IS NOT NULL AND t.due_at<$1) OR j.status='failed' ORDER BY t.due_at`, [cutoff]);
    },
    async retryStuck(transferId) {
      const t = await first(db, 'SELECT * FROM transfers WHERE id=$1', [transferId]); if (!t) fail('Transfer not found.', 404, 'NOT_FOUND');
      const r = await db.query("UPDATE jobs SET status='scheduled',due_at=$2 WHERE bag_id=$1 AND kind='sandbox_payout' AND status='failed' RETURNING id", [t.bagId, now()]);
      return { transferId, requeued: r.rows.length };
    },
    async scan() {
      const dash = await domain.dashboard();
      if (!dash.summary.ledgerBalanced) await alert('reconciliation', 'critical', null, 'Ledger journals are not balanced.', `ledger:${now().toISOString().slice(0, 10)}`);
      const mismatches = await rows(db, 'SELECT b.id,b.transfer_cents,t.amount_cents FROM bags b JOIN transfers t ON t.bag_id=b.id WHERE b.transfer_cents<>t.amount_cents');
      for (const m of mismatches) await alert('reconciliation', 'high', m.id, `Bag transfer ${m.transferCents} ≠ transfer ${m.amountCents}.`, `transfer-mismatch:${m.id}`);
      for (const s of await con.stuckTransfers()) await alert('stuck_transfer', 'medium', s.transferId, `Transfer ${s.transferId} is overdue or its payout job failed.`, `stuck:${s.transferId}:${s.jobStatus || s.status}`);
      for (const d of await rows(db, "SELECT * FROM disputes WHERE status='needs_response' AND respond_by<$1", [new Date(now().getTime() + 2 * DAY)]))
        await alert('dispute_deadline', 'high', d.id, `Dispute ${d.id} evidence due by ${new Date(d.respondBy).toISOString()}.`, `dispute-due:${d.id}`);
      return con.alerts();
    },
    async alerts({ all = false } = {}) { return rows(db, `SELECT * FROM platform_alerts${all ? '' : ' WHERE acknowledged_at IS NULL'} ORDER BY created_at DESC`); },
    async acknowledge(alertId) { const r = await first(db, 'UPDATE platform_alerts SET acknowledged_at=$2 WHERE id=$1 RETURNING *', [alertId, now()]); if (!r) fail('Alert not found.', 404, 'NOT_FOUND'); return r; },
    async summary() {
      return { disputes: await con.listDisputes(), holds: await con.holds(), stuckTransfers: await con.stuckTransfers(), alerts: await con.alerts(),
        ledgerBalanced: (await domain.dashboard()).summary.ledgerBalanced, sandbox: true };
    },
    async payoutChecks({ enforce = false } = {}) {
      const out = [];
      for (const b of await rows(db, 'SELECT id FROM brands ORDER BY id')) {
        const check = await risk.brandPayoutCheck(b.id);
        if (enforce && !check.pass) {
          const held = await db.query("UPDATE transfers SET status='held' WHERE brand_id=$1 AND status='scheduled' AND NOT EXISTS (SELECT 1 FROM bags WHERE bags.id=transfers.bag_id AND bags.provider_bound) RETURNING id", [b.id]);
          await db.query("UPDATE jobs SET status='held' WHERE kind='sandbox_payout' AND status='scheduled' AND bag_id IN (SELECT bag_id FROM transfers WHERE brand_id=$1 AND status='held')", [b.id]);
          check.heldTransfers = held.rows.map(r => r.id);
          if (held.rows.length) await alert('payout_check', 'high', b.id, `Pre-payout check failed (${check.reasons.join(', ')}); ${held.rows.length} transfer(s) held.`, `payout-check:${b.id}:${now().toISOString().slice(0, 10)}`);
        }
        out.push(check);
      }
      return out;
    },
  };
  return con;
}

/** Reports: state sales-tax summary and brand annual payout (1099-K style) export. */
export function createReports(db, { domain }) {
  const csv = (header, list) => [header.join(','), ...list.map(r => header.map(h => { const v = r[h] ?? ''; return /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v); }).join(','))].join('\n');
  // Refund components are persisted from the exact native refund allocation,
  // not inferred from Bag status or pro-rated from a cash total. Older partial
  // refunds without evidence must be reconciled, never silently reported as 0.
  const refundAllocation = async bag => {
    const refunds = await rows(db,"SELECT * FROM refunds WHERE bag_id=$1 AND status='approved'",[bag.id]);
    const totals = { amount: 0, subtotal: 0, shipping: 0, tax: 0, commission: 0 };
    let allocated = 0;
    for (const refund of refunds) {
      const parts = refund.amountCents===bag.totalCents && [refund.subtotalCents,refund.shippingCents,refund.taxCents,refund.commissionCents].every(v=>v==null)
        ? { subtotalCents:bag.subtotalCents,shippingCents:bag.shippingCents,taxCents:bag.taxCents,commissionCents:bag.commissionCents }
        : refund;
      totals.amount += refund.amountCents;
      if (![parts.subtotalCents,parts.shippingCents,parts.taxCents,parts.commissionCents].every(v=>Number.isSafeInteger(v) && v>=0)
        || parts.subtotalCents+parts.shippingCents+parts.taxCents!==refund.amountCents || parts.commissionCents>parts.subtotalCents) continue;
      allocated += refund.amountCents;
      for (const key of ['subtotal','shipping','tax','commission']) totals[key] += parts[`${key}Cents`];
    }
    const complete = totals.amount===bag.refundedCents && allocated===totals.amount
      && totals.subtotal<=bag.subtotalCents && totals.shipping<=bag.shippingCents && totals.tax<=bag.taxCents && totals.commission<=bag.commissionCents;
    return { ...totals,complete,unallocated:Math.max(0,bag.refundedCents-allocated) };
  };
  return {
    async salesTax({ from, to } = {}) {
      const params = []; const where = [];
      if (from) { params.push(new Date(from)); where.push(`created_at>=$${params.length}`); }
      if (to) { params.push(new Date(to)); where.push(`created_at<$${params.length}`); }
      const bags = await rows(db, `SELECT id FROM bags${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, params);
      const states = new Map();
      for (const { id: bagId } of bags) {
        const bag = await domain.getBag(bagId);
        const st = bag.shipTo?.region || 'UNKNOWN';
        const row = states.get(st) || { state: st, bags: 0, grossSalesCents: 0, shippingCents: 0, taxCollectedCents: 0, refundedCents: 0, taxRefundedCents: 0, refundedSalesCents: 0, refundedShippingCents: 0, refundAllocationComplete: true, unallocatedRefundCents: 0 };
        row.bags += 1; row.grossSalesCents += bag.subtotalCents; row.shippingCents += bag.shippingCents; row.taxCollectedCents += bag.taxCents;
        const allocation = await refundAllocation(bag);
        row.refundedCents += bag.refundedCents; row.taxRefundedCents += allocation.tax; row.refundedSalesCents += allocation.subtotal; row.refundedShippingCents += allocation.shipping;
        row.refundAllocationComplete &&= allocation.complete; row.unallocatedRefundCents += allocation.unallocated;
        states.set(st, row);
      }
      const list = [...states.values()].map(r => ({ ...r, netSalesCents: r.refundAllocationComplete ? r.grossSalesCents - r.refundedSalesCents : null,
        netTaxCents: r.refundAllocationComplete ? r.taxCollectedCents - r.taxRefundedCents : null, reconciliationRequired: !r.refundAllocationComplete }))
        .sort((a, b) => a.state.localeCompare(b.state));
      return { from: from || null, to: to || null, states: list, note: 'Sandbox marketplace-facilitator summary by ship-to state; confirm nexus and filing with a tax advisor.',
        csv: csv(['state', 'bags', 'grossSalesCents', 'shippingCents', 'taxCollectedCents', 'refundedCents', 'taxRefundedCents', 'refundedSalesCents', 'refundedShippingCents', 'netSalesCents', 'netTaxCents', 'refundAllocationComplete', 'unallocatedRefundCents', 'reconciliationRequired'], list) };
    },
    async brandAnnualPayouts(year, brandId) {
      const y = int(Number(year), 'year', 2000, 2100);
      const start = new Date(Date.UTC(y, 0, 1)); const end = new Date(Date.UTC(y + 1, 0, 1));
      const brands = await rows(db, `SELECT id,name,stripe_account_id FROM brands${brandId ? ' WHERE id=$1' : ''} ORDER BY id`, brandId ? [brandId] : []);
      const out = [];
      for (const b of brands) {
        const bags = await rows(db, 'SELECT * FROM bags WHERE brand_id=$1 AND created_at>=$2 AND created_at<$3', [b.id, start, end]);
        const allocations = await Promise.all(bags.map(refundAllocation));
        const refundAllocationComplete = allocations.every(a=>a.complete);
        const monthly = Array(12).fill(0);
        for (const bag of bags) monthly[new Date(bag.createdAt).getUTCMonth()] += bag.totalCents;
        const paid = await first(db, "SELECT COALESCE(SUM(amount_cents-reversed_cents),0)::int AS c FROM transfers WHERE brand_id=$1 AND status IN ('paid','reversed') AND paid_at>=$2 AND paid_at<$3", [b.id, start, end]);
        out.push({ brandId: b.id, brandName: b.name, connectedAccount: b.stripeAccountId || null, year: y,
          grossPaymentVolumeCents: bags.reduce((s, x) => s + x.totalCents, 0), transactionCount: bags.length,
          refundsCents: bags.reduce((s, x) => s + x.refundedCents, 0), commissionCents: refundAllocationComplete ? bags.reduce((s,x,i)=>s+x.commissionCents-allocations[i].commission,0) : null,
          refundAllocationComplete, reconciliationRequired: !refundAllocationComplete, unallocatedRefundCents: allocations.reduce((s,a)=>s+a.unallocated,0),
          netTransfersPaidCents: paid.c, monthlyGrossCents: monthly });
      }
      const header = ['brandId', 'brandName', 'connectedAccount', 'year', 'grossPaymentVolumeCents', 'transactionCount', 'refundsCents', 'commissionCents', 'netTransfersPaidCents', 'refundAllocationComplete', 'unallocatedRefundCents', 'reconciliationRequired', ...Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`)];
      return { year: y, brands: out, note: '1099-K style data only. Under Stripe Connect, Stripe may file 1099-Ks for connected accounts; confirm responsibilities before filing.',
        csv: csv(header, out.map(r => ({ ...r, ...Object.fromEntries(r.monthlyGrossCents.map((v, i) => [`m${String(i + 1).padStart(2, '0')}`, v])) }))) };
    },
  };
}
