import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyAdapter, isShopifyJobId, SHOPIFY_SCOPES } from '../server/integrations/shopify.mjs';

const orderId = 'gid://shopify/Order/100';
const fulfillmentOrderId = 'gid://shopify/FulfillmentOrder/200';
const fulfillmentOrderLineItemId = 'gid://shopify/FulfillmentOrderLineItem/201';
const lineItemId = 'gid://shopify/LineItem/300';
const parentTransactionId = 'gid://shopify/OrderTransaction/400';
const fulfillmentId = 'gid://shopify/Fulfillment/500';
const jobId = 'gid://shopify/Job/aa07a970-9d6d-4f0a-b52b-bbe49305af33';
const page = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
const money = amount => ({ shopMoney: { amount, currencyCode: 'USD' } });
const tracking = { number: 'AVAFEM-TEST-FIXTURE-1', company: 'Avafem Test (not a carrier)', url: 'https://example.com/test-tracking' };
const fulfillment = () => ({ id: fulfillmentId, status: 'SUCCESS', displayStatus: 'FULFILLED', deliveredAt: null, events: page([]), trackingInfo: [tracking], fulfillmentLineItems: page([{ quantity: 1, lineItem: { id: lineItemId, sku: 'FIXTURE' } }]) });
const order = () => ({
  id: orderId, test: true, currencyCode: 'USD', presentmentCurrencyCode: 'USD', sourceIdentifier: 'bag_test', tags: ['TEST_DO_NOT_SHIP'], cancelledAt: null,
  totalPriceSet: money('2.16'), totalRefundedSet: money('0.00'), totalShippingPriceSet: money('0.00'), refundable: true,
  lineItems: page([{ id: lineItemId, quantity: 2, currentQuantity: 2, refundableQuantity: 2, unfulfilledQuantity: 2, sku: 'FIXTURE', variant: { id: 'gid://shopify/ProductVariant/600' }, originalUnitPriceSet: money('1.00') }]),
  transactions: [{ id: parentTransactionId, kind: 'SALE', status: 'SUCCESS', test: true, gateway: 'manual', manualPaymentGateway: true, amountSet: money('2.16') }],
  refunds: [], fulfillmentOrders: page([{ id: fulfillmentOrderId, status: 'OPEN', requestStatus: 'UNSUBMITTED', supportedActions: [{ action: 'CREATE_FULFILLMENT' }], assignedLocation: { location: { id: 'gid://shopify/Location/700', isFulfillmentService: false } }, lineItems: page([{ id: fulfillmentOrderLineItemId, totalQuantity: 2, remainingQuantity: 2, lineItem: { id: lineItemId, sku: 'FIXTURE' } }]) }]),
  fulfillments: [], fulfillmentsCount: { count: 0, precision: 'EXACT' },
});
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function fixture({ current = order(), mutation, read, grantedScopes = SHOPIFY_SCOPES } = {}) {
  const calls = [];
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (url, options) => {
    assert.equal(new URL(url).pathname, '/admin/api/2026-10/graphql.json');
    const payload = JSON.parse(options.body); calls.push(payload);
    if (payload.query.includes('AvafemPreflight')) return response({ data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'i4vd1u-s8.myshopify.com', currencyCode: 'USD' }, currentAppInstallation: { id: 'gid://shopify/AppInstallation/1', app: { id: 'gid://shopify/App/1', title: 'Fixture' }, accessScopes: grantedScopes.map(handle => ({ handle })) } } });
    if (payload.query.includes('AvafemOrderOperations')) return response({ data: { order: typeof current === 'function' ? current() : current } });
    if (payload.query.startsWith('query')) return read?.(payload) ?? response({ data: { job: { id: jobId, done: true } } });
    return mutation?.(payload) ?? response({ data: { fulfillmentCreate: { fulfillment: fulfillment(), userErrors: [] } } });
  } });
  return { adapter, calls, writes: () => calls.filter(call => call.query.startsWith('mutation')) };
}
const fulfillInput = () => ({ orderId, fulfillmentOrderId, items: [{ fulfillmentOrderLineItemId, qty: 1 }], tracking, operationId: 'op_fulfill_1' });
const refundInput = () => ({ orderId, operationId: 'op_refund_1', lineItems: [{ lineItemId, qty: 1, restockType: 'NO_RESTOCK' }], amountCents: 108, parentTransactionId });
const suggestedRefund = () => ({
  amountSet: money('1.08'), subtotalSet: money('1.00'), discountedSubtotalSet: money('1.00'), totalTaxSet: money('0.08'),
  maximumRefundableSet: money('2.16'), totalDutiesSet: money('0.00'), totalCartDiscountAmountSet: money('0.00'),
  refundLineItems: [{ quantity: 1, restockType: 'NO_RESTOCK', lineItem: { id: lineItemId }, subtotalSet: money('1.00'), totalTaxSet: money('0.08') }],
  shipping: { amountSet: money('0.00'), taxSet: money('0.00'), maximumRefundableSet: money('0.25') },
});
const previewInput = () => ({ orderId, lineItems: [{ lineItemId, quantity: 1 }], shippingAmountCents: 0 });
function previewFixture({ suggestion = suggestedRefund(), current = order(), previewOrder = {} } = {}) {
  return fixture({ current, read: payload => {
    assert.match(payload.query, /AvafemSuggestedRefund/);
    return response({ data: { order: { id: orderId, test: true, currencyCode: 'USD', presentmentCurrencyCode: 'USD', suggestedRefund: suggestion, ...previewOrder } } });
  } });
}

