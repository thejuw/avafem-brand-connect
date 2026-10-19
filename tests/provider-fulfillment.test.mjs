import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderFulfillment } from '../server/provider-fulfillment.mjs';
import { shopifyBagTag } from '../server/integrations/projection.mjs';

const RUN = `uco_${'a'.repeat(32)}`;
const BAG = 'bag_fulfillment_unit';
const SHOP = 'i4vd1u-s8.myshopify.com';
const ORDER = 'gid://shopify/Order/100';
const LINE = 'gid://shopify/LineItem/200';
const VARIANT = 'gid://shopify/ProductVariant/300';
const FO = 'gid://shopify/FulfillmentOrder/400';
const FOLINE = 'gid://shopify/FulfillmentOrderLineItem/500';
const tracking = suffix => ({ number: `AVAFEM-TEST-${suffix}`, company: 'Other', url: `https://example.com/tracking/${suffix}` });
const input = (operationId, qty = 1) => ({ runId: RUN, bagId: BAG, operationId, items: [{ sku: 'FIXTURE-ONE', qty }], tracking: tracking(operationId.toUpperCase().replaceAll('_', '-')) });

async function fixture(t, { qty = 2 } = {}) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  await db.query('ALTER TABLE bags ADD COLUMN IF NOT EXISTS provider_bound BOOLEAN NOT NULL DEFAULT false');
  const auth = await createAuth(db, { sessionSecret: 'isolated-unit-session-not-real', encryptionKey: 'isolated-unit-encryption-not-real' });
  const wall = new Date('2026-10-19T12:00:00.000Z');
  const registry = { shop: SHOP, brand_id: 'brand_fulfillment_unit', state: 'connected', return_window_days: 30 };
  const calls = { create: 0, delivery: 0, read: 0 };
  const controls = { loseCreate: false, createWithoutVisibleResult: false, loseDelivery: false };
  const order = {
    id: ORDER, test: true, sourceIdentifier: BAG, tags: ['TEST_DO_NOT_SHIP', shopifyBagTag(BAG)],
    currencyCode: 'USD', presentmentCurrencyCode: 'USD', displayFinancialStatus: 'PAID', cancelledAt: null, operationsComplete: true,
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: LINE, sku: 'FIXTURE-ONE', quantity: qty, currentQuantity: qty, unfulfilledQuantity: qty, variant: { id: VARIANT } }] },
    fulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [{
      id: FO, status: 'OPEN', supportedActions: [{ action: 'CREATE_FULFILLMENT' }], assignedLocation: { location: { id: 'gid://shopify/Location/600' } },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: FOLINE, totalQuantity: qty, remainingQuantity: qty, lineItem: { id: LINE, sku: 'FIXTURE-ONE' } }] },
    }] },
    fulfillments: [], fulfillmentsCount: { count: 0, precision: 'EXACT' }, refunds: [],
  };
  const snapshot = { id: RUN, currency: 'USD', bags: [{ id: BAG, shop: SHOP, brandId: registry.brand_id, name: 'Unit Test Brand', shippingCents: 25,
    commissionBps: 1500, returnWindowDays: 30, items: [{ reference: 'line_unit', variantId: VARIANT, sku: 'FIXTURE-ONE', qty, unitPriceCents: 100, title: 'Test only' }] }] };
  const details = { paymentVerified: true, canonicalCommitted: true, shipTo: { name: 'PRIVATE_NAME', line1: 'PRIVATE_ADDRESS', email: 'PRIVATE_EMAIL', health: 'PRIVATE_HEALTH' },
    amounts: { subtotalCents: 200, shippingCents: 25, taxCents: 16, totalCents: 241 }, bags: { [BAG]: {
      verified: true, orderId: ORDER, state: 'order_created', subtotalCents: 200, shippingCents: 25, taxCents: 16, totalCents: 241, commissionCents: 30, transferCents: 195,
    } } };
  const mutateDetails = async change => {
    const row = (await db.query('SELECT details_encrypted FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0];
    const value = auth.decrypt(row.details_encrypted); change(value);
    await db.query('UPDATE unified_checkout_runs SET details_encrypted=$2 WHERE id=$1', [RUN, auth.encrypt(value)]);
  };
  const readDetails = async () => auth.decrypt((await db.query('SELECT details_encrypted FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0].details_encrypted);
  const adapter = {
    getOrderOperations: async id => { calls.read++; assert.equal(id, ORDER); return structuredClone(order); },
    createPartialFulfillment: async request => {
      calls.create++;
      const saved = await readDetails();
      assert.ok(Object.values(saved.bags[BAG].fulfillmentOps).some(op => op.status === 'intent' && op.providerOperationId === request.operationId), 'Durable immutable intent must exist before any provider write');
      assert.equal(request.orderId, ORDER); assert.equal(request.fulfillmentOrderId, FO);
      assert.deepEqual(Object.keys(request).sort(), ['fulfillmentOrderId', 'items', 'operationId', 'orderId', 'tracking']);
      assert.equal(request.items[0].fulfillmentOrderLineItemId, FOLINE);
      if (controls.createWithoutVisibleResult) throw new Error('PRIVATE_UPSTREAM_ADDRESS sk_test_NOT_REAL');
      const qty = request.items.reduce((sum, item) => sum + item.qty, 0);
      order.lineItems.nodes[0].unfulfilledQuantity -= qty;
      order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity -= qty;
      if (!order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity) order.fulfillmentOrders.nodes[0].status = 'CLOSED';
      const fulfillment = { id: `gid://shopify/Fulfillment/${700 + calls.create}`, status: 'SUCCESS', displayStatus: 'IN_TRANSIT',
        createdAt: new Date(wall.getTime() - 30_000 + calls.create * 1000).toISOString(), deliveredAt: null,
        trackingInfo: [request.tracking], fulfillmentLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: qty, lineItem: { id: LINE, sku: 'FIXTURE-ONE' } }] },
        events: { pageInfo: { hasNextPage: false }, nodes: [] } };
      order.fulfillments.push(fulfillment); order.fulfillmentsCount.count = order.fulfillments.length;
      if (controls.loseCreate) throw new Error('Synthetic lost response; PRIVATE_UPSTREAM_ADDRESS');
      return { shop: SHOP, orderId: ORDER, operationId: request.operationId, fulfillment: structuredClone(fulfillment) };
    },
    createTestDeliveryEvent: async request => {
      calls.delivery++;
      const saved = await readDetails();
      assert.ok(Object.values(saved.bags[BAG].deliveryOps).some(op => Object.values(op.children).some(child => child.status === 'intent' && child.operationId === request.operationId)));
      const fulfillment = order.fulfillments.find(item => item.id === request.fulfillmentId);
      const event = { id: `gid://shopify/FulfillmentEvent/${800 + calls.delivery}`, status: 'DELIVERED', happenedAt: wall.toISOString(), message: `AVAFEM SHOPIFY TEST DELIVERY / ${request.operationId} / NOT CARRIER VERIFIED` };
      fulfillment.events.nodes.push(event); fulfillment.deliveredAt = wall.toISOString(); fulfillment.displayStatus = 'DELIVERED';
      if (controls.loseDelivery) throw new Error('Synthetic lost delivery response');
      return { shop: SHOP, orderId: ORDER, operationId: request.operationId, fulfillmentEvent: event, carrierVerified: false };
    },
  };
  const stores = { row: async shop => { assert.equal(shop, SHOP); return { ...registry }; }, forShop: async shop => { assert.equal(shop, SHOP); return adapter; } };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => assert.fail('No Stripe operation is allowed in fulfillment tests'), clock: () => wall });
  await db.query("INSERT INTO brands(id,name,slug,commission_bps) VALUES($1,'Unit Test Brand','fulfillment-unit',1500)", [registry.brand_id]);
  await db.query("INSERT INTO orders(id,order_ref,subtotal_cents,shipping_cents,tax_cents,total_cents) VALUES($1,'UNIT-TEST',200,25,16,241)", [RUN]);
  await db.query(`INSERT INTO bags(id,order_id,brand_id,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,transfer_cents,total_cents,ship_by,provider_bound)
    VALUES($1,$2,$3,$4,$5,200,25,16,30,195,241,$6,true)`, [BAG, RUN, registry.brand_id, JSON.stringify(snapshot.bags[0].items), JSON.stringify({ encryptedShipping: auth.encrypt(details.shipTo) }), wall]);
  await db.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status) VALUES('transfer_unit',$1,$2,195,'scheduled')", [BAG, registry.brand_id]);
  await db.query("INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted) VALUES($1,'request_unit','cart_unit','orders_created',$2,$3)", [RUN, auth.encrypt(snapshot), auth.encrypt(details)]);
  const service = await createProviderFulfillment(db, auth, { runtime: unified.runtime, stores });
  return { db, auth, unified, service, stores, registry, order, calls, controls, readDetails, mutateDetails, wall,
    canonical: async () => (await db.query('SELECT status,delivered_at,payout_due_at FROM bags WHERE id=$1', [BAG])).rows[0],
    reopen: () => createProviderFulfillment(db, auth, { runtime: unified.runtime, stores }) };
}

