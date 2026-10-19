import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createProviderTaxReconciliation, PLATFORM_TAX_ROUNDING_POLICY } from '../server/provider-tax-reconciliation.mjs';

const [RUN, SECONDARY] = PLATFORM_TAX_ROUNDING_POLICY.runIds, PLATFORM = PLATFORM_TAX_ROUNDING_POLICY.accountId;
const PI = 'pi_fixturePayment123', CHARGE = 'ch_fixtureCharge123', ORIGINAL = 'tax_fixtureOriginal123';
const shops = ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'];
const decimal = cents => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: 'USD' } });
const problem = code => cause => cause.code === code;

async function setup(t, { runId = RUN, operator = false, acceptOperator = false, observed = false } = {}) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const calls = [], taxes = new Map(), lists = new Map(), refunds = new Map(), natives = new Map(), originals = new Map(), rows = new Map();
  const nativeTax = [8, 16, 24], stripeTax = runId === SECONDARY ? [...nativeTax] : [8, 17, 25];
  const snapshot = { id: runId, currency: 'USD', bags: [] };
  const details = { accountId: PLATFORM, paymentVerified: true, canonicalCommitted: true, chargeId: CHARGE, paymentIntentId: PI,
    amounts: { subtotalCents: 2400, shippingCents: 150, taxCents: 210, totalCents: 2760 }, shipTo: { name: 'PRIVATE_NAME', line1: 'PRIVATE_ADDRESS' }, bags: {} };
  const charge = { id: CHARGE, livemode: false, currency: 'usd', payment_intent: PI, paid: true, captured: true, amount: 2760, amount_refunded: 648 };
  const transaction = (id, type, reference, lines) => {
    taxes.set(id, { id, object: 'tax.transaction', livemode: false, currency: 'usd', type, reference,
      reversal: type === 'reversal' ? { original_transaction: ORIGINAL } : null, shipping_cost: null,
      customer_details: { address: { line1: 'PRIVATE_ADDRESS' }, email: 'PRIVATE_EMAIL' }, metadata: { private: 'PRIVATE_SECRET' } });
    lists.set(id, { object: 'list', url: `/v1/tax/transactions/${id}/line_items`, has_more: false, data: lines });
  };
  transaction(ORIGINAL, 'transaction', operator ? 'custom-original-reference' : PI, []);
  const line = (id, type, amount, tax, originalLineItemId = null) => ({ id, object: 'tax.transaction_line_item', livemode: false, type, amount, amount_tax: tax,
    quantity: 1, tax_behavior: 'exclusive', reference: 'PRIVATE_LINE_REFERENCE', reversal: originalLineItemId ? { original_line_item: originalLineItemId } : null });
  const mapping = { runId, originalTaxTransactionId: ORIGINAL, refunds: [], binding: operator
    ? { kind: 'operator_dashboard', artifactRef: 'verified-tax-source-links.json', evidenceSha256: 'a'.repeat(64), confirmedByOwner: true } : { kind: 'api_reference' } };
  for (let index = 0; index < 3; index++) {
    const bag = { id: `bag_tax_${index}`, shop: shops[index], brandId: `brand_tax_${index}`, shippingCents: 50,
      items: [{ sku: `SKU-${index}`, qty: 4, unitPriceCents: 100 * (index + 1) }] };
    const subtotal = 400 * (index + 1), tax = [45, 70, 95][index], total = subtotal + 50 + tax;
    const refundId = `re_fixtureRefund${index}`, taxId = `tax_fixtureReversal${index}`, nativeId = `gid://shopify/Refund/${200 + index}`;
    const lineId = `gid://shopify/LineItem/${300 + index}`, paymentId = `gid://shopify/OrderTransaction/${400 + index}`;
    const taxLineId = `tax_li_fixtureOriginal${index}`, cash = 100 * (index + 1) + nativeTax[index];
    snapshot.bags.push(bag); mapping.refunds.push({ refundId, taxTransactionId: taxId });
    const op = { id: `prf_fixtureOperation${index}`, status: 'complete', stripeStatus: 'succeeded', shopifyVerified: true,
      stripeRefundId: refundId, shopifyRefundId: nativeId, amountCents: cash, taxCents: nativeTax[index], shippingCents: 0,
      parentTransactionId: paymentId,
      lineItems: [{ lineItemId: lineId, sku: bag.items[0].sku, qty: 1, subtotalCents: 100 * (index + 1), taxCents: nativeTax[index] }] };
    const value = { verified: true, orderId: `gid://shopify/Order/${100 + index}`, subtotalCents: subtotal, shippingCents: 50, taxCents: tax,
      totalCents: total, refundOps: { return1: op } };
    details.bags[bag.id] = value; rows.set(bag.shop, { brand_id: bag.brandId });
    refunds.set(refundId, { id: refundId, object: 'refund', charge: CHARGE, payment_intent: PI, status: 'succeeded', currency: 'usd', amount: cash,
      metadata: { bag_id: bag.id, refund_id: op.id } });
    originals.set(value.orderId, { id: value.orderId, test: true, sourceIdentifier: bag.id, totalPriceSet: decimal(total), subtotalPriceSet: decimal(subtotal),
      totalShippingPriceSet: decimal(50), totalTaxSet: decimal(tax), shippingAddress: { address1: 'PRIVATE_ADDRESS' } });
    natives.set(value.orderId, { id: value.orderId, test: true, sourceIdentifier: bag.id, currencyCode: 'USD', operationsComplete: true, totalRefundedSet: decimal(cash),
      transactions: [{ id: paymentId, kind: 'SALE', status: 'SUCCESS', test: true, gateway: 'manual', amountSet: decimal(total) }],
      refunds: [{ id: nativeId, totalRefundedSet: decimal(cash), note: 'PRIVATE_NOTE',
        refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, lineItem: { id: lineId }, subtotalSet: decimal(100 * (index + 1)), totalTaxSet: decimal(nativeTax[index]) }] },
        refundShippingLines: { pageInfo: { hasNextPage: false }, nodes: [] },
        transactions: { pageInfo: { hasNextPage: false }, nodes: [{ kind: 'REFUND', status: 'SUCCESS', test: true, gateway: 'manual', parentTransaction: { id: paymentId }, amountSet: decimal(cash) }] } }] });
    lists.get(ORIGINAL).data.push(line(taxLineId, 'transaction', subtotal + 50, tax));
    transaction(taxId, 'reversal', operator ? `custom-reversal-${index}` : refundId,
      [line(`tax_li_fixtureReversed${index}`, 'reversal', -(cash - stripeTax[index]), -stripeTax[index], taxLineId)]);
  }
  let busy = false, time = new Date('2026-10-19T12:00:00Z'), state = 'completed';
  await db.query(`CREATE TABLE unified_checkout_runs(id TEXT PRIMARY KEY,lock_token TEXT,lease_until TIMESTAMPTZ,snapshot_encrypted TEXT,details_encrypted TEXT)`);
  await db.query('INSERT INTO unified_checkout_runs(id,snapshot_encrypted,details_encrypted) VALUES($1,$2,$3)', [runId, auth.encrypt(snapshot), auth.encrypt(details)]);
  const runtime = { read: async () => (await db.query('SELECT * FROM unified_checkout_runs WHERE id=$1', [runId])).rows[0],
    decode: row => ({ snapshot: auth.decrypt(row.snapshot_encrypted), details: auth.decrypt(row.details_encrypted) }), withRun: async (requested, action) => {
    assert.equal(requested, runId);
    if (busy) return { processing: true };
    busy = true;
    const token = randomUUID();
    await db.query('UPDATE unified_checkout_runs SET lock_token=$2,lease_until=$3,snapshot_encrypted=$4,details_encrypted=$5 WHERE id=$1',
      [runId, token, new Date(time.getTime() + 300_000), auth.encrypt(snapshot), auth.encrypt(details)]);
    try { await action({ snapshot, details, state, save: () => { throw new Error('Tax must not save cash state'); } }); }
    finally { busy = false; await db.query('UPDATE unified_checkout_runs SET lock_token=NULL,lease_until=NULL WHERE id=$1 AND lock_token=$2', [runId, token]); }
    return { id: runId, state };
  } };
  const stripe = {
    preflight: async () => ({ verified: true, mode: 'test', accountId: PLATFORM }),
    getCharge: async id => { calls.push(['getCharge', id]); return structuredClone(charge); },
    getRefund: async id => { calls.push(['getRefund', id]); return structuredClone(refunds.get(id)); },
    getTaxTransaction: async id => { calls.push(['getTaxTransaction', id]); return structuredClone(taxes.get(id)); },
    listTaxTransactionLineItems: async id => { calls.push(['listTaxTransactionLineItems', id]); return structuredClone(lists.get(id)); },
  };
  for (const method of ['createRefund', 'createTransfer', 'createReversal', 'createTestPayout', 'createCheckoutSession', 'capturePaymentIntent', 'recordTaxTransaction', 'createTaxReversal'])
    stripe[method] = async () => { calls.push(['FORBIDDEN_WRITE', method]); throw new Error('Provider writes are prohibited'); };
  const stores = { row: async shop => rows.get(shop), forShop: async shop => ({
    getOrderOperations: async id => { calls.push(['getOrderOperations', shop, id]); return structuredClone(natives.get(id)); },
    getOrderDetails: async id => { calls.push(['getOrderDetails', shop, id]); return structuredClone(originals.get(id)); },
  }) };
  // Explicit offline observation fixture, NOT an assertion of real Dashboard
  // acceptance. Production callback separately pins the reviewed artifact hash.
  const dashboardEvidence = { source: 'operator_verified_dashboard', runId, accountId: PLATFORM, test: true,
    observedAt: '2026-10-19T12:00:00Z', artifactRef: 'observed-tax-fixture.json', artifactSha256: 'b'.repeat(64),
    apiLimitation: { kind: 'stripe_managed_tax_not_retrievable', requestId: 'req_observedFixture123' },
    original: { id: ORIGINAL, reference: PI, grossCents: 2760, taxCents: 210 },
    reversals: mapping.refunds.map((mapped, index) => ({ id: mapped.taxTransactionId, reference: mapped.refundId,
      grossCents: -(100 * (index + 1) + nativeTax[index]), taxCents: -stripeTax[index] })) };
  const service = await createProviderTaxReconciliation(db, auth, { unifiedCheckout: { runtime }, stores, getStripe: () => stripe,
    verifyOperatorEvidence: async () => acceptOperator, getObservedTaxEvidence: async () => observed ? structuredClone(dashboardEvidence) : null, clock: () => time });
  await db.query(`INSERT INTO ledger_journals(id,business_key,kind,total_debit_cents,total_credit_cents) VALUES('journal_core','existing_core','stripe_test_payment',2760,2760)`);
  await db.query(`INSERT INTO ledger_entries(id,journal_id,account,debit_cents,credit_cents) VALUES('entry_debit','journal_core','stripe_platform_clearing',2760,0)`);
  await db.query(`INSERT INTO ledger_entries(id,journal_id,account,debit_cents,credit_cents) VALUES('entry_credit','journal_core','tax_payable',0,2760)`);
  const core = async () => JSON.stringify({ journals: (await db.query('SELECT * FROM ledger_journals ORDER BY id')).rows,
    entries: (await db.query('SELECT * FROM ledger_entries ORDER BY id')).rows, refunds: (await db.query('SELECT * FROM refunds ORDER BY id')).rows,
    transfers: (await db.query('SELECT * FROM transfers ORDER BY id')).rows });
  const baseline = await core();
  const configure = () => service.configureEvidence(structuredClone(mapping));
  const record = report => service.recordRounding({ reportId: report.id, reportHash: report.reportHash, operationId: 'tax_rounding_fixture_v1', confirmPlatformOnly: true });
  return { db, auth, calls, stripe, stores, taxes, lists, refunds, natives, originals, rows, snapshot, details, charge, service, mapping, configure, record, dashboardEvidence,
    core, baseline, setTime: value => { time = new Date(value); }, setBusy: value => { busy = value; }, getState: () => state };
}
const check = (report, name) => report.checks.find(item => item.name === name);

