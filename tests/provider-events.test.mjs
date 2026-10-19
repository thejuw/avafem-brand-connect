import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderEvents } from '../server/provider-events.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';
import { shopifyBagTag } from '../server/integrations/projection.mjs';

const runId = `uco_${'a'.repeat(32)}`;
const orderId = 'gid://shopify/Order/5000';
const refundId = 'gid://shopify/Refund/6000';
const PRIVATE = 'synthetic_private_health_and_shipping_never_return';
const shop = TEST_STORES[0].shop;
const stripeEvent = (deliveryId = 'evt_fixture1', topic = 'checkout.session.completed') => ({ provider: 'stripe', deliveryId, topic, payload: { id: deliveryId, type: topic, livemode: false, data: { object: { id: topic === 'checkout.session.completed' ? 'cs_test_fixture1' : 'pi_fixture1', livemode: false, metadata: { order_id: runId, integration: 'avafem' }, status: 'DO_NOT_TRUST_EVENT_STATUS', amount_total: 99999999, private: PRIVATE } } } });
const shopifyEvent = (deliveryId = 'shopify_fixture1', topic = 'orders/updated') => ({ provider: 'shopify', deliveryId, topic, shop, payload: topic.startsWith('orders/') ? { id: 5000, admin_graphql_api_id: orderId, test: false, financial_status: 'DO_NOT_TRUST_EVENT_STATUS', shipping_address: { address1: PRIVATE } } : { id: topic === 'refunds/create' ? 6000 : 7000, order_id: 5000, ...(topic === 'refunds/create' ? { admin_graphql_api_id: refundId } : {}), private: PRIVATE } });

async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  await db.query('CREATE TABLE external_orders(bag_id TEXT PRIMARY KEY,brand_id TEXT NOT NULL,shop TEXT NOT NULL,external_order_id TEXT,state TEXT,updated_at TIMESTAMPTZ DEFAULT now())');
  const bags = TEST_STORES.map((store, index) => ({ id: `bag_event_${index}`, brandId: `brand_event_${index}`, shop: store.shop, items: [{ sku: `AVF-CONNECT-TEST-${index}`, qty: 1, unitPriceCents: 100 }] }));
  for (const bag of bags) await db.query('INSERT INTO brands(id,name,slug,commission_bps) VALUES($1,$2,$3,1500)', [bag.brandId, bag.shop, bag.brandId]);
  const snapshot = { id: runId, currency: 'USD', bags };
  const details = { sessionId: 'cs_test_fixture1', paymentIntentId: 'pi_fixture1', accountId: 'acct_fixture1', canonicalCommitted: true, paymentVerified: true, bags: Object.fromEntries(bags.map((bag, index) => [bag.id, { orderId: `gid://shopify/Order/${5000 + index}`, verified: true }])) };
  const calls = { checkout: [], sync: [], refunds: [], cancellations: [], reads: [], disconnects: [] };
  const state = { error: null, busy: false, orderPatch: {}, resultError: null, installationAt: Date.now() - 10_000 };
  const summary = () => ({ id: runId, state: 'orders_created', lastError: state.resultError, ...(state.busy ? { processing: true } : {}) });
  const invoke = async (name, input) => { calls[name].push(structuredClone(input)); await new Promise(resolve => setTimeout(resolve, 2)); if (state.error) throw state.error; return summary(); };
  const stores = { row: async input => { const bag = bags.find(bag => bag.shop === input); return bag ? { shop: input, brand_id: bag.brandId } : null; },
    forShop: async input => ({ getOrderOperations: async inputId => { calls.reads.push({ shop: input, orderId: inputId }); const bag = bags.find(bag => bag.shop === input); return { id: inputId, test: true, currencyCode: 'USD', presentmentCurrencyCode: 'USD', sourceIdentifier: bag.id, tags: ['TEST_DO_NOT_SHIP', shopifyBagTag(bag.id)], operationsComplete: true, refunds: [{ id: refundId }], cancelledAt: null, ...state.orderPatch }; } }),
    disconnect: async (input, occurredAt) => { calls.disconnects.push({ shop: input, occurredAt }); return Date.parse(occurredAt) < state.installationAt ? { ignored: true } : { disconnected: true }; } };
  await createUnifiedCheckout(db, auth, { stores, getStripe: () => assert.fail('Fixture initialization must not contact Stripe') });
  await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted,checkout_session_id,payment_intent_id)
    VALUES($1,'fixture_request','fixture_cart','orders_created',$2,$3,'cs_test_fixture1','pi_fixture1')`, [runId, auth.encrypt(snapshot), auth.encrypt(details)]);
  await db.query("INSERT INTO orders(id,order_ref,subtotal_cents,shipping_cents,tax_cents,total_cents,provider_bound) VALUES($1,'AVF-EVENT-TEST',300,0,0,300,true)", [runId]);
  for (const [index, bag] of bags.entries()) {
    await db.query(`INSERT INTO bags(id,order_id,brand_id,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,transfer_cents,total_cents,ship_by,provider_bound)
      VALUES($1,$2,$3,'[]','{}',100,0,0,15,85,100,now(),true)`, [bag.id, runId, bag.brandId]);
    await db.query("INSERT INTO external_orders(bag_id,brand_id,shop,external_order_id,state) VALUES($1,$2,$3,$4,'created')", [bag.id, bag.brandId, bag.shop, `gid://shopify/Order/${5000 + index}`]);
  }
  const config = { unifiedCheckout: { reconcile: input => invoke('checkout', input) }, stores,
    providerMoney: { ingestShopifyRefund: input => invoke('refunds', input), ingestShopifyCancellation: input => invoke('cancellations', input) },
    providerFulfillment: { sync: input => invoke('sync', input) } };
  const service = await createProviderEvents(db, auth, config);
  return { db, auth, service, config, calls, state, snapshot, details };
}

