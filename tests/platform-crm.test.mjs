import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture, isoDate, DAY } from './helpers/platform-fixture.mjs';
import { cyclePhase } from '../server/platform/health.mjs';

const consentAll = { email: true, sms: true, marketing: true, health: true };

test('cycle phase math covers each phase and wraps cycles', () => {
  const at = new Date('2026-10-19T12:00:00Z');
  const start = days => isoDate(new Date(at.getTime() - days * DAY));
  assert.equal(cyclePhase({ lastPeriodStart: start(0), cycleLength: 28 }, at).phase, 'menstrual');
  assert.equal(cyclePhase({ lastPeriodStart: start(8), cycleLength: 28 }, at).phase, 'follicular');
  assert.equal(cyclePhase({ lastPeriodStart: start(14), cycleLength: 28 }, at).phase, 'ovulatory');
  assert.equal(cyclePhase({ lastPeriodStart: start(20), cycleLength: 28 }, at).phase, 'luteal');
  const wrapped = cyclePhase({ lastPeriodStart: start(30), cycleLength: 28 }, at);
  assert.equal(wrapped.day, 3); assert.equal(wrapped.daysUntilNextPeriod, 26);
  assert.equal(cyclePhase({}, at), null);
});

test('unified shopper profile combines orders, intake, cycle, swipes and consent with encrypted PII', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const shopper = await f.ok(f.owner({ method: 'POST', url: '/api/crm/shoppers', payload: { email: 'Maya@Example.com', firstName: 'Maya', phone: '+15125550142', consent: consentAll } }));
  assert.equal(shopper.emailHint, 'm***@example.com');
  const again = await f.ok(f.owner({ method: 'POST', url: '/api/crm/shoppers', payload: { email: 'maya@example.com' } }));
  assert.equal(again.id, shopper.id, 'email is the dedupe key');
  const orderId = await f.seedOrder();
  await f.ok(f.owner({ method: 'POST', url: `/api/crm/shoppers/${shopper.id}/orders`, payload: { orderId } }));
  await f.ok(f.owner({ method: 'PUT', url: `/api/crm/shoppers/${shopper.id}/intake`, payload: { intake: { concerns: ['Cramps', 'dryness'] }, cycle: { lastPeriodStart: isoDate(new Date(Date.now() - 20 * DAY)), cycleLength: 28 } } }));
  const product = (await f.domain.listProducts({ brandId: 'brand_hearth' }))[0];
  await f.ok(f.owner({ method: 'POST', url: `/api/crm/shoppers/${shopper.id}/swipes`, payload: { productId: product.id, liked: true } }));
  const profile = await f.ok(f.owner({ method: 'GET', url: `/api/crm/shoppers/${shopper.id}` }));
  assert.equal(profile.email, 'maya@example.com');
  assert.equal(profile.orders.length, 3); assert.equal(profile.orderCount, 1);
  assert.ok(profile.lifetimeSpendCents > 0);
  assert.deepEqual(profile.intake.concerns, ['cramps', 'dryness']);
  assert.equal(profile.cycle.phase, 'luteal');
  assert.deepEqual(profile.swipes.liked, [product.id]);
  assert.deepEqual(profile.beautyBank, { labCents: 0, vaultCents: 0, ...profile.beautyBank });
  const raw = JSON.stringify((await f.db.query('SELECT * FROM shoppers')).rows) + JSON.stringify((await f.db.query('SELECT * FROM health_records')).rows);
  for (const secret of ['maya@example.com', 'Maya', '5550142', 'cramps', 'lastPeriodStart']) assert.ok(!raw.includes(secret), `${secret} must be encrypted at rest`);
  const log = await f.platform.health.accessLog(shopper.id);
  assert.ok(log.some(entry => entry.purpose === 'profile' && entry.action === 'read'));
  // Withdrawing health consent withholds intake and cycle from the profile.
  await f.ok(f.owner({ method: 'PATCH', url: `/api/crm/shoppers/${shopper.id}/consent`, payload: { health: false } }));
  const withheld = await f.ok(f.owner({ method: 'GET', url: `/api/crm/shoppers/${shopper.id}` }));
  assert.equal(withheld.intake, null); assert.equal(withheld.cycle, null); assert.equal(withheld.healthWithheld, true);
  // A second shopper cannot claim the same order.
  const other = await f.ok(f.owner({ method: 'POST', url: '/api/crm/shoppers', payload: { email: 'other@example.com' } }));
  const conflict = await f.owner({ method: 'POST', url: `/api/crm/shoppers/${other.id}/orders`, payload: { orderId } });
  assert.equal(conflict.statusCode, 409);
});

test('shopper data is admin-only; brand sessions and bearer keys are refused', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const cred = await f.credential('brand_bloom', ['orders:read', 'catalog:read']);
  const r = await f.bearer(cred, { method: 'GET', url: '/api/crm/shoppers' });
  assert.equal(r.statusCode, 403);
  await f.ok(f.owner({ method: 'POST', url: '/api/session/brand', payload: { brandId: 'brand_bloom' } }));
  assert.equal((await f.owner({ method: 'GET', url: '/api/crm/shoppers' })).statusCode, 403);
});