test('actual-shaped 0/+1/+1 tax allocation remains explicit, complete, encrypted and GET-only', async t => {
  const fx = await setup(t); const binding = await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(binding.immutable, true); assert.equal(report.status, 'unrecorded_platform_variance'); assert.equal(report.readyToRecord, true);
  assert.equal(report.reviewCount, 0); assert.equal(report.provenance.apiReferenceProof, true);
  assert.deepEqual(report.refunds.map(item => item.signedVarianceCents), [0, 1, 1]);
  assert.deepEqual(report.totals, { originalGrossCents: 2760, originalStripeTaxCents: 210, originalShopifyTaxCents: 210, originalAllocatedTaxCents: 210,
    refundCashCents: 648, stripeReversedTaxCents: 50, shopifyRefundTaxCents: 48, rawVarianceCents: 2, recordedPlatformVarianceCents: 0, unaccountedVarianceCents: 2 });
  assert.equal(report.fullAcceptancePassed, false); assert.equal(report.providerWrites, 0); assert.equal(report.coreAccountingMutations, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|customer_details|shippingAddress|metadata|secret/i);
  const stored = (await fx.db.query('SELECT * FROM provider_tax_reports')).rows[0];
  assert.doesNotMatch(stored.report_encrypted, /PRIVATE_|tax_fixture|stripeTaxCents/);
  assert.deepEqual(await fx.service.getReport({ reportId: report.id }), report);
  assert.equal(fx.calls.filter(call => call[0] === 'listTaxTransactionLineItems').length, 4);
  assert.equal(fx.calls.filter(call => call[0] === 'FORBIDDEN_WRITE').length, 0); assert.equal(await fx.core(), fx.baseline);
});

