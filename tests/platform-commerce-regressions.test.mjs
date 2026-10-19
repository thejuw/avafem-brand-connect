import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createDomain } from '../server/domain.mjs';
import { seedDatabase } from '../server/seed.mjs';
import { createPlatform } from '../server/platform/index.mjs';
import { createSubscriptions } from '../server/platform/commerce.mjs';

const DAY = 86_400_000;
const shipTo = { name: 'Renewal Fixture', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
const secret = 'isolated-platform-commerce-regression';
const items = [{ brandId: 'brand_bloom', sku: 'BLOOM-COTTON-16', qty: 1 }];

async function fixture(t, charge) {
  const db = await createDatabase({ connectionString: null });
  t.after(() => db.close());
  await db.migrate();
  let stamp = Date.parse('2026-10-19T12:00:00Z');
  const clock = () => new Date(stamp);
  const domain = createDomain(db, { clock });
  await seedDatabase(db, domain);
  const platform = await createPlatform(db, { domain, auth: {}, secret, clock, subscriptionCharge: charge,
    fetch: async () => { throw new Error('External providers are forbidden in regression fixtures.'); } });
  const shopper = await platform.crm.upsertShopper({ email: 'renewal-fixture@example.com', consent: { email: true } });
  const sub = await platform.subscriptions.create(shopper.id, { items, shipTo });
  const orderCount = async () => (await db.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
  return { db, domain, platform, shopper, sub, clock, orderCount, advance: days => { stamp += days * DAY; } };
}

test('known decline then success creates a new fulfillable order, never a refunded replay', async t => {
  const keys = [];
  const f = await fixture(t, async input => {
    keys.push(input.idempotencyKey);
    return keys.length === 1 ? { ok: false, error: 'card_declined' } : { ok: true, ref: 'pi_sim_recovered', amountCents: input.amountCents };
  });
  const before = await f.orderCount();
  assert.equal((await f.platform.subscriptions.runDue())[0].status, 'failed');
  assert.equal(await f.orderCount(), before, 'a decline never creates a paid Bag, ledger or outbox event');
  f.advance(1.01);
  const [paid] = await f.platform.subscriptions.runDue();
  assert.equal(paid.status, 'paid'); assert.equal(paid.simulated, true);
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
  assert.equal(await f.orderCount(), before + 1);
  const bag = (await f.db.query('SELECT status,refunded_cents FROM bags WHERE order_id=$1', [paid.orderId])).rows[0];
  assert.deepEqual(bag, { status: 'awaiting_shipment', refunded_cents: 0 });
  const attempts = (await f.db.query('SELECT attempt,status FROM subscription_attempts ORDER BY attempt')).rows;
  assert.deepEqual(attempts, [{ attempt: 1, status: 'declined' }, { attempt: 2, status: 'paid' }]);
  assert.deepEqual(await f.platform.subscriptions.runDue(), []);
});

test('concurrent renewal workers reserve one durable cycle before the mocked charge', async t => {
  let calls = 0; let entered; let finish;
  const entry = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async input => { calls++; entered(); await gate; return { ok: true, ref: 'pi_sim_single', amountCents: input.amountCents }; });
  const first = f.platform.subscriptions.runDue();
  await entry;
  try {
    assert.deepEqual(await f.platform.subscriptions.runDue(), []);
    assert.equal(calls, 1);
    assert.equal((await f.db.query('SELECT status FROM subscription_attempts')).rows[0].status, 'charge_started');
  } finally { finish(); }
  assert.equal((await first)[0].status, 'paid');
  assert.equal((await f.platform.subscriptions.runs(f.sub.id)).filter(r => r.status === 'paid').length, 1);
});

test('resuming after known declines does not collide with historical failed-run statuses', async t => {
  const f = await fixture(t, async () => ({ ok: false, error: 'card_declined' }));
  for (let i = 0; i < 3; i++) { await f.platform.subscriptions.runDue(); f.advance(1.01); }
  assert.equal((await f.platform.subscriptions.list())[0].status, 'past_due');
  await f.platform.subscriptions.setStatus(f.sub.id, 'active');
  assert.equal((await f.platform.subscriptions.runDue())[0].status, 'failed');
  const history = await f.platform.subscriptions.runs(f.sub.id);
  assert.equal(history.filter(row => row.status.startsWith('failed')).length, 4);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM subscription_attempts')).rows[0].n, 4);
});

test('a legacy paid run with stale cycle_count cannot dispatch another charge', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw new Error('must not run'); });
  await f.db.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,charge_ref,amount_cents,created_at) VALUES('legacy_paid',$1,1,'paid','pi_sim_legacy',3964,$2)", [f.sub.id, f.clock()]);
  assert.deepEqual(await f.platform.subscriptions.runDue(), []); assert.equal(calls, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM subscription_attempts')).rows[0].n, 0);
});

