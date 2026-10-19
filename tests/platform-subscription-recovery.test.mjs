import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createDomain } from '../server/domain.mjs';
import { seedDatabase } from '../server/seed.mjs';
import { createPlatform } from '../server/platform/index.mjs';
import { createSubscriptions } from '../server/platform/commerce.mjs';

const items = [{ brandId: 'brand_bloom', sku: 'BLOOM-COTTON-16', qty: 1 }];
const shipTo = { name: 'Private Recovery Fixture', line1: '123 Private Review Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
const reason = 'Operator reviewed this isolated simulated attempt.';
async function fixture(t, { unknown = false, existingOrder = false } = {}) {
  const db = await createDatabase({ connectionString: null }); t.after(() => db.close()); await db.migrate();
  let stamp = Date.parse('2026-10-19T12:00:00Z'); const clock = () => new Date(stamp);
  const domain = createDomain(db, { clock }); await seedDatabase(db, domain);
  let charges = 0;
  const platform = await createPlatform(db, { domain, auth: {}, secret: 'isolated-recovery-test-secret', clock,
    subscriptionCharge: async input => { charges++; if (unknown) throw new Error('Unknown mocked outcome'); return { ok: true, ref: 'pi_sim_recovery_fixture', amountCents: input.amountCents }; },
    fetch: async () => { throw new Error('Provider access is disabled in recovery tests.'); } });
  const shopper = await platform.crm.upsertShopper({ email: 'private-recovery@example.com' });
  const sub = await platform.subscriptions.create(shopper.id, { items, shipTo });
  if (!unknown) {
    let failOnce = true;
    if (existingOrder) {
      const original = platform.crm.linkOrder.bind(platform.crm);
      t.mock.method(platform.crm, 'linkOrder', async (...args) => { if (failOnce) { failOnce = false; throw new Error('fixture post-order failure'); } return original(...args); });
    } else {
      const original = domain.createSandboxOrder.bind(domain);
      t.mock.method(domain, 'createSandboxOrder', async (...args) => { if (failOnce) { failOnce = false; throw new Error('fixture pre-order failure'); } return original(...args); });
    }
  }
  assert.equal((await platform.subscriptions.runDue())[0].status, 'review');
  const attempt = (await db.query('SELECT * FROM subscription_attempts WHERE subscription_id=$1', [sub.id])).rows[0];
  const command = (operationId, extra = {}) => ({ subscriptionId: sub.id, operationId, actor: 'owner', reason, ...extra });
  const proof = async resolution => {
    const row = (await platform.subscriptions.listReviews({ subscriptionId: sub.id }))[0].attempts.find(a => a.id === attempt.id);
    return { source: 'operator_mock_review', reference: 'mockproof_fixture_12345678', observedAt: clock().toISOString(),
      attemptKey: row.proofRequirements.attemptKey, requestFingerprint: row.proofRequirements.requestFingerprint, chargeRef: row.proofRequirements.chargeRef,
      acknowledgement: row.proofRequirements.requiredAcknowledgements[resolution] };
  };
  const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
  return { db, domain, platform, shopper, sub, attempt, command, proof, count, clock, charges: () => charges, advance: days => { stamp += days * 86_400_000; } };
}

test('review projections expose exact safe proof requirements and keep evidence/reason encrypted', async t => {
  const f = await fixture(t);
  const [review] = await f.platform.subscriptions.listReviews();
  assert.equal(review.requiresReview, true); assert.equal(review.simulated, true);
  assert.ok(review.attempts[0].allowedActions.includes('reconcile_paid'));
  assert.match(review.attempts[0].proofRequirements.requestFingerprint, /^[a-f0-9]{64}$/);
  const response = await f.platform.subscriptions.reconcileReview(f.command('recover_paid_projection', { attemptId: f.attempt.id, resolution: 'paid' }));
  assert.equal(response.status, 'resolved_paid'); assert.equal(response.providerVerified, false);
  const raw = (await f.db.query('SELECT * FROM subscription_review_actions')).rows[0];
  assert.ok(raw.reason_enc); assert.ok(!JSON.stringify(raw).includes(reason));
  const projection = JSON.stringify(await f.platform.subscriptions.listReviews());
  for (const secret of [shipTo.name, shipTo.line1, 'private-recovery@example.com', 'pm_card_visa', reason, 'chargeEvidenceEnc', 'reasonEnc']) assert.ok(!projection.includes(secret), secret);
});

test('paid reconciliation creates one exact canonical order without charging, then audited resume schedules later', async t => {
  const f = await fixture(t); const before = await f.count('orders');
  const input = f.command('recover_paid_once', { attemptId: f.attempt.id, resolution: 'paid' });
  const recovered = await f.platform.subscriptions.reconcileReview(input);
  assert.equal(recovered.status, 'resolved_paid'); assert.equal(await f.count('orders'), before + 1); assert.equal(f.charges(), 1);
  const replay = await f.platform.subscriptions.reconcileReview(input); assert.equal(replay.replayed, true); assert.equal(replay.orderId, recovered.orderId);
  assert.equal((await f.platform.subscriptions.runs(f.sub.id)).filter(row => row.status === 'paid').length, 1);
  assert.equal((await f.platform.subscriptions.list())[0].cycleCount, 1);
  await assert.rejects(() => f.platform.subscriptions.setStatus(f.sub.id, 'active'), { code: 'SUBSCRIPTION_REVIEW_REQUIRED' });
  const resume = await f.platform.subscriptions.resumeReview(f.command('recover_resume_once'));
  assert.equal(resume.status, 'active'); assert.equal(resume.chargeAttempted, false);
  assert.ok(Date.parse(resume.nextRunAt) >= f.clock().getTime() + 86_400_000);
  assert.deepEqual(await f.platform.subscriptions.runDue(), []); assert.equal(f.charges(), 1);
});

test('legacy active status cannot bypass audited resume after errors clear and the paid cycle advances', async t => {
  const f = await fixture(t);
  await f.platform.subscriptions.reconcileReview(f.command('persist_review_boundary', { attemptId: f.attempt.id, resolution: 'paid' }));
  await f.platform.subscriptions.resumeReview(f.command('first_audited_resume'));
  const recovered = (await f.platform.subscriptions.list())[0];
  assert.equal(recovered.lastError, null); assert.equal(recovered.cycleCount, 1);
  await f.platform.subscriptions.setStatus(f.sub.id, 'paused');
  // A due date in the past must not allow the legacy path to dispatch immediately.
  await f.db.query("UPDATE subscriptions SET next_run_at=$2 WHERE id=$1", [f.sub.id, new Date(f.clock().getTime() - 86_400_000)]);
  const beforeActions = await f.count('subscription_review_actions');
  await assert.rejects(() => f.platform.subscriptions.setStatus(f.sub.id, 'active'), { code: 'SUBSCRIPTION_REVIEW_REQUIRED' });
  assert.equal((await f.platform.subscriptions.list())[0].status, 'paused');
  assert.equal(await f.count('subscription_review_actions'), beforeActions);
  assert.deepEqual(await f.platform.subscriptions.runDue(), []); assert.equal(f.charges(), 1);
  const resumed = await f.platform.subscriptions.resumeReview(f.command('second_audited_resume'));
  assert.equal(resumed.status, 'active'); assert.ok(Date.parse(resumed.nextRunAt) >= f.clock().getTime() + 86_400_000);
  assert.equal(await f.count('subscription_review_actions'), beforeActions + 1);
  assert.equal(f.charges(), 1);
});

test('historical review runs and resolved attempts fence legacy reactivation without a mutable error marker', async t => {
  const f = await fixture(t, { unknown: true });
  // A legacy concluded review may predate the new operator-action table.
  await f.db.query("UPDATE subscription_attempts SET status='resolved_declined' WHERE id=$1", [f.attempt.id]);
  await f.db.query('UPDATE subscriptions SET last_error=NULL,cycle_count=1 WHERE id=$1', [f.sub.id]);
  await f.db.query("UPDATE subscription_runs SET status='legacy_record' WHERE subscription_id=$1", [f.sub.id]);
  assert.equal(await f.count('subscription_review_actions'), 0);
  await assert.rejects(() => f.platform.subscriptions.setStatus(f.sub.id, 'active'), { code: 'SUBSCRIPTION_REVIEW_REQUIRED' });
  await f.db.query("UPDATE subscription_attempts SET status='declined' WHERE id=$1", [f.attempt.id]);
  await f.db.query("UPDATE subscription_runs SET status='review_legacy' WHERE subscription_id=$1", [f.sub.id]);
  // Review runs independently preserve the boundary even when attempt status changed.
  await assert.rejects(() => f.platform.subscriptions.setStatus(f.sub.id, 'active'), { code: 'SUBSCRIPTION_REVIEW_REQUIRED' });
  assert.equal((await f.platform.subscriptions.list())[0].status, 'paused'); assert.equal(f.charges(), 1);
});

test('legacy pause/reactivation remains available to subscriptions that never entered review', async t => {
  const f = await fixture(t, { unknown: true });
  const fresh = await f.platform.subscriptions.create(f.shopper.id, { items, shipTo });
  await f.platform.subscriptions.setStatus(fresh.id, 'paused');
  assert.equal((await f.platform.subscriptions.setStatus(fresh.id, 'active')).status, 'active');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM subscription_review_actions WHERE subscription_id=$1', [fresh.id])).rows[0].n, 0);
  assert.equal(f.charges(), 1);
});

test('concurrent same-operation paid recovery reuses the existing order and one credit/run', async t => {
  const f = await fixture(t, { existingOrder: true }); const before = await f.count('orders');
  const input = f.command('recover_existing_concurrent', { attemptId: f.attempt.id, resolution: 'paid' });
  const results = await Promise.all([f.platform.subscriptions.reconcileReview(input), f.platform.subscriptions.reconcileReview(input)]);
  assert.ok(results.every(result => result.status === 'resolved_paid'));
  assert.equal(results[0].orderId, f.attempt.order_id); assert.equal(results[1].orderId, f.attempt.order_id);
  assert.equal(await f.count('orders'), before); assert.equal(f.charges(), 1);
  assert.equal((await f.platform.subscriptions.runs(f.sub.id)).filter(row => row.status === 'paid').length, 1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM bank_lots WHERE shopper_id=$1', [f.shopper.id])).rows[0].n, 1);
});

test('review IDs bind reason/action/target; missing reasons and cross-subscription attempts are rejected', async t => {
  const f = await fixture(t, { unknown: true });
  await assert.rejects(() => f.platform.subscriptions.cancelReview(f.command('missing_reason_123', { reason: '' })), { code: 'VALIDATION_ERROR' });
  const input = f.command('cancel_global_binding'); await f.platform.subscriptions.cancelReview(input);
  await assert.rejects(() => f.platform.subscriptions.cancelReview({ ...input, reason: 'Different operator explanation.' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const other = await f.platform.subscriptions.create(f.shopper.id, { items, shipTo });
  await assert.rejects(() => f.platform.subscriptions.reconcileReview({ ...f.command('wrong_subscription_target', { attemptId: f.attempt.id, resolution: 'paid' }), subscriptionId: other.id }), { code: 'NOT_FOUND' });
  await assert.rejects(() => f.platform.subscriptions.cancelReview({ ...input, subscriptionId: other.id }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('unknown outcomes need exact explicit mock attestation; decline then resume never calls charge', async t => {
  const f = await fixture(t, { unknown: true });
  const input = f.command('attest_decline_valid', { attemptId: f.attempt.id, resolution: 'declined' });
  await assert.rejects(() => f.platform.subscriptions.reconcileReview({ ...input, proof: { success: true } }), { code: 'SUBSCRIPTION_PROOF_REQUIRED' });
  const proof = await f.proof('declined');
  await assert.rejects(() => f.platform.subscriptions.reconcileReview({ ...input, proof: { ...proof, attemptKey: 'another_attempt' } }), { code: 'SUBSCRIPTION_PROOF_REQUIRED' });
  const result = await f.platform.subscriptions.reconcileReview({ ...input, proof });
  assert.equal(result.status, 'resolved_declined'); assert.equal(result.proofSource, 'operator_attestation_not_provider_verified');
  assert.equal((await f.platform.subscriptions.resumeReview(f.command('resume_after_attestation'))).status, 'active');
  assert.equal(f.charges(), 1); assert.deepEqual(await f.platform.subscriptions.runDue(), []);
});

test('known payment cannot be dismissed as declined or voided while its canonical order is payable', async t => {
  const f = await fixture(t, { existingOrder: true });
  await assert.rejects(async () => f.platform.subscriptions.reconcileReview(f.command('bad_paid_decline', { attemptId: f.attempt.id, resolution: 'declined', proof: await f.proof('declined') })), { code: 'SUBSCRIPTION_PAID_EVIDENCE' });
  await assert.rejects(async () => f.platform.subscriptions.reconcileReview(f.command('bad_payable_void', { attemptId: f.attempt.id, resolution: 'voided', proof: await f.proof('voided') })), { code: 'SUBSCRIPTION_ORDER_STILL_PAYABLE' });
  const cancelled = await f.platform.subscriptions.cancelReview(f.command('cancel_known_paid_hold'));
  assert.equal(cancelled.requiresReview, true); assert.equal(cancelled.paymentResolved, false); assert.equal(cancelled.refundAttempted, false);
  assert.equal((await f.db.query('SELECT charge_ref,status FROM subscription_attempts WHERE id=$1', [f.attempt.id])).rows[0].charge_ref, 'pi_sim_recovery_fixture');
});

test('cancel unknown retains the hold; explicit void is audited but can never resume a cancelled subscription', async t => {
  const f = await fixture(t, { unknown: true });
  const cancelled = await f.platform.subscriptions.cancelReview(f.command('cancel_unknown_hold'));
  assert.equal(cancelled.requiresReview, true); assert.equal(cancelled.paymentResolved, false);
  assert.equal((await f.db.query('SELECT status FROM subscription_attempts WHERE id=$1', [f.attempt.id])).rows[0].status, 'uncertain');
  const result = await f.platform.subscriptions.reconcileReview(f.command('void_cancelled_mock', { attemptId: f.attempt.id, resolution: 'voided', proof: await f.proof('voided') }));
  assert.equal(result.status, 'resolved_voided'); assert.equal(result.canResume, false);
  await assert.rejects(() => f.platform.subscriptions.resumeReview(f.command('resume_cancelled_fails')), { code: 'SUBSCRIPTION_NOT_PAUSED' });
  assert.equal(f.charges(), 1);
});

test('a known simulated payment with no order needs an explicit exact-ref void attestation', async t => {
  const f = await fixture(t); const before = await f.count('orders');
  const proof = await f.proof('voided');
  await assert.rejects(() => f.platform.subscriptions.reconcileReview(f.command('void_wrong_charge_ref', { attemptId: f.attempt.id, resolution: 'voided', proof: { ...proof, chargeRef: 'pi_sim_other' } })), { code: 'SUBSCRIPTION_PROOF_REQUIRED' });
  const result = await f.platform.subscriptions.reconcileReview(f.command('void_known_mock_exact', { attemptId: f.attempt.id, resolution: 'voided', proof }));
  assert.equal(result.status, 'resolved_voided'); assert.equal(result.chargeRef, 'pi_sim_recovery_fixture');
  assert.equal(result.proofSource, 'operator_attestation_not_provider_verified');
  assert.equal(await f.count('orders'), before); assert.equal(f.charges(), 1);
});

test('a mismatched stored canonical order fails before any recovery writes', async t => {
  const f = await fixture(t, { existingOrder: true });
  const other = (await f.db.query("SELECT id FROM orders WHERE order_ref='SANDBOX-EX-1042'")).rows[0];
  await f.db.query('UPDATE subscription_attempts SET order_id=$2 WHERE id=$1', [f.attempt.id, other.id]);
  const before = await f.count('orders');
  await assert.rejects(() => f.platform.subscriptions.reconcileReview(f.command('reject_wrong_order_identity', { attemptId: f.attempt.id, resolution: 'paid' })), { code: 'SUBSCRIPTION_ORDER_MISMATCH' });
  assert.equal(await f.count('orders'), before); assert.equal(await f.count('subscription_review_actions'), 0); assert.equal(f.charges(), 1);
});

test('recovery enforces price/fingerprint and cannot manufacture paid proof for legacy unknown results', async t => {
  const f = await fixture(t);
  await f.db.query("UPDATE products SET price_cents=price_cents+100 WHERE sku='BLOOM-COTTON-16'");
  const before = await f.count('orders');
  const review = await f.platform.subscriptions.reconcileReview(f.command('recover_changed_quote', { attemptId: f.attempt.id, resolution: 'paid' }));
  assert.equal(review.status, 'review'); assert.equal(review.error.code, 'QUOTE_CHANGED'); assert.equal(await f.count('orders'), before);
  await f.db.query('UPDATE subscription_attempts SET charge_evidence_enc=NULL,request_fingerprint=NULL WHERE id=$1', [f.attempt.id]);
  await assert.rejects(() => f.platform.subscriptions.reconcileReview(f.command('fake_paid_boolean', { attemptId: f.attempt.id, resolution: 'paid', proof: { success: true } })), { code: 'SUBSCRIPTION_PAID_PROOF_REQUIRED' });
  assert.equal(f.charges(), 1);
});

test('DSAR immediately before recovery canonical creation leaves no new order or cached shipping events', async t => {
  const f = await fixture(t); const beforeOrders = await f.count('orders'); const beforeEvents = await f.count('outbox_events');
  const original = f.domain.createSandboxOrder.bind(f.domain);
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { await f.platform.privacy.erase(f.shopper.id, 'owner', { confirm: 'DELETE' }); return original(...args); });
  const result = await f.platform.subscriptions.reconcileReview(f.command('recovery_erase_race', { attemptId: f.attempt.id, resolution: 'paid' }));
  assert.equal(result.status, 'review'); assert.equal(result.error.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(await f.count('orders'), beforeOrders); assert.equal(await f.count('outbox_events'), beforeEvents);
  assert.equal(f.charges(), 1);
});

test('in-flight worker attempts cannot be attested; cancellation safely fences recovery without refund assertions', async t => {
  const f = await fixture(t, { unknown: true });
  await f.db.query("UPDATE subscription_attempts SET status='charge_started' WHERE id=$1", [f.attempt.id]);
  const [row] = await f.platform.subscriptions.listReviews(); assert.equal(row.attempts[0].workerFenceRequired, true);
  assert.deepEqual(row.attempts[0].allowedActions, []);
  await assert.rejects(async () => f.platform.subscriptions.reconcileReview(f.command('inflight_attestation_denied', { attemptId: f.attempt.id, resolution: 'declined', proof: await f.proof('declined') })), { code: 'SUBSCRIPTION_WORKER_FENCE_REQUIRED' });
  const cancel = await f.platform.subscriptions.cancelReview(f.command('inflight_cancel_safe'));
  assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.paymentResolved, false); assert.equal(f.charges(), 1);
});

test('non-simulated subscription identities cannot use operator mock resolution', async t => {
  const f = await fixture(t, { unknown: true });
  await f.db.query("UPDATE subscriptions SET provider_ref='sub_real_external' WHERE id=$1", [f.sub.id]);
  const [row] = await f.platform.subscriptions.listReviews(); assert.deepEqual(row.attempts[0].allowedActions, []);
  await assert.rejects(async () => f.platform.subscriptions.reconcileReview(f.command('reject_nonsimulated_void', { attemptId: f.attempt.id, resolution: 'voided', proof: await f.proof('voided') })), { code: 'SUBSCRIPTION_NOT_SIMULATED' });
  assert.equal((await f.platform.subscriptions.cancelReview(f.command('cancel_nonsimulated_hold'))).paymentResolved, false);
  assert.equal(f.charges(), 1);
});

test('cancellation interrupts a pending recovery action without new order or hidden financial resolution', async t => {
  const f = await fixture(t); const before = await f.count('orders');
  let entered; let finish; const entry = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  const original = f.domain.createSandboxOrder.bind(f.domain);
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { entered(); await gate; return original(...args); });
  const recovery = f.platform.subscriptions.reconcileReview(f.command('pending_recover_interrupted', { attemptId: f.attempt.id, resolution: 'paid' }));
  await entry;
  const cancelled = await f.platform.subscriptions.cancelReview(f.command('cancel_pending_recovery'));
  assert.equal(cancelled.requiresReview, true); assert.equal(cancelled.paymentResolved, false);
  finish();
  const held = await recovery; assert.equal(held.error.code, 'SUBSCRIPTION_CANCELLED_DURING_REVIEW');
  assert.equal(await f.count('orders'), before); assert.equal(f.charges(), 1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM subscription_review_actions WHERE state='pending'")).rows[0].n, 0);
});

test('a persisted pending reservation can recover only its exact operation after restart', async t => {
  const f = await fixture(t);
  const input = f.command('recover_persisted_pending', { attemptId: f.attempt.id, resolution: 'paid' });
  // Capture the exact durable reservation shape, then simulate a stopped process
  // immediately after reserve (no subsequent provider or order write).
  const original = f.domain.createSandboxOrder.bind(f.domain); let failOnce = true;
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { if (failOnce) { failOnce = false; throw new Error('stopped fixture worker'); } return original(...args); });
  assert.equal((await f.platform.subscriptions.reconcileReview(input)).status, 'review');
  await f.db.transaction(async tx => {
    await tx.query("UPDATE subscription_review_actions SET state='pending',response=NULL,completed_at=NULL WHERE operation_id=$1", [input.operationId]);
    await tx.query("UPDATE subscription_attempts SET status='review_pending' WHERE id=$1", [f.attempt.id]);
  });
  await assert.rejects(() => f.platform.subscriptions.reconcileReview({ ...input, operationId: 'different_pending_attempt' }), { code: 'SUBSCRIPTION_REVIEW_BUSY' });
  const before = await f.count('orders');
  assert.equal((await f.platform.subscriptions.reconcileReview(input)).status, 'resolved_paid');
  assert.equal(await f.count('orders'), before + 1); assert.equal(f.charges(), 1);
});

test('continuation from a different caller can race the original request while preserving its actor and one order', async t => {
  const f = await fixture(t); const before = await f.count('orders');
  let firstEntered; let secondEntered; let finish; let entries = 0;
  const firstEntry = new Promise(resolve => { firstEntered = resolve; });
  const secondEntry = new Promise(resolve => { secondEntered = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  const original = f.domain.createSandboxOrder.bind(f.domain);
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { if (++entries === 1) firstEntered(); else secondEntered(); await gate; return original(...args); });
  const initial = f.platform.subscriptions.reconcileReview(f.command('continue_racing_original', { attemptId: f.attempt.id, resolution: 'paid' }));
  await firstEntry;
  const [review] = await f.platform.subscriptions.listReviews();
  assert.deepEqual(review.pendingActions.map(({ operationId, action, attemptId, actor }) => ({ operationId, action, attemptId, actor })),
    [{ operationId: 'continue_racing_original', action: 'reconcile_paid', attemptId: f.attempt.id, actor: 'owner' }]);
  const continuation = f.platform.subscriptions.continueReview({ subscriptionId: f.sub.id, operationId: review.pendingActions[0].operationId, actor: 'second_admin' });
  await secondEntry; finish();
  assert.equal((await initial).status, 'resolved_paid');
  const continued = await continuation;
  assert.equal(continued.status, 'resolved_paid'); assert.equal(continued.continued, true); assert.equal(continued.originalActor, 'owner');
  assert.equal(await f.count('orders'), before + 1); assert.equal(f.charges(), 1);
  const stored = (await f.db.query('SELECT actor,reason_enc FROM subscription_review_actions WHERE operation_id=$1', ['continue_racing_original'])).rows[0];
  assert.equal(stored.actor, 'owner'); assert.ok(!stored.reason_enc.includes(reason));
});

test('after reload a fresh service continues only the immutable server-owned request with no caller payload', async t => {
  const f = await fixture(t); const input = f.command('continue_after_reload', { attemptId: f.attempt.id, resolution: 'paid' });
  const original = f.domain.createSandboxOrder.bind(f.domain); let failOnce = true;
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { if (failOnce) { failOnce = false; throw new Error('fixture stopped after reservation'); } return original(...args); });
  assert.equal((await f.platform.subscriptions.reconcileReview(input)).status, 'review');
  await f.db.transaction(async tx => {
    await tx.query("UPDATE subscription_review_actions SET state='pending',response=NULL,completed_at=NULL WHERE operation_id=$1", [input.operationId]);
    await tx.query("UPDATE subscription_attempts SET status='review_pending' WHERE id=$1", [f.attempt.id]);
  });
  const restarted = createSubscriptions(f.db, { domain: f.domain, crm: f.platform.crm, bank: f.platform.bank, health: f.platform.health,
    clock: f.clock, secret: 'isolated-recovery-test-secret', charge: async () => assert.fail('Continuation must not charge') });
  const before = await f.count('orders');
  const result = await restarted.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'new_authenticated_admin' });
  assert.equal(result.status, 'resolved_paid'); assert.equal(result.originalActor, 'owner');
  assert.equal(await f.count('orders'), before + 1); assert.equal(f.charges(), 1);
  assert.equal((await restarted.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'third_admin' })).replayed, true);
  assert.equal(await f.count('orders'), before + 1);
});

test('continuation restores exact encrypted operator proof rather than accepting a replacement attestation', async t => {
  const f = await fixture(t, { unknown: true });
  const input = f.command('continue_saved_attestation', { attemptId: f.attempt.id, resolution: 'declined', proof: await f.proof('declined') });
  assert.equal((await f.platform.subscriptions.reconcileReview(input)).status, 'resolved_declined');
  await f.db.transaction(async tx => {
    await tx.query("UPDATE subscription_review_actions SET state='pending',response=NULL,completed_at=NULL WHERE operation_id=$1", [input.operationId]);
    await tx.query("UPDATE subscription_attempts SET status='review_pending' WHERE id=$1", [f.attempt.id]);
  });
  const result = await f.platform.subscriptions.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'second_admin' });
  assert.equal(result.status, 'resolved_declined'); assert.equal(result.proofSource, 'operator_attestation_not_provider_verified'); assert.equal(f.charges(), 1);
  await assert.rejects(() => f.platform.subscriptions.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'second_admin', reason: 'Caller replacement reason.' }), { code: 'VALIDATION_ERROR' });
});