test('explicit atomic recording creates only two balanced memo entries and replay never hides the raw difference or changes core accounting', async t => {
  const fx = await setup(t); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN }); const result = await fx.record(report);
  assert.equal(result.entriesRecorded, 2); assert.equal(result.status, 'reconciled_platform_rounding'); assert.equal(result.readyToRecord, false);
  assert.equal(result.totals.rawVarianceCents, 2); assert.equal(result.totals.recordedPlatformVarianceCents, 2); assert.equal(result.totals.unaccountedVarianceCents, 0);
  assert.equal(result.fullAcceptancePassed, false); assert.equal(fx.getState(), 'completed');
  const entries = (await fx.db.query('SELECT * FROM provider_tax_rounding_entries ORDER BY refund_id')).rows;
  assert.equal(entries.length, 2); assert.ok(entries.every(entry => entry.signed_variance_cents === 1 && entry.amount_cents === 1
    && entry.debit_account === 'platform_tax_rounding_difference' && entry.credit_account === 'platform_tax_rounding_control'));
  assert.ok(entries.every(entry => !/PRIVATE_|re_fixture/.test(entry.entry_encrypted)));
  const replay = await fx.record(report); assert.equal(replay.replayed, true); assert.equal(replay.entriesRecorded, 0);
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 2);
  assert.equal(await fx.core(), fx.baseline); assert.equal(fx.calls.filter(call => call[0] === 'FORBIDDEN_WRITE').length, 0);
});

