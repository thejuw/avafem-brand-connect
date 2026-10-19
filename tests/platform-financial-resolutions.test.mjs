import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture, DAY } from './helpers/platform-fixture.mjs';

const reason = 'Reviewed synthetic sandbox financial adjustment';
const input = (key, extra = {}) => ({ reason, idempotencyKey: key, ...extra });
async function fixture(t, { loss = true, credits = true } = {}) {
  const f = await platformFixture(t);
  const orderId = await f.seedOrder();
  const bag = await f.domain.getBag((await f.bagFor(orderId, 'brand_hearth')).id);
  const shopper = await f.platform.crm.upsertShopper({ email: 'resolution-fixture@example.test' });
  await f.platform.crm.linkOrder(shopper.id, orderId);
  if (credits) await f.platform.bank.earnForOrder(shopper.id, orderId);
  const transfer = (await f.db.query('SELECT * FROM transfers WHERE bag_id=$1', [bag.id])).rows[0];
  const credit = (await f.db.query('SELECT * FROM credits WHERE bag_id=$1', [bag.id])).rows[0];
  const lot = (await f.platform.bank.lots(shopper.id)).find(l => l.bagId === bag.id);
  let dispute;
  if (loss) { dispute = await f.platform.console.openDispute({ externalId: 'dp_resolution_fixture', bagId: bag.id }); await f.platform.console.resolveDispute(dispute.id, 'lost'); }
  return { ...f, con: f.platform.console, bag, shopper, transfer, credit, lot, dispute };
}
const recover = (f, key = 'recovery-evidence-01') => f.con.resolveLostDispute(f.dispute.id, input(key, { resolution: 'operator_verified_recovery', recoveryReference: 'sandbox-evidence-0001' }), 'owner');

test('lost recovery is separately audited/encrypted and cannot bypass a return window or a second dispute', async t => {
  const f = await fixture(t);
  const result = await recover(f);
  assert.equal(result.disputeStatus, 'lost'); assert.equal(result.cashRecoveredCents, 0); assert.equal(result.providerWrites, false);
  assert.equal((await f.db.query('SELECT status FROM disputes WHERE id=$1', [f.dispute.id])).rows[0].status, 'lost');
  await assert.rejects(f.con.releaseHold(f.transfer.id, input('release-too-early'), 'owner'), e => e.code === 'HOLD_BLOCKED');
  const other = await f.con.openDispute({ externalId: 'dp_second_fixture', bagId: f.bag.id });
  await f.con.resolveDispute(other.id, 'won');
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1', [f.transfer.id])).rows[0].status, 'held', 'a separate won dispute cannot implicitly bypass the audited release');
  f.advance(31);
  const released = await f.con.releaseHold(f.transfer.id, input('audited-release-01'), 'owner');
  assert.equal(released.status, 'scheduled');
  assert.equal((await f.con.releaseHold(f.transfer.id, input('audited-release-01'), 'owner')).replayed, true);
  const history = await f.con.resolutionHistory({ bagId: f.bag.id });
  assert.equal(history.length, 2); assert.ok(history.every(r => r.reason === reason));
  assert.ok(!JSON.stringify((await f.db.query('SELECT * FROM financial_resolutions')).rows).includes(reason));
  assert.equal((await f.domain.dashboard()).summary.ledgerBalanced, true);
});

test('operator resolutions require evidence/reason/idempotency and cannot reuse keys for another decision', async t => {
  const f = await fixture(t);
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, { resolution: 'operator_verified_recovery' }, 'owner'), e => e.code === 'RESOLUTION_AUDIT_REQUIRED');
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('short-reason-01', {resolution:'writeoff',reason:'ok'}), 'owner'), e => e.code === 'RESOLUTION_AUDIT_REQUIRED');
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('missing-evidence', { resolution: 'operator_verified_recovery' }), 'owner'), e => e.code === 'RECOVERY_EVIDENCE_REQUIRED');
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('bad-evidence-01', { resolution: 'operator_verified_recovery', recoveryReference: 'person@example.test' }), 'owner'), e => e.code === 'INVALID_RECOVERY_REFERENCE');
  const [a, b] = await Promise.all([recover(f), recover(f)]);
  assert.equal(a.resolutionId, b.resolutionId); assert.equal([a, b].filter(r => r.replayed).length, 1);
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('recovery-evidence-01', { resolution: 'writeoff' }), 'owner'), e => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('other-resolution-key', { resolution: 'writeoff' }), 'owner'), e => e.code === 'DISPUTE_RECOVERY_RESOLVED');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM financial_resolutions')).rows[0].n, 1);
});

