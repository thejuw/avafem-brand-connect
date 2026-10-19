import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture, isoDate, DAY } from './helpers/platform-fixture.mjs';
import { checkProduct } from '../server/platform/compliance.mjs';

const shipTo = { name: 'Sub Scriber', line1: '9 Renew Rd', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
const approvedSku = async (f, brandId) => (await f.domain.listProducts({ brandId, status: 'approved' })).find(p => p.inventoryQty > 5);

test('compliance rules flag disease/drug claims, DSHEA disclaimers and restricted ingredients', () => {
  assert.equal(checkProduct({ title: 'Gentle wash', description: 'Supports a gentle cleansing routine.', category: 'body-care', evidence: { claims: [], ingredients_inci: ['Aqua'] } }).status, 'pass');
  const disease = checkProduct({ title: 'Boric balm', description: 'Cures yeast infection fast.', category: 'intimate', evidence: {} });
  assert.equal(disease.status, 'blocked'); assert.equal(disease.flags[0].code, 'DISEASE_CLAIM');
  assert.equal(checkProduct({ title: 'Natural antibiotic wash', description: '', category: '', evidence: {} }).flags[0].code, 'DRUG_CLAIM');
  const supp = checkProduct({ title: 'Cycle support capsules', description: 'Supports a comfortable cycle.', category: 'supplements', evidence: { claims: [{ text: 'Supports mood', type: 'structure' }], ingredients_inci: ['Magnesium'] } });
  assert.ok(supp.supplement); assert.ok(supp.flags.some(f => f.code === 'MISSING_DSHEA_DISCLAIMER'));
  const ok = checkProduct({ title: 'Cycle support capsules', description: 'Supports a comfortable cycle. These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.', category: 'supplements', evidence: { claims: [], ingredients_inci: ['Magnesium'], contraindications: 'Not for use if pregnant.' } });
  assert.equal(ok.status, 'pass', JSON.stringify(ok.flags));
  assert.equal(checkProduct({ title: 'Slim', description: '', category: 'supplements', evidence: { ingredients_inci: ['DMAA'] } }).flags.some(f => f.code === 'BANNED_INGREDIENT'), true);
  assert.equal(checkProduct({ title: 'Hormone tea', description: 'Balances hormones naturally.', category: 'wellness/tea', evidence: {} }).status, 'flagged');
});

test('listing approval is gated by compliance; override is content-bound; brand MCP can pre-check', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const listing = { title: 'Soothing intimate balm', description: 'Treats bacterial vaginosis and soothes.', category: 'intimate-care/balm', priceCents: 2200, inventoryQty: 10,
    images: ['https://img.example.com/b.jpg'], taxCode: 'txcd_99999999', evidence: { ingredients_inci: ['Aqua', 'Lactic acid'], certifications: [], claims: [], contraindications: 'External use only.' } };
  const put = await f.owner({ method: 'PUT', url: '/api/brands/brand_bloom/products/BLOOM-BALM', payload: listing });
  assert.equal(put.statusCode, 200, put.body);
  const product = (await f.domain.listProducts({ brandId: 'brand_bloom' })).find(p => p.sku === 'BLOOM-BALM');
  const report = await f.ok(f.owner({ method: 'GET', url: `/api/products/${product.id}/compliance` }));
  assert.equal(report.status, 'blocked'); assert.equal(report.canGoLive, false);
  const blocked = await f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } });
  assert.equal(blocked.statusCode, 409); assert.match(blocked.body, /COMPLIANCE_BLOCKED/);
  assert.equal((await f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'rejected', reason: 'claims' } })).statusCode, 200, 'rejection is never gated');
  assert.equal((await f.owner({ method: 'POST', url: `/api/products/${product.id}/compliance/override`, payload: { reason: 'short' } })).statusCode, 422);
  const overridden = await f.ok(f.owner({ method: 'POST', url: `/api/products/${product.id}/compliance/override`, payload: { reason: 'Counsel reviewed: cites cleared 510(k) device labelling.' } }));
  assert.equal(overridden.canGoLive, true);
  // Any later content edit invalidates the override.
  await f.ok(f.owner({ method: 'PUT', url: '/api/brands/brand_bloom/products/BLOOM-BALM', payload: { ...listing, description: 'Treats bacterial vaginosis overnight.' } }));
  assert.equal((await f.platform.compliance.check(product.id)).canGoLive, false);
  await f.ok(f.owner({ method: 'PUT', url: '/api/brands/brand_bloom/products/BLOOM-BALM', payload: { ...listing, description: 'A soothing, fragrance-free external balm.' } }));
  const approved = await f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } });
  assert.equal(approved.statusCode, 200, approved.body);
  const queue = await f.ok(f.owner({ method: 'GET', url: '/api/portal/review-queue' }));
  assert.ok(queue.every(p => p.compliance && typeof p.compliance.status === 'string'));
  const key = await f.credential('brand_bloom', ['catalog:read']);
  const pre = await f.tool(key, 'check_product_compliance', { title: 'PCOS cure tea', description: 'Cures PCOS.' });
  assert.equal(pre.status, 'blocked');
  assert.equal(typeof (await f.ok(f.bearer(key, { method: 'GET', url: '/v1/compliance' }))).checked, 'number');
  const other = await f.ok(f.owner({ method: 'POST', url: '/api/session/brand', payload: { brandId: 'brand_hearth' } }));
  assert.equal(other.brandId, 'brand_hearth');
  assert.equal((await f.owner({ method: 'GET', url: `/api/products/${product.id}/compliance` })).statusCode, 404, 'other brands cannot read compliance of this product');
});

