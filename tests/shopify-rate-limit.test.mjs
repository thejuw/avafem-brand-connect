import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyAdapter } from '../server/integrations/index.mjs';

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const bag = id => ({
  id, orderId: `ord_${id}`, orderRef: 'AVF-1001', brandId: 'brand_fixture', status: 'awaiting_shipment', sandbox: true, paid: true,
  items: [{ sku: 'BRAND-ONE', title: 'Fixture item', qty: 1, unitPriceCents: 100, shopifyVariantId: 'gid://shopify/ProductVariant/123' }],
  shipTo: { name: 'Synthetic Shopper', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' },
  shippingCents: 0, taxCents: 0, shippingMethod: 'standard',
});

test('dev-store order pacing refuses the 6th orderCreate in a minute before any write is sent', async () => {
  let now = 1_000_000; let creates = 0;
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', ordersPerMinute: 5, clock: () => now, fetch: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.query.includes('AvafemFindOrder')) return jsonResponse({ data: { orders: { nodes: [] } } });
    creates += 1;
    return jsonResponse({ data: { orderCreate: { order: { id: `gid://shopify/Order/${creates}`, sourceIdentifier: payload.variables.order.sourceIdentifier, tags: ['avafem'], test: true }, userErrors: [] } } });
  } });
  for (let i = 1; i <= 5; i += 1) await adapter.createOrder(bag(`bag_fixture_0${i}`));
  await assert.rejects(adapter.createOrder(bag('bag_fixture_06')), error => error.code === 'SHOPIFY_ORDER_RATE_LIMITED'
    && error.retryable === true && error.details.retryAfterMs === 60_000 && !error.requiresReconciliation);
  assert.equal(creates, 5);
  now += 60_000;
  await adapter.createOrder(bag('bag_fixture_06'));
  assert.equal(creates, 6);
});

test('pacing is off by default and Shopify 429 Retry-After is surfaced on reads', async () => {
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async () => jsonResponse({ errors: 'Throttled' }, 429, { 'retry-after': '2.0' }) });
  await assert.rejects(adapter.findOrder('bag_fixture_01'), error => error.retryable === true
    && error.details.upstreamStatus === 429 && error.details.retryAfterMs === 2000);
});