async function completedNoRestockRefund(f, { createdAt = '2026-10-19T11:59:00.000Z' } = {}) {
  const refundId = 'gid://shopify/Refund/1113419088059';
  const parentTransactionId = 'gid://shopify/OrderTransaction/901';
  f.order.displayFinancialStatus = 'PARTIALLY_REFUNDED';
  f.order.lineItems.nodes[0].currentQuantity--;
  f.order.refunds = [{ id: refundId, createdAt,
    refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, restockType: 'NO_RESTOCK', lineItem: { id: LINE } }] },
    transactions: { pageInfo: { hasNextPage: false }, nodes: [{ kind: 'REFUND', status: 'SUCCESS', test: true, gateway: 'manual', parentTransaction: { id: parentTransactionId } }] } }];
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { completed: {
    id: 'prf_before_shipping', status: 'complete', stripeStatus: 'succeeded', shopifyVerified: true, shopifyRefundId: refundId,
    parentTransactionId, items: [{ sku: 'FIXTURE-ONE', qty: 1 }], lineItems: [{ sku: 'FIXTURE-ONE', lineItemId: LINE, qty: 1 }],
  } }; });
}

test('partial actual-provider fixture shipments remain awaiting_shipment, full quantities become shipped once', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const first = await f.service.fulfill(input('first'));
  assert.equal(first.bags[0].shippingStatus, 'partially_fulfilled');
  assert.equal((await f.canonical()).status, 'awaiting_shipment');
  assert.equal((await f.canonical()).payout_due_at, null);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
  await f.service.fulfill(input('first'));
  assert.equal(f.calls.create, 1);
  const second = await f.service.fulfill(input('second'));
  assert.equal(second.bags[0].shippingStatus, 'shipped'); assert.equal((await f.canonical()).status, 'shipped');
  assert.equal(f.calls.create, 2); assert.equal(f.calls.delivery, 0);
  await f.service.sync({ runId: RUN, bagId: BAG });
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM shipments')).rows[0].n, 2);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM jobs')).rows[0].n, 0);
});