test('segments by cycle phase, concern, spend and lapsed respect health consent', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const a = await crm.upsertShopper({ email: 'a@example.com', firstName: 'A', consent: consentAll });
  const b = await crm.upsertShopper({ email: 'b@example.com', firstName: 'B', consent: { ...consentAll, health: false } });
  await health.write(a.id, { intake: { concerns: ['acne'] }, cycle: { lastPeriodStart: isoDate(new Date(Date.now() - 2 * DAY)) } });
  await health.write(b.id, { intake: { concerns: ['acne'] }, cycle: { lastPeriodStart: isoDate(new Date(Date.now() - 2 * DAY)) } });
  await crm.linkOrder(a.id, await f.seedOrder());
  const menstrual = await f.ok(f.owner({ method: 'POST', url: '/api/crm/segments', payload: { name: 'Menstrual', rules: { cyclePhase: 'menstrual' } } }));
  assert.deepEqual((await f.ok(f.owner({ method: 'GET', url: `/api/crm/segments/${menstrual.id}/members` }))).map(m => m.shopperId), [a.id]);
  const acne = await crm.createSegment({ rules: { concern: 'acne' } });
  assert.deepEqual((await crm.segmentMembers(acne.id)).map(m => m.shopperId), [a.id], 'no-health-consent shopper excluded');
  const spenders = await crm.createSegment({ rules: { minSpendCents: 1 } });
  assert.deepEqual((await crm.segmentMembers(spenders.id)).map(m => m.shopperId), [a.id]);
  const lapsed = await crm.createSegment({ rules: { lapsedDays: 60 } });
  assert.equal((await crm.segmentMembers(lapsed.id)).length, 0);
  f.advance(61);
  assert.deepEqual((await crm.segmentMembers(lapsed.id)).map(m => m.shopperId), [a.id]);
  assert.equal((await f.owner({ method: 'POST', url: '/api/crm/segments', payload: { rules: { cyclePhase: 'moon' } } })).statusCode, 422);
});

test('cycle-timed restock reminder writes once to the simulated outbox and skips non-consenting shoppers', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const orderId = await f.seedOrder();
  const yes = await crm.upsertShopper({ email: 'yes@example.com', firstName: 'Yasmin', consent: consentAll });
  await crm.linkOrder(yes.id, orderId);
  // In 20 days she will be on cycle day 27 of 28: two days from her next period.
  await health.write(yes.id, { cycle: { lastPeriodStart: isoDate(new Date(Date.now() + 20 * DAY - 26 * DAY)), cycleLength: 28 } });
  const no = await crm.upsertShopper({ email: 'no@example.com', firstName: 'Nora', consent: { ...consentAll, marketing: false } });
  const order2 = await f.domain.createSandboxOrder({ externalId: 'CRM-2', shipTo: { name: 'N', line1: '1 St', city: 'Austin', region: 'TX', postal: '78701', country: 'US' }, items: [{ brandId: 'brand_hearth', sku: (await f.domain.listProducts({ brandId: 'brand_hearth', status: 'approved' }))[0].sku, qty: 1 }] });
  await f.domain.recordShipment(order2.bags[0].id, { carrier: 'UPS', trackingNumber: 'CRM-2' });
  await f.domain.markDelivered(order2.bags[0].id);
  await crm.linkOrder(no.id, order2.id);
  await health.write(no.id, { cycle: { lastPeriodStart: isoDate(new Date(Date.now() + 20 * DAY - 26 * DAY)) } });
  const campaign = await f.ok(f.owner({ method: 'POST', url: '/api/crm/campaigns', payload: { name: 'Restock', kind: 'restock_reminder', channel: 'email' } }));
  const early = await f.ok(f.owner({ method: 'POST', url: `/api/crm/campaigns/${campaign.id}/run` }));
  assert.equal(early.queued, 0, 'too early in the cycle and too soon after delivery');
  f.advance(20);
  const run = await f.ok(f.owner({ method: 'POST', url: `/api/crm/campaigns/${campaign.id}/run` }));
  assert.equal(run.queued, 1);
  assert.deepEqual(run.skipped, [{ shopperId: no.id, reason: 'NO_CONSENT' }]);
  const rerun = await f.platform.jobs();
  assert.equal(rerun.campaigns[0].queued, 0);
  const outbox = await f.ok(f.owner({ method: 'GET', url: '/api/crm/outbox' }));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].recipientHint, 'y***@example.com');
  assert.match(outbox[0].body, /Yasmin/); assert.equal(outbox[0].status, 'simulated');
  assert.ok(!JSON.stringify((await f.db.query('SELECT recipient_enc FROM message_outbox')).rows).includes('yes@example.com'));
});