test('continuation rejects wrong targets and tampered saved request evidence without dispatch', async t => {
  const f = await fixture(t); const input = f.command('continue_tamper_guard', { attemptId: f.attempt.id, resolution: 'paid' });
  await f.platform.subscriptions.reconcileReview(input);
  const before = await f.count('orders');
  const other = await f.platform.subscriptions.create(f.shopper.id, { items, shipTo });
  await assert.rejects(() => f.platform.subscriptions.continueReview({ subscriptionId: other.id, operationId: input.operationId, actor: 'second_admin' }), { code: 'NOT_FOUND' });
  await f.db.query("UPDATE subscription_review_actions SET request_hash='tampered' WHERE operation_id=$1", [input.operationId]);
  await assert.rejects(() => f.platform.subscriptions.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'second_admin' }), { code: 'SUBSCRIPTION_REVIEW_EVIDENCE_INVALID' });
  assert.equal(await f.count('orders'), before); assert.equal(f.charges(), 1);
});

test('cancelled pending operations replay their hold instead of restarting canonical creation', async t => {
  const f = await fixture(t); const input = f.command('continue_cancelled_pending', { attemptId: f.attempt.id, resolution: 'paid' });
  const original = f.domain.createSandboxOrder.bind(f.domain); let failOnce = true;
  t.mock.method(f.domain, 'createSandboxOrder', async (...args) => { if (failOnce) { failOnce = false; throw new Error('fixture stopped after reserve'); } return original(...args); });
  await f.platform.subscriptions.reconcileReview(input);
  await f.db.transaction(async tx => {
    await tx.query("UPDATE subscription_review_actions SET state='pending',response=NULL,completed_at=NULL WHERE operation_id=$1", [input.operationId]);
    await tx.query("UPDATE subscription_attempts SET status='review_pending' WHERE id=$1", [f.attempt.id]);
  });
  const before = await f.count('orders');
  await f.platform.subscriptions.cancelReview(f.command('cancel_before_continue'));
  const result = await f.platform.subscriptions.continueReview({ subscriptionId: f.sub.id, operationId: input.operationId, actor: 'second_admin' });
  assert.equal(result.replayed, true); assert.equal(result.requiresReview, true); assert.equal(result.error.code, 'SUBSCRIPTION_CANCELLED_DURING_REVIEW');
  assert.equal(await f.count('orders'), before); assert.equal(f.charges(), 1);
});