test('cross-brand subscription renews into per-brand Bags, earns credit, retries declines and goes past_due', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const s = await f.platform.crm.upsertShopper({ email: 'sub@example.com', firstName: 'Sol', consent: { email: true } });
  const a = await approvedSku(f, 'brand_bloom'); const b = await approvedSku(f, 'brand_lunelle');
  const sub = await f.ok(f.owner({ method: 'POST', url: `/api/crm/shoppers/${s.id}/subscriptions`, payload: { intervalDays: 30, shipTo, paymentMethod: 'pm_card_visa', items: [{ brandId: a.brandId, sku: a.sku, qty: 1 }, { brandId: b.brandId, sku: b.sku, qty: 1 }] } }));
  assert.equal(sub.status, 'active'); assert.equal(sub.shipToEnc, undefined); assert.match(sub.providerRef, /^sub_sim_/);
  const run = await f.ok(f.owner({ method: 'POST', url: '/api/subscriptions/run' }));
  assert.equal(run.length, 1); assert.equal(run[0].status, 'paid'); assert.equal(run[0].bags, 2);
  assert.deepEqual(await f.ok(f.owner({ method: 'POST', url: '/api/subscriptions/run' })), [], 'not due again until the interval passes');
  const profile = await f.platform.crm.profile(s.id);
  assert.equal(profile.orderCount, 1); assert.ok(profile.beautyBank.labCents > 0);
  f.advance(30);
  const second = await f.platform.subscriptions.runDue();
  assert.equal(second[0].cycle, 2);
  // Declines: three failures -> past_due + service notice; renewal Bags are released.
  const failing = await f.platform.subscriptions.create(s.id, { intervalDays: 14, shipTo, paymentMethod: 'pm_card_chargeDeclined_fail', items: [{ brandId: a.brandId, sku: a.sku, qty: 1 }] });
  for (let i = 0; i < 3; i++) { await f.platform.subscriptions.runDue(); f.advance(1.01); }
  const [after] = (await f.platform.subscriptions.list(s.id)).filter(x => x.id === failing.id);
  assert.equal(after.status, 'past_due'); assert.equal(after.failures, 3);
  const runs = await f.ok(f.owner({ method: 'GET', url: `/api/subscriptions/${failing.id}/runs` }));
  assert.equal(runs.filter(r => r.status.startsWith('failed')).length, 3);
  const failedOrders = runs.map(r => r.orderId).filter(Boolean);
  for (const orderId of failedOrders) for (const bag of (await f.db.query('SELECT status FROM bags WHERE order_id=$1', [orderId])).rows) assert.equal(bag.status, 'refunded');
  assert.ok((await f.platform.crm.outbox({ shopperId: s.id })).some(m => /subscription needs attention/.test(m.subject)));
  assert.equal((await f.ok(f.owner({ method: 'POST', url: `/api/subscriptions/${failing.id}/status`, payload: { status: 'cancelled' } }))).status, 'cancelled');
  assert.equal((await f.owner({ method: 'POST', url: `/api/subscriptions/${failing.id}/status`, payload: { status: 'active' } })).statusCode, 409);
  assert.equal((await f.owner({ method: 'POST', url: `/api/crm/shoppers/${s.id}/subscriptions`, payload: { shipTo, paymentMethod: 'tok_visa', items: [{ brandId: a.brandId, sku: a.sku }] } })).statusCode, 422);
});

