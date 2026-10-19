import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderAutomation } from '../server/provider-automation.mjs';
import { APPROVED_TEST_PLATFORM_SWITCH } from '../server/provider-platform-switch.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';

// These are mocked orchestration tests, never live Stripe/Shopify evidence.
const TARGET = APPROVED_TEST_PLATFORM_SWITCH.toAccountId;
const RUN = `uco_${'d'.repeat(32)}`;
async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: 'unit-automation-session-not-real', encryptionKey: 'unit-automation-encryption-not-real' });
  const instant = new Date('2026-10-19T12:00:00.000Z'); let clock = instant;
  const controls = { mode: 'test', platform: TARGET, report: 'matched', partial: false, readFailure: false,
    unknownTransfer: false, unknownPayout: false, beforeSettle: null, payoutPending: false, pendingReports: false,
    extraPending: false, badPendingCount: false };
  const rows = TEST_STORES.map((store, index) => ({ shop: store.shop, brand_id: `brand_auto_${index}`, state: 'connected',
    connected_account_id: `acct_unitrecipient${index}123`, connected_account_created_in_test: true, connected_account_verified: true,
    return_window_days: 30 }));
  const stores = { row: async shop => ({ ...rows.find(row => row.shop === shop) }) };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => assert.fail('No provider call is permitted in automation fixtures.'), clock: () => clock });
  const calls = { preflight: 0, sync: [], reconcile: 0, reports: 0, settle: 0, transfers: [], payouts: [] }; let guard;
  const load = async runId => unified.runtime.decode(await unified.runtime.read(runId));
  const mutate = async (change, runId = RUN) => {
    const value = await load(runId); change(value.details, value.snapshot);
    await db.query('UPDATE unified_checkout_runs SET details_encrypted=$2,snapshot_encrypted=$3 WHERE id=$1', [runId, auth.encrypt(value.details), auth.encrypt(value.snapshot)]);
  };
  const money = {
    setAutomationGuard: value => { guard = value; },
    reconcile: async ({ runId }) => { calls.reconcile++; return unified.get(runId); },
    settle: async ({ runId, automationPolicyId }) => {
      if (controls.beforeSettle) { const before = controls.beforeSettle; controls.beforeSettle = null; await before(); }
      return unified.runtime.withRun(runId, async ctx => {
        await guard(ctx, { action: 'settle', automationPolicyId }); calls.settle++;
        for (const [index, bag] of ctx.snapshot.bags.entries()) {
          const detail = ctx.details.bags[bag.id];
          if (detail.fullyDelivered !== true) continue;
          if (detail.transferOp?.startedAt) continue;
          const prior = Object.values(detail.refundOps ?? {}).filter(op => op.stripeStatus === 'succeeded' && !op.afterTransfer).reduce((sum, op) => sum + op.recoveryCents, 0);
          detail.transferOp = { startedAt: clock.toISOString(), amountCents: detail.transferCents - prior,
            accountId: rows[index].connected_account_id, status: controls.unknownTransfer ? 'uncertain' : 'verified' };
          calls.transfers.push({ runId, bagId: bag.id, amountCents: detail.transferOp.amountCents });
          if (!controls.unknownTransfer) { detail.transferId = `tr_unittransfer${index}123`; detail.transferOp.id = detail.transferId; }
        }
        await ctx.save();
      });
    },
    payout: async ({ runId, bagId, operationId, automationPolicyId }) => unified.runtime.withRun(runId, async ctx => {
      await guard(ctx, { action: 'payout', bagId, operationId, automationPolicyId });
      const detail = ctx.details.bags[bagId]; if (detail.payoutOp?.startedAt) return;
      const recovered = Object.values(detail.refundOps ?? {}).filter(op => op.stripeStatus === 'succeeded' && op.afterTransfer && op.reversalVerified).reduce((sum, op) => sum + op.recoveryCents, 0);
      detail.payoutOp = { operationId, startedAt: clock.toISOString(), amountCents: detail.transferOp.amountCents - recovered,
        status: controls.unknownPayout ? 'uncertain' : controls.payoutPending ? 'pending' : 'paid' };
      calls.payouts.push({ runId, bagId, operationId, amountCents: detail.payoutOp.amountCents });
      if (!controls.unknownPayout) detail.payoutId = detail.payoutOp.id = `po_unitpayout${ctx.snapshot.bags.findIndex(bag => bag.id === bagId)}123`;
      await ctx.save();
    }),
  };
  const fulfillment = { sync: async ({ runId, bagId }) => {
    calls.sync.push({ runId, bagId });
    if (controls.readFailure) throw new Error('PRIVATE_TOKEN_MUST_NOT_ESCAPE');
    if (controls.partial) await mutate(details => { details.bags[bagId].fullyDelivered = false; }, runId);
    return unified.get(runId);
  } };
  const reconciliation = { reconcile: async ({ runId }) => {
    calls.reports++; const value = await load(runId);
    const checks = [{ name: 'exact_cents', status: controls.report === 'mismatch' ? 'mismatch' : 'matched' }];
    if (controls.pendingReports) for (const bag of value.snapshot.bags) if (value.details.bags[bag.id].payoutOp?.status === 'pending')
      checks.push({ name: `${bag.id}:stripe_payout_status`, status: 'pending', code: 'PAYOUT_NOT_PAID' });
    if (controls.extraPending && checks.length > 1) checks.push({ name: 'unknown_refund', status: 'pending', code: 'ACTUAL_REFUND_REQUIRED' });
    const pending = checks.filter(check => check.status === 'pending').length;
    return { runId, test: true, status: controls.report === 'mismatch' ? 'mismatch' : pending ? 'pending' : controls.report,
      mismatchCount: controls.report === 'mismatch' ? 1 : 0, pendingCount: controls.badPendingCount && pending ? pending + 1 : pending, checks };
  } };
  const stripe = { preflight: async () => { calls.preflight++; return { verified: true, mode: controls.mode, accountId: controls.platform }; } };
  const automation = await createProviderAutomation(db, auth, { runtime: unified.runtime, stores, getStripe: () => stripe,
    providerMoney: money, providerFulfillment: fulfillment, providerReconciliation: reconciliation, clock: () => clock });
  async function add(runId = RUN) {
    const suffix = runId.slice(-4);
    const snapshot = { id: runId, currency: 'USD', bags: TEST_STORES.map((store, index) => ({ id: `bag_auto_${suffix}_${index}`, shop: store.shop,
      brandId: rows[index].brand_id, name: store.name, shippingCents: store.shippingCents, commissionBps: 1500, returnWindowDays: 30,
      items: [{ sku: `TEST-${index}`, qty: 2, unitPriceCents: 100 }] })) };
    const details = { accountId: TARGET, paymentVerified: true, paymentIntentId: `pi_unitpayment${suffix}`, chargeId: `ch_unitcharge${suffix}`,
      canonicalCommitted: true, testClock: { now: '2026-12-01T12:00:00.000Z' },
      privateFixture: { address: 'PRIVATE_ADDRESS', email: 'PRIVATE_EMAIL', token: 'PRIVATE_TOKEN' },
      bags: Object.fromEntries(snapshot.bags.map((bag, index) => [bag.id, { verified: true, orderId: `gid://shopify/Order/${9000 + index}`,
        fullyDelivered: true, deliveredAt: '2026-10-01T12:00:00.000Z', payoutDueAt: '2026-10-31T12:00:00.000Z',
        subtotalCents: 200, shippingCents: bag.shippingCents, taxCents: 18, totalCents: 218 + bag.shippingCents,
        commissionCents: 30, transferCents: 170 + bag.shippingCents, refundCents: 0, state: 'delivered' }])) };
    await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted,charge_id)
      VALUES($1,$2,$3,'delivered',$4,$5,$6)`, [runId, `request_${runId}`, `cart_${runId}`, auth.encrypt(snapshot), auth.encrypt(details), details.chargeId]);
    return snapshot;
  }
  const snapshot = await add();
  const input = (runId = RUN, selected = snapshot) => ({ runId, confirmTest: true, autoSettle: true, autoPayout: true,
    payoutGates: selected.bags.map((bag, index) => ({ bagId: bag.id, refundOperationId: `planned_refund_${index}` })) });
  const gates = async ({ afterTransfer = true, reversal = true } = {}, runId = RUN) => mutate((details, value) => {
    for (const [index, bag] of value.bags.entries()) details.bags[bag.id].refundOps = { [`planned_refund_${index}`]: {
      id: `prf_unit${index}`, status: 'complete', stripeStatus: 'succeeded', stripeRefundId: `re_unitrefund${index}123`, shopifyRefundId: `gid://shopify/Refund/${9500 + index}`,
      amountCents: 54, recoveryCents: 42, afterTransfer: index === 1 ? false : afterTransfer, reversalVerified: reversal,
      ...(afterTransfer && reversal ? { reversalId: `trr_unitreversal${index}123` } : {}),
    } };
  }, runId);
  return { db, auth, unified, automation, money, controls, rows, calls, snapshot, input, gates, mutate, add, load,
    now: value => { clock = new Date(value); }, guard: (...args) => guard(...args) };
}