test('unknown mocked charge pauses durably without order or automatic charge replay after restart', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('sk_test_private_contact@example.com raw provider response'); });
  const before = await f.orderCount();
  const report = await f.platform.subscriptions.runDue();
  assert.equal(report[0].status, 'review'); assert.equal(report[0].error, 'CHARGE_OUTCOME_UNKNOWN');
  assert.equal(await f.orderCount(), before);
  assert.equal((await f.platform.subscriptions.list())[0].status, 'paused');
  await assert.rejects(() => f.platform.subscriptions.setStatus(f.sub.id, 'active'), { code: 'SUBSCRIPTION_REVIEW_REQUIRED' });
  f.advance(2);
  // Even an erroneous external reactivation cannot bypass the persisted attempt claim.
  await f.db.query("UPDATE subscriptions SET status='active' WHERE id=$1", [f.sub.id]);
  const restarted = createSubscriptions(f.db, { clock: f.clock, domain: f.domain, crm: f.platform.crm, health: f.platform.health, bank: f.platform.bank, secret,
    charge: async () => { calls++; throw new Error('must not be called'); } });
  assert.deepEqual(await restarted.runDue(), []); assert.equal(calls, 1);
  const persisted = JSON.stringify((await f.db.query('SELECT * FROM subscription_attempts')).rows) + JSON.stringify(await restarted.runs(f.sub.id));
  assert.ok(!persisted.includes('sk_test_private')); assert.ok(!persisted.includes('contact@example.com'));
});

test('malformed, non-simulated or amount-mismatched mocked results are held rather than retried', async t => {
  for (const result of [undefined, { ok: false, error: 'network_timeout' }, { ok: true, ref: 'pi_sim_short', amountCents: 1 }, { ok: true, ref: 'pi_actual_external', amountCents: 3964 }]) {
    await t.test(JSON.stringify(result) || 'missing result', async t => {
      let calls = 0; const f = await fixture(t, async () => { calls++; return result; });
      const before = await f.orderCount();
      assert.equal((await f.platform.subscriptions.runDue())[0].error, 'CHARGE_RESULT_MISMATCH');
      f.advance(3); assert.deepEqual(await f.platform.subscriptions.runDue(), []);
      assert.equal(calls, 1); assert.equal(await f.orderCount(), before);
    });
  }
});

test('successful mock payment followed by order failure preserves the attempt and never charges again', async t => {
  let calls = 0;
  const f = await fixture(t, async input => { calls++; return { ok: true, ref: 'pi_sim_order_failure', amountCents: input.amountCents }; });
  t.mock.method(f.domain, 'createSandboxOrder', async () => { throw new Error('isolated forced persistence failure'); });
  const before = await f.orderCount();
  assert.equal((await f.platform.subscriptions.runDue())[0].error, 'PAID_ORDER_REVIEW');
  const attempt = (await f.db.query('SELECT status,charge_ref,amount_cents FROM subscription_attempts')).rows[0];
  assert.deepEqual(attempt, { status: 'uncertain', charge_ref: 'pi_sim_order_failure', amount_cents: 3964 });
  f.advance(5); assert.deepEqual(await f.platform.subscriptions.runDue(), []);
  assert.equal(calls, 1); assert.equal(await f.orderCount(), before);
});

test('canonical quote drift after mocked payment fails before creating stock/order/outbox changes', async t => {
  let f;
  f = await fixture(t, async input => {
    await f.db.query("UPDATE products SET price_cents=price_cents+100 WHERE brand_id='brand_bloom' AND sku='BLOOM-COTTON-16'");
    return { ok: true, ref: 'pi_sim_drift', amountCents: input.amountCents };
  });
  const before = await f.orderCount();
  const inventory = (await f.db.query("SELECT inventory_qty FROM products WHERE sku='BLOOM-COTTON-16'")).rows[0].inventory_qty;
  assert.equal((await f.platform.subscriptions.runDue())[0].error, 'PAID_ORDER_REVIEW');
  assert.equal(await f.orderCount(), before);
  assert.equal((await f.db.query("SELECT inventory_qty FROM products WHERE sku='BLOOM-COTTON-16'")).rows[0].inventory_qty, inventory);
});

