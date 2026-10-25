import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';

const shipTo = { name: 'Synthetic Reporting', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
const requiresCommerce = error => error.code === 'COMMERCE_WORKFLOW_REQUIRED' && error.statusCode === 409;
async function fixture(t) {
  const f = await platformFixture(t);
  const { policies, inventory, checkout } = f.commerce;
  const brand = await f.domain.createBrand({ name: 'Owned Reporting Fixture', slug: 'owned-reporting-fixture' });
  await policies.saveBrand(brand.id, { expectedVersion: 0, reason: 'Explicit owned reporting fixture.', model: 'first_party',
    inventoryAuthority: 'native', inventoryOwner: 'avafem', fulfiller: 'avafem', settlementModel: 'retail', commissionBps: 0 });
  const product = await f.domain.upsertProduct(brand.id, 'OWNED-REPORT-01', { title: 'Owned reporting fixture',
    description: 'Synthetic product for local reporting tests.', category: 'body-care', priceCents: 1000, inventoryQty: 0,
    images: ['https://example.com/fixture.jpg'], evidence: { ingredients_inci: ['Cotton'], claims: [], certifications: [], contraindications: 'Follow directions.' },
    taxCode: 'txcd_99999999', shippingProfile: 'standard' });
  await f.domain.reviewProduct(product.id, { status: 'approved' });
  const variant = await inventory.createVariant({ productId: product.id, sku: product.sku, unitPriceCents: 1000, unitCostCents: 400 }, 'owner');
  await inventory.adjust({ operationId: 'reporting_stock_001', variantId: variant.id, delta: 10, reason: 'Isolated reporting stock.' }, 'owner');
  await f.domain.updateBrand(brand.id, { status: 'ready', supportEmail: 'test@example.com',
    shipFromAddress: { name: 'Synthetic Warehouse', line1: '100 Test Warehouse', city: 'Austin', region: 'TX', postal: '78701', country: 'US' } });
  const partner = (await f.domain.listProducts({ brandId: 'brand_bloom' })).find(p => p.sku === 'BLOOM-COTTON-16');
  await f.domain.upsertProduct(partner.brandId, partner.sku, { priceCents: 2000, inventoryQty: 100 });
  await policies.saveBrand(partner.brandId, { expectedVersion: 0, reason: 'Explicit reporting partner shipping.', shippingCents: 200 });
  await policies.save({ expectedVersion: 0, reason: 'Local reporting promotion.', discountBps: 1000, ownedShippingCents: 100 });
  const quote = (operationId, items = [{ variantId: variant.id, qty: 2 }, { productId: partner.id, qty: 1 }]) => checkout.quote({ operationId, items, shipTo });
  const paid = async (operationId, items) => {
    const q = await quote(operationId, items); const payment = await checkout.simulatePayment(q.id);
    return { q, payment, owned: q.groups.find(g => g.terms.model === 'first_party'), partner: q.groups.find(g => g.terms.model === 'partner') };
  };
  return { ...f, policies, inventory, checkout, brand, variant, partnerProduct: partner, quote, paid };
}
const state = report => report.states.find(row => row.state === 'TX');

test('discounted partial refunds report exact net merchandise/tax and keep retail out of partner annual payouts', { timeout: 60_000 }, async t => {
  const f = await fixture(t), year = f.clock().getUTCFullYear();
  const before = state(await f.platform.reports.salesTax());
  const annualBefore = await f.platform.reports.brandAnnualPayouts(year);
  const p = await f.paid('reporting_mixed_001');
  const afterPayment = state(await f.platform.reports.salesTax());
  assert.equal(afterPayment.discountCents - before.discountCents, 400);
  assert.equal(afterPayment.netSalesCents - before.netSalesCents, 3600);
  const line = p.owned.items[0], unit = line.units[0];
  const refund = await f.checkout.refund(p.owned.id, { operationId: 'reporting_refund_001', reason: 'Local partial refund.',
    items: [{ reference: line.reference, qty: 1 }], refundShipping: false });
  assert.equal(refund.amountCents, 975);
  const persisted = (await f.db.query('SELECT * FROM refunds WHERE id=$1', [refund.refundId])).rows[0];
  assert.equal(persisted.discount_cents, unit.discountCents);
  const after = state(await f.platform.reports.salesTax());
  assert.equal(after.refundAllocationComplete, true);
  assert.equal(after.refundedSalesCents - before.refundedSalesCents, 1000);
  assert.equal(after.refundedDiscountCents - before.refundedDiscountCents, 100);
  assert.equal(after.taxRefundedCents - before.taxRefundedCents, 75);
  assert.equal(after.netSalesCents - before.netSalesCents, 2700);
  assert.equal(after.netTaxCents, after.taxCollectedCents - after.taxRefundedCents);
  const report = await f.platform.reports.salesTax();
  assert.match(report.csv, /discountCents/); assert.match(report.csv, /refundedDiscountCents/);
  const annual = await f.platform.reports.brandAnnualPayouts(year);
  const oldPartner = annualBefore.brands.find(b => b.brandId === p.partner.brandId);
  const partner = annual.brands.find(b => b.brandId === p.partner.brandId);
  const owned = annual.brands.find(b => b.brandId === p.owned.brandId);
  assert.equal(partner.grossPaymentVolumeCents - oldPartner.grossPaymentVolumeCents, p.partner.totalCents);
  assert.equal(partner.commissionCents - oldPartner.commissionCents, p.partner.commissionCents);
  assert.equal(owned.transactionCount, 0); assert.equal(owned.grossPaymentVolumeCents, 0); assert.equal(owned.commissionCents, 0);
  assert.equal(owned.firstPartyExcluded, 1); assert.equal(annual.firstPartyExcluded, 1); assert.equal(annual.scope, 'partner_commission_only');
});

test('zero-cash free-gift refund reverses commission in reports without inventing a positive cash refund', { timeout: 60_000 }, async t => {
  const f = await fixture(t), year = f.clock().getUTCFullYear();
  const before = (await f.platform.reports.brandAnnualPayouts(year, f.partnerProduct.brandId)).brands[0];
  const baseline = state(await f.platform.reports.salesTax());
  await f.policies.save({ expectedVersion: 1, reason: 'Avafem funds a full merchandise discount.', discountBps: 10_000 });
  const p = await f.paid('reporting_freegift_001', [{ productId: f.partnerProduct.id, qty: 1 }]);
  assert.equal(p.partner.discountCents, 2000); assert.equal(p.partner.commissionCents, 300);
  const result = await f.checkout.refund(p.partner.id, { operationId: 'freegift_refund_001', reason: 'Cancel the free merchandise.', items: [{ reference: p.partner.items[0].reference, qty: 1 }] });
  assert.equal(result.amountCents, 0); assert.equal(result.recoveryCents, 1700);
  assert.equal((await f.db.query('SELECT * FROM refunds WHERE bag_id=$1', [p.partner.id])).rows.length, 0);
  let annual = (await f.platform.reports.brandAnnualPayouts(year, p.partner.brandId)).brands[0];
  assert.equal(annual.commissionCents, before.commissionCents);
  assert.equal(annual.refundAllocationComplete, true);
  let tax = state(await f.platform.reports.salesTax());
  assert.equal(tax.refundedSalesCents - baseline.refundedSalesCents, 2000);
  assert.equal(tax.refundedDiscountCents - baseline.refundedDiscountCents, 2000);
  assert.equal(tax.netSalesCents, baseline.netSalesCents);
  assert.equal(tax.refundAllocationComplete, true);
  const shipping = await f.checkout.refund(p.partner.id, { operationId: 'freegift_shipping_001', reason: 'Refund only the remaining shipping.', items: [], refundShipping: true });
  assert.equal(shipping.amountCents, 217);
  annual = (await f.platform.reports.brandAnnualPayouts(year, p.partner.brandId)).brands[0];
  tax = state(await f.platform.reports.salesTax());
  assert.equal(annual.refundAllocationComplete, true); assert.equal(annual.commissionCents, before.commissionCents);
  assert.equal(tax.refundAllocationComplete, true); assert.equal(tax.netTaxCents, baseline.netTaxCents);
});

test('commerce report refuses missing or inconsistent unit evidence instead of reporting zero as reconciled', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const p = await f.paid('reporting_evidence_001', [{ variantId: f.variant.id, qty: 1 }]);
  await f.db.query("UPDATE commerce_bag_allocations SET allocation=jsonb_set(allocation,'{items,0,units,0,refunded}','true'::jsonb) WHERE bag_id=$1", [p.owned.id]);
  let row = state(await f.platform.reports.salesTax());
  assert.equal(row.refundAllocationComplete, false); assert.equal(row.reconciliationRequired, true); assert.equal(row.netSalesCents, null);
  await f.db.query('DELETE FROM commerce_bag_allocations WHERE bag_id=$1', [p.owned.id]);
  row = state(await f.platform.reports.salesTax());
  assert.equal(row.refundAllocationComplete, false); assert.equal(row.netTaxCents, null);
});