test('release preserves current/prior return promises, refunds, unavailable brands and provider isolation', async t => {
  const f = await fixture(t); await recover(f); f.advance(31);
  const checks = [
    ["UPDATE brands SET status='paused' WHERE id='brand_hearth'", "UPDATE brands SET status='ready' WHERE id='brand_hearth'"],
    ["UPDATE bags SET provider_bound=TRUE WHERE id=$1", "UPDATE bags SET provider_bound=FALSE WHERE id=$1"],
    ["UPDATE brands SET return_window_days=90 WHERE id='brand_hearth'", "UPDATE brands SET return_window_days=30 WHERE id='brand_hearth'"],
    ["UPDATE bags SET refunded_cents=1 WHERE id=$1", "UPDATE bags SET refunded_cents=0 WHERE id=$1"],
    ["UPDATE jobs SET status='failed' WHERE bag_id=$1", "UPDATE jobs SET status='held' WHERE bag_id=$1"],
    ["UPDATE transfers SET paid_at=NOW() WHERE bag_id=$1", "UPDATE transfers SET paid_at=NULL WHERE bag_id=$1"],
    ["UPDATE transfers SET amount_cents=amount_cents+1 WHERE bag_id=$1", "UPDATE transfers SET amount_cents=amount_cents-1 WHERE bag_id=$1"],
  ];
  for (const [set, reset] of checks) {
    await f.db.query(set, set.includes('$1') ? [f.bag.id] : []);
    await assert.rejects(f.con.releaseHold(f.transfer.id, input('gate-release-0001'), 'owner'), e => e.code === 'HOLD_BLOCKED');
    await f.db.query(reset, reset.includes('$1') ? [f.bag.id] : []);
  }
  const proposed = await f.domain.requestRefund(f.bag.id, { reason: 'Synthetic pending return' });
  await assert.rejects(f.con.releaseHold(f.transfer.id, input('gate-release-0001'), 'owner'), e => e.code === 'HOLD_BLOCKED');
  await f.db.query("UPDATE refunds SET status='rejected' WHERE id=$1", [proposed.id]);
  const other = await f.con.openDispute({ externalId: 'dp_unresolved_other', bagId: f.bag.id });
  await assert.rejects(f.con.releaseHold(f.transfer.id, input('gate-release-0001'), 'owner'), e => e.code === 'HOLD_BLOCKED');
  await f.con.resolveDispute(other.id, 'won');
  const future = new Date(f.clock().getTime() + 10 * DAY);
  await f.db.query('UPDATE transfers SET due_at=$2 WHERE id=$1', [f.transfer.id, future]);
  await assert.rejects(f.con.releaseHold(f.transfer.id, input('gate-release-0001'), 'owner'), e => e.code === 'HOLD_BLOCKED');
  const listed = (await f.con.holds()).find(h => h.transferId === f.transfer.id);
  assert.ok(listed.holdReasons.includes('RETURN_WINDOW_OPEN'));
  assert.equal(listed.eligibleAt, future.toISOString());
});

test('whole-Bag writeoff is noncash, cancels only the payable, voids pending credits and balances liabilities', async t => {
  const f = await fixture(t);
  const clearing = (await f.db.query("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE account='sandbox_clearing'")).rows[0].n;
  const result = await f.con.resolveLostDispute(f.dispute.id, input('whole-bag-writeoff-01', { resolution: 'writeoff' }), 'owner');
  assert.equal(result.cashRecoveredCents, 0); assert.equal(result.shopperRefunded, false); assert.equal(result.noncashAdjustment, true);
  assert.equal(result.payableWrittenOffCents, f.transfer.amount_cents);
  assert.equal((await f.db.query('SELECT status FROM bags WHERE id=$1', [f.bag.id])).rows[0].status, 'delivered');
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1', [f.transfer.id])).rows[0].status, 'cancelled');
  assert.equal((await f.db.query('SELECT status FROM credits WHERE id=$1', [f.credit.id])).rows[0].status, 'voided');
  assert.equal((await f.db.query('SELECT status FROM jobs WHERE bag_id=$1', [f.bag.id])).rows[0].status, 'cancelled');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE account='sandbox_clearing'")).rows[0].n, clearing);
  const liability = await f.platform.bank.liabilityReport();
  assert.equal(liability.writtenOffCents, f.lot.amountCents); assert.equal(liability.balanced, true);
  assert.equal((await f.domain.dashboard()).summary.ledgerBalanced, true);
  const payable = (await f.db.query("SELECT COALESCE(SUM(e.credit_cents-e.debit_cents),0)::int AS n FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 AND e.account='brand_payable'", [f.bag.id])).rows[0].n;
  assert.equal(payable, 0);
  assert.equal((await f.con.resolveLostDispute(f.dispute.id, input('whole-bag-writeoff-01', { resolution: 'writeoff' }), 'owner')).replayed, true);
  f.advance(90); await f.domain.runDueSandboxPayouts();
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1', [f.transfer.id])).rows[0].status, 'cancelled');
  await assert.rejects(f.con.releaseHold(f.transfer.id, input('cannot-undo-writeoff'), 'owner'), e => e.code === 'NOT_HELD');
});