test('synthetic notices are encrypted, deduplicated by provider fulfillment, and never claim external email', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('notice', 2)); await f.service.sync({ runId: RUN, bagId: BAG });
  const notices = await f.service.listNotifications(RUN);
  assert.equal(notices.length, 1); assert.equal(notices[0].state, 'simulated_delivered');
  assert.equal(notices[0].mode, 'simulated_inbox'); assert.equal(notices[0].externalEmailDelivered, false);
  assert.match(notices[0].receiptId, /^simulated_/);
  assert.doesNotMatch(JSON.stringify(notices), /PRIVATE_|body|address/i);
  const row = (await f.db.query('SELECT body_encrypted FROM provider_notifications')).rows[0];
  assert.doesNotMatch(row.body_encrypted, /AVAFEM|FIXTURE|PRIVATE/);
  assert.equal(f.auth.decrypt(row.body_encrypted).externalEmailDelivered, false);
  const events = (await f.db.query('SELECT payload FROM outbox_events')).rows;
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|shipTo|health/);
});

test('lost fulfillment create responses reconcile existing tracking/items after recreation without another mutation', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.controls.loseCreate = true;
  assert.equal((await f.service.fulfill(input('lost'))).state, 'needs_review');
  assert.equal(f.calls.create, 1);
  const reopened = await f.reopen(); const result = await reopened.fulfill(input('lost'));
  assert.equal(f.calls.create, 1); assert.equal(result.bags[0].shippingStatus, 'partially_fulfilled');
  assert.equal((await f.readDetails()).bags[BAG].fulfillmentOps.lost.status, 'complete');
});