test('legacy manual recovery and BeautyBank earning cannot mutate commerce Bags; dispute resolution retains commerce hold authority', { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.paid('reporting_guard_001');
  const shopper = await f.platform.crm.upsertShopper({ email: 'commerce-reporting@example.invalid', consent: { email: true } });
  await f.platform.crm.linkOrder(shopper.id, p.payment.orderId);
  await assert.rejects(f.platform.bank.earnForOrder(shopper.id, p.payment.orderId), requiresCommerce);
  assert.equal((await f.platform.bank.lots(shopper.id)).length, 0);
  const transfer = (await f.db.query('SELECT * FROM transfers WHERE bag_id=$1', [p.partner.id])).rows[0];
  await assert.rejects(f.platform.console.releaseHold(transfer.id), requiresCommerce);
  await assert.rejects(f.platform.console.retryStuck(transfer.id), requiresCommerce);
  const credit = (await f.db.query('SELECT * FROM credits WHERE bag_id=$1', [p.owned.id])).rows[0];
  for (const action of ['release', 'writeoff']) await assert.rejects(f.platform.console.resolvePendingCredit(credit.id,
    { action, reason: 'This action must stay inside commerce.', idempotencyKey: `commerce_credit_${action}` }, 'owner'), requiresCommerce);
  const won = await f.platform.console.openDispute({ externalId: 'commerce_dispute_won', bagId: p.partner.id });
  await f.platform.console.resolveDispute(won.id, 'won');
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1', [transfer.id])).rows[0].status, 'held');
  const lost = await f.platform.console.openDispute({ externalId: 'commerce_dispute_lost', bagId: p.partner.id });
  await f.platform.console.resolveDispute(lost.id, 'lost');
  for (const resolution of ['operator_verified_recovery', 'writeoff']) await assert.rejects(f.platform.console.resolveLostDispute(lost.id,
    { resolution, reason: 'This action must stay inside commerce.', idempotencyKey: `commerce_lost_${resolution}`, recoveryReference: 'fixture:operator-proof' }, 'owner'), requiresCommerce);
  assert.equal((await f.db.query('SELECT * FROM financial_resolutions WHERE bag_id=ANY($1::text[])', [[p.owned.id, p.partner.id]])).rows.length, 0);
  assert.equal((await f.db.query('SELECT status FROM credits WHERE id=$1', [credit.id])).rows[0].status, 'pending');
  const pending = (await f.platform.console.pendingCredits()).find(entry => entry.id === credit.id);
  assert.ok(pending.holdReasons.includes('COMMERCE_WORKFLOW_REQUIRED'));
});