test('writeoff refuses provider-bound, paid, refunded, spent-credit or unreconciled payable states', async t => {
  const f = await fixture(t);
  const attempt = key => f.con.resolveLostDispute(f.dispute.id, input(key, { resolution: 'writeoff' }), 'owner');
  await f.db.query('UPDATE bags SET provider_bound=TRUE WHERE id=$1', [f.bag.id]);
  await assert.rejects(attempt('provider-writeoff'), e => e.code === 'PROVIDER_WORKFLOW_REQUIRED');
  await f.db.query('UPDATE bags SET provider_bound=FALSE WHERE id=$1', [f.bag.id]);
  await f.db.query("UPDATE transfers SET status='paid',paid_at=NOW() WHERE id=$1", [f.transfer.id]);
  await assert.rejects(attempt('paid-writeoff-01'), e => e.code === 'PAYABLE_NOT_WRITABLE');
  await f.db.query("UPDATE transfers SET status='held',paid_at=NULL WHERE id=$1", [f.transfer.id]);
  await f.db.query('UPDATE bags SET refunded_cents=1 WHERE id=$1', [f.bag.id]);
  await assert.rejects(attempt('partial-writeoff'), e => e.code === 'REFUND_REVIEW_REQUIRED');
  await f.db.query('UPDATE bags SET refunded_cents=0 WHERE id=$1', [f.bag.id]);
  await f.db.query("UPDATE bank_lots SET state='VAULT' WHERE id=$1", [f.lot.id]);
  await assert.rejects(attempt('spent-writeoff-01'), e => e.code === 'CREDIT_CLAWBACK_REQUIRED');
  await f.db.query("UPDATE bank_lots SET state='LAB' WHERE id=$1", [f.lot.id]);
  await f.db.query('UPDATE transfers SET amount_cents=amount_cents+1 WHERE id=$1', [f.transfer.id]);
  await assert.rejects(attempt('ledger-writeoff-01'), e => e.code === 'LEDGER_RECONCILIATION_REQUIRED');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM financial_resolutions')).rows[0].n, 0);
});

test('standalone pending-credit review releases canonical/LAB only after all gates and is idempotent', async t => {
  const f = await fixture(t);
  let list = (await f.con.pendingCredits({ brandId: f.bag.brandId, shopperId: f.shopper.id }));
  assert.equal(list.length, 2); assert.ok(list.every(c => c.holdReasons.includes('DISPUTE_RECOVERY_REQUIRED')));
  await assert.rejects(f.con.resolvePendingCredit(f.credit.id, input('early-credit-release', { action: 'release' }), 'owner'), e => e.code === 'CREDIT_RELEASE_BLOCKED');
  await recover(f); f.advance(31);
  await f.con.releaseHold(f.transfer.id, input('credit-hold-release'), 'owner');
  const canonical = await f.con.resolvePendingCredit(f.credit.id, input('canonical-release-01', { action: 'release' }), 'owner');
  const lab = await f.con.resolvePendingCredit(f.lot.id, input('lab-release-0001', { action: 'release' }), 'owner');
  assert.equal(canonical.status, 'released'); assert.equal(lab.status, 'VAULT');
  assert.equal((await f.con.resolvePendingCredit(f.lot.id, input('lab-release-0001', { action: 'release' }), 'owner')).replayed, true);
  list = await f.con.pendingCredits({ brandId: f.bag.brandId }); assert.equal(list.length, 0);
  assert.equal((await f.platform.bank.liabilityReport()).balanced, true);
  assert.equal((await f.domain.dashboard()).summary.ledgerBalanced, true);
});