test('an invisible ambiguous create blocks replay and different operations instead of blindly retrying', { timeout: 20_000 }, async t => {
  const f = await fixture(t); f.controls.createWithoutVisibleResult = true;
  await f.service.fulfill(input('unknown')); await f.service.fulfill(input('unknown')); await f.service.fulfill(input('other'));
  assert.equal(f.calls.create, 1);
  const details = await f.readDetails(); assert.equal(details.bags[BAG].fullyDelivered, false);
  assert.equal(details.bags[BAG].fulfillmentOps.unknown.status, 'uncertain');
  const view = await f.unified.get(RUN); assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|sk_test_/);
});

test('changed operation bodies, excess quantities and non-synthetic tracking never mutate Shopify', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('immutable'));
  const changed = await f.service.fulfill(input('immutable', 2));
  assert.equal(changed.lastError.code, 'FULFILLMENT_OPERATION_CHANGED'); assert.equal(f.calls.create, 1);
  const excess = await f.service.fulfill(input('excess', 3));
  assert.equal(excess.lastError.code, 'FULFILLMENT_QUANTITY_EXCEEDED'); assert.equal(f.calls.create, 1);
  await assert.rejects(f.service.fulfill({ ...input('bad'), tracking: { number: 'REAL-CARRIER-NUMBER', company: 'Other' } }), { code: 'SYNTHETIC_TRACKING_REQUIRED' });
  await assert.rejects(f.service.fulfill({ ...input('bad'), tracking: { ...tracking('BAD'), url: 'https://external.example/label' } }), { code: 'SYNTHETIC_TRACKING_REQUIRED' });
});

test('identity/pagination failures fail closed and invalidate stale delivery eligibility', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const change of [() => { f.order.operationsComplete = false; }, () => { f.order.test = false; }, () => { f.order.sourceIdentifier = 'other_bag'; }, () => { f.registry.brand_id = 'other_brand'; }]) {
    f.order.operationsComplete = true; f.order.test = true; f.order.sourceIdentifier = BAG; f.registry.brand_id = 'brand_fulfillment_unit';
    await f.mutateDetails(details => { details.bags[BAG].fullyDelivered = true; }); change();
    const result = await f.service.sync({ runId: RUN, bagId: BAG });
    assert.equal(result.state, 'needs_review'); assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
  }
  assert.equal(f.calls.create, 0); assert.equal(f.calls.delivery, 0);
});

test('test delivery requires every nonrefunded unit, records provider wall evidence and logical return hold separately', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('partial'));
  const blocked = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'delivery_early', confirmTestDelivery: true });
  assert.equal(blocked.lastError.code, 'FULFILLMENT_PARTIAL_DELIVERY_BLOCKED'); assert.equal(f.calls.delivery, 0);
  await f.service.fulfill(input('remaining'));
  await f.mutateDetails(details => { details.testClock = { now: '2026-11-01T12:00:00.000Z' }; });
  const delivered = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'delivery_all', confirmTestDelivery: true });
  assert.equal(delivered.bags[0].shippingStatus, 'delivered'); assert.equal(f.calls.delivery, 2);
  const value = (await f.readDetails()).bags[BAG];
  assert.equal(value.fullyDelivered, true); assert.equal(value.deliveredAt, '2026-11-01T12:00:00.000Z');
  assert.equal(value.providerDeliveredAt, f.wall.toISOString()); assert.equal(value.carrierVerified, false);
  assert.equal(value.payoutDueAt, '2026-12-01T12:00:00.000Z');
  assert.equal((await f.db.query("SELECT due_at,status FROM transfers WHERE bag_id=$1", [BAG])).rows[0].status, 'scheduled');
  await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'delivery_all', confirmTestDelivery: true }); assert.equal(f.calls.delivery, 2);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM jobs')).rows[0].n, 0);
});