test('zero-difference existing secondary evidence is matched without inventing a rounding journal', async t => {
  const fx = await setup(t, { runId: SECONDARY }); await fx.configure(); const report = await fx.service.reconcile({ runId: SECONDARY });
  assert.equal(report.status, 'matched'); assert.equal(report.readyToRecord, false); assert.equal(report.totals.rawVarianceCents, 0);
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED'));
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
});

test('negative one-cent variance reverses memo/control direction without altering shopper refunds', async t => {
  const fx = await setup(t, { runId: SECONDARY });
  const last = fx.lists.get('tax_fixtureReversal2').data[0]; last.amount_tax = -23; last.amount = -301;
  await fx.configure(); const report = await fx.service.reconcile({ runId: SECONDARY }); const result = await fx.record(report);
  assert.equal(result.totals.rawVarianceCents, -1); assert.equal(result.totals.recordedPlatformVarianceCents, -1); assert.equal(result.totals.unaccountedVarianceCents, 0);
  const row = (await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows[0];
  assert.equal(row.debit_account, 'platform_tax_rounding_control'); assert.equal(row.credit_account, 'platform_tax_rounding_difference');
  assert.equal(row.amount_cents, 1); assert.equal(await fx.core(), fx.baseline);
});

test('a two-cent per-refund outlier remains exact and reviewable, never silently tolerated or posted', async t => {
  const fx = await setup(t); const reversal = fx.lists.get('tax_fixtureReversal1').data[0]; reversal.amount_tax = -18; reversal.amount = -198;
  await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'review'); assert.equal(report.readyToRecord, false); assert.equal(report.totals.rawVarianceCents, 3);
  assert.equal(check(report, 're_fixtureRefund1:rounding_policy').code, 'PLATFORM_ROUNDING_OUTLIER');
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED'));
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
});

test('custom Tax references require independently accepted operator evidence; amounts or a supplied screenshot hash alone are not proof', async t => {
  const fx = await setup(t, { operator: true }); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'review'); assert.equal(report.provenance.operatorEvidenceAccepted, false); assert.equal(report.totals.rawVarianceCents, null);
  assert.ok(report.checks.some(item => item.code === 'INDEPENDENT_TAX_BINDING_REQUIRED'));
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED'));
});

test('accepted audited operator binding stays labelled non-API and cannot override a conflicting recognizable payment/refund reference', async t => {
  const fx = await setup(t, { operator: true, acceptOperator: true }); await fx.configure();
  const report = await fx.service.reconcile({ runId: RUN }); assert.equal(report.reviewCount, 0);
  assert.equal(report.provenance.apiReferenceProof, false); assert.equal(report.provenance.operatorEvidenceAccepted, true);
  fx.taxes.get('tax_fixtureReversal1').reference = 're_wrongRefund123';
  const conflict = await fx.service.reconcile({ runId: RUN }); assert.equal(conflict.readyToRecord, false);
  assert.ok(conflict.checks.some(item => item.code === 'CONFLICTING_API_REFERENCE'));
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED'));
});

test('explicit mapping is complete and immutable, and scope cannot expand to another platform or run', async t => {
  const fx = await setup(t); const first = await fx.configure(); assert.deepEqual(await fx.configure(), first);
  const changed = structuredClone(fx.mapping); changed.originalTaxTransactionId = 'tax_anotherOriginal123';
  await assert.rejects(fx.service.configureEvidence(changed), problem('TAX_BINDING_IMMUTABLE'));
  const missing = structuredClone(fx.mapping); missing.refunds.pop(); await assert.rejects(fx.service.configureEvidence(missing), problem('TAX_REFUND_COVERAGE_REQUIRED'));
  const duplicate = structuredClone(fx.mapping); duplicate.refunds[1].taxTransactionId = duplicate.refunds[0].taxTransactionId;
  await assert.rejects(fx.service.configureEvidence(duplicate), problem('TAX_MAPPING_INVALID'));
  await assert.rejects(fx.service.reconcile({ runId: `uco_${'f'.repeat(32)}` }), problem('TAX_RUN_NOT_AUTHORIZED'));
  fx.details.accountId = 'acct_wrongPlatform123'; const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'review'); assert.equal(report.totals.stripeReversedTaxCents, null); assert.equal(fx.getState(), 'completed');
});