test('legacy BeautyBank maturity skips ghost lots while first-party canonical credits release without Connect', { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.paid('reporting_credits_001', [{ variantId: f.variant.id, qty: 1 }]);
  const work = (await f.checkout.fulfillment()).find(row => row.bagId === p.owned.id);
  await f.checkout.ship(work.id, { operationId: 'credit_ship_001', carrier: 'SYNTHETIC', trackingNumber: 'NOT-A-CARRIER-EVENT', items: [{ reference: p.owned.items[0].reference, qty: 1 }] });
  await f.checkout.deliver(work.id, { operationId: 'credit_deliver_001' });
  const shopper = await f.platform.crm.upsertShopper({ email: 'commerce-ghost@example.invalid', consent: {} });
  await f.db.query(`INSERT INTO bank_lots(id,shopper_id,bag_id,source,state,amount_cents,remaining_cents,source_key,created_at,updated_at)
    VALUES('commerce_ghost_lot',$1,$2,'purchase','LAB',50,50,'fixture:commerce-ghost',$3,$3)`, [shopper.id, p.owned.id, f.clock()]);
  // Deliberately satisfy old eligibility fields to prove the managed boundary.
  await f.db.query("UPDATE brands SET status='live',connection_healthy=true,charges_enabled=true,payouts_enabled=true,stripe_account_id='acct_sandbox_fixture' WHERE id=$1", [p.owned.brandId]);
  f.advance(31);
  await f.platform.bank.mature();
  assert.equal((await f.db.query("SELECT state FROM bank_lots WHERE id='commerce_ghost_lot'")).rows[0].state, 'LAB');
  await f.db.query('UPDATE brands SET charges_enabled=false,payouts_enabled=false,stripe_account_id=NULL WHERE id=$1', [p.owned.brandId]);
  await f.checkout.run();
  assert.equal((await f.db.query('SELECT status FROM credits WHERE bag_id=$1', [p.owned.id])).rows[0].status, 'released');
  assert.equal((await f.db.query('SELECT * FROM transfers WHERE bag_id=$1', [p.owned.id])).rows.length, 0);
  assert.equal((await f.db.query("SELECT state FROM bank_lots WHERE id='commerce_ghost_lot'")).rows[0].state, 'LAB');
});

test('legacy mismatch scan excludes valid reduced commerce payables but still flags an altered legacy transfer', { timeout: 60_000 }, async t => {
  const f = await fixture(t), p = await f.paid('reporting_scan_001', [{ productId: f.partnerProduct.id, qty: 2 }]);
  await f.checkout.refund(p.partner.id, { operationId: 'scan_refund_001', reason: 'Partial merchandise refund.', items: [{ reference: p.partner.items[0].reference, qty: 1 }] });
  const alerts = await f.platform.console.scan();
  assert.ok(!alerts.some(alert => alert.dedupeKey === `transfer-mismatch:${p.partner.id}`));
  const seedBag = await f.bagFor(await f.seedOrder(), 'brand_bloom');
  await f.db.query('UPDATE transfers SET amount_cents=amount_cents-1 WHERE bag_id=$1', [seedBag.id]);
  assert.ok((await f.platform.console.scan()).some(alert => alert.dedupeKey === `transfer-mismatch:${seedBag.id}`));
});