test('later return policy and existing promises never shorten or drift on repeated logical-clock syncs', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('all', 2));
  await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'deliver', confirmTestDelivery: true });
  f.registry.return_window_days = 45;
  await f.service.sync({ runId: RUN, bagId: BAG });
  assert.equal((await f.readDetails()).bags[BAG].payoutDueAt, '2026-12-03T12:00:00.000Z');
  await f.db.query('UPDATE bags SET payout_due_at=$2 WHERE id=$1', [BAG, '2026-12-08T12:00:00.000Z']);
  f.registry.return_window_days = 7;
  await f.mutateDetails(details => { details.testClock = { now: '2027-01-01T12:00:00.000Z' }; });
  await f.service.sync({ runId: RUN, bagId: BAG });
  const value = (await f.readDetails()).bags[BAG];
  assert.equal(value.deliveredAt, f.wall.toISOString()); assert.equal(value.payoutDueAt, '2026-12-08T12:00:00.000Z');
});

test('lost test-delivery responses are reconciled by provider evidence and never recreate an event', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('all', 2)); f.controls.loseDelivery = true;
  await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'lost_delivery', confirmTestDelivery: true });
  assert.equal(f.calls.delivery, 1);
  await f.service.sync({ runId: RUN, bagId: BAG });
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, true);
  await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'lost_delivery', confirmTestDelivery: true });
  assert.equal(f.calls.delivery, 1);
});

test('completed successful refund quantities are excluded without double-counting provider and local records', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.order.displayFinancialStatus = 'PARTIALLY_REFUNDED'; f.order.lineItems.nodes[0].currentQuantity = 1; f.order.lineItems.nodes[0].unfulfilledQuantity = 1;
  f.order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 1;
  f.order.refunds = [{ id: 'gid://shopify/Refund/900', refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, lineItem: { id: LINE } }] }, transactions: { pageInfo: { hasNextPage: false }, nodes: [] } }];
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { prior: { stripeStatus: 'succeeded', status: 'complete', items: [{ sku: 'FIXTURE-ONE', qty: 1 }] } }; });
  await f.service.fulfill(input('last_unit'));
  const result = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'remaining_delivered', confirmTestDelivery: true });
  assert.equal(result.bags[0].shippingStatus, 'delivered'); assert.equal(f.calls.create, 1); assert.equal(f.calls.delivery, 1);
});

test('unresolved refunds and refunded already-fulfilled units cannot prematurely start delivery or settlement', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { pending: { status: 'refund_uncertain', stripeStatus: 'pending', items: [{ sku: 'FIXTURE-ONE', qty: 1 }] } }; });
  await f.service.fulfill(input('held')); assert.equal(f.calls.create, 0);
  await f.mutateDetails(details => { delete details.bags[BAG].refundOps; });
  await f.service.fulfill(input('one_unit'));
  f.order.displayFinancialStatus = 'PARTIALLY_REFUNDED'; f.order.lineItems.nodes[0].currentQuantity = 1;
  f.order.refunds = [{ id: 'gid://shopify/Refund/901', refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, lineItem: { id: LINE } }] }, transactions: { pageInfo: { hasNextPage: false }, nodes: [] } }];
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { done: { status: 'complete', stripeStatus: 'succeeded', items: [{ sku: 'FIXTURE-ONE', qty: 1 }] } }; });
  await f.service.sync({ runId: RUN, bagId: BAG });
  const blocked = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'not_delivered', confirmTestDelivery: true });
  assert.equal(blocked.bags[0].shippingStatus, 'partially_fulfilled'); assert.equal(f.calls.delivery, 0);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false); assert.equal((await f.canonical()).payout_due_at, null);
});