test('live, wrong parent, incomplete pagination and invalid signed Tax evidence yield unknown totals, not fabricated zero reconciliation', async t => {
  const fx = await setup(t); await fx.configure();
  const cases = [
    ['live parent', () => { fx.taxes.get(ORIGINAL).livemode = true; }, () => { fx.taxes.get(ORIGINAL).livemode = false; }],
    ['truncated lines', () => { fx.lists.get('tax_fixtureReversal1').has_more = true; }, () => { fx.lists.get('tax_fixtureReversal1').has_more = false; }],
    ['wrong tax parent', () => { fx.taxes.get('tax_fixtureReversal1').reversal.original_transaction = 'tax_wrongOriginal123'; }, () => { fx.taxes.get('tax_fixtureReversal1').reversal.original_transaction = ORIGINAL; }],
    ['wrong original line', () => { fx.lists.get('tax_fixtureReversal1').data[0].reversal.original_line_item = 'tax_li_wrongOriginal123'; }, () => { fx.lists.get('tax_fixtureReversal1').data[0].reversal.original_line_item = 'tax_li_fixtureOriginal1'; }],
    ['positive reversal', () => { fx.lists.get('tax_fixtureReversal1').data[0].amount_tax = 17; }, () => { fx.lists.get('tax_fixtureReversal1').data[0].amount_tax = -17; }],
    ['duplicate line', () => { fx.lists.get('tax_fixtureReversal1').data.push(structuredClone(fx.lists.get('tax_fixtureReversal1').data[0])); }, () => { fx.lists.get('tax_fixtureReversal1').data.pop(); }],
  ];
  for (const [name, alter, restore] of cases) {
    alter(); const report = await fx.service.reconcile({ runId: RUN });
    assert.equal(report.status, 'review', name); assert.equal(report.readyToRecord, false, name); assert.equal(report.totals.rawVarianceCents, null, name);
    assert.equal(report.totals.unaccountedVarianceCents, null, name); restore();
  }
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
});

test('fresh linked Stripe charge/refund and exact native quantities, manual parent, tax and original totals are all mandatory', async t => {
  const fx = await setup(t); await fx.configure();
  const value = fx.details.bags.bag_tax_1, native = fx.natives.get(value.orderId), refund = fx.refunds.get('re_fixtureRefund1');
  const cases = [
    ['refund mode', () => { refund.livemode = true; }, () => { delete refund.livemode; }],
    ['refund charge', () => { refund.charge = 'ch_wrongCharge123'; }, () => { refund.charge = CHARGE; }],
    ['refund metadata', () => { refund.metadata.bag_id = 'bag_wrong'; }, () => { refund.metadata.bag_id = 'bag_tax_1'; }],
    ['refund cash', () => { refund.amount = 217; }, () => { refund.amount = 216; }],
    ['unseen charge refund', () => { fx.charge.amount_refunded = 649; }, () => { fx.charge.amount_refunded = 648; }],
    ['native qty', () => { native.refunds[0].refundLineItems.nodes[0].quantity = 2; }, () => { native.refunds[0].refundLineItems.nodes[0].quantity = 1; }],
    ['native parent', () => { native.refunds[0].transactions.nodes[0].parentTransaction.id = 'gid://shopify/OrderTransaction/999'; }, () => { native.refunds[0].transactions.nodes[0].parentTransaction.id = 'gid://shopify/OrderTransaction/401'; }],
    ['native pagination', () => { native.refunds[0].refundShippingLines.pageInfo.hasNextPage = true; }, () => { native.refunds[0].refundShippingLines.pageInfo.hasNextPage = false; }],
    ['native original tax', () => { fx.originals.get(value.orderId).totalTaxSet = decimal(71); }, () => { fx.originals.get(value.orderId).totalTaxSet = decimal(70); }],
  ];
  for (const [name, alter, restore] of cases) { alter(); const report = await fx.service.reconcile({ runId: RUN }); assert.equal(report.status, 'review', name); assert.equal(report.readyToRecord, false, name); restore(); }
  assert.equal(await fx.core(), fx.baseline); assert.equal(fx.getState(), 'completed');
});

test('recording rejects stale hashes, changed fresh provider evidence, absent confirmation and operation conflicts before any subledger entry', async t => {
  const fx = await setup(t); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  await assert.rejects(fx.service.recordRounding({ reportId: report.id, reportHash: 'f'.repeat(64), operationId: 'tax_rounding_fixture_v1', confirmPlatformOnly: true }), problem('TAX_REPORT_HASH_MISMATCH'));
  await assert.rejects(fx.service.recordRounding({ reportId: report.id, reportHash: report.reportHash, operationId: 'short', confirmPlatformOnly: true }), problem('PLATFORM_ROUNDING_CONFIRMATION_REQUIRED'));
  fx.setTime('2026-10-19T12:06:00Z'); await assert.rejects(fx.record(report), problem('TAX_REPORT_STALE'));
  fx.setTime('2026-10-19T12:00:00Z'); fx.taxes.get('tax_fixtureReversal1').reference = 're_changedRefund123';
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED')); fx.taxes.get('tax_fixtureReversal1').reference = 're_fixtureRefund1';
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
  await fx.record(report); const newReport = await fx.service.reconcile({ runId: RUN });
  await assert.rejects(fx.service.recordRounding({ reportId: newReport.id, reportHash: newReport.reportHash, operationId: 'tax_rounding_fixture_v1', confirmPlatformOnly: true }), problem('TAX_OPERATION_CONFLICT'));
});