test('cycle-aligned subscription schedules the next box three days before the next period', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const s = await f.platform.crm.upsertShopper({ email: 'align@example.com', consent: { health: true } });
  await f.platform.health.write(s.id, { cycle: { lastPeriodStart: isoDate(new Date(Date.now() - 5 * DAY)), cycleLength: 28 } });
  const a = await approvedSku(f, 'brand_hearth');
  const sub = await f.platform.subscriptions.create(s.id, { intervalDays: 28, alignToCycle: true, shipTo, items: [{ brandId: a.brandId, sku: a.sku }] });
  await f.platform.subscriptions.runDue();
  const [row] = await f.platform.subscriptions.list(s.id);
  const nextPeriod = Date.parse(isoDate(new Date(Date.now() - 5 * DAY))) + 28 * DAY;
  assert.equal(new Date(row.nextRunAt).getTime(), nextPeriod - 3 * DAY);
  assert.ok((await f.platform.health.accessLog(s.id)).some(e => e.actor === `subscription:${sub.id}`));
});

test('free-shipping threshold is funded from commission (capped), quoted and booked idempotently', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const a = await approvedSku(f, 'brand_bloom'); const b = await approvedSku(f, 'brand_hearth');
  await f.domain.updateBrand('brand_bloom', { shippingTable: [{ method: 'standard', priceCents: 400, days: 5 }] });
  await f.domain.updateBrand('brand_hearth', { shippingTable: [{ method: 'standard', priceCents: 50_000, days: 5 }] });
  await f.ok(f.owner({ method: 'PUT', url: '/api/shipping/rules', payload: { freeThresholdCents: 100 } }));
  const items = [{ brandId: a.brandId, sku: a.sku, qty: 1 }, { brandId: b.brandId, sku: b.sku, qty: 1 }];
  const q = await f.ok(f.owner({ method: 'POST', url: '/api/shipping/quote', payload: { items } }));
  assert.equal(q.freeShipping, true); assert.equal(q.shopperShippingCents, 0);
  const bloom = q.bags.find(x => x.brandId === 'brand_bloom'); const hearth = q.bags.find(x => x.brandId === 'brand_hearth');
  assert.equal(bloom.fundedFromCommissionCents, Math.min(400, bloom.commissionCents));
  assert.equal(hearth.fundedFromCommissionCents, hearth.commissionCents, 'subsidy capped at commission');
  assert.equal(hearth.absorbedCents, 50_000 - hearth.commissionCents);
  assert.equal(hearth.netCommissionCents, 0);
  await f.ok(f.owner({ method: 'PUT', url: '/api/shipping/rules', payload: { freeThresholdCents: 1_000_000 } }));
  const notYet = await f.platform.shipping.quote(items);
  assert.equal(notYet.freeShipping, false); assert.equal(notYet.remainingForFreeShippingCents, 1_000_000 - notYet.subtotalCents);
  await f.platform.shipping.setRule({ freeThresholdCents: 0 });
  const orderId = await f.seedOrder();
  const applied = await f.ok(f.owner({ method: 'POST', url: `/api/shipping/orders/${orderId}/apply` }));
  assert.equal(applied.subsidies.length, 3);
  await f.platform.shipping.applyToOrder(orderId);
  assert.equal((await f.ok(f.owner({ method: 'GET', url: '/api/shipping/subsidies' }))).bags, 3, 'idempotent per Bag');
});