test('existing runs are manual by default and due polling cannot create any money without explicit opt-in', async t => {
  const f = await fixture(t); assert.equal((await f.automation.get(RUN)).configured, false);
  assert.equal((await f.automation.runDue()).checked, 0); assert.equal((await f.automation.advance({ runId: RUN })).outcome, 'manual_or_disabled');
  assert.equal(f.calls.preflight + f.calls.settle + f.calls.reconcile + f.calls.sync.length + f.calls.payouts.length, 0);
  await assert.rejects(f.automation.configure({ ...f.input(), confirmTest: false }), { code: 'AUTOMATION_CONFIRMATION_REQUIRED' });
  assert.equal(f.calls.transfers.length, 0);
});

test('owner policy freezes all recipients and future exact per-Bag refund gates, replays once and cannot be changed or rearmed', async t => {
  const f = await fixture(t), first = await f.automation.configure(f.input());
  assert.equal(first.enabled, true); assert.equal(first.payoutGates.length, 3); assert.equal(first.platformAccountId, TARGET);
  assert.equal((await f.automation.configure(f.input())).policyId, first.policyId); assert.equal(f.calls.preflight, 1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM provider_automation_policies')).rows[0].n, 1);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|encrypted|secret/i);
  const changed = f.input(); changed.payoutGates[0].refundOperationId = 'different_refund';
  await assert.rejects(f.automation.configure(changed), { code: 'AUTOMATION_POLICY_IMMUTABLE' });
  assert.equal((await f.automation.disable({ runId: RUN, confirmTest: true })).enabled, false);
  await assert.rejects(f.automation.configure(f.input()), { code: 'AUTOMATION_REARM_DENIED' });
  assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0);
});