test('concurrent record calls cannot duplicate memo entries and run lease failures do not downgrade completed cash state', async t => {
  const fx = await setup(t); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  const results = await Promise.allSettled([fx.record(report), fx.record(report)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'TAX_RUN_BUSY');
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 2);
  fx.setBusy(true); await assert.rejects(fx.service.reconcile({ runId: RUN }), problem('TAX_RUN_BUSY')); fx.setBusy(false);
  assert.equal(fx.getState(), 'completed'); assert.equal(await fx.core(), fx.baseline);
});

test('nightly audits only configured approved runs once per UTC day and deduplicate unchanged review alerts', async t => {
  const fx = await setup(t); await fx.configure();
  const first = await fx.service.runNightly(); assert.equal(first.reports.length, 1); assert.equal(first.fullAcceptancePassed, false);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.tax_reconciliation_review'")).rows.length, 1);
  const reads = fx.calls.length; assert.equal((await fx.service.runNightly()).reports.length, 0); assert.equal(fx.calls.length, reads);
  fx.setTime('2026-10-20T00:00:01Z'); assert.equal((await fx.service.runNightly()).reports.length, 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.tax_reconciliation_review'")).rows.length, 1);
  const report = await fx.service.latest({ runId: RUN }); await fx.record(report);
  fx.setTime('2026-10-21T00:00:01Z'); const reconciled = await fx.service.runNightly();
  assert.equal(reconciled.reports[0].status, 'reconciled_platform_rounding');
  assert.equal((await fx.db.query('SELECT last_alert_hash FROM provider_tax_bindings')).rows[0].last_alert_hash, null);
});

test('immutable report and entry evidence cannot be silently edited or reused for a different reversal', async t => {
  const fx = await setup(t); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN }); await fx.record(report);
  await fx.db.query("UPDATE provider_tax_rounding_entries SET signed_variance_cents=-1 WHERE refund_id='re_fixtureRefund1'");
  const changed = await fx.service.reconcile({ runId: RUN }); assert.equal(changed.status, 'review');
  assert.ok(changed.checks.some(item => item.code === 'IMMUTABLE_ROUNDING_EVIDENCE_CHANGED'));
  await assert.rejects(fx.record(report), problem('TAX_REPLAY_REVIEW_REQUIRED'));
  const decrypted = fx.auth.decrypt((await fx.db.query('SELECT report_encrypted FROM provider_tax_reports WHERE id=$1', [report.id])).rows[0].report_encrypted);
  decrypted.totals.rawVarianceCents = 0;
  await fx.db.query('UPDATE provider_tax_reports SET report_encrypted=$2 WHERE id=$1', [report.id, fx.auth.encrypt(decrypted)]);
  await assert.rejects(fx.service.getReport({ reportId: report.id }), problem('TAX_REPORT_CHANGED'));
});

test('expired or stolen runtime lease is rechecked inside commit, before any immutable memo record', async t => {
  const fx = await setup(t); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  const originalRead = fx.stripe.getTaxTransaction;
  let tamper = true;
  fx.stripe.getTaxTransaction = async id => {
    const value = await originalRead(id);
    if (tamper && id === 'tax_fixtureReversal2') { tamper = false; await fx.db.query("UPDATE unified_checkout_runs SET lock_token='stolen-worker-token' WHERE id=$1", [RUN]); }
    return value;
  };
  await assert.rejects(fx.record(report), problem('TAX_LEASE_LOST'));
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
  assert.equal(fx.getState(), 'completed'); assert.equal(await fx.core(), fx.baseline);
  fx.stripe.getTaxTransaction = async id => {
    const value = await originalRead(id);
    if (id === 'tax_fixtureReversal2') await fx.db.query("UPDATE unified_checkout_runs SET lease_until='2026-10-19T11:59:59Z' WHERE id=$1", [RUN]);
    return value;
  };
  await assert.rejects(fx.record(report), problem('TAX_LEASE_LOST'));
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
});

test('nightly busy failure releases its UTC claim and persists one safe deduplicated retryable alert', async t => {
  const fx = await setup(t); await fx.configure(); fx.setBusy(true);
  const first = await fx.service.runNightly(); assert.equal(first.reports[0].code, 'TAX_RUN_BUSY');
  assert.equal((await fx.db.query('SELECT nightly_claimed_date FROM provider_tax_bindings')).rows[0].nightly_claimed_date, null);
  await fx.service.runNightly();
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.tax_reconciliation_review'")).rows.length, 1);
  fx.setBusy(false); const recovered = await fx.service.runNightly(); assert.equal(recovered.reports[0].readyToRecord, true);
  assert.equal((await fx.service.runNightly()).reports.length, 0);
  const payloads = (await fx.db.query("SELECT payload FROM outbox_events WHERE type='provider.tax_reconciliation_review'")).rows;
  assert.doesNotMatch(JSON.stringify(payloads), /PRIVATE_|secret|address|email/i);
});