test('native suggested refund is read-only and exposes exact item/shipping tax authority as the official array shape', async () => {
  const suggestion = suggestedRefund();
  suggestion.amountSet = money('1.35'); suggestion.totalTaxSet = money('0.10');
  suggestion.shipping.amountSet = money('0.25'); suggestion.shipping.taxSet = money('0.02');
  const f = previewFixture({ suggestion });
  const result = await f.adapter.getSuggestedRefund({ ...previewInput(), shippingAmountCents: 25 });
  assert.equal(result.orderId, orderId); assert.equal(result.shop, 'i4vd1u-s8.myshopify.com');
  assert.equal(result.operationsComplete, true);
  assert.deepEqual(result.refundLineItems, suggestion.refundLineItems);
  assert.equal(result.shipping.taxSet.shopMoney.amount, '0.02');
  assert.equal(result.totalTaxSet.shopMoney.amount, '0.10');
  const payload = f.calls[1];
  assert.deepEqual(payload.variables, { id: orderId, lineItems: [{ lineItemId, quantity: 1, restockType: 'NO_RESTOCK' }], shippingAmount: '0.25' });
  assert.match(payload.query, /suggestedRefund\(refundLineItems:\$lineItems,shippingAmount:\$shippingAmount\)/);
  assert.match(payload.query, /refundLineItems \{ quantity restockType lineItem \{ id \}/);
  assert.doesNotMatch(payload.query, /refundLineItems\(first|refundLineItems \{ (nodes|pageInfo)|shippingAddress|customer|email/);
  assert.equal(f.writes().length, 0);
});

test('native preview supports shipping-only and returns provider partial-quantity rounding without inventing taxes', async () => {
  const suggestion = suggestedRefund(); suggestion.refundLineItems = [];
  suggestion.amountSet = money('0.27'); suggestion.subtotalSet = money('0.00'); suggestion.discountedSubtotalSet = money('0.00');
  suggestion.totalTaxSet = money('0.02'); suggestion.shipping.amountSet = money('0.25'); suggestion.shipping.taxSet = money('0.02');
  const f = previewFixture({ suggestion });
  const result = await f.adapter.getSuggestedRefund({ orderId, lineItems: [], shippingAmountCents: 25 });
  assert.deepEqual(result.refundLineItems, []); assert.equal(result.amountSet.shopMoney.amount, '0.27');
  const rounded = suggestedRefund(); rounded.amountSet = money('1.07'); rounded.totalTaxSet = money('0.07'); rounded.refundLineItems[0].totalTaxSet = money('0.07');
  const p = previewFixture({ suggestion: rounded });
  assert.equal((await p.adapter.getSuggestedRefund(previewInput())).refundLineItems[0].totalTaxSet.shopMoney.amount, '0.07');
  assert.equal(p.writes().length, 0);
});

test('native preview rejects invalid quantities/identities and incomplete or live order snapshots without remote writes', async () => {
  for (const input of [
    { ...previewInput(), orderId: 'bad' }, { ...previewInput(), lineItems: [] },
    { ...previewInput(), lineItems: [{ lineItemId, quantity: 0 }] },
    { ...previewInput(), lineItems: [{ lineItemId, quantity: 1 }, { lineItemId, quantity: 1 }] },
    { ...previewInput(), shippingAmountCents: -1 }, { ...previewInput(), shippingAmountCents: 2.5 },
  ]) {
    const f = previewFixture(); await assert.rejects(f.adapter.getSuggestedRefund(input)); assert.equal(f.calls.length, 0);
  }
  for (const change of [
    value => { value.test = false; }, value => { value.lineItems.pageInfo.hasNextPage = true; },
    value => { value.lineItems.nodes[0].refundableQuantity = 0; }, value => { value.lineItems.nodes[0].id = 'gid://shopify/LineItem/999'; },
  ]) {
    const current = order(); change(current); const f = previewFixture({ current });
    await assert.rejects(f.adapter.getSuggestedRefund(previewInput())); assert.equal(f.calls.length, 1); assert.equal(f.writes().length, 0);
  }
});

test('native preview rejects incomplete, counterfeit, wrong-currency, out-of-bounds and mismatched provider responses', async () => {
  for (const change of [
    value => { value.refundLineItems = { nodes: value.refundLineItems }; },
    value => { value.refundLineItems = []; }, value => { value.refundLineItems.push({ ...value.refundLineItems[0] }); },
    value => { value.refundLineItems[0].lineItem.id = 'gid://shopify/LineItem/999'; },
    value => { value.refundLineItems[0].quantity = 2; }, value => { delete value.shipping.taxSet; },
    value => { value.totalTaxSet.shopMoney.currencyCode = 'EUR'; }, value => { value.totalTaxSet.shopMoney.amount = '-0.01'; },
    value => { value.shipping.amountSet = money('0.01'); }, value => { value.amountSet = money('100.01'); },
    value => { value.maximumRefundableSet = money('0.50'); },
  ]) {
    const suggestion = suggestedRefund(); change(suggestion); const f = previewFixture({ suggestion });
    await assert.rejects(f.adapter.getSuggestedRefund(previewInput()), { code: 'SHOPIFY_REFUND_PREVIEW_INVALID' }); assert.equal(f.writes().length, 0);
  }
  for (const previewOrder of [{ id: 'gid://shopify/Order/999' }, { test: false }, { currencyCode: 'EUR' }, { presentmentCurrencyCode: 'CAD' }]) {
    const f = previewFixture({ previewOrder });
    await assert.rejects(f.adapter.getSuggestedRefund(previewInput()), { code: 'SHOPIFY_REFUND_PREVIEW_INVALID' }); assert.equal(f.writes().length, 0);
  }
});

test('lifecycle reads include precise fulfillment/refund identities and no customer/address fields', async () => {
  const f = fixture();
  const result = await f.adapter.getOrderOperations(orderId);
  assert.equal(result.operationsComplete, true);
  assert.equal(result.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity, 2);
  const query = f.calls[0].query;
  assert.match(query, /refunds \{ id note/);
  assert.match(query, /fulfillments\(first:10\) \{ id status displayStatus createdAt deliveredAt/);
  assert.match(query, /refundableQuantity/);
  assert.match(query, /parentTransaction \{ id \}/);
  assert.doesNotMatch(query, /shippingAddress|email|customer\s*\{|phone|read_locations|isFulfillmentService/);
  assert.equal(SHOPIFY_SCOPES.length, 15);
});

test('explicit partial fulfillment sends exact subset, test tracking and no notifications', async () => {
  const f = fixture();
  const result = await f.adapter.createPartialFulfillment(fulfillInput());
  assert.equal(result.fulfillment.id, fulfillmentId);
  assert.equal(result.operationId, 'op_fulfill_1');
  const payload = f.writes()[0];
  assert.match(payload.query, /fulfillmentCreate\(fulfillment:\$fulfillment,message:\$message\)/);
  assert.deepEqual(payload.variables.fulfillment, { notifyCustomer: false, trackingInfo: tracking, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId, fulfillmentOrderLineItems: [{ id: fulfillmentOrderLineItemId, quantity: 1 }] }] });
  assert.match(payload.variables.message, /AVAFEM TEST ONLY/);
  assert.equal(f.writes().length, 1);
});

test('all lifecycle writes refuse non-test orders, including tracking/refunds/cancellation', async () => {
  const current = order(); current.test = false; current.fulfillments = [fulfillment()]; current.fulfillmentsCount.count = 1;
  const f = fixture({ current });
  for (const call of [() => f.adapter.createPartialFulfillment(fulfillInput()), () => f.adapter.updateTracking({ orderId, fulfillmentId, tracking, operationId: 'track' }), () => f.adapter.createManualRefund(refundInput()), () => f.adapter.cancelOrder({ orderId, operationId: 'cancel' })]) {
    await assert.rejects(call(), { code: 'SHOPIFY_TEST_ORDER_REQUIRED' });
  }
  assert.equal(f.writes().length, 0);
});

test('fulfillment verifies ownership, merchant-managed location, supported action and remaining quantity', async () => {
  for (const alter of [
    value => { value.fulfillmentOrders.nodes[0].id = 'gid://shopify/FulfillmentOrder/999'; },
    value => { value.fulfillmentOrders.nodes[0].assignedLocation.location = null; },
    value => { value.fulfillmentOrders.nodes[0].supportedActions = []; },
    value => { value.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 0; },
    value => { value.cancelledAt = new Date(0).toISOString(); },
  ]) {
    const current = order(); alter(current); const f = fixture({ current });
    await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()));
    assert.equal(f.writes().length, 0);
  }
});

test('partial fulfillment verifies the exact merchant-managed permission ceiling without read_locations', async () => {
  for (const grantedScopes of [
    SHOPIFY_SCOPES.filter(scope => !['read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'].includes(scope)),
    [...SHOPIFY_SCOPES, 'read_assigned_fulfillment_orders'],
    [...SHOPIFY_SCOPES, 'write_third_party_fulfillment_orders'],
    [...SHOPIFY_SCOPES, 'read_locations'],
  ]) {
    const f = fixture({ grantedScopes });
    await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), { code: 'SHOPIFY_FULFILLMENT_SCOPE_REQUIRED' });
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].query, /AvafemPreflight/); assert.equal(f.writes().length, 0);
  }
  const current = order(); delete current.fulfillmentOrders.nodes[0].assignedLocation.location.isFulfillmentService;
  const f = fixture({ current });
  await f.adapter.createPartialFulfillment(fulfillInput());
  assert.equal(f.writes().length, 1);
  assert.ok(f.calls.every(call => !/isFulfillmentService|read_locations/.test(call.query)));
});