test('verified encrypted events deduplicate durably and never expose payloads or accept changed delivery bodies', async t => {
  const f = await fixture(t); const event = stripeEvent();
  const receipt = await f.service.queue(event); assert.equal(receipt.duplicate, false);
  assert.equal((await f.service.queue(event)).duplicate, true); assert.equal(await f.service.isManagedEvent('stripe', event.deliveryId), true);
  assert.equal(await f.service.isManagedEvent('stripe', 'not_present'), false);
  const raw = (await f.db.query('SELECT * FROM unified_provider_events')).rows[0];
  assert.ok(!JSON.stringify(raw).includes(PRIVATE)); assert.equal(f.auth.decrypt(raw.payload_encrypted).payload.data.object.private, PRIVATE);
  const changed = structuredClone(event); changed.payload.data.object.amount_total++;
  await assert.rejects(f.service.queue(changed), { code: 'PROVIDER_EVENT_DUPLICATE_CONFLICT' });
  const restarted = await createProviderEvents(f.db, f.auth, f.config);
  const result = await restarted.processPending(); assert.equal(result.events[0].state, 'complete'); assert.deepEqual(f.calls.checkout, [runId]);
  assert.ok(!JSON.stringify([receipt, result]).includes(PRIVATE));
  assert.equal((await restarted.processPending()).processed, 0);
});

test('both Stripe completion and PI success trigger one bound checkout reconciliation using authoritative workflow, not event amounts', async t => {
  const f = await fixture(t);
  await f.service.queue(stripeEvent()); await f.service.queue(stripeEvent('evt_fixture2', 'payment_intent.succeeded'));
  const result = await f.service.processPending(); assert.equal(result.processed, 2);
  assert.ok(result.events.every(event => event.state === 'complete')); assert.deepEqual(f.calls.checkout, [runId, runId]);
  assert.equal(f.calls.refunds.length, 0); assert.equal(f.calls.sync.length, 0);
});

test('Shopify order/fulfillment, native refund and cancellation topics bind exact shop/Bags before authoritative workflows', async t => {
  const f = await fixture(t);
  await f.service.queue(shopifyEvent('order_updated')); await f.service.queue(shopifyEvent('fulfillment_created', 'fulfillments/create'));
  await f.service.queue(shopifyEvent('refund_created', 'refunds/create'));
  f.state.orderPatch = { cancelledAt: new Date().toISOString() }; await f.service.queue(shopifyEvent('order_cancelled', 'orders/cancelled'));
  const result = await f.service.processPending(); assert.ok(result.events.every(event => event.state === 'complete'));
  assert.deepEqual(f.calls.sync, [{ runId, bagId: 'bag_event_0' }, { runId, bagId: 'bag_event_0' }]);
  assert.deepEqual(f.calls.refunds, [{ runId, bagId: 'bag_event_0', shopifyRefundId: refundId }]);
  assert.deepEqual(f.calls.cancellations, [{ runId, bagId: 'bag_event_0' }]);
  assert.ok(f.calls.reads.every(read => read.orderId === orderId && read.shop === shop));
});

