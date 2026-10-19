import { createHash, randomUUID } from 'node:crypto';
import { STRIPE_TAX_VALIDATION_FIELDS } from './integrations/stripe.mjs';

export const PLATFORM_TAX_ROUNDING_POLICY = Object.freeze({
  id: 'shopify_native_platform_rounding_test_v1',
  accountId: 'acct_1U74iQGgawRtH2qe',
  runIds: Object.freeze(['uco_33e3eed7612b443d82655b1a4e07bb55', 'uco_240916a4109e44c38252610a5df298e9']),
  maxAbsoluteCentsPerRefund: 1,
});
const SCOPE = 'separate_platform_rounding_subledger_only';
const DIFFERENCE = 'platform_tax_rounding_difference', CONTROL = 'platform_tax_rounding_control';
const integer = value => Number.isSafeInteger(value);
const nonnegative = value => integer(value) && value >= 0;
const providerId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{8,100}$`).test(value);
const gid = (value, type) => typeof value === 'string' && new RegExp(`^gid://shopify/${type}/[0-9]{1,40}$`).test(value);
const safeOperation = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
// Request IDs identify individual GET attempts, not the economic evidence.
// They remain in authenticated encrypted reports but must not make unchanged
// frozen Dashboard evidence impossible to compare on a fresh read.
const semanticChecks = checks => checks.map(({ requestId: ignoredRequestId, ...check }) => check);
const reportDigest = report => {
  const { id: ignoredId, checkedAt: ignoredTime, reportHash: ignoredHash, ...stable } = report;
  return hash({ ...stable, checks: semanticChecks(stable.checks) });
};
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const money = value => {
  const raw = value?.shopMoney;
  if (raw?.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(raw.amount))) return null;
  const [whole, fraction = ''] = String(raw.amount).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return nonnegative(cents) ? cents : null;
};
const sum = values => { const total = values.reduce((result, value) => result + value, 0); return integer(total) ? total : null; };
const signedAccounts = value => value < 0 ? { debitAccount: CONTROL, creditAccount: DIFFERENCE } : { debitAccount: DIFFERENCE, creditAccount: CONTROL };

/**
 * Existing TEST records only. Provider access is GET-only. This is a separate
 * balanced memo/control subledger, NOT a cash repair, tax filing, tax-payable
 * reclassification, expense determination, or production acceptance decision.
 * TaxTransaction.reference is custom: absent exact PI/refund references require
 * independently accepted, immutable operator evidence, never amount matching.
 */