test('bounded snapshots fail closed on any incomplete nested lifecycle page or truncated fulfillment array', async () => {
  for (const alter of [
    value => { value.lineItems.pageInfo.hasNextPage = true; },
    value => { value.fulfillmentOrders.pageInfo.hasNextPage = true; },
    value => { value.fulfillmentOrders.nodes[0].lineItems.pageInfo.hasNextPage = true; },
    value => { value.fulfillmentsCount.count = 11; },
    value => { value.fulfillmentsCount.precision = 'AT_LEAST'; },
    value => { value.refunds = [{ refundLineItems: page([]), transactions: { ...page([]), pageInfo: { hasNextPage: true } } }]; },
  ]) {
    const current = order(); alter(current); const f = fixture({ current });
    assert.equal((await f.adapter.getOrderOperations(orderId)).operationsComplete, false);
    await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), { code: 'SHOPIFY_PAGINATION_REQUIRED' });
    assert.equal(f.writes().length, 0);
  }
});

test('tracking updates only an existing order-owned active fulfillment, with notifyCustomer false', async () => {
  const current = order(); current.fulfillments = [fulfillment()]; current.fulfillmentsCount.count = 1;
  const f = fixture({ current, mutation: () => response({ data: { fulfillmentTrackingInfoUpdate: { fulfillment: fulfillment(), userErrors: [] } } }) });
  await f.adapter.updateTracking({ orderId, fulfillmentId, tracking, operationId: 'tracking_1' });
  assert.deepEqual(f.writes()[0].variables, { fulfillmentId, trackingInfoInput: tracking, notifyCustomer: false });
  await assert.rejects(f.adapter.updateTracking({ orderId, fulfillmentId: 'gid://shopify/Fulfillment/999', tracking, operationId: 'tracking_2' }));
  assert.equal(f.writes().length, 1);
});