test('unknown exact-store orders stay managed and require review after three attempts, never entering a sandbox fallback', async t => {
  const f = await fixture(t); const event = shopifyEvent(); event.payload.id = 9999; event.payload.admin_graphql_api_id = 'gid://shopify/Order/9999';
  await f.service.queue(event);
  for (const expected of ['pending', 'pending', 'pending_review']) assert.equal((await f.service.processPending()).events[0].state, expected);
  assert.equal((await f.service.processPending()).processed, 0); assert.equal(await f.service.isManagedEvent('shopify', event.deliveryId), true);
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.sync.length, 0); assert.equal(f.calls.refunds.length, 0);
});

test('foreign-store headers, live or mismatched Stripe objects and invalid authoritative test-order identities cannot move money', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.queue({ ...shopifyEvent(), shop: 'unrelated.myshopify.com' }), { code: 'PROVIDER_EVENT_STORE' });
  for (const [index, alter] of [value => { value.payload.livemode = true; }, value => { value.payload.data.object.id = 'cs_test_wrong'; }, value => { value.payload.data.object.metadata.integration = 'not_avafem'; }, value => { value.payload.id = 'evt_other'; }].entries()) {
    const event = stripeEvent(`evt_invalid${index}`); alter(event); await f.service.queue(event);
  }
  await f.service.processPending(); assert.equal(f.calls.checkout.length, 0);
  f.state.orderPatch = { test: false }; await f.service.queue(shopifyEvent('unverified_order')); await f.service.processPending();
  assert.equal(f.calls.sync.length, 0); assert.equal(f.calls.refunds.length, 0); assert.equal(f.calls.cancellations.length, 0);
  const cross = shopifyEvent('cross_store_order'); cross.shop = TEST_STORES[1].shop;
  await f.service.queue(cross); await f.service.processPending(); assert.equal(f.calls.sync.length, 0);
});

test('out-of-order refund/cancellation envelopes wait for actual provider records instead of trusting event flags', async t => {
  const f = await fixture(t); f.state.orderPatch = { refunds: [], cancelledAt: null };
  await f.service.queue(shopifyEvent('refund_waiting', 'refunds/create')); await f.service.queue(shopifyEvent('cancel_waiting', 'orders/cancelled'));
  let result = await f.service.processPending(); assert.ok(result.events.every(event => event.state === 'pending'));
  assert.equal(f.calls.refunds.length, 0); assert.equal(f.calls.cancellations.length, 0);
  f.state.orderPatch = { refunds: [{ id: refundId }], cancelledAt: new Date().toISOString() };
  result = await f.service.processPending(); assert.ok(result.events.every(event => event.state === 'complete'));
  assert.equal(f.calls.refunds.length, 1); assert.equal(f.calls.cancellations.length, 1);
});

test('durable leases serialize concurrent workers, recover expired claims and retain sanitized failures for review', async t => {
  const f = await fixture(t); await f.service.queue(stripeEvent());
  await Promise.all([f.service.processPending(), f.service.processPending()]); assert.equal(f.calls.checkout.length, 1);
  await f.service.queue(stripeEvent('evt_expired'));
  await f.db.query("UPDATE unified_provider_events SET state='processing',attempts=1,lease_token='old_worker',lease_until=now()+interval '1 minute' WHERE delivery_id='evt_expired'");
  assert.equal((await f.service.processPending()).processed, 0);
  await f.db.query("UPDATE unified_provider_events SET lease_until=now()-interval '1 minute' WHERE delivery_id='evt_expired'");
  assert.equal((await f.service.processPending()).events[0].attempts, 2); assert.equal(f.calls.checkout.length, 2);
  f.state.error = new Error(PRIVATE); await f.service.queue(stripeEvent('evt_provider_failed'));
  for (let index = 0; index < 3; index++) await f.service.processPending();
  const row = (await f.db.query("SELECT state,last_error FROM unified_provider_events WHERE delivery_id='evt_provider_failed'")).rows[0];
  assert.equal(row.state, 'pending_review'); assert.ok(!JSON.stringify(row).includes(PRIVATE));
});

