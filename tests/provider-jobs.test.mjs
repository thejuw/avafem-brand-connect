import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderJobs } from '../server/provider-jobs.mjs';

async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  await createUnifiedCheckout(db, auth, {});
  let instant = 0;
  const calls = { events: 0, checkout: [], sync: [], money: [], decode: [], catalog: 0, nightly: 0 };
  const state = { eventError: null, eventGate: null, syncErrorFor: null };
  const summary = async id => ({ id, state: (await db.query('SELECT state FROM unified_checkout_runs WHERE id=$1', [id])).rows[0].state });
  const config = {
    clock: () => instant,
    unifiedCheckout: {
      reconcile: async id => { calls.checkout.push(id); await db.query('UPDATE unified_checkout_runs SET updated_at=now() WHERE id=$1', [id]); return summary(id); },
      runtime: { decode: row => { calls.decode.push(row.id); return { snapshot: auth.decrypt(row.snapshot_encrypted), details: auth.decrypt(row.details_encrypted) }; } },
    },
    providerEvents: { processPending: async () => { calls.events++; if (state.eventGate) await state.eventGate; if (state.eventError) { const error = state.eventError; state.eventError = null; throw error; } return { processed: 0, events: [] }; } },
    providerFulfillment: { sync: async input => { calls.sync.push(input); if (state.syncErrorFor === input.runId) throw new Error('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'); return summary(input.runId); } },
    providerMoney: { reconcile: async input => { calls.money.push(input); return summary(input.runId); }, settle: () => assert.fail('The background worker cannot initiate a new transfer.'), payout: () => assert.fail('The background worker cannot initiate a bank payout.'), createRecipients: () => assert.fail('The worker cannot create recipient accounts.') },
    catalog: { syncAll: async () => { calls.catalog++; } }, reconciliation: { runNightly: async () => { calls.nightly++; } },
  };
  const jobs = createProviderJobs(db, config);
  async function add(index, { status = 'checkout_open', paid = false, canonical = false, verified = true, detailsPatch = {} } = {}) {
    const id = `uco_${index.toString(16).padStart(32, '0')}`;
    const snapshot = { id, currency: 'USD', captureMethod: 'manual', bags: [0, 1, 2].map(number => ({ id: `bag_jobs_${index}_${number}`, brandId: `brand_jobs_${number}`, shop: ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'][number], items: [{ sku: `AVF-CONNECT-TEST-${number}`, qty: 2 }] })) };
    const details = { sessionStartedAt: new Date().toISOString(), sessionId: status === 'checkout_needs_review' ? null : `cs_test_jobs${index}`, paymentVerified: paid, canonicalCommitted: canonical,
      bags: Object.fromEntries(snapshot.bags.map(bag => [bag.id, { verified, ...(verified ? { orderId: `gid://shopify/Order/${index}` } : { dispatchStartedAt: new Date().toISOString() }) }])), ...detailsPatch };
    await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted,charge_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, `request_${index}`, `cart_${index}`, status, auth.encrypt(snapshot), auth.encrypt(details), paid ? `ch_jobs${index}` : null, new Date(Date.UTC(2020, 0, index + 1))]);
    return { id, snapshot, details };
  }
  return { db, auth, jobs, calls, state, config, add, now: value => { instant = value; } };
}

test('provider jobs resume durable uncertain checkout/order intents as well as ordinary pending states', async t => {
  const f = await fixture(t);
  const session = await f.add(1, { status: 'checkout_needs_review' });
  const paidOrder = await f.add(2, { status: 'needs_review', paid: true, canonical: true, verified: false });
  const ordinary = await f.add(3, { status: 'capture_pending' });
  await f.jobs.run();
  assert.deepEqual(new Set(f.calls.checkout), new Set([session.id, paidOrder.id, ordinary.id]), 'Saved uncertain provider intents need bounded reconciliation, never replacement creates.');
});

test('minute lifecycle polling decodes actual canonical rows and calls sync/reconcile only, never new transfers or payouts', async t => {
  const f = await fixture(t); const committed = await f.add(1, { status: 'delivered', paid: true, canonical: true });
  const uncommitted = await f.add(2, { status: 'needs_review', paid: true, canonical: false });
  await f.jobs.run();
  assert.equal(f.calls.sync.filter(input => input.runId === committed.id).length, 3);
  assert.deepEqual(f.calls.money, [{ runId: committed.id }]);
  assert.ok(f.calls.decode.includes(committed.id)); assert.ok(f.calls.decode.includes(uncommitted.id));
  assert.equal(f.calls.catalog, 1); assert.equal(f.calls.nightly, 1);
  f.now(59_999); await f.jobs.run(); assert.equal(f.calls.money.length, 1);
  f.now(60_000); await f.jobs.run(); assert.equal(f.calls.money.length, 2); assert.equal(f.calls.catalog, 1);
  f.now(900_000); await f.jobs.run(); assert.equal(f.calls.catalog, 2);
  assert.equal((await f.db.query('SELECT state FROM unified_checkout_runs WHERE id=$1', [committed.id])).rows[0].state, 'delivered');
});

test('concurrent ticks drop the second attempt and release the local running lease after completion', async t => {
  const f = await fixture(t); let release; f.state.eventGate = new Promise(resolve => { release = resolve; });
  const running = f.jobs.run(); assert.deepEqual(await f.jobs.run(), { processing: true });
  assert.equal(f.calls.events, 1); release(); await running;
  f.state.eventGate = null; const again = await f.jobs.run(); assert.equal(again.processing, undefined); assert.equal(f.calls.events, 2);
});

test('a worker exception always releases the local running flag so the next tick can retry', async t => {
  const f = await fixture(t); f.state.eventError = new Error('Synthetic event queue failure');
  await assert.rejects(f.jobs.run(), /Synthetic event queue failure/);
  const result = await f.jobs.run(); assert.equal(result.processing, undefined); assert.equal(f.calls.events, 2);
});

test('bounded checkout polling is fair to a sixth open cart rather than forever selecting the oldest five', async t => {
  const f = await fixture(t); const runs = [];
  for (let index = 1; index <= 6; index++) runs.push(await f.add(index));
  await f.jobs.run(); assert.equal(f.calls.checkout.length, 5);
  f.now(1000); await f.jobs.run();
  assert.ok(f.calls.checkout.includes(runs[5].id), 'A newer durable checkout must eventually be polled even if older Sessions stay open.');
});

test('one failed provider lifecycle read cannot suppress healthy later runs or leak provider messages', async t => {
  const f = await fixture(t); const healthy = await f.add(1, { status: 'settled', paid: true, canonical: true });
  const failed = await f.add(2, { status: 'delivered', paid: true, canonical: true }); f.state.syncErrorFor = failed.id;
  const result = await f.jobs.run();
  assert.ok(f.calls.money.some(input => input.runId === healthy.id));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'));
  assert.equal((await f.db.query('SELECT state FROM unified_checkout_runs WHERE id=$1', [healthy.id])).rows[0].state, 'settled');
  f.state.syncErrorFor = null; f.now(60_000); await f.jobs.run();
  assert.ok(f.calls.money.some(input => input.runId === failed.id));
});

test('unexpected checkout/decode/catalog/nightly errors are isolated and returned as safe pending states', async t => {
  const f = await fixture(t); const checkout = await f.add(1);
  const corrupt = await f.add(2, { status: 'delivered', paid: true, canonical: true });
  const healthy = await f.add(3, { status: 'settled', paid: true, canonical: true });
  const decode = f.config.unifiedCheckout.runtime.decode;
  f.config.unifiedCheckout.reconcile = async id => { if (id === checkout.id) throw new Error('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'); return { id, state: 'checkout_open' }; };
  f.config.unifiedCheckout.runtime.decode = row => { if (row.id === corrupt.id) throw new Error('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'); return decode(row); };
  f.config.catalog.syncAll = async () => { throw new Error('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'); };
  f.config.reconciliation.runNightly = async () => { throw new Error('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'); };
  const result = await f.jobs.run();
  assert.ok(result.checkouts.some(row => row.id === checkout.id && row.state === 'checkout_reconciliation_pending'));
  assert.ok(result.lifecycle.some(row => row.id === corrupt.id && row.state === 'run_decode_review'));
  assert.ok(result.lifecycle.some(row => row.state === 'catalog_sync_pending'));
  assert.ok(result.lifecycle.some(row => row.state === 'nightly_reconciliation_pending'));
  assert.ok(f.calls.money.some(input => input.runId === healthy.id));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR_NEVER_RETURN'));
  assert.notEqual((await f.jobs.run()).processing, true);
});

test('only an injected opt-in automation service may advance a bounded fair due queue; default worker never invokes new money directly', async t => {
  const f = await fixture(t), calls = [];
  const jobs = createProviderJobs(f.db, { ...f.config, automation: { runDue: async input => {
    calls.push(input); return { test: true, checked: 0, results: [], boundedBatch: 5 };
  } } });
  const first = await jobs.run(); assert.deepEqual(calls, [{ limit: 5 }]); assert.equal(first.automaticMoney.checked, 0);
  await jobs.run(); assert.equal(calls.length, 2, 'The durable automation queue owns timing, not the in-memory minute lifecycle throttle.');
  assert.equal(f.calls.money.length, 0);
});

test('automation failures are sanitized without suppressing default reconciliation or creating replacement money', async t => {
  const f = await fixture(t); const paid = await f.add(1, { status: 'delivered', paid: true, canonical: true });
  const jobs = createProviderJobs(f.db, { ...f.config, automation: { runDue: async () => { throw new Error('PRIVATE_AUTOMATION_PROVIDER_TOKEN'); } } });
  const result = await jobs.run(); assert.deepEqual(result.automaticMoney, { test: true, outcome: 'automation_review_hold', checked: 0 });
  assert.ok(f.calls.money.some(input => input.runId === paid.id)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTOMATION/);
});

test('optional tax reconciliation runs after cash reconciliation on the minute lifecycle cadence before independent automation', async t => {
  const f = await fixture(t), order = [];
  const config = { ...f.config, reconciliation: { runNightly: async () => { order.push('cash'); } },
    taxReconciliation: { runNightly: async () => { order.push('tax'); return { test: true, status: 'tax_pending' }; } },
    automation: { runDue: async input => { assert.deepEqual(input, { limit: 5 }); order.push('automation'); return { test: true, checked: 0 }; } } };
  const jobs = createProviderJobs(f.db, config);
  await jobs.run(); assert.deepEqual(order, ['cash', 'tax', 'automation']);
  f.now(59_999); await jobs.run(); assert.deepEqual(order, ['cash', 'tax', 'automation', 'automation']);
  f.now(60_000); await jobs.run(); assert.deepEqual(order, ['cash', 'tax', 'automation', 'automation', 'cash', 'tax', 'automation']);
  assert.equal(f.calls.money.length, 0); assert.equal(f.calls.checkout.length, 0);
});

test('cash and tax nightly failures are separately sanitized and cannot suppress automation, lifecycle status or the next minute', async t => {
  const f = await fixture(t), order = []; const committed = await f.add(1, { status: 'settled', paid: true, canonical: true });
  const jobs = createProviderJobs(f.db, { ...f.config,
    reconciliation: { runNightly: async () => { order.push('cash'); throw new Error('PRIVATE_CASH_TAX_PROVIDER_KEY'); } },
    taxReconciliation: { runNightly: async () => { order.push('tax'); throw new Error('PRIVATE_TAX_CUSTOMER_ADDRESS'); } },
    automation: { runDue: async () => { order.push('automation'); return { test: true, checked: 0 }; } },
  });
  const result = await jobs.run(); assert.deepEqual(order, ['cash', 'tax', 'automation']);
  assert.ok(result.lifecycle.some(value => value.state === 'nightly_reconciliation_pending'));
  assert.ok(result.lifecycle.some(value => value.state === 'nightly_tax_reconciliation_pending'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Error|message|stack|cause/);
  assert.equal((await f.db.query('SELECT state FROM unified_checkout_runs WHERE id=$1', [committed.id])).rows[0].state, 'settled');
  f.now(60_000); assert.notEqual((await jobs.run()).processing, true);
  assert.deepEqual(order, ['cash', 'tax', 'automation', 'cash', 'tax', 'automation']);
});

test('a held tax-nightly read drops concurrent ticks and its failure releases the worker without a provider mutation retry', { timeout: 20_000 }, async t => {
  const f = await fixture(t); let enter, release; let count = 0;
  const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const jobs = createProviderJobs(f.db, { ...f.config, taxReconciliation: { runNightly: async () => {
    count++; enter(); await gate; throw new Error('PRIVATE_TAX_TOKEN');
  } } });
  const running = jobs.run(); await entered;
  assert.deepEqual(await jobs.run(), { processing: true }); assert.equal(count, 1);
  release(); const result = await running;
  assert.ok(result.lifecycle.some(value => value.state === 'nightly_tax_reconciliation_pending')); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TAX/);
  assert.notEqual((await jobs.run()).processing, true); assert.equal(count, 1, 'Minute polling must not immediately repeat even a failed read.');
  f.now(60_000); await jobs.run(); assert.equal(count, 2);
});