test('cancellation while mocked charge awaits prevents publishing a renewal order', async t => {
  let entered; let finish;
  const entry = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, async input => { entered(); await gate; return { ok: true, ref: 'pi_sim_cancelled', amountCents: input.amountCents }; });
  const before = await f.orderCount();
  const pending = f.platform.subscriptions.runDue(); await entry;
  await f.platform.subscriptions.setStatus(f.sub.id, 'cancelled'); finish();
  assert.equal((await pending)[0].status, 'review'); assert.equal(await f.orderCount(), before);
  assert.equal((await f.platform.subscriptions.list())[0].status, 'cancelled');
});

test('completed erasure or cancellation just before canonical create cannot republish cached shipping PII', async t => {
  for (const change of ['erase', 'cancel']) {
    await t.test(change, async t => {
      let calls = 0;
      const f = await fixture(t, async input => { calls++; return { ok: true, ref: 'pi_sim_create_race', amountCents: input.amountCents }; });
      const beforeOrders = await f.orderCount();
      const beforeEvents = (await f.db.query('SELECT COUNT(*)::int AS n FROM outbox_events')).rows[0].n;
      const beforeInventory = (await f.db.query("SELECT inventory_qty FROM products WHERE sku='BLOOM-COTTON-16'")).rows[0].inventory_qty;
      const create = f.domain.createSandboxOrder.bind(f.domain);
      t.mock.method(f.domain, 'createSandboxOrder', async (...args) => {
        // This is after the earlier active/deleted read and mock charge succeeded.
        if (change === 'erase') await f.platform.privacy.erase(f.shopper.id, 'owner', { confirm: 'DELETE' });
        else await f.platform.subscriptions.setStatus(f.sub.id, 'cancelled');
        return create(...args);
      });
      assert.equal((await f.platform.subscriptions.runDue())[0].error, 'PAID_ORDER_REVIEW');
      assert.equal(calls, 1);
      assert.equal(await f.orderCount(), beforeOrders);
      assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM outbox_events')).rows[0].n, beforeEvents);
      assert.equal((await f.db.query("SELECT inventory_qty FROM products WHERE sku='BLOOM-COTTON-16'")).rows[0].inventory_qty, beforeInventory);
      f.advance(2); assert.deepEqual(await f.platform.subscriptions.runDue(), []); assert.equal(calls, 1);
      const attempt = (await f.db.query('SELECT status,charge_ref,order_id FROM subscription_attempts')).rows[0];
      assert.deepEqual(attempt, { status: 'uncertain', charge_ref: 'pi_sim_create_race', order_id: null });
    });
  }
});

test('DSAR clears cancelled subscription addresses, ticket/message subjects and encrypted message copies', async t => {
  const f = await fixture(t);
  await f.platform.subscriptions.setStatus(f.sub.id, 'cancelled');
  assert.ok((await f.db.query('SELECT ship_to_enc FROM subscriptions WHERE id=$1', [f.sub.id])).rows[0].ship_to_enc);
  await f.platform.crm.openTicket({ shopperId: f.shopper.id, subject: 'Private diagnosis subject', message: 'Private diagnosis body' });
  await f.platform.crm.sendTransactional(f.shopper.id, { subject: 'Private email subject', body: 'Private email body', dedupeKey: 'regression-private-message' });
  await f.db.query("UPDATE message_outbox SET body_enc='encrypted-health-copy' WHERE shopper_id=$1", [f.shopper.id]);
  const other = await f.platform.crm.upsertShopper({ email: 'retained-fixture@example.com' });
  const retained = await f.platform.subscriptions.create(other.id, { items, shipTo });
  await f.platform.privacy.erase(f.shopper.id, 'owner', { confirm: 'DELETE' });
  assert.equal((await f.db.query('SELECT ship_to_enc FROM subscriptions WHERE id=$1', [f.sub.id])).rows[0].ship_to_enc, null);
  assert.ok((await f.db.query('SELECT ship_to_enc FROM subscriptions WHERE id=$1', [retained.id])).rows[0].ship_to_enc);
  const tickets = (await f.db.query('SELECT subject,messages FROM support_tickets WHERE shopper_id=$1', [f.shopper.id])).rows;
  const messages = (await f.db.query('SELECT subject,body,body_enc FROM message_outbox WHERE shopper_id=$1', [f.shopper.id])).rows;
  assert.ok(tickets.length); assert.ok(messages.length);
  assert.ok(tickets.every(row => row.subject === '[erased]'));
  assert.ok(messages.every(row => row.subject === '[erased]' && row.body === '[erased]' && row.body_enc === null));
  assert.ok(!JSON.stringify({ tickets, messages }).includes('Private'));
});