test('verified pre-shipment NO_RESTOCK refund leaves one native orphan but only the three nonrefunded units can ship', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { qty: 4 }); await completedNoRestockRefund(f);
  const first = await f.service.fulfill(input('two_of_three', 2));
  assert.equal(first.bags[0].shippingStatus, 'partially_fulfilled');
  const second = await f.service.fulfill(input('last_of_three', 1));
  assert.equal(second.bags[0].shippingStatus, 'shipped'); assert.equal(f.calls.create, 2);
  assert.equal(f.order.lineItems.nodes[0].unfulfilledQuantity, 1);
  assert.equal(f.order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity, 1);
  const orphan = await f.service.fulfill(input('must_not_ship_refunded_orphan', 1));
  assert.equal(orphan.lastError.code, 'FULFILLMENT_QUANTITY_EXCEEDED'); assert.equal(f.calls.create, 2);
  const delivered = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'nonrefunded_delivered', confirmTestDelivery: true });
  assert.equal(delivered.bags[0].shippingStatus, 'delivered'); assert.equal(f.calls.delivery, 2);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, true);
  assert.equal((await f.readDetails()).bags[BAG].carrierVerified, false);
});

test('a native residual never increases the new-shipment cap after some nonrefunded units are already fulfilled', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { qty: 4 }); await completedNoRestockRefund(f);
  await f.service.fulfill(input('first_two', 2));
  const exceeded = await f.service.fulfill(input('remaining_plus_orphan', 2));
  assert.equal(exceeded.lastError.code, 'FULFILLMENT_QUANTITY_EXCEEDED'); assert.equal(f.calls.create, 1);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
});

test('post-fulfillment NO_RESTOCK refunds cannot explain an unfulfilled residual even with completed exact identities', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('already_shipped', 1));
  await completedNoRestockRefund(f, { createdAt: '2026-10-19T11:59:40.000Z' });
  const result = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'not_proven', confirmTestDelivery: true });
  assert.equal(result.lastError.code, 'FULFILLMENT_PARTIAL_DELIVERY_BLOCKED'); assert.equal(f.calls.delivery, 0);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false); assert.equal((await f.canonical()).payout_due_at, null);
});

test('pre-fulfillment residual proof rejects incomplete, future, equal-time, mixed or uncorrelated history', { timeout: 30_000 }, async t => {
  const f = await fixture(t); await completedNoRestockRefund(f); await f.service.fulfill(input('one_nonrefunded', 1));
  const goodRefund = structuredClone(f.order.refunds[0]); const goodFulfillment = structuredClone(f.order.fulfillments[0]);
  const goodDetails = await f.readDetails();
  const changes = [
    () => { delete f.order.refunds[0].createdAt; },
    () => { f.order.refunds[0].createdAt = 'not-a-provider-time'; },
    () => { f.order.refunds[0].createdAt = '2026-10-19T12:00:00.001Z'; },
    () => { f.order.refunds[0].createdAt = f.order.fulfillments[0].createdAt; },
    () => { delete f.order.fulfillments[0].createdAt; },
    () => { f.order.fulfillments[0].createdAt = '2026-10-19T12:00:00.001Z'; },
    () => { f.order.refunds[0].refundLineItems.nodes[0].restockType = 'RETURN'; },
    () => { f.order.refunds[0].transactions.nodes[0].status = 'PENDING'; },
    () => { f.order.refunds[0].transactions.nodes[0].test = false; },
    () => { f.order.refunds[0].id = 'gid://shopify/Refund/999'; },
    () => f.mutateDetails(value => { value.bags[BAG].refundOps.completed.shopifyVerified = false; }),
    () => f.mutateDetails(value => { value.bags[BAG].refundOps.completed.lineItems[0].lineItemId = 'gid://shopify/LineItem/999'; }),
    () => f.mutateDetails(value => { value.bags[BAG].refundOps.duplicate = structuredClone(value.bags[BAG].refundOps.completed); }),
    () => {
      f.order.fulfillments.push({ ...structuredClone(goodFulfillment), id: 'gid://shopify/Fulfillment/799', status: 'CANCELLED',
        createdAt: '2026-10-19T11:58:00.000Z' });
      f.order.fulfillmentsCount.count = 2;
    },
    () => { f.order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 2; },
    () => { f.order.lineItems.nodes[0].unfulfilledQuantity = 2; },
  ];
  for (const [index, change] of changes.entries()) {
    f.order.refunds = [structuredClone(goodRefund)]; f.order.fulfillments = [structuredClone(goodFulfillment)]; f.order.fulfillmentsCount.count = 1;
    f.order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 1; f.order.lineItems.nodes[0].unfulfilledQuantity = 1;
    await f.mutateDetails(value => { value.bags[BAG] = structuredClone(goodDetails.bags[BAG]); });
    await change();
    const result = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: `ambiguous_${index}`, confirmTestDelivery: true });
    assert.notEqual(result.bags[0].shippingStatus, 'delivered', `Ambiguous history ${index} must not start delivery`);
    assert.equal(f.calls.delivery, 0); assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
    assert.equal((await f.canonical()).payout_due_at, null);
  }
});