test('manual refund uses an explicit original manual test payment and mandatory stable UUID idempotency', async () => {
  const refund = { id: 'gid://shopify/Refund/800', totalRefundedSet: money('1.08') };
  const make = () => fixture({ mutation: () => response({ data: { refundCreate: { refund, userErrors: [] } } }) });
  const first = make(); await first.adapter.createManualRefund(refundInput());
  const payload = first.writes()[0];
  assert.match(payload.query, /refundCreate\(input:\$input\) @idempotent\(key:\$idempotencyKey\)/);
  assert.match(payload.variables.idempotencyKey, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(payload.variables.input.transactions, [{ orderId, parentId: parentTransactionId, kind: 'REFUND', gateway: 'manual', amount: '1.08' }]);
  assert.deepEqual(payload.variables.input.refundLineItems, [{ lineItemId, quantity: 1, restockType: 'NO_RESTOCK' }]);
  assert.equal(payload.variables.input.notify, false);
  assert.equal(payload.variables.input.allowOverRefunding, false);
  const second = make(); await second.adapter.createManualRefund(refundInput());
  assert.equal(second.writes()[0].variables.idempotencyKey, payload.variables.idempotencyKey);
  const third = make(); await third.adapter.createManualRefund({ ...refundInput(), operationId: 'different_op' });
  assert.notEqual(third.writes()[0].variables.idempotencyKey, payload.variables.idempotencyKey);
});

test('refund prevents cross-order lines/transactions, over-refunds, pending refund duplicates and implicit restock', async () => {
  for (const alter of [
    value => { value.transactions[0].id = 'gid://shopify/OrderTransaction/999'; },
    value => { value.transactions[0].test = false; },
    value => { value.transactions[0].gateway = 'shopify_payments'; },
    value => { value.transactions[0].manualPaymentGateway = false; },
    value => { value.lineItems.nodes[0].refundableQuantity = 0; },
    value => { value.transactions.push({ id: 'gid://shopify/OrderTransaction/401', kind: 'REFUND', status: 'PENDING', parentTransaction: { id: parentTransactionId }, amountSet: money('2.00') }); },
  ]) {
    const current = order(); alter(current); const f = fixture({ current });
    await assert.rejects(f.adapter.createManualRefund(refundInput())); assert.equal(f.writes().length, 0);
  }
  const f = fixture();
  await assert.rejects(f.adapter.createManualRefund({ ...refundInput(), amountCents: 217 }));
  await assert.rejects(f.adapter.createManualRefund({ ...refundInput(), lineItems: [{ lineItemId, qty: 1, restockType: 'RETURN' }] }));
  assert.equal(f.writes().length, 0);
});

test('cancellation disables Shopify refunds/notifications/restocking, returns an async job for polling', async () => {
  const f = fixture({ mutation: () => response({ data: { orderCancel: { job: { id: jobId, done: false }, orderCancelUserErrors: [] } } }) });
  const result = await f.adapter.cancelOrder({ orderId, operationId: 'cancel_1' });
  assert.equal(result.job.id, jobId); assert.equal(result.job.done, false);
  assert.deepEqual(f.writes()[0].variables, { orderId, notifyCustomer: false, refundMethod: { originalPaymentMethodsRefund: false }, restock: false, reason: 'OTHER', staffNote: 'AVAFEM TEST ONLY / cancel_1' });
  assert.deepEqual(await f.adapter.getJob(jobId), { id: jobId, done: true });
  assert.match(f.calls.at(-1).query, /job\(id:\$id\)/);
});

test('Shopify Job IDs accept exact numeric or UUID shapes, including the documented cancellation UUID', async () => {
  for (const id of [jobId, 'gid://shopify/Job/1fb9ff6d-d99c-49cf-80c5-6f915f0735ad', 'gid://shopify/Job/123456789']) {
    assert.equal(isShopifyJobId(id), true);
    const f = fixture({ read: () => response({ data: { job: { id, done: false } } }) });
    assert.deepEqual(await f.adapter.getJob(id), { id, done: false });
    assert.deepEqual(f.calls[0].variables, { id });
  }
  for (const id of ['gid://shopify/Order/1', 'gid://shopify/Job/not-a-uuid', 'gid://shopify/Job/1fb9ff6d-d99c-49cf-80c5-6f915f0735a',
    'gid://shopify/Job/1fb9ff6d-d99c-49cf-80c5-6f915f0735ad/extra', 'GID://shopify/Job/123', 'gid://shopify/Job/123?key=private', null]) {
    assert.equal(isShopifyJobId(id), false);
    const f = fixture(); await assert.rejects(f.adapter.getJob(id), { code: 'INVALID_INTEGRATION_INPUT' }); assert.equal(f.calls.length, 0);
  }
});

test('an invalid cancellation job response stays uncertain and cannot cause a second cancel mutation', async () => {
  const f = fixture({ mutation: () => response({ data: { orderCancel: { job: { id: 'gid://shopify/Job/not-a-uuid', done: false }, orderCancelUserErrors: [] } } }) });
  const input = { orderId, operationId: 'invalid_returned_job' };
  await assert.rejects(f.adapter.cancelOrder(input), { code: 'OUTCOME_UNCERTAIN' });
  await assert.rejects(f.adapter.cancelOrder(input), { code: 'OUTCOME_UNCERTAIN' });
  assert.equal(f.writes().length, 1);
});

test('cancellation rejects fulfilled orders and never repeats already-cancelled orders', async () => {
  const fulfilled = order(); fulfilled.fulfillments = [fulfillment()]; fulfilled.fulfillmentsCount.count = 1;
  const f = fixture({ current: fulfilled });
  await assert.rejects(f.adapter.cancelOrder({ orderId, operationId: 'cancel' })); assert.equal(f.writes().length, 0);
  const cancelled = order(); cancelled.cancelledAt = new Date(0).toISOString(); const c = fixture({ current: cancelled });
  assert.equal((await c.adapter.cancelOrder({ orderId, operationId: 'cancel' })).alreadyCancelled, true);
  assert.equal(c.writes().length, 0);
  await assert.rejects(c.adapter.cancelOrder({ orderId, operationId: 'cancel', restock: true }));
});

test('uncertain lifecycle writes are never blindly repeated and report the actual operation', async () => {
  for (const mutation of [() => { throw new DOMException('PRIVATE_ADDRESS fixture timeout', 'TimeoutError'); }, () => response({}, 503), () => response({ errors: [{ message: 'PRIVATE_ADDRESS resolver failure' }] })]) {
    const f = fixture({ mutation });
    await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), error => error.code === 'OUTCOME_UNCERTAIN' && error.details.operation === 'fulfillmentCreate' && error.details.reference === 'op_fulfill_1' && !error.message.includes('PRIVATE_ADDRESS'));
    await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), { code: 'OUTCOME_UNCERTAIN' });
    assert.equal(f.writes().length, 1);
  }
});

