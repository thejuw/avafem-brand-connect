import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from './db.mjs';
import { createAuth } from './auth.mjs';
import { createProviderMoney } from './provider-money.mjs';
import { TEST_STORES } from './test-stores.mjs';
import { APPROVED_TEST_PLATFORM_SWITCH } from './provider-platform-switch.mjs';
import { SHOPIFY_ALLOWED_SCOPES, normalizeShopifyGrantedScopes } from './integrations/shopify-policy.mjs';

const RUN = 'uco_33e3eed7612b443d82655b1a4e07bb55';
const PLATFORM = APPROVED_TEST_PLATFORM_SWITCH.toAccountId;
const fail = (code, statusCode = 409) => { throw Object.assign(new Error('The fixed TEST readback exercise could not be verified. No provider mutation is authorized.'), { code, statusCode, unifiedSafe: true }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{8,100}$`).test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const money = value => {
  const raw = value?.shopMoney;
  if (raw?.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(raw.amount))) return null;
  const [whole, fraction = ''] = String(raw.amount).split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0')); return integer(amount) ? amount : null;
};
const SAFE_ERRORS = new Set(['STRIPE_REFUND_MISMATCH', 'STRIPE_TRANSFER_MISMATCH', 'STRIPE_PAYOUT_MISMATCH',
  'REFUND_UNCERTAIN', 'FAILURE_READBACK_BASELINE_REQUIRED', 'FAILURE_READBACK_SOURCE_CHANGED', 'FAILURE_READBACK_WRITER_FORBIDDEN',
  'FAILURE_READBACK_FAILED']);

export function guardReadbackAdapter(reads, counters) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method === 'symbol') return undefined;
    if (Object.hasOwn(reads, method)) return reads[method];
    return async () => { counters.forbiddenWrites++; fail('FAILURE_READBACK_WRITER_FORBIDDEN'); };
  } });
}

/** Provider snapshots are read once, then every injected failure executes the
 * real money service against private in-memory state and an in-memory PGlite.
 * This is not an induced provider failure or a new payment/refund/payout test.
 * No main runtime.withRun, canonical writer, valid webhook or provider writer
 * is reachable. Only an encrypted, minimal result report is persisted outside
 * the shadow. Raw upstream records and shopper data never enter that report.
 */
export async function createProviderFailureReadbacks(db, auth, { unifiedCheckout, stores, getStripe } = {}) {
  const runtime = unifiedCheckout?.runtime;
  if (!db?.query || !auth?.encrypt || !auth?.decrypt || !runtime?.read || !runtime?.decode
    || !stores?.row || !stores?.forShop || typeof getStripe !== 'function') fail('FAILURE_READBACK_SETUP_REQUIRED', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_failure_readback_reports (
    id TEXT PRIMARY KEY,report_encrypted TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  let running = false;

  async function sourceHashes() {
    const row = await runtime.read(RUN), decoded = runtime.decode(row), bagIds = decoded.snapshot?.bags?.map(bag => bag.id) ?? [];
    const records = {};
    for (const [table, clause] of [['orders', 'id=$1'], ['bags', 'order_id=$1']])
      records[table] = (await db.query(`SELECT * FROM ${table} WHERE ${clause} ORDER BY id`, [RUN])).rows;
    for (const table of ['refunds', 'transfers', 'credits', 'ledger_journals'])
      records[table] = (await db.query(`SELECT * FROM ${table} WHERE bag_id=ANY($1) ORDER BY id`, [bagIds])).rows;
    records.ledger_entries = (await db.query(`SELECT e.* FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id
      WHERE j.bag_id=ANY($1) ORDER BY e.id`, [bagIds])).rows;
    records.bookings = (await db.query('SELECT * FROM provider_money_bookings WHERE run_id=$1 ORDER BY business_key', [RUN])).rows;
    return { run: hash({ state: row.state, ...decoded }), financial: hash(records), row, ...decoded };
  }
  async function snapshotProviders(source, counters) {
    const { snapshot, details, row } = source;
    if (row.state !== 'completed' || snapshot.id !== RUN || snapshot.currency !== 'USD' || details.accountId !== PLATFORM
      || details.paymentVerified !== true || details.canonicalCommitted !== true || details.processingFeeRecorded !== true
      || !id(details.chargeId, 'ch') || !id(details.paymentIntentId, 'pi') || !integer(details.amounts?.totalCents)
      || !Array.isArray(snapshot.bags) || snapshot.bags.length !== 3 || new Set(snapshot.bags.map(bag => bag.shop)).size !== 3
      || snapshot.bags.some(bag => !TEST_STORES.some(store => store.shop === bag.shop))) fail('FAILURE_READBACK_BASELINE_REQUIRED');
    const real = getStripe();
    const reads = Object.fromEntries(['preflight', 'getCharge', 'getRefund', 'getTransfer', 'getPayout'].map(method => [method, async (...args) => {
      counters.providerReads++; return real[method](...args);
    }]));
    const stripe = guardReadbackAdapter(reads, counters);
    const checked = await stripe.preflight();
    if (checked?.verified !== true || checked.mode !== 'test' || checked.accountId !== PLATFORM) fail('FAILURE_READBACK_BASELINE_REQUIRED');
    const charge = await stripe.getCharge(details.chargeId);
    if (charge?.id !== details.chargeId || charge.livemode !== false || charge.currency !== 'usd'
      || charge.payment_intent !== details.paymentIntentId || charge.captured !== true || charge.paid !== true
      || charge.amount !== details.amounts.totalCents || !integer(charge.amount_refunded)) fail('FAILURE_READBACK_BASELINE_REQUIRED');
    const baseline = { checked, charge, bags: [] }; let refunded = 0;
    for (const identity of TEST_STORES) {
      const bag = snapshot.bags.find(bag => bag.shop === identity.shop), detail = details.bags?.[bag.id];
      const row = await stores.row(bag.shop), ops = Object.entries(detail?.refundOps ?? {});
      if (row?.brand_id !== bag.brandId || row.connected_account_created_in_test !== true || row.connected_account_verified !== true
        || !id(row.connected_account_id, 'acct') || detail?.verified !== true || bag.commissionBps !== 1500
        || ops.length !== 1 || detail.transferOp?.status !== 'verified' || detail.transferId !== detail.transferOp.id
        || detail.payoutOp?.status !== 'paid' || detail.payoutId !== detail.payoutOp.id) fail('FAILURE_READBACK_BASELINE_REQUIRED');
      const [operationId, op] = ops[0];
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId) || op.status !== 'complete' || op.stripeStatus !== 'succeeded'
        || op.shopifyVerified !== true || !id(op.stripeRefundId, 're') || !op.input || !Array.isArray(op.input.items)
        || !integer(op.amountCents) || !/^gid:\/\/shopify\/Refund\/\d+$/.test(op.shopifyRefundId ?? '')) fail('FAILURE_READBACK_BASELINE_REQUIRED');
      const refund = await stripe.getRefund(op.stripeRefundId), transfer = await stripe.getTransfer(detail.transferId);
      const payout = await stripe.getPayout(detail.payoutId, { accountId: row.connected_account_id });
      const original = await stores.forShop(bag.shop);
      const shopify = guardReadbackAdapter(Object.fromEntries(['preflight', 'getOrderOperations'].map(method => [method, async (...args) => {
        counters.providerReads++; return original[method](...args);
      }])), counters);
      const shop = await shopify.preflight(), scopes = normalizeShopifyGrantedScopes(shop.grantedScopes);
      if (shop.shop?.myshopifyDomain !== bag.shop || shop.shop.currencyCode !== 'USD'
        || scopes.length !== SHOPIFY_ALLOWED_SCOPES.length || SHOPIFY_ALLOWED_SCOPES.some(scope => !scopes.includes(scope))) fail('FAILURE_READBACK_BASELINE_REQUIRED');
      const order = await shopify.getOrderOperations(detail.orderId), native = order?.refunds?.find(value => value.id === op.shopifyRefundId);
      if (refund?.id !== op.stripeRefundId || refund.livemode === true || refund.currency !== 'usd' || refund.status !== 'succeeded'
        || refund.amount !== op.amountCents || refund.charge !== details.chargeId || refund.payment_intent !== details.paymentIntentId
        || refund.metadata?.bag_id !== bag.id || refund.metadata?.refund_id !== op.id
        || transfer?.id !== detail.transferId || transfer.livemode !== false || transfer.currency !== 'usd'
        || transfer.amount !== detail.transferOp.amountCents || transfer.destination !== row.connected_account_id
        || detail.transferOp.accountId !== row.connected_account_id || transfer.source_transaction !== details.chargeId
        || transfer.transfer_group !== `ORD_${RUN}` || payout?.id !== detail.payoutId || payout.livemode !== false
        || payout.currency !== 'usd' || payout.status !== 'paid' || payout.amount !== detail.payoutOp.amountCents
        || detail.payoutOp.accountId !== row.connected_account_id || order?.id !== detail.orderId || order.test !== true
        || order.sourceIdentifier !== bag.id || order.currencyCode !== 'USD' || order.operationsComplete !== true
        || !Array.isArray(order.tags) || !order.tags.includes('TEST_DO_NOT_SHIP') || money(native?.totalRefundedSet) !== op.amountCents)
        fail('FAILURE_READBACK_BASELINE_REQUIRED');
      refunded += refund.amount;
      baseline.bags.push({ bag, detail, operationId, op, refund, transfer, payout, order,
        store: { shop: bag.shop, brand_id: bag.brandId, connected_account_id: row.connected_account_id,
          connected_account_created_in_test: true, connected_account_verified: true, return_window_days: row.return_window_days } });
    }
    if (charge.amount_refunded !== refunded) fail('FAILURE_READBACK_BASELINE_REQUIRED');
    return baseline;
  }

  async function casesFor(source, baseline, counters) {
    const shadow = await createDatabase({ connectionString: null });
    try {
      await shadow.migrate();
      const shadowAuth = await createAuth(shadow, { sessionSecret: randomBytes(48).toString('hex'), encryptionKey: randomBytes(48).toString('hex') });
      await shadow.query('CREATE TABLE failure_shadow_journals (business_key TEXT,kind TEXT,entries JSONB)');
      await shadow.query('CREATE TABLE failure_shadow_events (type TEXT)');
      let local;
      const shadowRuntime = { withRun: async (runId, action) => {
        if (runId !== RUN) fail('FAILURE_READBACK_FAILED');
        const save = async (state = local.state, error = null) => { local.state = state; local.lastError = error; };
        try { await action({ snapshot: local.snapshot, details: local.details, get state() { return local.state; }, save,
          now: () => new Date(local.details.testClock?.now ?? Date.now()), wallNow: () => new Date(),
          journal: async (tx, key, kind, _bag, entries) => tx.query('INSERT INTO failure_shadow_journals VALUES($1,$2,$3)', [key, kind, JSON.stringify(entries)]),
          emit: async (tx, type) => tx.query('INSERT INTO failure_shadow_events VALUES($1)', [type]) });
        } catch (cause) { await save('needs_review', { code: SAFE_ERRORS.has(cause?.code) ? cause.code : 'FAILURE_READBACK_FAILED' }); }
        return { state: local.state, lastError: local.lastError };
      } };
      let fault = null;
      const reads = {
        preflight: async () => clone(baseline.checked),
        getCharge: async chargeId => { if (chargeId !== source.details.chargeId) fail('FAILURE_READBACK_FAILED'); const value = clone(baseline.charge); if (fault?.field === 'charge_live') value.livemode = true; if (fault?.field === 'charge_amount') value.amount++; return value; },
        getRefund: async refundId => {
          const value = clone(baseline.bags.find(value => value.refund.id === refundId)?.refund); if (!value) fail('FAILURE_READBACK_FAILED');
          if (value.id === fault?.refundId) {
            if (fault.field === 'refund_amount') value.amount++;
            if (fault.field === 'refund_currency') value.currency = 'eur';
            if (fault.field === 'refund_live') value.livemode = true;
            if (fault.field === 'refund_metadata') value.metadata.refund_id = 'prf_injected_wrong_binding';
          } return value;
        },
      };
      const stripe = guardReadbackAdapter(reads, counters);
      const localStores = guardReadbackAdapter({ row: async shop => clone(baseline.bags.find(value => value.bag.shop === shop)?.store),
        forShop: async shop => guardReadbackAdapter({ getOrderOperations: async orderId => clone(baseline.bags.find(value => value.bag.shop === shop && value.order.id === orderId)?.order) }, counters) }, counters);
      const moneyService = await createProviderMoney(shadow, shadowAuth, { runtime: shadowRuntime, stores: localStores, getStripe: () => stripe });
      const cases = [];
      for (const [index, bound] of baseline.bags.entries()) for (const field of ['refund_amount', 'refund_currency', 'refund_live', 'refund_metadata', 'charge_live', 'charge_amount', 'refund_id_unknown']) {
        local = { state: 'completed', snapshot: clone(source.snapshot), details: clone(source.details), lastError: null };
        const op = local.details.bags[bound.bag.id].refundOps[bound.operationId];
        op.status = 'refund_pending'; op.stripeStatus = 'pending';
        fault = { field, refundId: op.stripeRefundId };
        if (field === 'refund_id_unknown') { op.stripeRefundId = null; op.stripeStartedAt ||= new Date().toISOString(); }
        const before = counters.forbiddenWrites;
        const result = await moneyService.refund({ runId: RUN, bagId: bound.bag.id, operationId: bound.operationId,
          items: clone(op.input.items), refundShipping: op.input.refundShipping === true });
        const unknown = field === 'refund_id_unknown', observedCode = result.lastError?.code ?? null;
        const observedState = local.details.bags[bound.bag.id].refundOps[bound.operationId].status;
        cases.push({ caseId: `store_${[2, 4, 6][index]}_${field}`, expectedCode: unknown ? null : 'STRIPE_REFUND_MISMATCH',
          observedCode, expectedState: unknown ? 'refund_uncertain' : null, observedState: unknown ? observedState : null,
          pass: (unknown ? !observedCode && observedState === 'refund_uncertain' : observedCode === 'STRIPE_REFUND_MISMATCH')
            && counters.forbiddenWrites === before, forbiddenWriteAttempts: counters.forbiddenWrites - before });
      }
      return cases;
    } finally { await shadow.close(); }
  }

  async function run(input = {}) {
    if (Object.keys(input).some(key => key !== 'confirmTest') || input.confirmTest !== true) fail('FAILURE_READBACK_CONFIRMATION_REQUIRED', 422);
    if (running) fail('FAILURE_READBACK_BUSY'); running = true;
    const counters = { providerReads: 0, forbiddenWrites: 0 }, report = { id: `frb_${randomUUID().replaceAll('-', '')}`,
      source: 'real_provider_snapshot_with_local_injected_fault', test: true, fullAcceptancePassed: false,
      realProviderFailureExecuted: false, scope: 'existing_main_readbacks_shadow_only', providerMutations: 0,
      supportedFaults: ['refund_readback_mismatch', 'parent_charge_mismatch', 'unknown_refund_id_hold'],
      unsupportedFaults: ['transfer_fault_injection', 'payout_fault_injection'], cases: [], checkedAt: new Date().toISOString() };
    let before;
    try {
      before = await sourceHashes(); const baseline = await snapshotProviders(before, counters);
      report.cases = await casesFor(before, baseline, counters);
    } catch (cause) { report.errorCode = SAFE_ERRORS.has(cause?.code) ? cause.code : 'FAILURE_READBACK_FAILED'; }
    try {
      const after = await sourceHashes(); report.sourceRunUnchanged = Boolean(before && after.run === before.run);
      report.sourceFinancialRowsUnchanged = Boolean(before && after.financial === before.financial);
    } catch { report.sourceRunUnchanged = false; report.sourceFinancialRowsUnchanged = false; }
    report.providerReads = counters.providerReads; report.forbiddenWriteAttempts = counters.forbiddenWrites;
    report.summary = { total: report.cases.length, passed: report.cases.filter(value => value.pass).length, failed: report.cases.filter(value => !value.pass).length };
    report.status = !report.errorCode && report.summary.total === 21 && report.summary.failed === 0 && !counters.forbiddenWrites
      && report.sourceRunUnchanged && report.sourceFinancialRowsUnchanged ? 'passed_local_injected_guards' : 'review';
    try { await db.query('INSERT INTO provider_failure_readback_reports(id,report_encrypted) VALUES($1,$2)', [report.id, auth.encrypt(report)]); }
    finally { running = false; }
    return report;
  }
  async function get({ reportId } = {}) {
    if (!/^frb_[a-f0-9]{32}$/.test(reportId ?? '')) fail('FAILURE_READBACK_NOT_FOUND', 404);
    const row = (await db.query('SELECT report_encrypted FROM provider_failure_readback_reports WHERE id=$1', [reportId])).rows[0];
    if (!row) fail('FAILURE_READBACK_NOT_FOUND', 404); return auth.decrypt(row.report_encrypted);
  }
  return { run, get };
}