export async function createProviderTaxReconciliation(db, auth, {
  unifiedCheckout, stores, getStripe, verifyOperatorEvidence = async () => false,
  getObservedTaxEvidence = async () => null, clock = () => new Date(),
} = {}) {
  const runtime = unifiedCheckout?.runtime, policy = PLATFORM_TAX_ROUNDING_POLICY;
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !runtime?.read || !runtime?.decode || !runtime?.withRun
    || !stores?.row || !stores?.forShop || typeof getStripe !== 'function' || typeof verifyOperatorEvidence !== 'function'
    || typeof getObservedTaxEvidence !== 'function')
    fail('TAX_RECONCILIATION_SETUP_REQUIRED', 'An encrypted run runtime and bound read adapters are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_tax_bindings (
    run_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,binding_hash TEXT NOT NULL UNIQUE,
    evidence_hash TEXT NOT NULL,binding_encrypted TEXT NOT NULL,nightly_claimed_date DATE,last_alert_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_tax_reports (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES provider_tax_bindings(run_id),binding_hash TEXT NOT NULL,
    report_hash TEXT NOT NULL,evidence_hash TEXT NOT NULL,status TEXT NOT NULL,report_encrypted TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_tax_rounding_entries (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES provider_tax_bindings(run_id),report_id TEXT NOT NULL REFERENCES provider_tax_reports(id),
    refund_id TEXT NOT NULL UNIQUE,tax_reversal_id TEXT NOT NULL UNIQUE,business_key TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL,source_report_hash TEXT NOT NULL,policy_id TEXT NOT NULL,
    signed_variance_cents INTEGER NOT NULL CHECK(abs(signed_variance_cents)<=1),
    debit_account TEXT NOT NULL CHECK(debit_account IN ('platform_tax_rounding_difference','platform_tax_rounding_control')),
    credit_account TEXT NOT NULL CHECK(credit_account IN ('platform_tax_rounding_difference','platform_tax_rounding_control')),
    amount_cents INTEGER NOT NULL CHECK(amount_cents=abs(signed_variance_cents)),
    evidence_hash TEXT NOT NULL,entry_encrypted TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK(debit_account<>credit_account)
  )`);
  const now = () => { const value = new Date(clock()); if (!Number.isFinite(value.getTime())) fail('TAX_CLOCK_INVALID', 'A valid wall-clock observation is required.', 503); return value; };
  const approvedRun = runId => { if (!policy.runIds.includes(runId)) fail('TAX_RUN_NOT_AUTHORIZED', 'This policy covers only the two explicitly approved existing test runs.', 422); };
  async function readBinding(runId, tx = db) {
    const row = (await tx.query('SELECT * FROM provider_tax_bindings WHERE run_id=$1', [runId])).rows[0];
    if (!row) fail('TAX_BINDING_REQUIRED', 'Configure the exact immutable Tax transaction mapping first.');
    let binding; try { binding = auth.decrypt(row.binding_encrypted); } catch { fail('TAX_BINDING_UNREADABLE', 'The immutable mapping cannot be verified.'); }
    if (hash(binding) !== row.binding_hash || binding.runId !== runId || row.account_id !== policy.accountId || row.policy_id !== policy.id)
      fail('TAX_BINDING_CHANGED', 'The immutable mapping audit does not verify.');
    return { row, binding };
  }
  async function withRun(runId, action) {
    approvedRun(runId); let executed = false, result, problem;
    // Catch INSIDE the existing lease: a tax audit must not change cash run state.
    await runtime.withRun(runId, async ctx => {
      executed = true;
      try { result = await action(ctx); }
      catch (cause) { problem = cause?.unifiedSafe ? cause : Object.assign(new Error('Tax evidence could not be safely verified.'), { code: 'TAX_EVIDENCE_UNAVAILABLE', statusCode: 409, unifiedSafe: true }); }
    });
    if (!executed) fail('TAX_RUN_BUSY', 'The run is being processed; retry the read after its lease is released.');
    if (problem) throw problem;
    return result;
  }
  async function captureLease(ctx) {
    const row = await runtime.read(ctx.snapshot.id);
    const frozenHash = hash({ snapshot: ctx.snapshot, details: ctx.details });
    if (typeof row?.lock_token !== 'string' || !row.lock_token || !(new Date(row.lease_until) > now())
      || hash(runtime.decode(row)) !== frozenHash) fail('TAX_LEASE_LOST', 'The original run lease and immutable context must verify.');
    return { runId: ctx.snapshot.id, token: row.lock_token, frozenHash, startedAt: Date.now() };
  }
  async function assertLease(guard, tx) {
    const row = tx ? (await tx.query('SELECT * FROM unified_checkout_runs WHERE id=$1 FOR UPDATE', [guard.runId])).rows[0] : await runtime.read(guard.runId);
    if (!row || row.lock_token !== guard.token || !(new Date(row.lease_until) > now()) || Date.now() - guard.startedAt > 240_000
      || hash(runtime.decode(row)) !== guard.frozenHash) fail('TAX_LEASE_LOST', 'The run lease expired or immutable context changed; no new rounding record was authorized.');
  }
  async function configureEvidence({ runId, originalTaxTransactionId, refunds, binding: proof } = {}) {
    approvedRun(runId);
    if (!providerId(originalTaxTransactionId, 'tax') || !Array.isArray(refunds) || !refunds.length || refunds.length > 20
      || refunds.some(item => !providerId(item?.refundId, 're') || !providerId(item?.taxTransactionId, 'tax') || item.taxTransactionId === originalTaxTransactionId)
      || new Set(refunds.map(item => item.refundId)).size !== refunds.length || new Set(refunds.map(item => item.taxTransactionId)).size !== refunds.length)
      fail('TAX_MAPPING_INVALID', 'Exact unique existing refund and Tax transaction IDs are required.', 422);
    if (!proof || !['api_reference', 'operator_dashboard'].includes(proof.kind)) fail('TAX_BINDING_PROOF_REQUIRED', 'Specify the provenance of the explicit mapping.', 422);
    const audit = proof.kind === 'api_reference' ? { kind: 'api_reference' } : {
      kind: 'operator_dashboard', artifactRef: proof.artifactRef, evidenceSha256: proof.evidenceSha256, confirmedByOwner: proof.confirmedByOwner,
    };
    if (audit.kind === 'operator_dashboard' && (audit.confirmedByOwner !== true || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(?:json|png|jpe?g|pdf)$/.test(audit.artifactRef ?? '')
      || !/^[a-f0-9]{64}$/.test(audit.evidenceSha256 ?? '')))
      fail('TAX_BINDING_PROOF_REQUIRED', 'A bounded evidence artifact name, SHA256 and explicit owner confirmation are required.', 422);
    const mapping = { runId, accountId: policy.accountId, policyId: policy.id, originalTaxTransactionId,
      refunds: refunds.map(({ refundId, taxTransactionId }) => ({ refundId, taxTransactionId })).sort((a, b) => a.refundId.localeCompare(b.refundId)), binding: audit };
    const bindingHash = hash(mapping), evidenceHash = hash(audit);
    return withRun(runId, async ctx => {
      if (ctx.snapshot?.id !== runId || ctx.details?.accountId !== policy.accountId || ctx.details.paymentVerified !== true
        || ctx.details.canonicalCommitted !== true || !providerId(ctx.details.chargeId, 'ch') || !providerId(ctx.details.paymentIntentId, 'pi'))
        fail('TAX_CAPTURED_RUN_REQUIRED', 'The existing captured test run and platform must verify before binding.');
      const known = Object.values(ctx.details.bags ?? {}).flatMap(value => Object.values(value.refundOps ?? {})).map(op => op.stripeRefundId).filter(Boolean).sort();
      if (known.length !== mapping.refunds.length || known.some((value, index) => value !== mapping.refunds[index].refundId))
        fail('TAX_REFUND_COVERAGE_REQUIRED', 'The explicit mapping must cover every known existing refund exactly.');
      return db.transaction(async tx => {
        await tx.query(`INSERT INTO provider_tax_bindings(run_id,account_id,policy_id,binding_hash,evidence_hash,binding_encrypted)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO NOTHING`, [runId, policy.accountId, policy.id, bindingHash, evidenceHash, auth.encrypt(mapping)]);
        const prior = await readBinding(runId, tx);
        if (prior.row.binding_hash !== bindingHash) fail('TAX_BINDING_IMMUTABLE', 'An existing mapping cannot be overwritten; keep its original audit.');
        return { runId, bindingHash, evidenceHash, policyId: policy.id, immutable: true, test: true, fullAcceptancePassed: false };
      });
    });
  }

  function taxProjection(transaction, list, expectedId, type, add, label) {
    const valid = transaction?.id === expectedId && transaction.object === 'tax.transaction' && transaction.livemode === false
      && transaction.currency === 'usd' && transaction.type === type;
    add(`${label}:identity`, valid, 'TAX_TRANSACTION_IDENTITY');
    const complete = list?.object === 'list' && list.has_more === false && list.url === `/v1/tax/transactions/${expectedId}/line_items`
      && Array.isArray(list.data) && list.data.length <= 1000;
    add(`${label}:complete_lines`, complete, 'COMPLETE_TAX_LINE_PAGINATION_REQUIRED');
    if (!valid || !complete) return null;
    const direction = type === 'transaction' ? 1 : -1, seen = new Set(), lines = [];
    for (const line of list.data) {
      const okay = providerId(line?.id, 'tax_li') && !seen.has(line.id) && line.object === 'tax.transaction_line_item'
        && line.livemode === false && line.type === type && integer(line.amount) && integer(line.amount_tax)
        && line.amount * direction >= 0 && line.amount_tax * direction >= 0 && Number.isFinite(line.quantity) && line.quantity > 0
        && ['inclusive', 'exclusive'].includes(line.tax_behavior)
        && (type === 'transaction' ? !line.reversal : providerId(line.reversal?.original_line_item, 'tax_li'));
      add(`${label}:line_${lines.length}`, okay, 'TAX_LINE_IDENTITY_SIGN_OR_PROVENANCE');
      if (!okay) return null;
      seen.add(line.id); lines.push({ id: line.id, amountCents: line.amount, taxCents: line.amount_tax, quantity: line.quantity,
        taxBehavior: line.tax_behavior, originalLineItemId: line.reversal?.original_line_item ?? null });
    }
    const shipping = transaction.shipping_cost;
    const shippingValid = shipping === null || (shipping && integer(shipping.amount) && integer(shipping.amount_tax)
      && shipping.amount * direction >= 0 && shipping.amount_tax * direction >= 0 && ['inclusive', 'exclusive'].includes(shipping.tax_behavior));
    add(`${label}:shipping`, Boolean(shippingValid), 'TAX_SHIPPING_SIGN_OR_BEHAVIOR');
    if (!shippingValid) return null;
    const components = [...lines, ...(shipping ? [{ amountCents: shipping.amount, taxCents: shipping.amount_tax, taxBehavior: shipping.tax_behavior }] : [])];
    const grossCents = sum(components.map(value => value.amountCents + (value.taxBehavior === 'exclusive' ? value.taxCents : 0)));
    const taxCents = sum(components.map(value => value.taxCents));
    add(`${label}:integer_totals`, integer(grossCents) && integer(taxCents), 'EXACT_TAX_CENTS_REQUIRED');
    if (!integer(grossCents) || !integer(taxCents)) return null;
    return { id: expectedId, type, grossCents, taxCents, lines,
      originalTransactionId: transaction.reversal?.original_transaction ?? null,
      shipping: shipping ? { amountCents: shipping.amount, taxCents: shipping.amount_tax, taxBehavior: shipping.tax_behavior } : null };
  }
  async function inspect(ctx, mapping) {
    const { snapshot, details } = ctx, checks = [], evidence = { mappingHash: hash(mapping), taxes: [], refunds: [], native: [] };
    const report = { id: `taxrecon_${randomUUID().replaceAll('-', '')}`, runId: mapping.runId, policyId: policy.id, accountId: policy.accountId,
      bindingHash: hash(mapping), checkedAt: now().toISOString(), originalTaxTransactionId: mapping.originalTaxTransactionId,
      provenance: { configured: mapping.binding.kind, source: 'native_tax_api', observationMode: 'live_tax_api', operatorEvidenceAccepted: false, apiReferenceProof: false,
        dashboardSnapshotOnly: false, taxLineApiAvailable: true, mappingScope: 'explicit_existing_records_not_provider_wide_discovery' },
      refunds: [], checks, totals: { originalGrossCents: null, originalStripeTaxCents: null, originalShopifyTaxCents: null, originalAllocatedTaxCents: details.amounts?.taxCents ?? null,
        refundCashCents: 0, stripeReversedTaxCents: 0, shopifyRefundTaxCents: 0, rawVarianceCents: 0, recordedPlatformVarianceCents: 0, unaccountedVarianceCents: 0 },
      fullAcceptancePassed: false, test: true, scope: SCOPE, providerWrites: 0, coreAccountingMutations: 0 };
    const add = (name, okay, code, values = {}) => checks.push({ name, status: okay ? 'matched' : 'review', ...(okay ? {} : { code }), ...values });
    const sameCents = (name, expected, actual) => add(name, integer(expected) && actual === expected, 'EXACT_CENT_MISMATCH', { expectedCents: integer(expected) ? expected : null, actualCents: integer(actual) ? actual : null,
      differenceCents: integer(expected) && integer(actual) ? actual - expected : null });
    const read = async (name, fn) => {
      try { return await fn(); }
      catch (cause) {
        // Diagnostic identifiers only. Never retain an upstream message/body,
        // customer fields, arbitrary metadata, or raw credential-like values.
        const safeCode = value => new Set(['STRIPE_REQUEST_FAILED','STRIPE_MODE_MISMATCH','STRIPE_TAX_READBACK_MISMATCH','STRIPE_MANAGED_TAX_READ_UNAVAILABLE',
          'STRIPE_TAX_PAGINATION_REQUIRED','INTEGRATION_UNAVAILABLE','INVALID_INTEGRATION_INPUT','SHOPIFY_REQUEST_FAILED',
          'SHOPIFY_ORDER_MISMATCH','SHOPIFY_PAGINATION_REQUIRED']).has(value) ? value : undefined;
        const providerCode = safeCode(cause?.code);
        const stripeCode = ['resource_missing', 'parameter_unknown', 'invalid_request_error', 'permission_error', 'api_key_expired', 'account_invalid', 'rate_limit'].includes(cause?.details?.stripeCode) ? cause.details.stripeCode : undefined;
        const requestId = /^req_[A-Za-z0-9]{1,80}$/.test(cause?.details?.requestId ?? '') ? cause.details.requestId : undefined;
        const allowedFields = new Set([...STRIPE_TAX_VALIDATION_FIELDS,'id','object','livemode','currency','type','reference','timestamps','reversal','shipping_cost','line_items','page','line','line_id','line_object','line_livemode','line_amount','line_quantity','line_reference','line_tax_behavior','line_tax_code','line_type','line_reversal']);
        const validationFields = Array.isArray(cause?.details?.validationFields) ? cause.details.validationFields.filter(value => allowedFields.has(value)).slice(0, 22) : [];
        add(name, false, 'PROVIDER_READ_UNAVAILABLE', { ...(providerCode ? { providerCode } : {}), ...(stripeCode ? { stripeCode } : {}),
          ...(requestId ? { requestId } : {}), ...(validationFields.length ? { validationFields } : {}) });
        return null;
      }
    };
    const complete = () => {
      report.evidenceHash = hash(evidence);
      report.reviewCount = checks.filter(check => check.status === 'review').length;
      const amountsComplete = report.refunds.length === mapping.refunds.length && report.refunds.every(refund => nonnegative(refund.stripeTaxCents) && nonnegative(refund.shopifyTaxCents))
        && checks.filter(check => check.status === 'review').every(check => ['PLATFORM_ROUNDING_OUTLIER', 'IMMUTABLE_ROUNDING_EVIDENCE_CHANGED'].includes(check.code));
      if (!amountsComplete) {
        report.totals.refundCashCents = null; report.totals.stripeReversedTaxCents = null; report.totals.shopifyRefundTaxCents = null;
        report.totals.rawVarianceCents = null; report.totals.unaccountedVarianceCents = null;
      } else {
        report.totals.rawVarianceCents = report.totals.stripeReversedTaxCents - report.totals.shopifyRefundTaxCents;
        report.totals.unaccountedVarianceCents = report.totals.rawVarianceCents - report.totals.recordedPlatformVarianceCents;
      }
      report.readyToRecord = report.reviewCount === 0 && report.refunds.some(refund => refund.signedVarianceCents !== 0 && !refund.recorded);
      report.status = report.reviewCount ? 'review' : report.totals.unaccountedVarianceCents !== 0 ? 'unrecorded_platform_variance'
        : report.refunds.some(refund => refund.signedVarianceCents !== 0) ? 'reconciled_platform_rounding' : 'matched';
      report.reportHash = reportDigest(report); return report;
    };
    add('captured_run', snapshot?.id === mapping.runId && details.accountId === policy.accountId && details.paymentVerified === true && details.canonicalCommitted === true
      && snapshot.currency === 'USD' && Array.isArray(snapshot.bags) && snapshot.bags.length === 3, 'CAPTURED_TEST_RUN_REQUIRED');
    const stripe = getStripe();
    const preflight = await read('stripe_platform_read', () => stripe.preflight());
    const platformValid = preflight?.verified === true && preflight.mode === 'test' && preflight.accountId === policy.accountId;
    add('stripe_platform', platformValid, 'APPROVED_TEST_PLATFORM_REQUIRED');
    if (!platformValid || checks.some(value => value.status !== 'matched')) return complete();
    const charge = await read('stripe_charge_read', () => stripe.getCharge(details.chargeId));
    const chargeValid = charge?.id === details.chargeId && charge.livemode === false && charge.currency === 'usd' && charge.payment_intent === details.paymentIntentId
      && charge.paid === true && charge.captured === true && charge.amount === details.amounts?.totalCents;
    add('stripe_charge_identity', chargeValid, 'LINKED_TEST_CHARGE_REQUIRED');
    if (!chargeValid) return complete();
    evidence.charge = { id: charge.id, paymentIntentId: charge.payment_intent, amountCents: charge.amount, refundedCents: charge.amount_refunded };
    let operatorAccepted = false;
    if (mapping.binding.kind === 'operator_dashboard') {
      try { operatorAccepted = await verifyOperatorEvidence(structuredClone(mapping.binding), structuredClone(mapping)) === true; } catch { /* fail closed */ }
    }
    report.provenance.operatorEvidenceAccepted = operatorAccepted;
    const referenceProof = (transaction, expected, label, source = 'api') => {
      const reference = transaction?.reference;
      const exact = reference === expected;
      const conflicting = typeof reference === 'string' && /^(?:pi|re|cs_test)_[A-Za-z0-9]+$/.test(reference) && !exact;
      const valid = !conflicting && (exact || operatorAccepted);
      add(`${label}:binding_provenance`, valid, conflicting ? 'CONFLICTING_API_REFERENCE' : 'INDEPENDENT_TAX_BINDING_REQUIRED');
      evidence[`${label}Reference`] = { referenceHash: hash(reference ?? null), expectedId: expected, exactApiReference: exact && source === 'api',
        operatorEvidenceAccepted: !exact && operatorAccepted, source };
      return exact && source === 'api';
    };
    const originalTransaction = await read('original_tax_read', () => stripe.getTaxTransaction(mapping.originalTaxTransactionId));
    let observed = null, original;
    if (originalTransaction === null) {
      let candidate;
      // Only the adapter's exact managed-record rejection permits this
      // separately authorized snapshot source. Credential/mode/malformed/read
      // errors NEVER become permission to substitute observed evidence.
      if (checks.find(check => check.name === 'original_tax_read')?.providerCode === 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE') {
        try { candidate = await getObservedTaxEvidence(structuredClone(mapping)); } catch { /* root evidence reader must fail closed */ }
      }
      if (candidate) {
        const sourceValid = candidate.source === 'operator_verified_dashboard' && candidate.runId === mapping.runId
          && candidate.accountId === policy.accountId && candidate.test === true
          && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(?:json|png|jpe?g|pdf)$/.test(candidate.artifactRef ?? '')
          && /^[a-f0-9]{64}$/.test(candidate.artifactSha256 ?? '')
          && candidate.apiLimitation?.kind === 'stripe_managed_tax_not_retrievable' && /^req_[A-Za-z0-9]{1,80}$/.test(candidate.apiLimitation?.requestId ?? '')
          && candidate.original?.id === mapping.originalTaxTransactionId && candidate.original.reference === details.paymentIntentId
          && nonnegative(candidate.original.grossCents) && nonnegative(candidate.original.taxCents) && candidate.original.taxCents <= candidate.original.grossCents
          && Array.isArray(candidate.reversals) && candidate.reversals.length === mapping.refunds.length
          && new Set(candidate.reversals.map(item => item?.id)).size === candidate.reversals.length
          && candidate.reversals.every(item => mapping.refunds.some(mapped => mapped.taxTransactionId === item?.id && mapped.refundId === item.reference)
            && integer(item.grossCents) && item.grossCents < 0 && integer(item.taxCents) && item.taxCents <= 0 && item.taxCents >= item.grossCents);
        add('dashboard_evidence_identity', sourceValid, 'VERIFIED_DASHBOARD_EVIDENCE_REQUIRED');
        if (sourceValid) {
          observed = { source: candidate.source, runId: candidate.runId, accountId: candidate.accountId, test: true,
            observedAt: candidate.observedAt, artifactRef: candidate.artifactRef, artifactSha256: candidate.artifactSha256,
            apiLimitation: { kind: candidate.apiLimitation.kind, requestId: candidate.apiLimitation.requestId },
            original: { id: candidate.original.id, reference: candidate.original.reference, grossCents: candidate.original.grossCents, taxCents: candidate.original.taxCents },
            reversals: candidate.reversals.map(item => ({ id: item.id, reference: item.reference, grossCents: item.grossCents, taxCents: item.taxCents })).sort((a, b) => a.id.localeCompare(b.id)) };
          const observedTime = new Date(observed.observedAt).getTime(), age = now().getTime() - observedTime;
          add('dashboard_snapshot_freshness', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observed.observedAt ?? '')
            && Number.isFinite(observedTime) && age >= -60_000 && age <= 86_400_000, 'DASHBOARD_EVIDENCE_REFRESH_REQUIRED');
          for (const check of checks.filter(value => value.name === 'original_tax_read')) check.status = 'unavailable';
          checks.push({ name: 'original_tax_line_item_api', status: 'unavailable', code: 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE' });
          report.provenance = { ...report.provenance, source: 'operator_verified_dashboard', dashboardSnapshotOnly: true,
            observationMode: 'frozen_snapshot_not_live_tax_api', taxLineApiAvailable: false, freshTaxApiAudit: false, parentProof: 'refund_charge_payment_intent_to_dashboard_tax_reference',
            observedAt: observed.observedAt, artifactRef: observed.artifactRef, artifactSha256: observed.artifactSha256 };
          report.limitations = ['Stripe-managed Tax records are unavailable through this Tax API; no Tax line-item or native original_transaction proof is claimed.',
            'Tax amounts are a root-verified immutable Dashboard snapshot, not live or automated Tax-provider readback; refresh is required after 24 hours.'];
          evidence.observedTaxSnapshot = observed;
          original = { source: observed.source, id: observed.original.id, grossCents: observed.original.grossCents, taxCents: observed.original.taxCents };
        }
      }
    } else {
      const originalLines = await read('original_tax_lines_read', () => stripe.listTaxTransactionLineItems(mapping.originalTaxTransactionId));
      original = taxProjection(originalTransaction, originalLines, mapping.originalTaxTransactionId, 'transaction', add, 'original_tax');
    }
    if (!original) return complete();
    if (!observed) add('original_tax:not_reversal', original.originalTransactionId === null, 'ORIGINAL_TAX_TRANSACTION_REQUIRED');
    const originalApi = referenceProof(observed?.original ?? originalTransaction, details.paymentIntentId, 'original_tax', observed ? 'operator_verified_dashboard' : 'api');
    evidence.taxes.push(original);
    report.totals.originalGrossCents = original.grossCents; report.totals.originalStripeTaxCents = original.taxCents;
    sameCents('original_tax_gross', charge.amount, original.grossCents); sameCents('original_tax_total', details.amounts?.taxCents, original.taxCents);
    const operations = snapshot.bags.flatMap(bag => Object.values(details.bags?.[bag.id]?.refundOps ?? {}).map(op => ({ bag, value: details.bags[bag.id], op })));
    const expected = operations.filter(({ op }) => op.stripeRefundId);
    add('known_refund_outcomes', operations.every(({ op }) => op.stripeRefundId || (!op.stripeStartedAt && !op.amountCents)), 'UNKNOWN_REFUND_OUTCOME');
    add('refund_mapping_coverage', expected.length === mapping.refunds.length && new Set(expected.map(({ op }) => op.stripeRefundId)).size === expected.length
      && expected.every(({ op }) => mapping.refunds.some(item => item.refundId === op.stripeRefundId)), 'EXACT_REFUND_MAPPING_REQUIRED');
    const nativeOrders = new Map(), nativeOriginalTaxes = new Map(), originalLineTotals = new Map((original.lines ?? []).map(line => [line.id, { amountCents: 0, taxCents: 0 }]));
    let shippingReversedAmount = 0, shippingReversedTax = 0, allApi = originalApi;
    for (const mapped of mapping.refunds) {
      const found = expected.find(({ op }) => op.stripeRefundId === mapped.refundId);
      if (!found) { add(`${mapped.refundId}:known_operation`, false, 'KNOWN_REFUND_REQUIRED'); continue; }
      const { bag, value, op } = found;
      const label = mapped.refundId;
      const result = { refundId: mapped.refundId, taxTransactionId: mapped.taxTransactionId, shopifyRefundId: op.shopifyRefundId ?? op.sourceShopifyRefundId ?? null,
        bagId: bag.id, operationId: op.id, refundCashCents: op.amountCents, stripeTaxCents: null, shopifyTaxCents: null, signedVarianceCents: null,
        recorded: false, recordedVarianceCents: 0, evidenceHash: null };
      report.refunds.push(result);
      add(`${label}:complete_operation`, op.status === 'complete' && op.stripeStatus === 'succeeded' && op.shopifyVerified === true
        && providerId(op.id, 'prf') && gid(result.shopifyRefundId, 'Refund') && nonnegative(op.amountCents) && nonnegative(op.taxCents), 'COMPLETE_NATIVE_REFUND_REQUIRED');
      const refund = await read(`${label}:stripe_read`, () => stripe.getRefund(mapped.refundId));
      const refundValid = refund?.id === mapped.refundId && refund.livemode !== true && refund.currency === 'usd' && refund.charge === charge.id
        && refund.payment_intent === details.paymentIntentId && refund.status === 'succeeded' && refund.amount === op.amountCents
        && refund.metadata?.bag_id === bag.id && refund.metadata?.refund_id === op.id;
      add(`${label}:stripe_identity`, refundValid, 'LINKED_SUCCEEDED_REFUND_REQUIRED');
      const observedReversal = observed?.reversals.find(item => item.id === mapped.taxTransactionId);
      const transaction = observedReversal ?? await read(`${label}:tax_read`, () => stripe.getTaxTransaction(mapped.taxTransactionId));
      const lines = observed ? null : await read(`${label}:tax_lines_read`, () => stripe.listTaxTransactionLineItems(mapped.taxTransactionId));
      const reversal = observedReversal ? { source: observed.source, id: observedReversal.id, grossCents: observedReversal.grossCents, taxCents: observedReversal.taxCents }
        : taxProjection(transaction, lines, mapped.taxTransactionId, 'reversal', add, `${label}:tax`);
      if (reversal) {
        if (!observed) add(`${label}:tax_original`, reversal.originalTransactionId === original.id, 'TAX_REVERSAL_PARENT_MISMATCH');
        allApi = referenceProof(transaction, mapped.refundId, `${label}:tax`, observed ? 'operator_verified_dashboard' : 'api') && allApi;
        sameCents(`${label}:tax_refund_cash`, op.amountCents, -reversal.grossCents);
        for (const line of reversal.lines ?? []) {
          const source = original.lines.find(item => item.id === line.originalLineItemId);
          add(`${label}:tax_line_parent_${line.id}`, Boolean(source) && source.taxBehavior === line.taxBehavior, 'TAX_REVERSAL_LINE_PARENT_MISMATCH');
          if (source) { const total = originalLineTotals.get(source.id); total.amountCents -= line.amountCents; total.taxCents -= line.taxCents; }
        }
        if (reversal.shipping) { shippingReversedAmount -= reversal.shipping.amountCents; shippingReversedTax -= reversal.shipping.taxCents; }
        if (!observed) add(`${label}:tax_shipping_behavior`, !reversal.shipping || Boolean(original.shipping && original.shipping.taxBehavior === reversal.shipping.taxBehavior), 'TAX_SHIPPING_BEHAVIOR_MISMATCH');
        result.stripeTaxCents = -reversal.taxCents; evidence.taxes.push(reversal);
      }
      const row = await read(`${label}:store_binding_read`, () => stores.row(bag.shop));
      add(`${label}:store_binding`, row?.brand_id === bag.brandId, 'IMMUTABLE_STORE_BINDING_REQUIRED');
      if (!nativeOrders.has(bag.id)) {
        const adapter = await read(`${label}:store_adapter_read`, () => stores.forShop(bag.shop));
        nativeOrders.set(bag.id, adapter ? await read(`${label}:native_order_read`, () => adapter.getOrderOperations(value.orderId)) : null);
        const nativeOriginal = adapter ? await read(`${label}:native_original_read`, () => adapter.getOrderDetails(value.orderId)) : null;
        const originalValid = nativeOriginal?.id === value.orderId && nativeOriginal.test === true && nativeOriginal.sourceIdentifier === bag.id
          && money(nativeOriginal.totalPriceSet) === value.totalCents && money(nativeOriginal.subtotalPriceSet) === value.subtotalCents
          && money(nativeOriginal.totalShippingPriceSet) === value.shippingCents && money(nativeOriginal.totalTaxSet) === value.taxCents;
        add(`${label}:native_original`, originalValid, 'EXACT_NATIVE_ORIGINAL_REQUIRED');
        if (originalValid) nativeOriginalTaxes.set(bag.id, money(nativeOriginal.totalTaxSet));
      }
      const order = nativeOrders.get(bag.id);
      const orderValid = order?.id === value.orderId && order.test === true && order.currencyCode === 'USD' && order.sourceIdentifier === bag.id
        && order.operationsComplete === true && Array.isArray(order.refunds);
      add(`${label}:native_order`, orderValid, 'COMPLETE_BOUND_TEST_ORDER_REQUIRED');
      const native = orderValid ? order.refunds.find(item => item.id === result.shopifyRefundId) : null;
      const nativeValid = native && native.refundLineItems?.pageInfo?.hasNextPage === false && Array.isArray(native.refundLineItems.nodes)
        && native.refundShippingLines?.pageInfo?.hasNextPage === false && Array.isArray(native.refundShippingLines.nodes)
        && native.transactions?.pageInfo?.hasNextPage === false && Array.isArray(native.transactions.nodes);
      add(`${label}:native_refund_complete`, Boolean(nativeValid), 'COMPLETE_NATIVE_REFUND_REQUIRED');
      let nativeProjection = null;
      if (nativeValid) {
        const nativeLines = native.refundLineItems.nodes.map(line => ({ lineItemId: line.lineItem?.id, qty: line.quantity, subtotalCents: money(line.subtotalSet), taxCents: money(line.totalTaxSet) }));
        const nativeShipping = native.refundShippingLines.nodes.map(line => ({ subtotalCents: money(line.subtotalAmountSet), taxCents: money(line.taxAmountSet) }));
        const amountsValid = nativeLines.every(line => gid(line.lineItemId, 'LineItem') && nonnegative(line.subtotalCents) && nonnegative(line.taxCents) && integer(line.qty) && line.qty > 0)
          && nativeShipping.every(line => nonnegative(line.subtotalCents) && nonnegative(line.taxCents));
        add(`${label}:native_usd_cents`, amountsValid, 'EXACT_NATIVE_USD_CENTS_REQUIRED');
        const txs = native.transactions.nodes;
        const transactionValid = txs.length > 0 && txs.every(tx => tx.kind === 'REFUND' && tx.status === 'SUCCESS' && tx.test === true && tx.gateway === 'manual'
          && tx.parentTransaction?.id === op.parentTransactionId && nonnegative(money(tx.amountSet)) && order.transactions?.some(parent => parent.id === tx.parentTransaction?.id
            && ['SALE', 'CAPTURE'].includes(parent.kind) && parent.status === 'SUCCESS' && parent.test === true && parent.gateway === 'manual'
            && money(parent.amountSet) === value.totalCents));
        add(`${label}:native_transactions`, transactionValid, 'SUCCESSFUL_TEST_MANUAL_REFUND_REQUIRED');
        if (amountsValid && transactionValid) {
          const nativeTax = sum([...nativeLines, ...nativeShipping].map(line => line.taxCents));
          const nativeSubtotal = sum(nativeLines.map(line => line.subtotalCents));
          const nativeShippingCents = sum(nativeShipping.map(line => line.subtotalCents));
          sameCents(`${label}:native_total`, op.amountCents, money(native.totalRefundedSet));
          sameCents(`${label}:native_components`, op.amountCents, nativeSubtotal + nativeShippingCents + nativeTax);
          sameCents(`${label}:native_transaction_amount`, op.amountCents, sum(txs.map(tx => money(tx.amountSet))));
          sameCents(`${label}:native_tax`, op.taxCents, nativeTax);
          sameCents(`${label}:native_shipping`, op.shippingCents ?? 0, nativeShippingCents);
          const expectedLines = op.lineItems ?? [];
          add(`${label}:native_quantities`, nativeLines.length === expectedLines.length && new Set(nativeLines.map(line => line.lineItemId)).size === nativeLines.length
            && expectedLines.every(line => nativeLines.some(item => item.lineItemId === line.lineItemId && item.qty === line.qty
              && item.subtotalCents === line.subtotalCents && item.taxCents === line.taxCents)), 'EXACT_NATIVE_REFUND_LINES_REQUIRED');
          result.shopifyTaxCents = nativeTax;
          nativeProjection = { id: native.id, orderId: order.id, cashCents: money(native.totalRefundedSet), taxCents: nativeTax,
            lines: nativeLines, shipping: nativeShipping, transactions: txs.map(tx => ({ kind: tx.kind, status: tx.status, test: tx.test, gateway: tx.gateway, amountCents: money(tx.amountSet) })) };
          evidence.native.push(nativeProjection);
        }
      }
      const refundEvidence = { mappingHash: hash(mapping), originalTaxTransactionId: original.id,
        observedArtifactHash: observed ? hash(observed) : null,
        refundId: mapped.refundId, taxTransactionId: mapped.taxTransactionId, bagId: bag.id, operationId: op.id,
        referenceProof: evidence[`${label}:taxReference`] ?? null,
        stripe: refundValid ? { id: refund.id, chargeId: refund.charge, paymentIntentId: refund.payment_intent, amountCents: refund.amount, status: refund.status } : null,
        tax: reversal, native: nativeProjection };
      result.evidenceHash = hash(refundEvidence); evidence.refunds.push(refundEvidence);
      if (integer(result.stripeTaxCents) && integer(result.shopifyTaxCents)) {
        result.signedVarianceCents = result.stripeTaxCents - result.shopifyTaxCents;
        add(`${label}:rounding_policy`, Math.abs(result.signedVarianceCents) <= policy.maxAbsoluteCentsPerRefund, 'PLATFORM_ROUNDING_OUTLIER', { differenceCents: result.signedVarianceCents });
        report.totals.stripeReversedTaxCents += result.stripeTaxCents; report.totals.shopifyRefundTaxCents += result.shopifyTaxCents;
      }
      if (refundValid) report.totals.refundCashCents += refund.amount;
    }
    report.provenance.apiReferenceProof = allApi;
    if (nativeOriginalTaxes.size === snapshot.bags.length) report.totals.originalShopifyTaxCents = sum([...nativeOriginalTaxes.values()]);
    for (const line of original.lines ?? []) {
      const total = originalLineTotals.get(line.id);
      add(`original_line_remainder:${line.id}`, nonnegative(total.amountCents) && total.amountCents <= line.amountCents && nonnegative(total.taxCents) && total.taxCents <= line.taxCents, 'TAX_REVERSAL_EXCEEDS_ORIGINAL_LINE');
    }
    if (!observed) add('original_shipping_remainder', shippingReversedAmount >= 0 && shippingReversedAmount <= (original.shipping?.amountCents ?? 0)
      && shippingReversedTax >= 0 && shippingReversedTax <= (original.shipping?.taxCents ?? 0), 'TAX_REVERSAL_EXCEEDS_ORIGINAL_SHIPPING');
    else add('dashboard_original_remainder', sum(observed.reversals.map(item => -item.grossCents)) <= original.grossCents
      && sum(observed.reversals.map(item => -item.taxCents)) <= original.taxCents, 'DASHBOARD_REVERSALS_EXCEED_ORIGINAL');
    sameCents('charge_refund_coverage', charge.amount_refunded, report.totals.refundCashCents);
    for (const bag of snapshot.bags) {
      const order = nativeOrders.get(bag.id); if (!order) continue;
      const known = expected.filter(item => item.bag.id === bag.id);
      add(`${bag.id}:native_refund_coverage`, order.refunds.length === known.length && order.refunds.every(native => known.some(({ op }) => (op.shopifyRefundId ?? op.sourceShopifyRefundId) === native.id)), 'UNMAPPED_NATIVE_REFUND');
      sameCents(`${bag.id}:native_refund_total`, sum(known.map(({ op }) => op.amountCents)), money(order.totalRefundedSet));
    }
    const entries = (await db.query('SELECT * FROM provider_tax_rounding_entries WHERE run_id=$1 ORDER BY refund_id', [mapping.runId])).rows;
    for (const entry of entries) {
      const refund = report.refunds.find(item => item.refundId === entry.refund_id), accounts = signedAccounts(entry.signed_variance_cents);
      const valid = refund && entry.tax_reversal_id === refund.taxTransactionId && entry.policy_id === policy.id
        && entry.signed_variance_cents === refund.signedVarianceCents && entry.evidence_hash === refund.evidenceHash
        && entry.amount_cents === Math.abs(entry.signed_variance_cents) && entry.debit_account === accounts.debitAccount && entry.credit_account === accounts.creditAccount;
      add(`${entry.refund_id}:immutable_subledger`, Boolean(valid), 'IMMUTABLE_ROUNDING_EVIDENCE_CHANGED');
      if (valid) { refund.recorded = true; refund.recordedVarianceCents = entry.signed_variance_cents; report.totals.recordedPlatformVarianceCents += entry.signed_variance_cents; }
    }
    return complete();
  }

  async function persistReport(report) {
    await db.query(`INSERT INTO provider_tax_reports(id,run_id,binding_hash,report_hash,evidence_hash,status,report_encrypted,checked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [report.id, report.runId, report.bindingHash, report.reportHash, report.evidenceHash, report.status, auth.encrypt(report), report.checkedAt]);
    return report;
  }
  async function getReport({ reportId } = {}) {
    if (!/^taxrecon_[a-f0-9]{32}$/.test(reportId ?? '')) fail('TAX_REPORT_INVALID', 'A valid exact Tax report ID is required.', 422);
    const row = (await db.query('SELECT * FROM provider_tax_reports WHERE id=$1', [reportId])).rows[0];
    if (!row) fail('TAX_REPORT_NOT_FOUND', 'The Tax report was not found.', 404);
    let report; try { report = auth.decrypt(row.report_encrypted); } catch { fail('TAX_REPORT_UNREADABLE', 'The encrypted Tax audit cannot be verified.'); }
    const { id: ignoredId, checkedAt: ignoredTime, reportHash: ignoredHash, ...legacyStable } = report;
    // Preserve pre-snapshot audit reports whose hashes included request IDs.
    if (report.id !== row.id || (reportDigest(report) !== row.report_hash && hash(legacyStable) !== row.report_hash)
      || report.reportHash !== row.report_hash || report.evidenceHash !== row.evidence_hash)
      fail('TAX_REPORT_CHANGED', 'The immutable report does not verify.');
    return report;
  }
  async function latest({ runId } = {}) {
    approvedRun(runId);
    const row = (await db.query('SELECT id FROM provider_tax_reports WHERE run_id=$1 ORDER BY checked_at DESC,id DESC LIMIT 1', [runId])).rows[0];
    return row ? getReport({ reportId: row.id }) : null;
  }
  async function reconcile({ runId } = {}) {
    approvedRun(runId); const { binding } = await readBinding(runId);
    return withRun(runId, async ctx => {
      const guard = await captureLease(ctx), report = await inspect(ctx, binding);
      await assertLease(guard); return persistReport(report);
    });
  }
  async function recordRounding({ reportId, reportHash, operationId, confirmPlatformOnly } = {}) {
    if (confirmPlatformOnly !== true || !safeOperation(operationId) || !/^[a-f0-9]{64}$/.test(reportHash ?? ''))
      fail('PLATFORM_ROUNDING_CONFIRMATION_REQUIRED', 'Confirm the platform-only record with a stable operation ID and exact report hash.', 422);
    const previous = await getReport({ reportId });
    if (previous.reportHash !== reportHash) fail('TAX_REPORT_HASH_MISMATCH', 'The supplied immutable report hash does not match.');
    approvedRun(previous.runId); const { binding } = await readBinding(previous.runId);
    return withRun(previous.runId, async ctx => {
      const guard = await captureLease(ctx);
      const replay = (await db.query('SELECT * FROM provider_tax_rounding_entries WHERE operation_id=$1', [operationId])).rows;
      if (replay.length && replay.some(entry => entry.run_id !== previous.runId || entry.source_report_hash !== reportHash))
        fail('TAX_OPERATION_CONFLICT', 'This operation ID is already bound to another immutable report.');
      if (!replay.length && (now().getTime() - new Date(previous.checkedAt).getTime() > 300_000 || now() < new Date(previous.checkedAt)))
        fail('TAX_REPORT_STALE', 'Refresh the read-only Tax report before recording.');
      const fresh = await inspect(ctx, binding);
      if (replay.length) {
        if (fresh.reviewCount || replay.length !== fresh.refunds.filter(refund => refund.signedVarianceCents !== 0).length
          || !fresh.refunds.every(refund => refund.signedVarianceCents === 0 || refund.recorded))
          fail('TAX_REPLAY_REVIEW_REQUIRED', 'The recorded operation no longer has complete matching evidence.');
        await assertLease(guard);
        return { ...await persistReport(fresh), operationId, replayed: true, entriesRecorded: 0 };
      }
      if (!previous.readyToRecord || !fresh.readyToRecord || fresh.reportHash !== previous.reportHash || fresh.evidenceHash !== previous.evidenceHash)
        fail('TAX_FRESH_EVIDENCE_REQUIRED', 'Evidence changed, is incomplete, or exceeds the explicit one-cent policy; no record was created.');
      await db.transaction(async tx => {
        await assertLease(guard, tx);
        const locked = (await tx.query('SELECT * FROM provider_tax_bindings WHERE run_id=$1 FOR UPDATE', [previous.runId])).rows[0];
        if (locked?.binding_hash !== previous.bindingHash) fail('TAX_BINDING_CHANGED', 'The immutable mapping no longer matches.');
        // db.transaction globally serializes both supported databases, including
        // PostgreSQL's shared advisory lock: this operation reservation covers
        // BOTH approved runs, not just this run's binding row.
        const prior = (await tx.query('SELECT refund_id FROM provider_tax_rounding_entries WHERE refund_id=ANY($1) OR tax_reversal_id=ANY($2) OR operation_id=$3',
          [fresh.refunds.map(refund => refund.refundId), fresh.refunds.map(refund => refund.taxTransactionId), operationId])).rows;
        if (prior.length) fail('TAX_ROUNDING_ALREADY_RECORDED', 'Existing rounding entries cannot be overwritten or duplicated.');
        for (const refund of fresh.refunds.filter(value => value.signedVarianceCents !== 0)) {
          const accounts = signedAccounts(refund.signedVarianceCents);
          const entry = { runId: previous.runId, refundId: refund.refundId, taxReversalId: refund.taxTransactionId, operationId,
            policyId: policy.id, signedVarianceCents: refund.signedVarianceCents, amountCents: Math.abs(refund.signedVarianceCents),
            ...accounts, evidenceHash: refund.evidenceHash, sourceReportHash: reportHash, scope: SCOPE, coreAccountingMutations: 0 };
          await tx.query(`INSERT INTO provider_tax_rounding_entries(id,run_id,report_id,refund_id,tax_reversal_id,business_key,operation_id,source_report_hash,
            policy_id,signed_variance_cents,debit_account,credit_account,amount_cents,evidence_hash,entry_encrypted)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [`taxround_${randomUUID().replaceAll('-', '')}`, previous.runId, previous.id,
            refund.refundId, refund.taxTransactionId, `platform-tax-rounding:${refund.refundId}:v1`, operationId, reportHash, policy.id,
            refund.signedVarianceCents, accounts.debitAccount, accounts.creditAccount, Math.abs(refund.signedVarianceCents), refund.evidenceHash, auth.encrypt(entry)]);
        }
      });
      // Same fresh provider evidence, now with locally recorded immutable controls.
      const updated = await inspect(ctx, binding);
      await assertLease(guard);
      return { ...await persistReport(updated), operationId, replayed: false, entriesRecorded: fresh.refunds.filter(refund => refund.signedVarianceCents !== 0).length };
    });
  }
  async function runNightly() {
    const date = now().toISOString().slice(0, 10), results = [];
    for (const runId of policy.runIds) {
      const claimed = (await db.query(`UPDATE provider_tax_bindings SET nightly_claimed_date=$2 WHERE run_id=$1
        AND (nightly_claimed_date IS NULL OR nightly_claimed_date<$2::date) RETURNING run_id`, [runId, date])).rows.length;
      if (!claimed) continue;
      let report;
      try { report = await reconcile({ runId }); }
      catch (cause) {
        const code = ['TAX_RUN_BUSY', 'TAX_LEASE_LOST', 'TAX_BINDING_CHANGED', 'TAX_BINDING_UNREADABLE'].includes(cause?.code) ? cause.code : 'TAX_RECONCILIATION_UNAVAILABLE';
        await db.transaction(async tx => {
          const row = (await tx.query('SELECT last_alert_hash FROM provider_tax_bindings WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
          const alertHash = hash({ runId, code });
          if (row?.last_alert_hash !== alertHash) await tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,payload)
            VALUES($1,'provider.tax_reconciliation_review',$2,$3)`, [`evt_${randomUUID().replaceAll('-', '')}`, runId,
            JSON.stringify({ runId, status: 'review', code, test: true, sandbox: true, fullAcceptancePassed: false })]);
          await tx.query(`UPDATE provider_tax_bindings SET nightly_claimed_date=CASE WHEN nightly_claimed_date=$2::date THEN NULL ELSE nightly_claimed_date END,
            last_alert_hash=$3 WHERE run_id=$1`, [runId, date, alertHash]);
        });
        results.push({ runId, status: 'review', code, fullAcceptancePassed: false }); continue;
      }
      await db.transaction(async tx => {
        const row = (await tx.query('SELECT last_alert_hash FROM provider_tax_bindings WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
        const alertHash = report.reviewCount || report.totals.unaccountedVarianceCents ? hash({ status: report.status, evidenceHash: report.evidenceHash,
          checks: semanticChecks(report.checks.filter(check => check.status === 'review')), unaccountedVarianceCents: report.totals.unaccountedVarianceCents }) : null;
        if (alertHash && row?.last_alert_hash !== alertHash) await tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,payload)
          VALUES($1,'provider.tax_reconciliation_review',$2,$3)`, [`evt_${randomUUID().replaceAll('-', '')}`, runId,
          JSON.stringify({ runId, reportId: report.id, reportHash: report.reportHash, evidenceHash: report.evidenceHash, status: report.status,
            unaccountedVarianceCents: report.totals.unaccountedVarianceCents, test: true, sandbox: true, fullAcceptancePassed: false })]);
        await tx.query('UPDATE provider_tax_bindings SET last_alert_hash=$2 WHERE run_id=$1', [runId, alertHash]);
      });
      results.push(report);
    }
    return { date, reports: results, providerWrites: 0, fullAcceptancePassed: false };
  }
  return { configureEvidence, reconcile, getReport, latest, recordRounding, runNightly };
}