test('automatic settlement does not drain recipients before the named refund probe; pre-transfer and verified after-transfer refunds both unlock exact remainders', async t => {
  const f = await fixture(t); await f.automation.configure(f.input());
  const beforeRefund = await f.automation.advance({ runId: RUN }); assert.equal(beforeRefund.outcome, 'awaiting_named_refund_gate');
  assert.equal(f.calls.transfers.length, 3); assert.equal(f.calls.payouts.length, 0);
  await f.gates({ reversal: false }); await f.automation.advance({ runId: RUN });
  assert.equal(f.calls.payouts.length, 1, 'The complete pre-transfer Store4 refund needs no reversal; other Bags remain held.');
  await f.gates(); const completed = await f.automation.advance({ runId: RUN }); assert.equal(completed.outcome, 'completed');
  assert.equal(f.calls.transfers.length, 3); assert.equal(f.calls.payouts.length, 3);
  assert.ok(f.calls.payouts.every(call => /^auto_payout_[a-f0-9]{32}$/.test(call.operationId)));
  assert.equal(new Set(f.calls.payouts.map(call => call.operationId)).size, 3);
  assert.equal((await f.automation.get(RUN)).enabled, false); assert.ok((await f.automation.get(RUN)).completedAt);
  await f.automation.advance({ runId: RUN }); assert.equal(f.calls.payouts.length, 3);
});

test('partial delivery, open or extended return promises and unresolved refund/cancellation intents cannot trigger automatic money', async t => {
  for (const mode of ['partial','early','extended','refund','cancel']) await t.test(mode, async child => {
    const f = await fixture(child); await f.automation.configure(f.input());
    if (mode === 'partial') f.controls.partial = true;
    if (mode === 'early') await f.mutate(details => { details.testClock.now = '2026-10-15T12:00:00.000Z'; });
    if (mode === 'extended') f.rows.forEach(row => { row.return_window_days = 90; });
    if (mode === 'refund') await f.mutate(details => { Object.values(details.bags).forEach(bag => { bag.refundOps = { unknown: { status: 'refund_uncertain' } }; }); });
    if (mode === 'cancel') await f.mutate(details => { Object.values(details.bags).forEach(bag => { bag.cancelOp = { status: 'cancel_uncertain' }; }); });
    await f.automation.advance({ runId: RUN });
    assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0);
  });
});

test('fresh fulfillment failures or unmatched cent evidence stop new money and sanitized due retries back off', async t => {
  const f = await fixture(t); await f.automation.configure(f.input()); f.controls.readFailure = true;
  const failed = await f.automation.runDue(); assert.equal(failed.results[0].outcome, 'review_hold');
  assert.doesNotMatch(JSON.stringify([failed, await f.automation.get(RUN)]), /PRIVATE_TOKEN/);
  assert.equal((await f.automation.runDue()).checked, 0);
  f.controls.readFailure = false; f.controls.report = 'mismatch'; f.now('2026-10-19T12:01:01.000Z');
  const report = await f.automation.runDue(); assert.equal(report.results[0].outcome, 'cent_reconciliation_hold');
  assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0);
});

