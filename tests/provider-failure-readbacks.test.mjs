import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createProviderFailureReadbacks, guardReadbackAdapter } from '../server/provider-failure-readbacks.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';
import { APPROVED_TEST_PLATFORM_SWITCH } from '../server/provider-platform-switch.mjs';

const RUN = 'uco_33e3eed7612b443d82655b1a4e07bb55', PLATFORM = APPROVED_TEST_PLATFORM_SWITCH.toAccountId;
const PI = 'pi_UNITPAYMENT123', CHARGE = 'ch_UNITCHARGE123';
const dollars = cents => ({ shopMoney: { currencyCode: 'USD', amount: (cents / 100).toFixed(2) } });
async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  await db.query('CREATE TABLE provider_money_bookings (business_key TEXT PRIMARY KEY,run_id TEXT)');
  const calls = { reads: 0, writes: 0, sourceLease: 0 }, controls = {};
  const snapshot = { id: RUN, currency: 'USD', bags: [] };
  const details = { accountId: PLATFORM, paymentVerified: true, canonicalCommitted: true, processingFeeRecorded: true,
    chargeId: CHARGE, paymentIntentId: PI, bags: {}, testClock: { now: '2026-11-20T12:00:00Z' },
    shipTo: { name: 'PRIVATE_NAME_NEVER_RETURN', line1: 'PRIVATE_ADDRESS_NEVER_RETURN', email: 'PRIVATE_EMAIL_NEVER_RETURN' } };
  const refunds = new Map(), transfers = new Map(), payouts = new Map(), orders = new Map(), rows = new Map();
  for (const [index, identity] of TEST_STORES.entries()) {
    const bag = { id: `bag_unit_${index}`, brandId: `brand_unit_${index}`, shop: identity.shop, name: `Unit ${index}`,
      shippingCents: 25 * (index + 1), commissionBps: 1500, returnWindowDays: 30,
      items: [{ sku: `UNIT-SKU-${index}`, qty: 4, unitPriceCents: 100 * (index + 1) }] };
    snapshot.bags.push(bag);
    const subtotalCents = bag.items[0].unitPriceCents * 4, taxCents = 30 * (index + 1), commissionCents = Math.round(subtotalCents * .15);
    const totalCents = subtotalCents + bag.shippingCents + taxCents, transferCents = subtotalCents - commissionCents + bag.shippingCents;
    const accountId = `acct_UNITRECIPIENT${index}`, operationId = `unit_refund_${index}`, refundId = `re_UNITREFUND${index}`;
    const transferId = `tr_UNITTRANSFER${index}`, payoutId = `po_UNITPAYOUT${index}`, shopifyRefundId = `gid://shopify/Refund/${1000 + index}`;
    const amountCents = bag.items[0].unitPriceCents + 8 * (index + 1), recoveryCents = bag.items[0].unitPriceCents - Math.round(bag.items[0].unitPriceCents * .15);
    const input = { items: [{ sku: bag.items[0].sku, qty: 1 }], refundShipping: false };
    const afterTransfer = index !== 1;
    const op = { id: `prf_UNITREFUND${index}`, input, ...input, status: 'complete', stripeStatus: 'succeeded', stripeStartedAt: '2026-10-19T12:00:00Z',
      stripeRefundId: refundId, shopifyRefundId, shopifyVerified: true, amountCents, recoveryCents, afterTransfer,
      taxCents: 8 * (index + 1), commissionCents: Math.round(bag.items[0].unitPriceCents * .15), shippingCents: 0,
      reversalVerified: afterTransfer, reversalId: afterTransfer ? `trr_UNITREVERSAL${index}` : null };
    const transferred = transferCents - (afterTransfer ? 0 : recoveryCents), paid = transferred - (afterTransfer ? recoveryCents : 0);
    details.bags[bag.id] = { verified: true, orderId: `gid://shopify/Order/${100 + index}`, subtotalCents, shippingCents: bag.shippingCents,
      taxCents, totalCents, commissionCents, transferCents, refundCents: amountCents, refundOps: { [operationId]: op },
      transferId, transferOp: { id: transferId, status: 'verified', amountCents: transferred, accountId },
      payoutId, payoutOp: { id: payoutId, status: 'paid', amountCents: paid, accountId } };
    rows.set(bag.shop, { brand_id: bag.brandId, connected_account_id: accountId, connected_account_created_in_test: true,
      connected_account_verified: true, return_window_days: 30 });
    refunds.set(refundId, { id: refundId, amount: amountCents, status: 'succeeded', currency: 'usd', charge: CHARGE,
      payment_intent: PI, metadata: { bag_id: bag.id, refund_id: op.id }, raw: 'PRIVATE_RAW_REFUND' });
    transfers.set(transferId, { id: transferId, amount: transferred, currency: 'usd', livemode: false,
      destination: accountId, source_transaction: CHARGE, transfer_group: `ORD_${RUN}` });
    payouts.set(payoutId, { id: payoutId, amount: paid, currency: 'usd', livemode: false, status: 'paid' });
    orders.set(bag.shop, { id: details.bags[bag.id].orderId, sourceIdentifier: bag.id, test: true, tags: ['TEST_DO_NOT_SHIP'], currencyCode: 'USD',
      operationsComplete: true, refunds: [{ id: shopifyRefundId, totalRefundedSet: dollars(amountCents), note: 'PRIVATE_NATIVE_NOTE_NEVER_RETURN' }] });
  }
  details.amounts = { totalCents: Object.values(details.bags).reduce((sum, bag) => sum + bag.totalCents, 0) };
  const charge = { id: CHARGE, livemode: false, paid: true, captured: true, currency: 'usd', payment_intent: PI,
    amount: details.amounts.totalCents, amount_refunded: [...refunds.values()].reduce((sum, refund) => sum + refund.amount, 0), raw: 'PRIVATE_RAW_CHARGE' };
  const stripe = {
    preflight: async () => { calls.reads++; if (controls.wait) await controls.wait;
      return { verified: true, mode: controls.live ? 'live' : 'test', accountId: controls.foreignAccount ? 'acct_FOREIGN123' : PLATFORM }; },
    getCharge: async id => { calls.reads++; assert.equal(id, CHARGE); if (controls.throwPrivate) throw new Error('PRIVATE_PROVIDER_SECRET_NEVER_RETURN'); return structuredClone(charge); },
    getRefund: async id => { calls.reads++; if (controls.sourceChange) details.unexpectedChange = true;
      const value = structuredClone(refunds.get(id)); if (controls.badRefund) value.amount++; return value; },
    getTransfer: async id => { calls.reads++; return structuredClone(transfers.get(id)); },
    getPayout: async (id, options) => { calls.reads++; assert.ok([...rows.values()].some(row => row.connected_account_id === options.accountId)); return structuredClone(payouts.get(id)); },
  };
  for (const name of ['createRefund', 'createReversal', 'createTransfer', 'createTestPayout', 'capturePaymentIntent', 'createCheckoutSession'])
    stripe[name] = async () => { calls.writes++; assert.fail('No actual or fake provider writer is allowed'); };
  const stores = { row: async shop => structuredClone(rows.get(shop)), forShop: async shop => ({
    preflight: async () => { calls.reads++; return { shop: { myshopifyDomain: shop, currencyCode: 'USD' }, grantedScopes: [...SHOPIFY_ALLOWED_SCOPES] }; },
    getOrderOperations: async id => { calls.reads++; const value = structuredClone(orders.get(shop)); assert.equal(value.id, id);
      if (controls.incomplete) value.operationsComplete = false; return value; },
    createManualRefund: async () => { calls.writes++; assert.fail('No native refund writer is allowed'); },
  }) };
  const unifiedCheckout = { runtime: { read: async id => { assert.equal(id, RUN); return { id, state: 'completed' }; },
    decode: () => structuredClone({ snapshot, details }),
    withRun: async () => { calls.sourceLease++; assert.fail('Main runtime lease/writer must never be used'); } } };
  const service = await createProviderFailureReadbacks(db, auth, { unifiedCheckout, stores, getStripe: () => stripe });
  return { db, auth, service, calls, controls, snapshot, details, stripe };
}