test('pending credit writeoffs are atomic and cannot double-book under concurrent operator actions', async t => {
  const f = await fixture(t, { loss: false });
  const calls = await Promise.all([f.con.resolvePendingCredit(f.credit.id, input('canonical-writeoff', { action: 'writeoff' }), 'owner'), f.con.resolvePendingCredit(f.credit.id, input('canonical-writeoff', { action: 'writeoff' }), 'owner')]);
  assert.equal(calls[0].resolutionId, calls[1].resolutionId);
  await f.con.resolvePendingCredit(f.lot.id, input('lab-writeoff-0001', { action: 'writeoff' }), 'owner');
  assert.equal((await f.platform.bank.liabilityReport()).balanced, true);
  assert.equal((await f.domain.dashboard()).summary.ledgerBalanced, true);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM bank_events WHERE lot_id=$1 AND kind='written_off'", [f.lot.id])).rows[0].n, 1);
});

test('failed atomic audit persistence rolls back writeoff ledger, payable and credit transitions', async t => {
  const f = await fixture(t);
  const original = f.db.transaction.bind(f.db);
  const mock = t.mock.method(f.db, 'transaction', fn => original(tx => fn({ query: (sql, params) => {
    if (/INSERT INTO financial_resolutions/.test(sql)) throw new Error('synthetic audit persistence failure');
    return tx.query(sql, params);
  } })));
  await assert.rejects(f.con.resolveLostDispute(f.dispute.id, input('atomic-writeoff-01', { resolution: 'writeoff' }), 'owner'), /synthetic audit persistence failure/);
  mock.mock.restore();
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1', [f.transfer.id])).rows[0].status, 'held');
  assert.equal((await f.db.query('SELECT status FROM credits WHERE id=$1', [f.credit.id])).rows[0].status, 'pending');
  assert.equal((await f.platform.bank.lots(f.shopper.id)).find(l => l.id === f.lot.id).state, 'LAB');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM ledger_journals WHERE kind='operator_payable_writeoff'")).rows[0].n, 0);
});

test('closed disputes cannot be reopened by concurrent stale evidence and a different won dispute cannot release loss', async t => {
  const f = await fixture(t, { loss: false });
  const d = await f.con.openDispute({ externalId: 'dp_race_closed', bagId: f.bag.id });
  await Promise.allSettled([f.con.resolveDispute(d.id, 'lost'), f.con.submitEvidence(d.id, { note: 'Synthetic stale evidence' })]);
  assert.equal((await f.db.query('SELECT status FROM disputes WHERE id=$1', [d.id])).rows[0].status, 'lost');
  assert.equal((await f.con.resolveDispute(d.id, 'won')).status, 'lost');
  await assert.rejects(f.con.submitEvidence(d.id, { note: 'Late evidence' }), e => e.code === 'DISPUTE_CLOSED');
});

test('later credit earning cannot recreate LAB liability after a whole-Bag payable writeoff', async t => {
  const f = await fixture(t, { credits: false });
  await f.con.resolveLostDispute(f.dispute.id, input('no-future-credit-writeoff', { resolution: 'writeoff' }), 'owner');
  const created = await f.platform.bank.earnForOrder(f.shopper.id, f.bag.orderId);
  assert.ok(created.every(l => l.bagId !== f.bag.id));
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM bank_lots WHERE bag_id=$1', [f.bag.id])).rows[0].n, 0);
  assert.equal((await f.platform.bank.liabilityReport()).balanced, true);
});

test('manual LAB release and pending list preserve a previously promised lot maturity date', async t => {
  const f = await fixture(t, { loss: false }); f.advance(31);
  const promised = new Date(f.clock().getTime() + 10 * DAY).toISOString();
  await f.db.query('UPDATE bank_lots SET matures_at=$2 WHERE id=$1', [f.lot.id, promised]);
  const listed = (await f.con.pendingCredits()).find(c => c.id === f.lot.id);
  assert.equal(listed.eligibleAt, promised);
  assert.ok(listed.holdReasons.includes('RETURN_WINDOW_OPEN'));
  await assert.rejects(f.con.resolvePendingCredit(f.lot.id, input('promised-lab-release', { action: 'release' }), 'owner'), e => e.code === 'CREDIT_RELEASE_BLOCKED');
  f.advance(11);
  assert.equal((await f.con.resolvePendingCredit(f.lot.id, input('promised-lab-release', { action: 'release' }), 'owner')).status, 'VAULT');
  assert.equal((await f.platform.bank.lots(f.shopper.id)).find(l => l.id === f.lot.id).maturesAt, promised);
});