test('provider read diagnostics retain only allowlisted identifiers and field names, never raw messages, credentials or shopper values', async t => {
  const fx = await setup(t); await fx.configure();
  const raw = 'PRIVATE_NAME PRIVATE_ADDRESS PRIVATE_EMAIL sk_test_PRIVATE_CREDENTIAL';
  fx.stripe.getTaxTransaction = async () => { throw Object.assign(new Error(raw), {
    code: 'STRIPE_TAX_READBACK_MISMATCH', details: { stripeCode: 'resource_missing', requestId: 'req_safeFixture123',
      validationFields: ['reference', 'shipping_cost', 'line_amount', 'customer_details', raw], rawMessage: raw, apiKey: raw, body: { address: raw } },
  }); };
  const report = await fx.service.reconcile({ runId: RUN }), diagnostic = check(report, 'original_tax_read');
  assert.equal(diagnostic.code, 'PROVIDER_READ_UNAVAILABLE'); assert.equal(diagnostic.providerCode, 'STRIPE_TAX_READBACK_MISMATCH');
  assert.equal(diagnostic.stripeCode, 'resource_missing'); assert.equal(diagnostic.requestId, 'req_safeFixture123');
  assert.deepEqual(diagnostic.validationFields, ['reference', 'shipping_cost', 'line_amount']);
  assert.equal(report.status, 'review'); assert.equal(report.readyToRecord, false); assert.equal(report.totals.rawVarianceCents, null);
  assert.doesNotMatch(JSON.stringify(await fx.service.getReport({ reportId: report.id })), /PRIVATE_|sk_test_|customer_details|rawMessage|apiKey/);
  fx.stripe.getTaxTransaction = async () => { throw Object.assign(new Error(raw), { code: raw,
    details: { stripeCode: raw, requestId: 'req_sk_test_PRIVATE_CREDENTIAL', validationFields: ['line_quantity', raw, 'address', 'secret'] } }); };
  const hostile = await fx.service.reconcile({ runId: RUN }), filtered = check(hostile, 'original_tax_read');
  assert.equal(filtered.providerCode, undefined); assert.equal(filtered.stripeCode, undefined); assert.equal(filtered.requestId, undefined);
  assert.deepEqual(filtered.validationFields, ['line_quantity']); assert.doesNotMatch(JSON.stringify(hostile), /PRIVATE_|sk_test_|secret|address/i);
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
  assert.equal(await fx.core(), fx.baseline); assert.equal(fx.getState(), 'completed');
});

const managedTaxUnavailable = fx => {
  let request = 0;
  fx.stripe.getTaxTransaction = async () => { throw Object.assign(new Error('PRIVATE provider body: Stripe-managed record cannot be retrieved'), {
    code: 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE', details: { stripeCode: 'resource_missing', requestId: `req_managedFixture${++request}` },
  }); };
};

test('explicit verified Dashboard snapshot reconciles unavailable managed Tax records without fabricating API objects or line-parent proof', async t => {
  const fx = await setup(t, { observed: true }); managedTaxUnavailable(fx); await fx.configure();
  const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.reviewCount, 0); assert.equal(report.readyToRecord, true); assert.equal(report.status, 'unrecorded_platform_variance');
  assert.equal(report.provenance.source, 'operator_verified_dashboard'); assert.equal(report.provenance.observationMode, 'frozen_snapshot_not_live_tax_api');
  assert.equal(report.provenance.taxLineApiAvailable, false); assert.equal(report.provenance.apiReferenceProof, false);
  assert.equal(report.provenance.parentProof, 'refund_charge_payment_intent_to_dashboard_tax_reference');
  assert.equal(report.provenance.observedAt, fx.dashboardEvidence.observedAt); assert.equal(report.provenance.dashboardSnapshotOnly, true);
  assert.equal(check(report, 'original_tax_read').status, 'unavailable'); assert.equal(check(report, 'original_tax_line_item_api').status, 'unavailable');
  assert.ok(!report.checks.some(item => /tax_original|tax_line_parent|original_line_remainder/.test(item.name)));
  assert.equal(report.totals.stripeReversedTaxCents, 50); assert.equal(report.totals.shopifyRefundTaxCents, 48); assert.equal(report.totals.rawVarianceCents, 2);
  const result = await fx.record(report); assert.equal(result.entriesRecorded, 2); assert.equal(result.totals.recordedPlatformVarianceCents, 2);
  assert.equal(result.totals.rawVarianceCents, 2); assert.equal(result.totals.unaccountedVarianceCents, 0); assert.equal(result.fullAcceptancePassed, false);
  assert.equal((await fx.record(report)).replayed, true);
  assert.equal(fx.calls.filter(call => call[0] === 'listTaxTransactionLineItems').length, 0);
  assert.equal(fx.calls.filter(call => call[0] === 'FORBIDDEN_WRITE').length, 0); assert.equal(await fx.core(), fx.baseline);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|customer_details|"original_transaction"\s*:|"original_line_item"\s*:/);
});