test('local concurrent/replayed lifecycle operation never makes a duplicate mutation; changed inputs rejected', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ mutation: async () => { await gate; return response({ data: { fulfillmentCreate: { fulfillment: fulfillment(), userErrors: [] } } }); } });
  const first = f.adapter.createPartialFulfillment(fulfillInput());
  while (!f.writes().length) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), { code: 'OUTCOME_UNCERTAIN' });
  release(); await first;
  await f.adapter.createPartialFulfillment(fulfillInput());
  assert.equal(f.writes().length, 1);
  await assert.rejects(f.adapter.createPartialFulfillment({ ...fulfillInput(), items: [{ fulfillmentOrderLineItemId, qty: 2 }] }), { code: 'SHOPIFY_OPERATION_MISMATCH' });
});

test('user rejection errors are sanitized and malformed tracking/items never trigger provider writes', async () => {
  const f = fixture({ mutation: () => response({ data: { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['address'], message: 'PRIVATE_ADDRESS customer@example.com' }] } } }) });
  await assert.rejects(f.adapter.createPartialFulfillment(fulfillInput()), error => error.code === 'SHOPIFY_LIFECYCLE_REJECTED' && !JSON.stringify(error).includes('PRIVATE_ADDRESS') && !error.message.includes('customer@example.com'));
  const invalid = fixture();
  for (const input of [{ ...fulfillInput(), tracking: { number: 'REAL_CARRIER_NUMBER' } }, { ...fulfillInput(), items: [] }, { ...fulfillInput(), items: [{ fulfillmentOrderLineItemId, qty: 1 }, { fulfillmentOrderLineItemId, qty: 1 }] }, { ...fulfillInput(), operationId: 'PRIVATE EMAIL@example.com' }]) await assert.rejects(invalid.adapter.createPartialFulfillment(input));
  assert.equal(invalid.calls.length, 0);
});