test('a completed shipping-only refund consumes no item quantities and does not block fulfillment', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.order.refunds = [{ id: 'gid://shopify/Refund/902', refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, transactions: { pageInfo: { hasNextPage: false }, nodes: [] } }];
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { shipping: {
    stripeStatus: 'succeeded', status: 'complete', items: [], refundShipping: true, subtotalCents: 0, shippingCents: 25,
  } }; });
  const result = await f.service.fulfill(input('shipping_only_refund', 2));
  assert.equal(result.lastError, null); assert.equal(result.bags[0].shippingStatus, 'shipped');
  assert.equal(f.calls.create, 1); assert.equal(f.calls.delivery, 0);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
  assert.equal((await f.canonical()).payout_due_at, null);
});

test('an empty successful refund without an explicit zero-merchandise shipping allocation still fails closed', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.mutateDetails(details => { details.bags[BAG].refundOps = { invalid: {
    stripeStatus: 'succeeded', status: 'complete', items: [], refundShipping: true, subtotalCents: 100, shippingCents: 25,
  } }; });
  const result = await f.service.fulfill(input('invalid_empty_refund', 2));
  assert.equal(result.lastError.code, 'FULFILLMENT_REFUND_MISMATCH'); assert.equal(f.calls.create, 0);
});

test('cancelled canonical/detail state cannot regain delivery eligibility from a delayed active Shopify snapshot', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.service.fulfill(input('before_cancellation', 2));
  await f.db.query("UPDATE bags SET status='cancelled' WHERE id=$1", [BAG]);
  await f.mutateDetails(details => { details.bags[BAG].state = 'cancelled'; details.bags[BAG].cancellationVerified = true; details.bags[BAG].fullyDelivered = true; });
  assert.equal(f.order.cancelledAt, null, 'Synthetic delayed provider snapshot intentionally omits cancellation.');
  const result = await f.service.deliver({ runId: RUN, bagId: BAG, operationId: 'closed_delivery', confirmTestDelivery: true });
  assert.equal(result.bags[0].state, 'cancelled'); assert.equal(f.calls.delivery, 0);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
  assert.equal((await f.canonical()).status, 'cancelled'); assert.equal((await f.canonical()).payout_due_at, null);
});

test('an uncertain cancellation intent prevents fresh fulfillment before authoritative cancellation arrives', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.mutateDetails(details => { details.bags[BAG].cancelOp = { operationId: 'unknown_cancel', status: 'cancel_uncertain' }; });
  const result = await f.service.fulfill(input('after_unknown_cancel', 2));
  assert.equal(result.lastError.code, 'FULFILLMENT_ORDER_CLOSED'); assert.equal(f.calls.create, 0);
  assert.equal((await f.readDetails()).bags[BAG].fullyDelivered, false);
});