test('Dashboard fallback cannot override malformed/live available API records or mismatch its exact account, PI, refund, tax ID and signed totals', async t => {
  const fx = await setup(t, { observed: true }); await fx.configure(); fx.taxes.get(ORIGINAL).livemode = true;
  const live = await fx.service.reconcile({ runId: RUN }); assert.equal(live.provenance.dashboardSnapshotOnly, false); assert.equal(live.readyToRecord, false);
  for (const code of ['STRIPE_REQUEST_FAILED', 'STRIPE_MODE_MISMATCH', 'STRIPE_TAX_READBACK_MISMATCH', 'INTEGRATION_UNAVAILABLE']) {
    fx.stripe.getTaxTransaction = async () => { throw Object.assign(new Error('PRIVATE upstream data'), { code, details: { stripeCode: 'resource_missing', requestId: 'req_notManagedProof123' } }); };
    const unavailable = await fx.service.reconcile({ runId: RUN });
    assert.equal(unavailable.provenance.dashboardSnapshotOnly, false, code); assert.equal(unavailable.readyToRecord, false, code); assert.equal(unavailable.totals.rawVarianceCents, null, code);
  }
  managedTaxUnavailable(fx);
  const cases = [
    [() => { fx.dashboardEvidence.accountId = 'acct_wrongPlatform123'; }, () => { fx.dashboardEvidence.accountId = PLATFORM; }],
    [() => { fx.dashboardEvidence.original.reference = 'pi_wrongPayment123'; }, () => { fx.dashboardEvidence.original.reference = PI; }],
    [() => { fx.dashboardEvidence.reversals[1].reference = 're_wrongRefund123'; }, () => { fx.dashboardEvidence.reversals[1].reference = 're_fixtureRefund1'; }],
    [() => { fx.dashboardEvidence.reversals[1].id = 'tax_wrongReversal123'; }, () => { fx.dashboardEvidence.reversals[1].id = 'tax_fixtureReversal1'; }],
    [() => { fx.dashboardEvidence.reversals[1].grossCents = 216; }, () => { fx.dashboardEvidence.reversals[1].grossCents = -216; }],
    [() => { fx.dashboardEvidence.original.grossCents = 2761; }, () => { fx.dashboardEvidence.original.grossCents = 2760; }],
    [() => { fx.dashboardEvidence.original.taxCents = 211; }, () => { fx.dashboardEvidence.original.taxCents = 210; }],
    [() => { fx.dashboardEvidence.artifactSha256 = 'invalid'; }, () => { fx.dashboardEvidence.artifactSha256 = 'b'.repeat(64); }],
  ];
  for (const [alter, restore] of cases) { alter(); const report = await fx.service.reconcile({ runId: RUN }); assert.equal(report.status, 'review'); assert.equal(report.readyToRecord, false); restore(); }
  assert.equal((await fx.db.query('SELECT * FROM provider_tax_rounding_entries')).rows.length, 0);
});

test('observed evidence remains fresh-snapshot scoped and changed artifact content cannot reuse an old report or silently alter posted evidence', async t => {
  const fx = await setup(t, { observed: true }); managedTaxUnavailable(fx); await fx.configure(); const report = await fx.service.reconcile({ runId: RUN });
  fx.dashboardEvidence.artifactSha256 = 'c'.repeat(64);
  await assert.rejects(fx.record(report), problem('TAX_FRESH_EVIDENCE_REQUIRED'));
  fx.dashboardEvidence.artifactSha256 = 'b'.repeat(64); await fx.record(report);
  fx.dashboardEvidence.artifactSha256 = 'c'.repeat(64);
  const changed = await fx.service.reconcile({ runId: RUN }); assert.equal(changed.status, 'review');
  assert.ok(changed.checks.some(item => item.code === 'IMMUTABLE_ROUNDING_EVIDENCE_CHANGED'));
  fx.dashboardEvidence.artifactSha256 = 'b'.repeat(64); fx.setTime('2026-10-20T12:00:01Z');
  const nightly = await fx.service.runNightly(); assert.equal(nightly.reports[0].status, 'review'); assert.equal(nightly.reports[0].readyToRecord, false);
  assert.ok(nightly.reports[0].checks.some(item => item.code === 'DASHBOARD_EVIDENCE_REFRESH_REQUIRED'));
  assert.equal(nightly.reports[0].provenance.freshTaxApiAudit, false); assert.equal(nightly.reports[0].totals.unaccountedVarianceCents, null);
  assert.equal(await fx.core(), fx.baseline);
});