test('preflight safely returns app installation identity without changing the exact scope ceiling', async () => {
  const f = fixture({ read: () => response({ data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'i4vd1u-s8.myshopify.com', currencyCode: 'USD' }, currentAppInstallation: { id: 'gid://shopify/AppInstallation/1', app: { id: 'gid://shopify/App/1', title: 'Fixture' }, accessScopes: SHOPIFY_SCOPES.map(handle => ({ handle })) } } }) });
  const result = await f.adapter.preflight();
  assert.equal(result.installationId, 'gid://shopify/AppInstallation/1'); assert.equal(result.verified, true);
  assert.deepEqual(result.locations, []); assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
});

test('variant reads expose inventory policy and explicit decrement does not silently change the BYPASS default', async () => {
  const calls = [];
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    if (payload.query.includes('AvafemTestVariant')) return response({ data: { shop: { currencyCode: 'USD' }, productVariant: { id: 'gid://shopify/ProductVariant/600', sku: 'FIXTURE', title: 'Default', price: '1.00', inventoryQuantity: 20, inventoryPolicy: 'DENY', product: { title: 'Fixture', status: 'ACTIVE' }, inventoryItem: { tracked: true, requiresShipping: true } } } });
    if (payload.query.includes('AvafemFindOrder')) return response({ data: { orders: { nodes: [] } } });
    return response({ data: { orderCreate: { order: { id: orderId, test: true }, userErrors: [] } } });
  } });
  assert.equal((await adapter.getVariant('gid://shopify/ProductVariant/600')).inventoryPolicy, 'DENY');
  const bag = id => ({ id, paid: true, sandbox: true, items: [{ sku: 'FIXTURE', title: 'Fixture', qty: 2, unitPriceCents: 100, shopifyVariantId: 'gid://shopify/ProductVariant/600' }], shipTo: { name: 'Synthetic Test', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' }, shippingCents: 0, taxCents: 0 });
  await adapter.createOrder(bag('bag_explicit_stock'), { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY' });
  await adapter.createOrder(bag('bag_original_bypass'));
  const creates = calls.filter(call => call.query.includes('mutation AvafemCreateOrder'));
  assert.equal(creates[0].variables.options.inventoryBehaviour, 'DECREMENT_OBEYING_POLICY');
  assert.equal(creates[1].variables.options.inventoryBehaviour, 'BYPASS');
  assert.equal(creates[0].variables.order.lineItems[0].quantity, 2);
});

test('explicit Shopify test delivery uses real wall time, no PII/location and honestly labeled evidence', async () => {
  const current = order(); current.fulfillments = [fulfillment()]; current.fulfillmentsCount.count = 1;
  const before = Date.now();
  const f = fixture({ current, mutation: payload => response({ data: { fulfillmentEventCreate: { fulfillmentEvent: { id: 'gid://shopify/FulfillmentEvent/900', ...payload.variables.fulfillmentEvent }, userErrors: [] } } }) });
  const result = await f.adapter.createTestDeliveryEvent({ orderId, fulfillmentId, operationId: 'delivery_1', happenedAt: '2099-01-01T00:00:00Z', logicalClock: '2099-01-01T00:00:00Z' });
  const payload = f.writes()[0];
  assert.match(payload.query, /fulfillmentEventCreate\(fulfillmentEvent:\$fulfillmentEvent\)/);
  assert.deepEqual(Object.keys(payload.variables.fulfillmentEvent).sort(), ['fulfillmentId', 'happenedAt', 'message', 'status']);
  assert.equal(payload.variables.fulfillmentEvent.status, 'DELIVERED');
  const time = Date.parse(payload.variables.fulfillmentEvent.happenedAt);
  assert.ok(time >= before && time <= Date.now());
  assert.match(payload.variables.fulfillmentEvent.message, /AVAFEM SHOPIFY TEST DELIVERY \/ delivery_1 \/ NOT CARRIER VERIFIED/);
  assert.equal(result.evidenceLabel, 'shopify_test_delivery_event'); assert.equal(result.carrierVerified, false);
  assert.equal(result.fulfillmentEvent.id, 'gid://shopify/FulfillmentEvent/900');
  await f.adapter.createTestDeliveryEvent({ orderId, fulfillmentId, operationId: 'delivery_1' });
  assert.equal(f.writes().length, 1);
  const otherId = 'gid://shopify/Fulfillment/501';
  current.fulfillments.push({ ...fulfillment(), id: otherId }); current.fulfillmentsCount.count = 2;
  await assert.rejects(f.adapter.createTestDeliveryEvent({ orderId, fulfillmentId: otherId, operationId: 'delivery_1' }), { code: 'SHOPIFY_OPERATION_MISMATCH' });
  const query = f.calls[0].query;
  assert.match(query, /displayStatus createdAt deliveredAt/); assert.match(query, /events\(first:20\)/);
});

test('test delivery refuses live, foreign, cancelled, non-synthetic, incomplete or already-delivered fulfillments', async () => {
  for (const alter of [
    value => { value.test = false; },
    value => { value.currencyCode = 'EUR'; },
    value => { value.presentmentCurrencyCode = 'EUR'; },
    value => { value.cancelledAt = new Date(0).toISOString(); },
    value => { value.fulfillments[0].id = 'gid://shopify/Fulfillment/999'; },
    value => { value.fulfillments[0].status = 'PENDING'; },
    value => { value.fulfillments[0].trackingInfo = []; },
    value => { value.fulfillments[0].trackingInfo = [{ number: 'REAL_CARRIER_NUMBER', company: 'UPS' }]; },
    value => { value.fulfillments[0].events.pageInfo.hasNextPage = true; },
    value => { value.fulfillments[0].displayStatus = 'DELIVERED'; },
    value => { value.fulfillments[0].events.nodes.push({ id: 'gid://shopify/FulfillmentEvent/899', status: 'DELIVERED', message: 'Another delivery operation' }); },
  ]) {
    const current = order(); current.fulfillments = [fulfillment()]; current.fulfillmentsCount.count = 1; alter(current);
    const f = fixture({ current });
    await assert.rejects(f.adapter.createTestDeliveryEvent({ orderId, fulfillmentId, operationId: 'delivery_1' }));
    assert.equal(f.writes().length, 0);
  }
});

test('an uncertain delivery event is reconciled by immutable operation marker and never blindly recreated', async () => {
  const current = order(); current.fulfillments = [fulfillment()]; current.fulfillmentsCount.count = 1;
  let event;
  const f = fixture({ current, mutation: payload => { event = { id: 'gid://shopify/FulfillmentEvent/900', ...payload.variables.fulfillmentEvent }; throw new DOMException('Fixture timeout', 'TimeoutError'); } });
  const input = { orderId, fulfillmentId, operationId: 'delivery_1' };
  await assert.rejects(f.adapter.createTestDeliveryEvent(input), error => error.code === 'OUTCOME_UNCERTAIN' && error.details.operation === 'fulfillmentEventCreate');
  await assert.rejects(f.adapter.createTestDeliveryEvent(input), { code: 'OUTCOME_UNCERTAIN' });
  assert.equal(f.writes().length, 1);
  current.fulfillments[0].events.nodes.push(event); current.fulfillments[0].displayStatus = 'DELIVERED';
  const reconciled = await f.adapter.createTestDeliveryEvent(input);
  assert.equal(reconciled.alreadyExists, true); assert.equal(reconciled.fulfillmentEvent.id, event.id);
  assert.equal(reconciled.carrierVerified, false); assert.equal(f.writes().length, 1);
  current.fulfillments[0].events.nodes.push({ ...event, id: 'gid://shopify/FulfillmentEvent/901' });
  await assert.rejects(f.adapter.createTestDeliveryEvent(input), { code: 'SHOPIFY_DELIVERY_MARKER_CONFLICT' });
});

test('shipping refunds explicitly request tax-exclusive USD shipping and preserve provider shipping-tax evidence', async () => {
  const current = order(); current.totalShippingPriceSet = money('0.25'); current.transactions[0].amountSet = money('2.43');
  const refund = { id: 'gid://shopify/Refund/800', totalRefundedSet: money('1.35'), refundShippingLines: page([{ id: 'gid://shopify/RefundShippingLine/801', shippingLine: { id: 'gid://shopify/ShippingLine/802' }, subtotalAmountSet: money('0.25'), taxAmountSet: money('0.02') }]), transactions: page([{ id: 'gid://shopify/OrderTransaction/803', kind: 'REFUND', status: 'SUCCESS', test: true, gateway: 'manual', parentTransaction: { id: parentTransactionId }, amountSet: money('1.35') }]) };
  const f = fixture({ current, mutation: () => response({ data: { refundCreate: { refund, userErrors: [] } } }) });
  const result = await f.adapter.createManualRefund({ ...refundInput(), amountCents: 135, shippingCents: 25 });
  assert.deepEqual(f.writes()[0].variables.input.shipping, { amount: '0.25' });
  assert.equal(f.writes()[0].variables.input.transactions[0].amount, '1.35');
  assert.equal(result.refund.refundShippingLines.nodes[0].taxAmountSet.shopMoney.amount, '0.02');
  assert.match(f.calls[0].query, /refundShippingLines\(first:20\)/); assert.match(f.writes()[0].query, /taxAmountSet/);
  for (const alter of [
    value => { value.refundShippingLines.nodes[0].subtotalAmountSet = money('0.24'); },
    value => { value.refundShippingLines.pageInfo.hasNextPage = true; },
    value => { value.transactions.nodes[0].status = 'PENDING'; },
    value => { value.transactions.nodes[0].test = false; },
    value => { value.totalRefundedSet = money('1.34'); },
    value => { value.refundShippingLines.nodes[0].taxAmountSet.shopMoney.currencyCode = 'CAD'; },
  ]) {
    const changed = structuredClone(refund); alter(changed);
    const failed = fixture({ current, mutation: () => response({ data: { refundCreate: { refund: changed, userErrors: [] } } }) });
    await assert.rejects(failed.adapter.createManualRefund({ ...refundInput(), amountCents: 135, shippingCents: 25 }), { code: 'OUTCOME_UNCERTAIN' });
    assert.equal(failed.writes().length, 1);
  }
});

test('shipping refund cannot exceed original or already-refunded shipping and rejects invalid cents without a write', async () => {
  const current = order(); current.totalShippingPriceSet = money('0.25');
  current.refunds = [{ id: 'gid://shopify/Refund/799', refundLineItems: page([]), transactions: page([]), refundShippingLines: page([{ subtotalAmountSet: money('0.20'), taxAmountSet: money('0.02') }]) }];
  const f = fixture({ current });
  await assert.rejects(f.adapter.createManualRefund({ ...refundInput(), shippingCents: 25 }));
  assert.equal(f.writes().length, 0);
  for (const shippingCents of [-1, 0.5, 109, Number.NaN]) await assert.rejects(f.adapter.createManualRefund({ ...refundInput(), shippingCents }));
  assert.equal(f.writes().length, 0);
});

test('final shipping-only refund needs no invented refundable product quantity', async () => {
  const current = order(); current.totalShippingPriceSet = money('0.25'); current.lineItems.nodes[0].refundableQuantity = 0;
  const refund = { id: 'gid://shopify/Refund/900', totalRefundedSet: money('0.27'), refundLineItems: page([]), refundShippingLines: page([{ subtotalAmountSet: money('0.25'), taxAmountSet: money('0.02') }]), transactions: page([{ id: 'gid://shopify/OrderTransaction/901', kind: 'REFUND', status: 'SUCCESS', test: true, gateway: 'manual', parentTransaction: { id: parentTransactionId }, amountSet: money('0.27') }]) };
  const f = fixture({ current, mutation: () => response({ data: { refundCreate: { refund, userErrors: [] } } }) });
  await f.adapter.createManualRefund({ ...refundInput(), lineItems: [], shippingCents: 25, amountCents: 27 });
  assert.deepEqual(f.writes()[0].variables.input.refundLineItems, []);
  assert.deepEqual(f.writes()[0].variables.input.shipping, { amount: '0.25' });
  await assert.rejects(f.adapter.createManualRefund({ ...refundInput(), operationId: 'empty_refund', lineItems: [], shippingCents: 0 }));
  assert.equal(f.writes().length, 1);
});
