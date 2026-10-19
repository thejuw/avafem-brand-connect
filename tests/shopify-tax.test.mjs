import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyAdapter } from '../server/integrations/shopify.mjs';

const money = cents => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: 'USD' } });
const tax = (amountCents, rate = .0625, title = 'Stripe TEST US TX tax') => ({ amountCents, rate, title });
const native = () => ({ lineTaxLines: { FIXTURE_A: [tax(13), tax(4, .02, 'Stripe TEST local tax')], FIXTURE_B: [] }, shippingTaxLines: [tax(2), tax(1, .02, 'Stripe TEST local tax')] });
const bag = () => ({
  id: 'bag_native_tax', paid: true, sandbox: true, shippingCents: 25, taxCents: 20,
  items: [
    { sku: 'FIXTURE_A', title: 'Fixture A', qty: 2, unitPriceCents: 100, shopifyVariantId: 'gid://shopify/ProductVariant/1' },
    { sku: 'FIXTURE_B', title: 'Fixture B exempt', qty: 1, unitPriceCents: 50, shopifyVariantId: 'gid://shopify/ProductVariant/2' },
  ],
  shipTo: { name: 'Synthetic Test', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' },
  customerEmail: 'PRIVATE_SHOPPER@example.com', health: { diagnosis: 'PRIVATE_HEALTH' },
});
const response = data => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
function fixture({ details } = {}) {
  const calls = [];
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, init) => {
    const payload = JSON.parse(init.body); calls.push(payload);
    if (payload.query.includes('AvafemFindOrder')) return response({ orders: { nodes: [] } });
    if (payload.query.includes('AvafemTestOrderReadback')) return response({ order: details });
    if (payload.query.includes('mutation AvafemCreateOrder')) return response({ orderCreate: { order: { id: 'gid://shopify/Order/1', test: true }, userErrors: [] } });
    throw new Error('Unexpected fixture query');
  } });
  return { adapter, calls, writes: () => calls.filter(call => call.query.startsWith('mutation')) };
}

test('native item and shipping taxes preserve exact multiple provider rates without order-level redistribution', async () => {
  const f = fixture();
  await f.adapter.createOrder(bag(), { ...native(), inventoryBehaviour: 'DECREMENT_OBEYING_POLICY' });
  const payload = f.writes()[0];
  const order = payload.variables.order;
  assert.equal(Object.hasOwn(order, 'taxLines'), false);
  assert.equal(order.taxesIncluded, false);
  assert.deepEqual(order.lineItems[0].taxLines, [
    { title: 'Stripe TEST US TX tax', rate: .0625, priceSet: money(13) },
    { title: 'Stripe TEST local tax', rate: .02, priceSet: money(4) },
  ]);
  assert.equal(order.lineItems[0].quantity, 2);
  assert.deepEqual(order.lineItems[0].priceSet, money(100));
  // 17 cents applies to the entire qty-2 line: never multiply it by quantity again.
  assert.equal(order.lineItems[0].taxable, true);
  assert.deepEqual(order.lineItems[1].taxLines, []);
  assert.equal(order.lineItems[1].taxable, false);
  assert.deepEqual(order.shippingLines, [{ title: 'standard', priceSet: money(25), taxLines: [
    { title: 'Stripe TEST US TX tax', rate: .0625, priceSet: money(2) },
    { title: 'Stripe TEST local tax', rate: .02, priceSet: money(1) },
  ] }]);
  assert.deepEqual(order.transactions[0], { kind: 'SALE', status: 'SUCCESS', gateway: 'manual', test: true, amountSet: money(295) });
  assert.equal(order.test, true);
  assert.deepEqual(payload.variables.options, { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: 'DECREMENT_OBEYING_POLICY' });
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_HEALTH|PRIVATE_SHOPPER|diagnosis|customerEmail/);
});

