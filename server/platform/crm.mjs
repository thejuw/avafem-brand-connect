import { id, sha, first, rows, fail, text, int, normEmail, maskEmail, maskPhone, keyring, DAY } from './util.mjs';
import { cyclePhase, PHASES } from './health.mjs';

const CONSENT_KEYS = ['email', 'sms', 'marketing', 'health'];
const CHANNEL_CONSENT = { email: 'email', sms: 'sms' };

/** CRM core: one shopper profile over orders, health intake, cycle, swipes, Beauty Bank
 * and consent. PII (email, name, phone) is AES-GCM encrypted; lookups use a SHA-256 hash.
 * Brands only ever see their own tickets/reviews and never shopper PII or health data. */
export function createCrm(db, deps) {
  const { secret, clock, health, domain } = deps;
  const pii = keyring(secret, 'shopper-pii');
  const now = () => clock();
  const ensureShopper = async shopperId => {
    const s = await first(db, 'SELECT * FROM shoppers WHERE id=$1', [shopperId]);
    if (!s || s.deletedAt) fail('Shopper not found.', 404, 'NOT_FOUND');
    return s;
  };
  const consentOf = input => Object.fromEntries(CONSENT_KEYS.map(k => [k, input?.[k] === true]));

  const crm = {
    pii,
    async upsertShopper(input = {}) {
      const email = normEmail(input.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('A valid shopper email is required.');
      const profile = { firstName: text(input.firstName, 100), lastName: text(input.lastName, 100), phone: text(input.phone, 30) };
      const existing = await first(db, 'SELECT * FROM shoppers WHERE email_hash=$1', [sha(email)]);
      if (existing && !existing.deletedAt) {
        const merged = { ...pii.decrypt(existing.profileEnc), ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v)) };
        const consent = input.consent ? { ...existing.consent, ...consentOf({ ...existing.consent, ...input.consent }) } : existing.consent;
        await db.query('UPDATE shoppers SET profile_enc=$2,consent=$3,updated_at=$4 WHERE id=$1', [existing.id, pii.encrypt(merged), JSON.stringify(consent), now()]);
        return crm.summary(existing.id);
      }
      const shopperId = id('shopper');
      await db.query('INSERT INTO shoppers(id,email_hash,email_enc,profile_enc,consent,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
        [shopperId, sha(email), pii.encrypt(email), pii.encrypt(profile), JSON.stringify(consentOf(input.consent)), now()]);
      return crm.summary(shopperId);
    },
    async summary(shopperId) {
      const s = await ensureShopper(shopperId); const p = pii.decrypt(s.profileEnc) || {};
      return { id: s.id, emailHint: maskEmail(pii.decrypt(s.emailEnc)), firstName: p.firstName || '', consent: s.consent, createdAt: s.createdAt };
    },
    async listShoppers() {
      const list = await rows(db, 'SELECT id FROM shoppers WHERE deleted_at IS NULL ORDER BY created_at,id');
      return Promise.all(list.map(s => crm.summary(s.id)));
    },
    async setConsent(shopperId, consent) {
      const s = await ensureShopper(shopperId);
      const next = { ...s.consent }; for (const k of CONSENT_KEYS) if (typeof consent?.[k] === 'boolean') next[k] = consent[k];
      await db.query('UPDATE shoppers SET consent=$2,updated_at=$3 WHERE id=$1', [shopperId, JSON.stringify(next), now()]);
      return next;
    },
    async linkOrder(shopperId, orderId) {
      await ensureShopper(shopperId);
      const bags = await rows(db, 'SELECT id,brand_id FROM bags WHERE order_id=$1', [orderId]);
      if (!bags.length) fail('Order not found.', 404, 'NOT_FOUND');
      for (const bag of bags) {
        const other = await first(db, 'SELECT shopper_id FROM shopper_orders WHERE bag_id=$1', [bag.id]);
        if (other && other.shopperId !== shopperId) fail('This order is linked to another shopper.', 409, 'ORDER_ALREADY_LINKED');
        await db.query('INSERT INTO shopper_orders(shopper_id,order_id,bag_id,brand_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [shopperId, orderId, bag.id, bag.brandId, now()]);
      }
      return { shopperId, orderId, bags: bags.map(b => b.id) };
    },
    async orders(shopperId) {
      return rows(db, `SELECT b.id AS bag_id,b.order_id,b.brand_id,b.status,b.total_cents,b.refunded_cents,b.items,b.delivered_at,b.created_at
        FROM shopper_orders so JOIN bags b ON b.id=so.bag_id WHERE so.shopper_id=$1 ORDER BY b.created_at,b.id`, [shopperId]);
    },
    async recordSwipe(shopperId, productId, liked) {
      await ensureShopper(shopperId);
      if (!await first(db, 'SELECT id FROM products WHERE id=$1', [productId])) fail('Product not found.', 404, 'NOT_FOUND');
      await db.query(`INSERT INTO swipe_likes(shopper_id,product_id,liked,created_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(shopper_id,product_id) DO UPDATE SET liked=EXCLUDED.liked,created_at=EXCLUDED.created_at`, [shopperId, productId, liked === true, now()]);
      return { shopperId, productId, liked: liked === true };
    },
    async profile(shopperId, { actor = 'admin' } = {}) {
      const s = await ensureShopper(shopperId); const p = pii.decrypt(s.profileEnc) || {};
      const orders = await crm.orders(shopperId);
      const h = await health.read(shopperId, { actor, purpose: 'profile' });
      const likes = await rows(db, 'SELECT product_id,liked,created_at FROM swipe_likes WHERE shopper_id=$1 ORDER BY created_at', [shopperId]);
      const spend = orders.reduce((sum, o) => sum + o.totalCents - o.refundedCents, 0);
      return {
        id: s.id, email: pii.decrypt(s.emailEnc), firstName: p.firstName || '', lastName: p.lastName || '', phoneHint: p.phone ? maskPhone(p.phone) : null,
        consent: s.consent, orders, lifetimeSpendCents: spend, orderCount: new Set(orders.map(o => o.orderId)).size,
        lastOrderAt: orders.at(-1)?.createdAt || null,
        intake: h ? h.intake : null, cycle: h ? cyclePhase(h.cycle, now()) : null,
        healthWithheld: !s.consent?.health,
        swipes: { liked: likes.filter(l => l.liked).map(l => l.productId), passed: likes.filter(l => !l.liked).map(l => l.productId) },
        beautyBank: deps.bank ? await deps.bank.balance(shopperId) : { labCents: 0, vaultCents: 0 },
      };
    },
    // ---------- segments ----------
    async createSegment(input = {}) {
      const r = input.rules || {};
      const rules = {};
      if (r.cyclePhase != null) { if (!PHASES.includes(r.cyclePhase)) fail(`cyclePhase must be one of ${PHASES.join(', ')}.`); rules.cyclePhase = r.cyclePhase; }
      if (r.concern != null) rules.concern = text(r.concern, 80).toLowerCase();
      if (r.minSpendCents != null) rules.minSpendCents = int(r.minSpendCents, 'minSpendCents');
      if (r.maxSpendCents != null) rules.maxSpendCents = int(r.maxSpendCents, 'maxSpendCents');
      if (r.lapsedDays != null) rules.lapsedDays = int(r.lapsedDays, 'lapsedDays', 1, 3650);
      if (!Object.keys(rules).length) fail('A segment needs at least one rule.');
      const name = text(input.name, 120) || 'Segment';
      const seg = await first(db, 'INSERT INTO segments(id,name,rules,created_at) VALUES($1,$2,$3,$4) RETURNING *', [id('seg'), name, JSON.stringify(rules), now()]);
      return seg;
    },
    async listSegments() { return rows(db, 'SELECT * FROM segments ORDER BY created_at,id'); },
    async evaluate(rules, { purpose = 'segmentation' } = {}) {
      const members = [];
      const needsHealth = rules.cyclePhase || rules.concern;
      for (const { id: shopperId } of await rows(db, 'SELECT id FROM shoppers WHERE deleted_at IS NULL ORDER BY created_at,id')) {
        const orders = await crm.orders(shopperId);
        const spend = orders.reduce((s, o) => s + o.totalCents - o.refundedCents, 0);
        if (rules.minSpendCents != null && spend < rules.minSpendCents) continue;
        if (rules.maxSpendCents != null && spend > rules.maxSpendCents) continue;
        if (rules.lapsedDays != null) {
          const last = orders.at(-1)?.createdAt; if (!last) continue;
          if (now().getTime() - Date.parse(last) < rules.lapsedDays * DAY) continue;
        }
        let cycle = null;
        if (needsHealth) {
          const h = await health.read(shopperId, { actor: 'segment-engine', purpose }); // null without health consent
          if (!h) continue;
          cycle = cyclePhase(h.cycle, now());
          if (rules.cyclePhase && cycle?.phase !== rules.cyclePhase) continue;
          if (rules.concern && !(h.intake?.concerns || []).includes(rules.concern)) continue;
        }
        members.push({ shopperId, spendCents: spend, cycle });
      }
      return members;
    },
    async segmentMembers(segmentId) {
      const seg = await first(db, 'SELECT * FROM segments WHERE id=$1', [segmentId]); if (!seg) fail('Segment not found.', 404, 'NOT_FOUND');
      return (await crm.evaluate(seg.rules)).map(m => ({ shopperId: m.shopperId, spendCents: m.spendCents, cyclePhase: m.cycle?.phase || null }));
    },
    // ---------- campaigns / simulated outbox ----------
    async createCampaign(input = {}) {
      const kind = ['broadcast', 'restock_reminder'].includes(input.kind) ? input.kind : fail('kind must be broadcast or restock_reminder.');
      const channel = ['email', 'sms'].includes(input.channel) ? input.channel : fail('channel must be email or sms.');
      if (kind === 'broadcast' && !input.segmentId) fail('A broadcast needs a segmentId.');
      if (input.segmentId && !await first(db, 'SELECT id FROM segments WHERE id=$1', [input.segmentId])) fail('Segment not found.', 404, 'NOT_FOUND');
      const template = text(input.template, 2000) || (kind === 'restock_reminder' ? 'Hi {{firstName}}, your next cycle starts around {{nextPeriodStart}}. Time to restock?' : 'Hi {{firstName}}!');
      const config = { leadDays: Number.isInteger(input.config?.leadDays) ? Math.min(Math.max(input.config.leadDays, 1), 10) : 3,
        minDaysSinceOrder: Number.isInteger(input.config?.minDaysSinceOrder) ? Math.max(input.config.minDaysSinceOrder, 0) : 14 };
      return first(db, 'INSERT INTO campaigns(id,name,kind,segment_id,channel,template,config,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id('camp'), text(input.name, 120) || kind, kind, input.segmentId || null, channel, template, JSON.stringify(config), now()]);
    },
    async listCampaigns() { return rows(db, 'SELECT * FROM campaigns ORDER BY created_at,id'); },
    async runCampaign(campaignId) {
      const c = await first(db, 'SELECT * FROM campaigns WHERE id=$1', [campaignId]); if (!c) fail('Campaign not found.', 404, 'NOT_FOUND');
      if (!c.active) return { campaignId, queued: 0, skipped: [], inactive: true };
      const seg = c.segmentId ? await first(db, 'SELECT rules FROM segments WHERE id=$1', [c.segmentId]) : null;
      let candidates;
      if (c.kind === 'restock_reminder') {
        const base = await crm.evaluate({ ...(seg?.rules || {}), ...(seg?.rules?.cyclePhase ? {} : {}) }, { purpose: 'campaign' });
        // Needs cycle data (health consent) and a delivered order long enough ago.
        candidates = [];
        for (const m of base) {
          let cycle = m.cycle;
          if (!cycle) { const h = await health.read(m.shopperId, { actor: `campaign:${c.id}`, purpose: 'campaign' }); cycle = h ? cyclePhase(h.cycle, now()) : null; }
          if (!cycle || cycle.daysUntilNextPeriod > c.config.leadDays) continue;
          const delivered = (await crm.orders(m.shopperId)).filter(o => o.deliveredAt && o.status === 'delivered');
          if (!delivered.length) continue;
          if (now().getTime() - Date.parse(delivered.at(-1).deliveredAt) < c.config.minDaysSinceOrder * DAY) continue;
          candidates.push({ ...m, cycle, dedupe: `${c.id}:${m.shopperId}:${cycle.nextPeriodStart}` });
        }
      } else candidates = (await crm.evaluate(seg.rules, { purpose: 'campaign' })).map(m => ({ ...m, dedupe: `${c.id}:${m.shopperId}` }));
      let queued = 0; const skipped = [];
      for (const m of candidates) {
        const s = await first(db, 'SELECT * FROM shoppers WHERE id=$1', [m.shopperId]);
        if (!s.consent?.marketing || !s.consent?.[CHANNEL_CONSENT[c.channel]]) { skipped.push({ shopperId: m.shopperId, reason: 'NO_CONSENT' }); continue; }
        const p = pii.decrypt(s.profileEnc) || {};
        const to = c.channel === 'email' ? pii.decrypt(s.emailEnc) : p.phone;
        if (!to) { skipped.push({ shopperId: m.shopperId, reason: 'NO_RECIPIENT' }); continue; }
        const body = c.template.replaceAll('{{firstName}}', p.firstName || 'there').replaceAll('{{nextPeriodStart}}', m.cycle?.nextPeriodStart || '')
          .replaceAll('{{cyclePhase}}', m.cycle?.phase || '');
        const r = await db.query(`INSERT INTO message_outbox(id,campaign_id,shopper_id,channel,recipient_enc,recipient_hint,subject,body,dedupe_key,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
          [id('msg'), c.id, m.shopperId, c.channel, pii.encrypt(to), c.channel === 'email' ? maskEmail(to) : maskPhone(to), c.name, body, m.dedupe, now()]);
        if (r.rows.length) queued += 1; else skipped.push({ shopperId: m.shopperId, reason: 'ALREADY_SENT' });
      }
      return { campaignId: c.id, queued, skipped };
    },
    async runActiveCampaigns() {
      const out = [];
      for (const c of await rows(db, "SELECT id FROM campaigns WHERE active AND kind='restock_reminder' ORDER BY created_at")) out.push(await crm.runCampaign(c.id));
      return out;
    },
    async outbox({ shopperId } = {}) {
      return rows(db, `SELECT id,campaign_id,shopper_id,channel,recipient_hint,subject,body,status,created_at FROM message_outbox
        ${shopperId ? 'WHERE shopper_id=$1' : ''} ORDER BY created_at,id`, shopperId ? [shopperId] : []);
    },
    async sendTransactional(shopperId, { channel = 'email', subject, body, dedupeKey }) {
      // Service messages (ticket replies) need channel contact consent but not marketing consent.
      const s = await ensureShopper(shopperId);
      if (!s.consent?.[CHANNEL_CONSENT[channel]] && channel !== 'email') return null;
      const to = channel === 'email' ? pii.decrypt(s.emailEnc) : (pii.decrypt(s.profileEnc) || {}).phone;
      if (!to) return null;
      const r = await db.query(`INSERT INTO message_outbox(id,campaign_id,shopper_id,channel,recipient_enc,recipient_hint,subject,body,dedupe_key,created_at)
        VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [id('msg'), shopperId, channel, pii.encrypt(to), channel === 'email' ? maskEmail(to) : maskPhone(to), text(subject, 200), text(body, 4000), dedupeKey || id('tx'), now()]);
      return r.rows[0]?.id || null;
    },
    // ---------- support inbox ----------
    async openTicket(input = {}) {
      const subject = text(input.subject, 200) || fail('A ticket subject is required.');
      let bag = null; let shipment = null;
      if (input.bagId) bag = await first(db, 'SELECT id,order_id,brand_id FROM bags WHERE id=$1', [input.bagId]) || fail('Bag not found.', 404, 'NOT_FOUND');
      if (input.shopperId) await ensureShopper(input.shopperId);
      if (bag && input.shopperId) {
        const link = await first(db, 'SELECT shopper_id FROM shopper_orders WHERE bag_id=$1', [bag.id]);
        if (link && link.shopperId !== input.shopperId) fail('This Bag belongs to another shopper.', 403, 'TENANT_MISMATCH');
      }
      if (bag) shipment = await first(db, 'SELECT id FROM shipments WHERE bag_id=$1 ORDER BY shipped_at DESC LIMIT 1', [bag.id]);
      const message = { from: 'shopper', body: text(input.message, 4000), at: now().toISOString() };
      return first(db, `INSERT INTO support_tickets(id,shopper_id,order_id,bag_id,brand_id,shipment_id,subject,messages,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [id('tkt'), input.shopperId || null, bag?.orderId || null, bag?.id || null, bag?.brandId || null,
        shipment?.id || null, subject, JSON.stringify(message.body ? [message] : []), now()]);
    },
    async listTickets({ brandId, status } = {}) {
      const where = []; const params = [];
      if (brandId) { params.push(brandId); where.push(`brand_id=$${params.length}`); }
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      const list = await rows(db, `SELECT * FROM support_tickets${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,id`, params);
      return brandId ? list.map(t => ({ ...t, shopperId: undefined })) : list;
    },
    async getTicket(ticketId, brandId) {
      const t = await first(db, 'SELECT * FROM support_tickets WHERE id=$1', [ticketId]);
      if (!t || (brandId && t.brandId !== brandId)) fail('Ticket not found.', 404, 'NOT_FOUND');
      const view = { ...t, bag: t.bagId ? await domain.getBag(t.bagId, brandId || undefined) : null,
        shipment: t.shipmentId ? await first(db, 'SELECT id,carrier,tracking_number,tracking_url,shipped_at FROM shipments WHERE id=$1', [t.shipmentId]) : null };
      if (brandId) delete view.shopperId;
      return view;
    },
    async replyTicket(ticketId, { from, body, status }, brandId) {
      const t = await crm.getTicket(ticketId, brandId);
      const msg = { from: brandId ? 'brand' : (from === 'shopper' ? 'shopper' : 'agent'), body: text(body, 4000) || fail('A reply body is required.'), at: now().toISOString() };
      const next = ['open', 'pending_brand', 'resolved'].includes(status) ? status : t.status;
      await db.query('UPDATE support_tickets SET messages=messages||$2::jsonb,status=$3,updated_at=$4 WHERE id=$1', [ticketId, JSON.stringify([msg]), next, now()]);
      const owner = (await first(db, 'SELECT shopper_id FROM support_tickets WHERE id=$1', [ticketId])).shopperId;
      if (msg.from !== 'shopper' && owner) await crm.sendTransactional(owner, { subject: `Re: ${t.subject}`, body: msg.body, dedupeKey: `ticket:${ticketId}:${t.messages.length}` });
      return crm.getTicket(ticketId, brandId);
    },
    async ticketAction(ticketId, input = {}, { refund, credit } = {}) {
      const t = await crm.getTicket(ticketId);
      let result;
      if (input.action === 'refund') {
        if (!t.bagId) fail('This ticket is not linked to a Bag.', 409, 'NO_BAG');
        result = await refund(t, text(input.reason, 1000) || `Support ticket ${t.id}`);
      } else if (input.action === 'credit') {
        if (!t.shopperId) fail('This ticket has no shopper.', 409, 'NO_SHOPPER');
        result = await credit(t, int(input.amountCents, 'amountCents', 1, 50_000), text(input.reason, 300) || 'Support goodwill credit');
      } else fail('action must be refund or credit.');
      const entry = { action: input.action, at: now().toISOString(), result: { id: result?.id || null, status: result?.status || null, amountCents: result?.amountCents ?? null } };
      await db.query("UPDATE support_tickets SET actions=actions||$2::jsonb,status='resolved',updated_at=$3 WHERE id=$1", [ticketId, JSON.stringify([entry]), now()]);
      return { ticket: await crm.getTicket(ticketId), result };
    },
    // ---------- reviews ----------
    async createReview(shopperId, input = {}) {
      await ensureShopper(shopperId);
      const link = await first(db, `SELECT b.id,b.brand_id,b.status,b.items FROM shopper_orders so JOIN bags b ON b.id=so.bag_id WHERE so.shopper_id=$1 AND b.id=$2`, [shopperId, input.bagId]);
      if (!link) fail('Bag not found for this shopper.', 404, 'NOT_FOUND');
      if (link.status !== 'delivered') fail('Reviews open after delivery.', 409, 'NOT_DELIVERED');
      const product = await first(db, 'SELECT id,sku FROM products WHERE id=$1 AND brand_id=$2', [input.productId, link.brandId]);
      if (!product || !(link.items || []).some(i => i.productId === product.id || i.sku === product.sku)) fail('That product is not in this Bag.', 422, 'PRODUCT_NOT_IN_BAG');
      const rating = int(input.rating, 'rating', 1, 5);
      let photo = null;
      if (input.photoUrl) { try { const u = new URL(input.photoUrl); if (u.protocol !== 'https:') throw 0; photo = u.toString().slice(0, 2000); } catch { fail('photoUrl must be an https URL.'); } }
      const review = await first(db, `INSERT INTO reviews(id,shopper_id,bag_id,brand_id,product_id,rating,body,photo_url,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(shopper_id,bag_id,product_id) DO UPDATE SET rating=EXCLUDED.rating,body=EXCLUDED.body,photo_url=EXCLUDED.photo_url RETURNING *`,
        [id('rev'), shopperId, link.id, link.brandId, product.id, rating, text(input.body, 5000), photo, now()]);
      await crm.syncReview(review);
      return first(db, 'SELECT * FROM reviews WHERE id=$1', [review.id]);
    },
    async syncReview(review) {
      // Brand-facing copy: no shopper id, only first name initial.
      const s = await first(db, 'SELECT profile_enc FROM shoppers WHERE id=$1', [review.shopperId]);
      const initial = ((pii.decrypt(s.profileEnc) || {}).firstName || 'A').slice(0, 1);
      const payload = { reviewId: review.id, productId: review.productId, bagId: review.bagId, rating: review.rating, body: review.body, photoUrl: review.photoUrl, author: `${initial}.`, verifiedPurchase: true };
      await db.query(`INSERT INTO brand_sync_feed(id,brand_id,kind,resource_id,payload,created_at) VALUES($1,$2,'review',$3,$4,$5)
        ON CONFLICT(kind,resource_id) DO UPDATE SET payload=EXCLUDED.payload,created_at=EXCLUDED.created_at`, [id('sync'), review.brandId, review.id, JSON.stringify(payload), now()]);
      await db.query('UPDATE reviews SET synced_at=$2 WHERE id=$1', [review.id, now()]);
    },
    async brandReviews(brandId) { return (await rows(db, "SELECT payload,created_at FROM brand_sync_feed WHERE brand_id=$1 AND kind='review' ORDER BY created_at", [brandId])).map(r => ({ ...r.payload, syncedAt: r.createdAt })); },
    async productReviews(productId) { return rows(db, "SELECT id,rating,body,photo_url,created_at FROM reviews WHERE product_id=$1 AND status='published' ORDER BY created_at", [productId]); },
  };
  return crm;
}