test('live/foreign platforms and unverified, duplicated or changed recipients fail closed without automatic provider writes', async t => {
  for (const mode of ['live','platform','unverified','duplicate','changed']) await t.test(mode, async child => {
    const f = await fixture(child);
    if (mode === 'live') f.controls.mode = 'live';
    if (mode === 'platform') f.controls.platform = APPROVED_TEST_PLATFORM_SWITCH.fromAccountId;
    if (mode === 'unverified') f.rows[0].connected_account_verified = false;
    if (mode === 'duplicate') f.rows[0].connected_account_id = f.rows[1].connected_account_id;
    if (mode === 'changed') { await f.automation.configure(f.input()); f.rows[0].connected_account_id = 'acct_changedrecipient123'; await assert.rejects(f.automation.advance({ runId: RUN })); }
    else await assert.rejects(f.automation.configure(f.input()));
    assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0);
  });
});

test('inside-lease guard observes revocation after worker inspection and prevents a stale automatic settlement', async t => {
  const f = await fixture(t); await f.automation.configure(f.input());
  f.controls.beforeSettle = () => f.automation.disable({ runId: RUN, confirmTest: true });
  const result = await f.automation.advance({ runId: RUN }); assert.equal(result.outcome, 'settlement_review');
  assert.equal(f.calls.transfers.length, 0); assert.equal((await f.automation.get(RUN)).enabled, false);
});

test('unknown transfer/payout outcomes never create replacement IDs after restart-style rechecks or 24 hours', async t => {
  for (const mode of ['transfer','payout']) await t.test(mode, async child => {
    const f = await fixture(child); await f.automation.configure(f.input()); await f.gates();
    if (mode === 'transfer') f.controls.unknownTransfer = true; else f.controls.unknownPayout = true;
    await f.automation.advance({ runId: RUN }); const before = { transfers: f.calls.transfers.length, payouts: f.calls.payouts.length };
    f.now('2026-10-21T12:00:00.000Z'); await f.automation.advance({ runId: RUN });
    assert.equal(f.calls.transfers.length, before.transfers); assert.equal(f.calls.payouts.length, before.payouts);
  });
});

test('fair persisted due scheduling reaches a sixth/seventh opted-in run and concurrent ticks claim once', async t => {
  const f = await fixture(t); f.controls.partial = true; await f.automation.configure(f.input());
  const ids = [RUN];
  for (let index = 1; index <= 6; index++) {
    const id = `uco_${index.toString(16).padStart(32,'0')}`, snapshot = await f.add(id); ids.push(id);
    await f.automation.configure(f.input(id, snapshot));
  }
  const [first, concurrent] = await Promise.all([f.automation.runDue(), f.automation.runDue()]);
  assert.equal(new Set([...first.results, ...concurrent.results].map(result => result.runId)).size, first.checked + concurrent.checked);
  await f.automation.runDue();
  const observed = new Set(f.calls.sync.map(call => call.runId)); assert.ok(ids.every(id => observed.has(id)));
  assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0);
});

test('known pending bank arrivals alone cannot starve other eligible Bags and never claim lifecycle completion', async t => {
  const f = await fixture(t); await f.automation.configure(f.input()); await f.gates();
  f.controls.payoutPending = true; f.controls.pendingReports = true;
  const result = await f.automation.advance({ runId: RUN });
  assert.equal(f.calls.payouts.length, 3); assert.notEqual(result.outcome, 'completed');
  assert.equal((await f.automation.get(RUN)).completedAt, null); assert.equal((await f.automation.get(RUN)).enabled, true);
});

test('a payout-pending report with any other unknown evidence or inconsistent pending count remains a hard hold', async t => {
  for (const mode of ['extra','count']) await t.test(mode, async child => {
    const f = await fixture(child); await f.automation.configure(f.input()); await f.gates();
    f.controls.payoutPending = true; f.controls.pendingReports = true;
    if (mode === 'extra') f.controls.extraPending = true; else f.controls.badPendingCount = true;
    const result = await f.automation.advance({ runId: RUN });
    assert.equal(result.outcome, 'cent_reconciliation_hold'); assert.equal(f.calls.payouts.length, 1);
  });
});

test('fully and authoritatively refunded closed Bags finish with no settlement or invented zero-dollar bank payout', async t => {
  const f = await fixture(t); await f.automation.configure(f.input()); await f.gates({ afterTransfer: false });
  await f.mutate(details => { for (const detail of Object.values(details.bags)) {
    detail.state = 'refunded'; detail.fullyDelivered = false; detail.refundCents = detail.totalCents;
    const op = Object.values(detail.refundOps)[0]; op.amountCents = detail.totalCents;
    op.recoveryCents = detail.transferCents; op.afterTransfer = false;
  } });
  const result = await f.automation.advance({ runId: RUN }); assert.equal(result.outcome, 'completed_no_payout_due');
  assert.equal(f.calls.transfers.length + f.calls.payouts.length, 0); assert.equal((await f.automation.get(RUN)).enabled, false);
});