test('fresh readbacks execute exactly21 real-money shadow guards without a provider writer or main lease and encrypt only safe results', async t => {
  const f = await fixture(t), result = await f.service.run({ confirmTest: true });
  assert.equal(result.status, 'passed_local_injected_guards'); assert.deepEqual(result.summary, { total: 21, passed: 21, failed: 0 });
  assert.equal(result.source, 'real_provider_snapshot_with_local_injected_fault'); assert.equal(result.realProviderFailureExecuted, false);
  assert.equal(result.fullAcceptancePassed, false); assert.equal(result.providerReads, 17); assert.equal(result.forbiddenWriteAttempts, 0);
  assert.equal(result.sourceRunUnchanged, true); assert.equal(result.sourceFinancialRowsUnchanged, true);
  assert.equal(f.calls.writes + f.calls.sourceLease, 0);
  for (const store of [2,4,6]) {
    assert.equal(result.cases.filter(row => row.caseId.startsWith(`store_${store}_`)).length, 7);
    assert.equal(result.cases.find(row => row.caseId === `store_${store}_refund_id_unknown`).observedState, 'refund_uncertain');
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|shipTo|"metadata":|acct_|re_UNIT|prf_UNIT|gid:\/\/|chargeId|paymentIntentId/);
  const row = (await f.db.query('SELECT report_encrypted FROM provider_failure_readback_reports')).rows[0];
  assert.ok(!row.report_encrypted.includes('PRIVATE_')); assert.deepEqual(await f.service.get({ reportId: result.id }), result);
  assert.equal((await f.db.query('SELECT * FROM provider_money_bookings')).rows.length, 0);
});
test('confirmation is exact and caller run IDs or provider payload overrides are rejected before reads', async t => {
  const f = await fixture(t);
  for (const input of [{}, { confirmTest: false }, { confirmTest: true, runId: RUN }, { confirmTest: true, live: true }])
    await assert.rejects(f.service.run(input), { code: 'FAILURE_READBACK_CONFIRMATION_REQUIRED' });
  assert.equal(f.calls.reads + f.calls.writes, 0);
});
test('live/foreign platform, provider cent drift and incomplete native snapshots stop before local injection with no writes', async t => {
  const f = await fixture(t);
  for (const flag of ['live', 'foreignAccount', 'badRefund', 'incomplete']) {
    f.controls[flag] = true; const result = await f.service.run({ confirmTest: true }); delete f.controls[flag];
    assert.equal(result.status, 'review'); assert.equal(result.errorCode, 'FAILURE_READBACK_BASELINE_REQUIRED');
    assert.equal(result.summary.total, 0); assert.equal(result.forbiddenWriteAttempts, 0);
  }
  assert.equal(f.calls.writes + f.calls.sourceLease, 0);
});
test('source mutation during snapshot is detected, never hidden by passing injected cases', async t => {
  const f = await fixture(t); f.controls.sourceChange = true;
  const result = await f.service.run({ confirmTest: true });
  assert.equal(result.summary.passed, 21); assert.equal(result.sourceRunUnchanged, false); assert.equal(result.status, 'review');
  assert.equal(f.calls.writes + f.calls.sourceLease, 0);
});
test('raw provider failures are never exposed and malformed or unknown report IDs cannot read stored reports', async t => {
  const f = await fixture(t); f.controls.throwPrivate = true;
  const result = await f.service.run({ confirmTest: true }); assert.equal(result.errorCode, 'FAILURE_READBACK_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_SECRET/);
  for (const reportId of ['../private', `frb_${'f'.repeat(32)}`])
    await assert.rejects(f.service.get({ reportId }), { code: 'FAILURE_READBACK_NOT_FOUND' });
});
test('concurrent runs are bounded rather than sharing a mutable shadow or reading providers twice', async t => {
  const f = await fixture(t); let release; f.controls.wait = new Promise(resolve => { release = resolve; });
  const first = f.service.run({ confirmTest: true });
  await assert.rejects(f.service.run({ confirmTest: true }), { code: 'FAILURE_READBACK_BUSY' });
  release(); assert.equal((await first).summary.passed, 21); assert.equal(f.calls.writes + f.calls.sourceLease, 0);
});
test('strict read adapters deny and count every undeclared external writer or reader without invoking a fallback', async () => {
  const counters = { forbiddenWrites: 0 }, allowed = guardReadbackAdapter({ getCharge: async () => ({ test: true }) }, counters);
  assert.deepEqual(await allowed.getCharge(), { test: true }); assert.equal(allowed.then, undefined);
  for (const method of ['createRefund', 'createTransfer', 'createReversal', 'createTestPayout', 'createManualRefund', 'getUnknown'])
    await assert.rejects(allowed[method]({}), { code: 'FAILURE_READBACK_WRITER_FORBIDDEN' });
  assert.equal(counters.forbiddenWrites, 6);
});