test('native zero-tax allocations remain explicit for each item and shipping', async () => {
  const value = bag(); value.taxCents = 0;
  const f = fixture();
  await f.adapter.createOrder(value, { lineTaxLines: { FIXTURE_A: [], FIXTURE_B: [] }, shippingTaxLines: [] });
  const order = f.writes()[0].variables.order;
  assert.equal(Object.hasOwn(order, 'taxLines'), false);
  assert.ok(order.lineItems.every(item => item.taxable === false && item.taxLines.length === 0));
  assert.deepEqual(order.shippingLines[0].taxLines, []);
  assert.deepEqual(order.transactions[0].amountSet, money(275));
});

test('native tax mode rejects mixed, partial, unknown, duplicate and invalid allocations before any provider call', async () => {
  const cases = [
    () => [bag(), { ...native(), taxLines: [] }],
    () => [bag(), { lineTaxLines: native().lineTaxLines }],
    () => [bag(), { shippingTaxLines: native().shippingTaxLines }],
    () => [bag(), { ...native(), lineTaxLines: { FIXTURE_A: native().lineTaxLines.FIXTURE_A } }],
    () => [bag(), { ...native(), lineTaxLines: { ...native().lineTaxLines, UNRECOGNIZED: [] } }],
    () => [bag(), { ...native(), lineTaxLines: { FIXTURE_A: undefined, FIXTURE_B: [] } }],
    () => { const value = bag(); value.items[1].sku = 'FIXTURE_A'; return [value, native()]; },
    () => { const value = bag(); value.shippingCents = 0; return [value, native()]; },
    () => [bag(), { ...native(), shippingTaxLines: [tax(4)] }],
    () => [bag(), { ...native(), shippingTaxLines: [tax(2.5), tax(.5)] }],
    () => [bag(), { ...native(), shippingTaxLines: [tax(3, NaN)] }],
    () => [bag(), { ...native(), shippingTaxLines: [tax(3, .05, '')] }],
    () => [bag(), { ...native(), shippingTaxLines: [null] }],
  ];
  for (const make of cases) {
    const f = fixture(); const [value, options] = make();
    await assert.rejects(f.adapter.createOrder(value, options), { code: 'INVALID_INTEGRATION_INPUT' });
    assert.equal(f.calls.length, 0);
  }
});

test('legacy single-store taxLines payload stays backward compatible without native allocations', async () => {
  const f = fixture();
  const value = bag(); value.shippingCents = 0; value.taxCents = 20;
  await f.adapter.createOrder(value, { taxLines: [tax(20, .08)] });
  const order = f.writes()[0].variables.order;
  assert.deepEqual(order.taxLines, [{ title: 'Stripe TEST US TX tax', rate: .08, priceSet: money(20) }]);
  assert.ok(order.lineItems.every(item => !Object.hasOwn(item, 'taxLines')));
  assert.equal(Object.hasOwn(order, 'taxesIncluded'), false);
  assert.equal(Object.hasOwn(order, 'shippingLines'), false);
});

test('native tax readback queries original item/shipping taxes and complete bounded pages', async () => {
  const details = { id: 'gid://shopify/Order/1', taxesIncluded: false,
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'FIXTURE_A', taxLines: [{ title: 'State', rate: .0625, priceSet: money(13) }] }] },
    shippingLines: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/ShippingLine/1', originalPriceSet: money(25), taxLines: [{ title: 'State', rate: .0625, priceSet: money(2) }] }] } };
  const f = fixture({ details });
  assert.deepEqual(await f.adapter.getOrderDetails(details.id), details);
  const query = f.calls[0].query;
  assert.match(query, /taxesIncluded/);
  assert.match(query, /lineItems\(first:10\) \{ pageInfo \{ hasNextPage \} nodes/);
  assert.match(query, /shippingLines\(first:10\) \{ pageInfo \{ hasNextPage \} nodes \{ id title originalPriceSet/);
  assert.equal((query.match(/taxLines \{ title rate priceSet/g) ?? []).length, 2);
});