test('DSAR export and erasure: health vault, access log, de-identified retention, brand feed cleanup', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const s = await crm.upsertShopper({ email: 'forget@example.com', firstName: 'Fay', phone: '+15125550199', consent: { email: true, marketing: true, health: true } });
  const orderId = await f.seedOrder(); await crm.linkOrder(s.id, orderId);
  await health.write(s.id, { intake: { concerns: ['cramps'] }, cycle: { lastPeriodStart: isoDate(new Date()) } });
  const hearth = await f.bagFor(orderId, 'brand_hearth');
  const product = (await f.db.query('SELECT id FROM products WHERE brand_id=$1 AND sku=$2', ['brand_hearth', hearth.items[0].sku])).rows[0];
  await crm.createReview(s.id, { bagId: hearth.id, productId: product.id, rating: 4, body: 'Nice', photoUrl: 'https://img.example.com/r.jpg' });
  await crm.openTicket({ shopperId: s.id, bagId: hearth.id, subject: 'Q', message: 'My phone is 5125550199' });
  await f.platform.bank.grantGoodwill(s.id, { amountCents: 300 });
  const exp = await f.ok(f.owner({ method: 'POST', url: `/api/privacy/shoppers/${s.id}/export` }));
  assert.equal(exp.profile.email, 'forget@example.com'); assert.equal(exp.profile.phone, '+15125550199');
  assert.deepEqual(exp.health.intake.concerns, ['cramps']); assert.equal(exp.reviews.length, 1); assert.equal(exp.tickets.length, 1);
  assert.ok(exp.healthAccessLog.some(e => e.purpose === 'dsar_export'));
  assert.equal((await f.owner({ method: 'POST', url: `/api/privacy/shoppers/${s.id}/delete`, payload: {} })).statusCode, 422);
  const erased = await f.ok(f.owner({ method: 'POST', url: `/api/privacy/shoppers/${s.id}/delete`, payload: { confirm: 'DELETE' } }));
  assert.equal(erased.counts.health, 1); assert.equal(erased.counts.creditsForfeited, 1);
  assert.equal((await f.owner({ method: 'GET', url: `/api/crm/shoppers/${s.id}` })).statusCode, 404);
  const dump = JSON.stringify((await f.db.query('SELECT * FROM shoppers')).rows) + JSON.stringify((await f.db.query('SELECT * FROM support_tickets')).rows)
    + JSON.stringify((await f.db.query('SELECT * FROM reviews')).rows) + JSON.stringify((await f.db.query('SELECT * FROM brand_sync_feed')).rows);
  for (const v of ['5125550199', 'img.example.com/r.jpg', 'Nice']) assert.ok(!dump.includes(v), `${v} erased`);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS c FROM health_records WHERE shopper_id=$1', [s.id])).rows[0].c, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS c FROM bags WHERE order_id=$1', [orderId])).rows[0].c, 3, 'financial records retained');
  const log = await f.ok(f.owner({ method: 'GET', url: `/api/privacy/shoppers/${s.id}/health-access-log` }));
  assert.ok(log.some(e => e.purpose === 'dsar_delete')); assert.ok(!JSON.stringify(log).includes('cramps'));
  assert.equal((await f.ok(f.owner({ method: 'GET', url: '/api/privacy/requests' }))).length, 2);
  const again = await crm.upsertShopper({ email: 'forget@example.com' });
  assert.notEqual(again.id, s.id, 're-signup creates a fresh profile');
  assert.equal((await f.platform.bank.liabilityReport()).balanced, true);
});