test('run leases and swallowed workflow-review results remain pending rather than losing the event as processed', async t => {
  const f = await fixture(t); await f.service.queue(stripeEvent());
  await f.db.query("UPDATE unified_checkout_runs SET lock_token='another_worker',lease_until=now()+interval '1 minute' WHERE id=$1", [runId]);
  assert.equal((await f.service.processPending()).events[0].state, 'pending'); assert.equal(f.calls.checkout.length, 0);
  await f.db.query('UPDATE unified_checkout_runs SET lock_token=NULL,lease_until=NULL WHERE id=$1', [runId]); f.state.busy = true;
  assert.equal((await f.service.processPending()).events[0].state, 'pending'); f.state.busy = false;
  assert.equal((await f.service.processPending()).events[0].state, 'complete');
  await f.service.queue(shopifyEvent('workflow_review')); f.state.resultError = { code: 'UNRESOLVED_PROVIDER_STATE' };
  assert.equal((await f.service.processPending()).events[0].state, 'pending');
});

test('a crash in the third attempt retires the expired event for review without a fourth workflow call', async t => {
  const f = await fixture(t); await f.service.queue(stripeEvent());
  await f.db.query("UPDATE unified_provider_events SET state='processing',attempts=3,lease_token='crashed_worker',lease_until=now()-interval '1 minute'");
  assert.equal((await f.service.processPending()).processed, 0); assert.equal(f.calls.checkout.length, 0);
  const stored = (await f.db.query('SELECT state,attempts,lease_token,last_error FROM unified_provider_events')).rows[0];
  assert.equal(stored.state, 'pending_review'); assert.equal(stored.attempts, 3); assert.equal(stored.lease_token, null);
  assert.equal(stored.last_error.code, 'PROVIDER_EVENT_ATTEMPTS_EXHAUSTED');
});

test('catalog/unsupported events are explicitly retained ignored, and uninstall uses the original occurrence timestamp', async t => {
  const f = await fixture(t);
  await f.service.queue({ ...shopifyEvent('catalog_update', 'products/update'), payload: { id: 123, private: PRIVATE } });
  await f.service.queue(stripeEvent('evt_account_updated', 'account.updated'));
  let result = await f.service.processPending(); assert.ok(result.events.every(event => event.state === 'ignored'));
  assert.equal(f.calls.reads.length, 0); assert.equal(f.calls.checkout.length, 0);
  const stale = new Date(f.state.installationAt - 1000).toISOString();
  const uninstall = { provider: 'shopify', deliveryId: 'stale_uninstall', topic: 'app/uninstalled', shop, payload: { myshopify_domain: shop }, occurredAt: stale };
  await f.service.queue(uninstall); result = await f.service.processPending(); assert.equal(result.events[0].state, 'ignored');
  assert.deepEqual(f.calls.disconnects[0], { shop, occurredAt: stale });
  await f.service.queue({ ...uninstall, deliveryId: 'current_uninstall', occurredAt: new Date().toISOString() });
  result = await f.service.processPending(); assert.equal(result.events[0].action, 'test_installation_disconnected');
  await f.service.queue({ ...uninstall, deliveryId: 'uninstall_without_time', occurredAt: null });
  assert.equal((await f.service.processPending()).events[0].state, 'pending');
});

test('optional catalog service pulls a complete exact-shop snapshot and never trusts event product or inventory values', async t => {
  const f = await fixture(t); const calls = []; let complete = true;
  const service = await createProviderEvents(f.db, f.auth, { ...f.config, providerCatalog: { sync: async input => {
    calls.push(input); return { test: true, shop: input.shop, brandId: 'brand_event_0', complete };
  } } });
  await service.queue({ provider: 'shopify', deliveryId: 'native_catalog', topic: 'products/update', shop, payload: { title: 'UNTRUSTED_EVENT_TITLE', private: PRIVATE } });
  assert.equal((await service.processPending()).events[0].action, 'provider_catalog_synced');
  assert.deepEqual(calls, [{ shop }]);
  complete = false;
  await service.queue({ provider: 'shopify', deliveryId: 'native_inventory', topic: 'inventory_levels/update', shop, payload: { available: 99999999 } });
  assert.equal((await service.processPending()).events[0].state, 'pending');
  assert.equal(f.calls.sync.length, 0); assert.equal(f.calls.refunds.length, 0);
});
