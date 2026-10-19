import { createHash } from 'node:crypto';
import { TEST_STORES } from './test-stores.mjs';
import { APPROVED_TEST_PLATFORM_SWITCH } from './provider-platform-switch.mjs';

const TARGET = APPROVED_TEST_PLATFORM_SWITCH.toAccountId;
const DAY = 86_400_000;
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const providerId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{8,}$`).test(value);
const businessId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const payoutOperation = (runId, bagId) => `auto_payout_${hash({ runId, bagId, version: 1 }).slice(0, 32)}`;
const own = (value, key) => Object.hasOwn(value ?? {}, key) ? value[key] : null;
const incomplete = detail => Object.values(detail.refundOps ?? {}).some(op => op.status !== 'complete');
const refunded = (detail, key) => Object.values(detail.refundOps ?? {}).filter(op => op.stripeStatus === 'succeeded')
  .reduce((sum, op) => sum + (Number.isSafeInteger(op[key]) ? op[key] : 0), 0);
const fullyReturned = detail => Number.isSafeInteger(detail.totalCents) && detail.totalCents > 0 && !incomplete(detail)
  && detail.refundCents === detail.totalCents && refunded(detail, 'amountCents') === detail.totalCents;
const centEvidenceReady = (report, runId, bagIds) => {
  if (report?.test !== true || report.runId !== runId || report.processing || report.mismatchCount !== 0
    || !Array.isArray(report.checks) || !report.checks.length) return false;
  const pending = report.checks.filter(check => check.status !== 'matched');
  if (report.pendingCount !== pending.length || pending.some(check => check.status !== 'pending')) return false;
  if (report.status === 'matched') return pending.length === 0;
  // An independently verified pending bank arrival is not a cent discrepancy.
  // Every unknown ID, read failure, refund/reversal gap or other pending reason
  // remains a hard hold; this never relabels lifecycle completion as matched.
  return report.status === 'pending' && pending.length > 0 && pending.every(check => check.code === 'PAYOUT_NOT_PAID'
    && bagIds.some(bagId => check.name === `${bagId}:stripe_payout_status`));
};

/** Opt-in TEST money orchestration only. No shipping, delivery simulation,
 * isolated-clock advance, refund, account creation or bank setup is authorized.
 * Money methods remain the sole provider writers and recheck policy INSIDE their
 * existing run lease, so disabling a policy cannot race an acknowledged revoke.
 */
export async function createProviderAutomation(db, auth, { runtime, stores, getStripe, providerMoney,
  providerFulfillment, providerReconciliation, clock = () => new Date() } = {}) {
  if (!db?.transaction || !auth?.encrypt || !runtime?.withRun || !runtime?.read || !runtime?.decode
    || !stores?.row || typeof getStripe !== 'function' || !providerMoney?.setAutomationGuard
    || !providerMoney?.settle || !providerMoney?.payout || !providerFulfillment?.sync || !providerReconciliation?.reconcile)
    fail('AUTOMATION_SETUP_REQUIRED', 'A bound encrypted test runtime, guarded money and authoritative readers are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_automation_policies (
    run_id TEXT PRIMARY KEY REFERENCES unified_checkout_runs(id),policy_id TEXT UNIQUE NOT NULL,policy_hash TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,last_error JSONB,last_outcome TEXT,last_checked_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const now = () => new Date(clock());
  const rowFor = async runId => (await db.query('SELECT * FROM provider_automation_policies WHERE run_id=$1', [runId])).rows[0];
  const load = async runId => {
    const row = await runtime.read(runId); return { row, ...runtime.decode(row) };
  };
  const policyFields = policy => { const { id, ...fields } = policy; return fields; };
  function validContext(ctx) {
    const { snapshot, details } = ctx;
    if (snapshot?.currency !== 'USD' || details?.accountId !== TARGET || details.paymentVerified !== true
      || details.canonicalCommitted !== true || !providerId(details.paymentIntentId, 'pi') || !providerId(details.chargeId, 'ch')
      || !Array.isArray(snapshot.bags) || snapshot.bags.length !== 3 || new Set(snapshot.bags.map(bag => bag.shop)).size !== 3
      || new Set(snapshot.bags.map(bag => bag.id)).size !== 3
      || snapshot.bags.some(bag => !TEST_STORES.some(store => store.shop === bag.shop) || !businessId(bag.id)
        || bag.commissionBps !== 1500 || details.bags?.[bag.id]?.verified !== true || !details.bags[bag.id].orderId))
      fail('AUTOMATION_TEST_RUN_REQUIRED', 'Only a captured, canonical three-store USD run on the fixed new test platform can be armed.');
  }
  async function recipients(ctx) {
    validContext(ctx); const result = [];
    for (const bag of [...ctx.snapshot.bags].sort((a, b) => a.shop.localeCompare(b.shop))) {
      const row = await stores.row(bag.shop);
      if (row?.shop !== bag.shop || row.brand_id !== bag.brandId || row.state === 'disconnected'
        || row.connected_account_created_in_test !== true || row.connected_account_verified !== true
        || !providerId(row.connected_account_id, 'acct') || row.connected_account_id === TARGET)
        fail('AUTOMATION_RECIPIENT_BINDING_REQUIRED', 'Each exact Bag must retain its newly created, verified test recipient.');
      result.push({ bagId: bag.id, brandId: bag.brandId, shop: bag.shop, accountId: row.connected_account_id });
    }
    if (new Set(result.map(item => item.accountId)).size !== 3) fail('AUTOMATION_RECIPIENT_BINDING_REQUIRED', 'Three distinct test recipients are required.');
    return result;
  }
  function gateReady(policy, bagId, detail) {
    const gate = policy.payoutGates.find(item => item.bagId === bagId), op = gate && own(detail.refundOps, gate.refundOperationId);
    if (!op || op.status !== 'complete' || op.stripeStatus !== 'succeeded' || !providerId(op.stripeRefundId, 're')
      || !/^gid:\/\/shopify\/Refund\/\d+$/.test(op.shopifyRefundId ?? '') || !Number.isSafeInteger(op.amountCents) || op.amountCents <= 0) return false;
    return op.afterTransfer !== true || (op.reversalVerified === true && providerId(op.reversalId, 'trr'));
  }
  async function checkPolicy(ctx, automationPolicyId, action, bagId, operationId) {
    const row = await rowFor(ctx.snapshot.id), policy = ctx.details.automationPolicy;
    if (!row?.enabled || row.disabled_at || row.completed_at || row.policy_id !== automationPolicyId
      || !policy || policy.id !== row.policy_id || hash(policyFields(policy)) !== row.policy_hash
      || policy.runId !== ctx.snapshot.id || policy.platformAccountId !== TARGET || policy.version !== 1
      || policy.autoSettle !== true || policy.autoPayout !== true)
      fail('AUTOMATION_POLICY_DISABLED', 'This immutable test policy is absent, disabled or no longer matches.');
    const current = await recipients(ctx);
    if (JSON.stringify(current) !== JSON.stringify(policy.recipients)) fail('AUTOMATION_RECIPIENT_BINDING_CHANGED', 'A frozen test recipient binding changed.');
    if (action === 'settle' && ctx.snapshot.bags.some(bag => {
      const detail = ctx.details.bags[bag.id];
      if (fullyReturned(detail) && (!detail.cancelOp || detail.cancelOp.status === 'complete')) return false;
      return incomplete(detail) || detail.cancelOp || detail.cancellationVerified || ['cancelled','refunded'].includes(detail.state);
    })) fail('AUTOMATION_LIFECYCLE_REVIEW', 'Pending refunds or cancellation/closed Bags hold new automatic settlement.');
    if (action === 'payout') {
      const detail = ctx.details.bags?.[bagId];
      if (!detail || operationId !== payoutOperation(ctx.snapshot.id, bagId) || !gateReady(policy, bagId, detail)
        || incomplete(detail) || detail.cancelOp || detail.cancellationVerified || ['cancelled','refunded'].includes(detail.state))
        fail('AUTOMATION_REFUND_GATE_REQUIRED', 'The exact planned refund and any required after-transfer reversal must complete before automatic bank payout.');
      if (detail.payoutOp && detail.payoutOp.operationId !== operationId)
        fail('AUTOMATION_PRIOR_PAYOUT_REQUIRED', 'Preserve and reconcile the original payout operation; do not create a replacement.');
    }
    return policy;
  }
  providerMoney.setAutomationGuard(async (ctx, input) => checkPolicy(ctx, input.automationPolicyId, input.action, input.bagId, input.operationId));

  async function get(runId) {
    const { details } = await load(runId), row = await rowFor(runId), policy = details.automationPolicy;
    if (!row) return { runId, test: true, configured: false, enabled: false, default: 'manual', policyId: null };
    return { runId, test: true, configured: true, enabled: row.enabled === true, policyId: row.policy_id,
      platformAccountId: policy?.platformAccountId ?? null, autoSettle: policy?.autoSettle === true, autoPayout: policy?.autoPayout === true,
      payoutGates: policy?.payoutGates?.map(item => ({ bagId: item.bagId, refundOperationId: item.refundOperationId })) ?? [],
      nextCheckAt: row.next_check_at, lastCheckedAt: row.last_checked_at, lastOutcome: row.last_outcome,
      disabledAt: row.disabled_at, completedAt: row.completed_at, lastError: row.last_error,
      warning: 'TEST money automation only. Named refund evidence gates payouts. No automatic shipping, refunds, test-clock advance or external email.' };
  }
  async function configure(input = {}) {
    if (Object.keys(input).some(key => !['runId','confirmTest','autoSettle','autoPayout','payoutGates'].includes(key))
      || input.confirmTest !== true || input.autoSettle !== true || input.autoPayout !== true
      || !Array.isArray(input.payoutGates) || input.payoutGates.length !== 3
      || input.payoutGates.some(gate => Object.keys(gate ?? {}).some(key => !['bagId','refundOperationId'].includes(key))
        || !businessId(gate?.bagId) || !businessId(gate?.refundOperationId)))
      fail('AUTOMATION_CONFIRMATION_REQUIRED', 'Explicit TEST settlement/payout opt-in and three bounded exact refund gates are required.', 422);
    let executed = false;
    const result = await runtime.withRun(input.runId, async ctx => {
      const frozenRecipients = await recipients(ctx), gates = [...input.payoutGates].sort((a, b) => a.bagId.localeCompare(b.bagId));
      if (new Set(gates.map(gate => gate.bagId)).size !== 3 || gates.some(gate => !ctx.snapshot.bags.some(bag => bag.id === gate.bagId)))
        fail('AUTOMATION_GATE_BINDING_REQUIRED', 'Each frozen Bag must have exactly one explicitly planned refund operation.');
      const fields = { version: 1, runId: ctx.snapshot.id, platformAccountId: TARGET, autoSettle: true, autoPayout: true,
        recipients: frozenRecipients, payoutGates: gates };
      const digest = hash(fields), policyId = `autopol_${digest.slice(0, 32)}`, prior = await rowFor(input.runId);
      if (prior) {
        if (!prior.enabled || prior.disabled_at || prior.completed_at) fail('AUTOMATION_REARM_DENIED', 'Disabling/completing this policy is terminal; no replacement payout identities may be armed.');
        if (prior.policy_hash !== digest || prior.policy_id !== policyId || hash(policyFields(ctx.details.automationPolicy ?? {})) !== digest)
          fail('AUTOMATION_POLICY_IMMUTABLE', 'The original recipient and refund-gate policy is immutable.');
        executed = true; return;
      }
      const checked = await getStripe().preflight();
      if (checked?.verified !== true || checked.mode !== 'test' || checked.accountId !== TARGET)
        fail('AUTOMATION_TEST_PLATFORM_REQUIRED', 'Fresh verification of the fixed new Stripe TEST platform is required.');
      ctx.details.automationPolicy = { id: policyId, ...fields }; await ctx.save();
      await db.transaction(async tx => {
        await tx.query(`INSERT INTO provider_automation_policies(run_id,policy_id,policy_hash,enabled,next_check_at)
          VALUES($1,$2,$3,true,$4)`, [input.runId, policyId, digest, now()]);
        await ctx.emit(tx, 'provider.automation_configured', input.runId, null, { runId: input.runId, policyId, autoSettle: true, autoPayout: true, test: true });
      });
      executed = true;
    });
    if (result.processing) return { ...await get(input.runId), processing: true };
    if (!executed) fail(result.lastError?.code ?? 'AUTOMATION_CONFIGURATION_HELD', 'Automation was not armed; inspect the run’s safe review status.');
    return get(input.runId);
  }
  async function disable({ runId, confirmTest } = {}) {
    if (confirmTest !== true) fail('AUTOMATION_CONFIRMATION_REQUIRED', 'Confirm disabling new automatic TEST money operations.', 422);
    const result = await runtime.withRun(runId, async ctx => {
      const row = await rowFor(runId); if (!row) return;
      await db.transaction(async tx => {
        await tx.query('UPDATE provider_automation_policies SET enabled=false,disabled_at=COALESCE(disabled_at,$2) WHERE run_id=$1', [runId, now()]);
        if (!row.disabled_at) await ctx.emit(tx, 'provider.automation_disabled', runId, null, { runId, policyId: row.policy_id, test: true });
      });
    });
    return { ...await get(runId), ...(result.processing ? { processing: true } : {}) };
  }
  const due = (ctx, bag, detail, registry) => {
    if (detail.fullyDelivered !== true || !Number.isFinite(Date.parse(detail.deliveredAt)) || detail.fulfillmentReview === true
      || incomplete(detail) || detail.cancelOp || detail.cancellationVerified || ['cancelled','refunded'].includes(detail.state)) return false;
    const days = Math.max(30, bag.returnWindowDays ?? 30, registry.return_window_days ?? 30);
    if (!Number.isSafeInteger(days) || days < 30) return false;
    const dates = [Date.parse(detail.deliveredAt) + days * DAY];
    if (detail.payoutDueAt) { if (!Number.isFinite(Date.parse(detail.payoutDueAt))) return false; dates.push(Date.parse(detail.payoutDueAt)); }
    const logical = ctx.details.testClock ? Date.parse(ctx.details.testClock.now) : now().getTime();
    return Number.isFinite(logical) && logical >= Math.max(...dates);
  };
  async function advance({ runId } = {}) {
    const initial = await rowFor(runId); if (!initial?.enabled) return { runId, test: true, advanced: false, outcome: 'manual_or_disabled' };
    const decoded = await load(runId), policy = decoded.details.automationPolicy;
    await checkPolicy(decoded, initial.policy_id, 'inspect');
    for (const bag of decoded.snapshot.bags) {
      const synced = await providerFulfillment.sync({ runId, bagId: bag.id });
      if (synced?.processing || synced?.lastError) return { runId, test: true, advanced: false, outcome: 'fulfillment_review' };
    }
    const reconciled = await providerMoney.reconcile({ runId });
    if (reconciled?.processing || reconciled?.lastError) return { runId, test: true, advanced: false, outcome: 'money_review' };
    let current = await load(runId), eligible = false;
    if (current.snapshot.bags.every(bag => fullyReturned(current.details.bags[bag.id])
      && gateReady(policy, bag.id, current.details.bags[bag.id])
      && (!current.details.bags[bag.id].cancelOp || current.details.bags[bag.id].cancelOp.status === 'complete'))) {
      const refundReport = await providerReconciliation.reconcile({ runId });
      if (!centEvidenceReady(refundReport, runId, current.snapshot.bags.map(bag => bag.id)))
        return { runId, test: true, advanced: false, outcome: 'cent_reconciliation_hold' };
      await db.query('UPDATE provider_automation_policies SET enabled=false,completed_at=COALESCE(completed_at,$2) WHERE run_id=$1 AND enabled=true', [runId, now()]);
      return { runId, test: true, advanced: true, outcome: 'completed_no_payout_due' };
    }
    for (const bag of current.snapshot.bags) if (due(current, bag, current.details.bags[bag.id], await stores.row(bag.shop))) eligible = true;
    if (!eligible) return { runId, test: true, advanced: false, outcome: 'return_window_or_delivery_hold' };
    const report = await providerReconciliation.reconcile({ runId });
    if (!centEvidenceReady(report, runId, current.snapshot.bags.map(bag => bag.id)))
      return { runId, test: true, advanced: false, outcome: 'cent_reconciliation_hold' };
    const settled = await providerMoney.settle({ runId, automationPolicyId: initial.policy_id });
    if (settled?.processing || settled?.lastError) return { runId, test: true, advanced: false, outcome: 'settlement_review' };
    current = await load(runId); let payouts = 0, awaitingGate = false;
    for (const bag of current.snapshot.bags) {
      const detail = current.details.bags[bag.id];
      if (!due(current, bag, detail, await stores.row(bag.shop))) continue;
      if (!gateReady(policy, bag.id, detail)) { awaitingGate = true; continue; }
      if (detail.payoutOp?.startedAt || detail.payoutId) continue; // Reconcile existing IDs only; never create a replacement.
      if (detail.transferOp?.status !== 'verified' || !providerId(detail.transferId, 'tr')) continue;
      const remaining = detail.transferOp.amountCents - Object.values(detail.refundOps ?? {}).filter(op => op.stripeStatus === 'succeeded' && op.afterTransfer && op.reversalVerified)
        .reduce((sum, op) => sum + op.recoveryCents, 0);
      if (!Number.isSafeInteger(remaining) || remaining <= 0) continue;
      const fresh = await providerReconciliation.reconcile({ runId });
      if (!centEvidenceReady(fresh, runId, current.snapshot.bags.map(bag => bag.id)))
        return { runId, test: true, advanced: true, outcome: 'cent_reconciliation_hold' };
      const result = await providerMoney.payout({ runId, bagId: bag.id, operationId: payoutOperation(runId, bag.id), automationPolicyId: initial.policy_id });
      if (result?.processing || result?.lastError) return { runId, test: true, advanced: true, outcome: 'payout_review' };
      payouts++;
    }
    const final = await load(runId);
    const complete = final.snapshot.bags.every(bag => {
      const detail = final.details.bags[bag.id];
      return detail.payoutOp?.status === 'paid' || (fullyReturned(detail) && gateReady(policy, bag.id, detail));
    });
    if (complete) await db.query('UPDATE provider_automation_policies SET enabled=false,completed_at=COALESCE(completed_at,$2) WHERE run_id=$1 AND enabled=true', [runId, now()]);
    return { runId, test: true, advanced: true, outcome: complete ? 'completed' : awaitingGate ? 'awaiting_named_refund_gate' : payouts ? 'payout_processing' : 'provider_money_pending' };
  }
  async function runDue({ limit = 5 } = {}) {
    limit = Math.min(5, Math.max(1, Number.isSafeInteger(limit) ? limit : 5)); const instant = now();
    const rows = (await db.query(`SELECT * FROM provider_automation_policies WHERE enabled=true AND next_check_at<=$1
      ORDER BY next_check_at,run_id LIMIT $2`, [instant, limit])).rows; const results = [];
    for (const row of rows) {
      const claim = await db.query(`UPDATE provider_automation_policies SET next_check_at=$2,last_checked_at=$1
        WHERE run_id=$3 AND enabled=true AND next_check_at<=$1 RETURNING run_id`, [instant, new Date(instant.getTime() + 60_000), row.run_id]);
      if (!claim.rows.length) continue;
      try {
        const result = await advance({ runId: row.run_id }); results.push(result);
        await db.query('UPDATE provider_automation_policies SET attempts=0,last_error=NULL,last_outcome=$2 WHERE run_id=$1', [row.run_id, result.outcome]);
      } catch (cause) {
        const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(cause.code) ? cause.code : 'AUTOMATION_HELD';
        const delay = Math.min(900_000, 60_000 * 2 ** Math.min(row.attempts, 4));
        await db.query(`UPDATE provider_automation_policies SET attempts=attempts+1,last_error=$2,last_outcome='review_hold',next_check_at=$3 WHERE run_id=$1`,
        [row.run_id, JSON.stringify({ code, message: 'Automatic TEST money is held for safe review; no replacement operation was authorized.' }), new Date(instant.getTime() + delay)]);
        results.push({ runId: row.run_id, test: true, advanced: false, outcome: 'review_hold', code });
      }
    }
    return { test: true, checked: results.length, results, boundedBatch: limit };
  }
  return { configure, disable, get, advance, runDue };
}