test('support tickets link order, brand and shipment, stay tenant-scoped, and refund through the core', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm } = f.platform;
  const orderId = await f.seedOrder();
  const s = await crm.upsertShopper({ email: 'help@example.com', firstName: 'Hana', consent: { email: true } });
  await crm.linkOrder(s.id, orderId);
  const bag = await f.bagFor(orderId, 'brand_lunelle');
  const ticket = await f.ok(f.owner({ method: 'POST', url: '/api/crm/tickets', payload: { shopperId: s.id, bagId: bag.id, subject: 'Where is my order?', message: 'Tracking stalled.' } }));
  assert.equal(ticket.brandId, 'brand_lunelle'); assert.equal(ticket.orderId, orderId); assert.ok(ticket.shipmentId);
  const full = await f.ok(f.owner({ method: 'GET', url: `/api/crm/tickets/${ticket.id}` }));
  assert.equal(full.shipment.trackingNumber, 'SANDBOX-LUNELLE-1042');
  const lunelle = await f.credential('brand_lunelle', ['orders:read']);
  const bloom = await f.credential('brand_bloom', ['orders:read']);
  const listed = await f.ok(f.bearer(lunelle, { method: 'GET', url: '/v1/tickets' }));
  assert.equal(listed.length, 1); assert.equal(listed[0].shopperId, undefined);
  assert.equal((await f.ok(f.bearer(bloom, { method: 'GET', url: '/v1/tickets' }))).length, 0);
  const reply = await f.bearer(lunelle, { method: 'POST', url: `/v1/tickets/${ticket.id}/replies`, headers: { 'idempotency-key': 'r1' }, payload: { body: 'Reshipping today.' } });
  assert.equal(reply.statusCode, 200, reply.body);
  const denied = await f.bearer(bloom, { method: 'POST', url: `/v1/tickets/${ticket.id}/replies`, headers: { 'idempotency-key': 'r2' }, payload: { body: 'hi' } });
  assert.equal(denied.statusCode, 404);
  assert.equal((await crm.outbox({ shopperId: s.id })).length, 1, 'shopper notified via simulated outbox');
  const action = await f.ok(f.owner({ method: 'POST', url: `/api/crm/tickets/${ticket.id}/actions`, payload: { action: 'refund', reason: 'Lost in transit' } }));
  assert.equal(action.ticket.status, 'resolved');
  assert.equal((await f.domain.getBag(bag.id)).status, 'refunded');
  assert.equal((await f.owner({ method: 'POST', url: `/api/crm/tickets/${ticket.id}/actions`, payload: { action: 'teleport' } })).statusCode, 422);
});

test('post-delivery reviews with photo sync to the brand without shopper PII; MCP exposes them', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm } = f.platform;
  const orderId = await f.seedOrder();
  const s = await crm.upsertShopper({ email: 'rev@example.com', firstName: 'Rae' });
  await crm.linkOrder(s.id, orderId);
  const hearth = await f.bagFor(orderId, 'brand_hearth');
  const product = (await f.db.query('SELECT id FROM products WHERE brand_id=$1 AND sku=$2', ['brand_hearth', hearth.items[0].sku])).rows[0];
  const review = await f.ok(f.owner({ method: 'POST', url: `/api/crm/shoppers/${s.id}/reviews`, payload: { bagId: hearth.id, productId: product.id, rating: 5, body: 'Love it', photoUrl: 'https://img.example.com/p.jpg' } }));
  assert.ok(review.syncedAt);
  const lunelleBag = await f.bagFor(orderId, 'brand_lunelle');
  const lp = (await f.db.query('SELECT id FROM products WHERE brand_id=$1 AND sku=$2', ['brand_lunelle', lunelleBag.items[0].sku])).rows[0];
  assert.equal((await f.owner({ method: 'POST', url: `/api/crm/shoppers/${s.id}/reviews`, payload: { bagId: lunelleBag.id, productId: lp.id, rating: 4 } })).statusCode, 409);
  assert.equal((await f.owner({ method: 'POST', url: `/api/crm/shoppers/${s.id}/reviews`, payload: { bagId: hearth.id, productId: product.id, rating: 4, photoUrl: 'http://x.example.com/a.jpg' } })).statusCode, 422);
  const cred = await f.credential('brand_hearth', ['orders:read']);
  const synced = await f.ok(f.bearer(cred, { method: 'GET', url: '/v1/reviews' }));
  assert.equal(synced.length, 1); assert.equal(synced[0].author, 'R.'); assert.equal(synced[0].photoUrl, 'https://img.example.com/p.jpg');
  assert.ok(!JSON.stringify(synced).includes(s.id) && !JSON.stringify(synced).includes('rev@example.com'));
  const names = (await f.mcp(cred, 'tools/list')).tools.map(x => x.name);
  for (const n of ['list_reviews', 'list_support_tickets', 'reply_support_ticket', 'get_bag']) assert.ok(names.includes(n), n);
  assert.equal((await f.tool(cred, 'list_reviews')).length, 1);
  const other = await f.credential('brand_bloom', ['orders:read']);
  assert.equal((await f.tool(other, 'list_reviews')).length, 0);
});
