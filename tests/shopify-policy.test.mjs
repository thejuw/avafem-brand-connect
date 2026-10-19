import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOPIFY_ALLOWED_SCOPES, SHOPIFY_ALLOWED_WEBHOOK_TOPICS, SHOPIFY_WEBHOOK_GRAPHQL_TOPICS,
  requestedShopifyScopes, normalizeShopifyGrantedScopes, missingShopifyScopes,
  requestedShopifyWebhookTopics, shopifyWebhookTopicEnum, missingShopifyWebhookScopes,
  shopifyScopeCapabilities,
} from '../server/integrations/shopify-policy.mjs';

test('approved Shopify scope ceiling is exactly the requested 15 and cannot be mutated', () => {
  assert.deepEqual(SHOPIFY_ALLOWED_SCOPES, [
    'read_products', 'write_products', 'read_inventory', 'write_inventory',
    'read_orders', 'write_orders', 'read_draft_orders', 'write_draft_orders',
    'read_fulfillments', 'write_fulfillments',
    'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
    'read_shipping', 'read_customers', 'write_customers',
  ]);
  assert.ok(Object.isFrozen(SHOPIFY_ALLOWED_SCOPES));
  assert.throws(() => SHOPIFY_ALLOWED_SCOPES.push('read_locations'), TypeError);
  const copied = requestedShopifyScopes();
  copied.pop();
  assert.equal(requestedShopifyScopes().length, 15);
});

test('OAuth requests are validated, canonicalized, deduplicated, and never expanded', () => {
  assert.deepEqual(requestedShopifyScopes('write_orders, read_products write_orders'), ['read_products', 'write_orders']);
  assert.deepEqual(requestedShopifyScopes(new Set(['write_customers'])), ['write_customers']);
  assert.deepEqual(requestedShopifyScopes([]), []);
  assert.deepEqual(requestedShopifyScopes(['write_orders']), ['write_orders']);
  assert.equal(requestedShopifyScopes(['write_orders']).includes('read_orders'), false);
});

test('requested scopes fail closed on extras, malformed types, and invalid handles', () => {
  for (const scope of ['read_locations', 'write_shipping', 'read_all_orders', 'write_third_party_fulfillment_orders', 'write_assigned_fulfillment_orders', 'read_payment_gateways']) {
    assert.throws(() => requestedShopifyScopes(['read_orders', scope]), { code: 'INVALID_INTEGRATION_INPUT' });
  }
  for (const input of [null, {}, 1, ['WRITE_ORDERS'], [' write_orders'], [{ handle: 'write_orders' }], ['write_orders', ''], ['read_orders&write_customers']]) {
    assert.throws(() => requestedShopifyScopes(input), { code: 'INVALID_INTEGRATION_INPUT' });
  }
});

test('granted writes imply matching reads only for approved resources', () => {
  assert.deepEqual(normalizeShopifyGrantedScopes('write_orders,write_products'), ['read_orders', 'read_products', 'write_orders', 'write_products']);
  assert.deepEqual(normalizeShopifyGrantedScopes([{ handle: 'write_inventory' }]), ['read_inventory', 'write_inventory']);
  assert.deepEqual(normalizeShopifyGrantedScopes(new Set(['write_merchant_managed_fulfillment_orders'])), [
    'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  ]);
  assert.deepEqual(normalizeShopifyGrantedScopes(['write_locations']), ['write_locations']);
});

test('missing scopes uses implication without treating read as write or orders as customer CRUD', () => {
  assert.deepEqual(missingShopifyScopes(['write_orders'], ['read_orders', 'write_orders']), []);
  assert.deepEqual(missingShopifyScopes(['read_orders'], ['write_orders']), ['write_orders']);
  assert.deepEqual(missingShopifyScopes(['write_orders'], ['read_customers', 'write_customers']), ['read_customers', 'write_customers']);
  const onlyWritesAndShipping = SHOPIFY_ALLOWED_SCOPES.filter(scope => scope.startsWith('write_') || scope === 'read_shipping');
  assert.deepEqual(missingShopifyScopes(onlyWritesAndShipping), []);
  assert.deepEqual(missingShopifyScopes(undefined), SHOPIFY_ALLOWED_SCOPES);
  assert.throws(() => missingShopifyScopes([], ['read_locations']), { code: 'INVALID_INTEGRATION_INPUT' });
});

test('capabilities keep FulfillmentService separate from merchant-managed fulfillment orders', () => {
  const services = shopifyScopeCapabilities(['write_fulfillments']);
  assert.equal(services.readFulfillmentServices, true);
  assert.equal(services.writeFulfillmentServices, true);
  assert.equal(services.readMerchantManagedFulfillmentOrders, false);
  assert.equal(services.writeMerchantManagedFulfillmentOrders, false);
  const merchant = shopifyScopeCapabilities(['write_merchant_managed_fulfillment_orders']);
  assert.equal(merchant.readMerchantManagedFulfillmentOrders, true);
  assert.equal(merchant.writeMerchantManagedFulfillmentOrders, true);
  assert.equal(merchant.writeFulfillmentServices, false);
});

test('unexpected grants remain visible without authorizing unrelated capabilities', () => {
  const result = shopifyScopeCapabilities(['read_locations', 'write_third_party_fulfillment_orders', 'read_orders']);
  assert.deepEqual(result.unexpectedScopes, ['read_locations', 'write_third_party_fulfillment_orders']);
  assert.equal(result.readOrders, true);
  assert.equal(result.createOrders, false);
  assert.equal(result.readCustomerProfiles, false);
  assert.equal(result.writeMerchantManagedFulfillmentOrders, false);
  assert.equal(result.readCarrierServices, false);
});

test('approved webhook list is exactly seven REST topics with exact GraphQL mapping', () => {
  assert.deepEqual(SHOPIFY_ALLOWED_WEBHOOK_TOPICS, [
    'orders/updated', 'orders/cancelled', 'refunds/create', 'fulfillments/create',
    'products/update', 'inventory_levels/update', 'app/uninstalled',
  ]);
  assert.deepEqual(SHOPIFY_ALLOWED_WEBHOOK_TOPICS.map(shopifyWebhookTopicEnum), [
    'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE', 'FULFILLMENTS_CREATE',
    'PRODUCTS_UPDATE', 'INVENTORY_LEVELS_UPDATE', 'APP_UNINSTALLED',
  ]);
  assert.ok(Object.isFrozen(SHOPIFY_ALLOWED_WEBHOOK_TOPICS));
  assert.ok(Object.isFrozen(SHOPIFY_WEBHOOK_GRAPHQL_TOPICS));
});

test('webhook selection cannot silently subscribe to create/delete/tracking extras', () => {
  assert.deepEqual(requestedShopifyWebhookTopics(['app/uninstalled', 'orders/updated', 'orders/updated']), ['orders/updated', 'app/uninstalled']);
  for (const topic of ['products/delete', 'products/create', 'fulfillments/update', 'orders/create', 'PRODUCTS_UPDATE', '__proto__']) {
    assert.throws(() => shopifyWebhookTopicEnum(topic), { code: 'INVALID_INTEGRATION_INPUT' });
    assert.throws(() => requestedShopifyWebhookTopics([topic]), { code: 'INVALID_INTEGRATION_INPUT' });
  }
  for (const input of [null, {}, 'products/update']) assert.throws(() => requestedShopifyWebhookTopics(input), { code: 'INVALID_INTEGRATION_INPUT' });
  assert.deepEqual(requestedShopifyWebhookTopics(), SHOPIFY_ALLOWED_WEBHOOK_TOPICS);
});

test('webhook resource scope readiness handles implied reads and uninstall needs none', () => {
  assert.deepEqual(missingShopifyWebhookScopes([]), ['read_products', 'read_inventory', 'read_orders', 'read_fulfillments']);
  assert.deepEqual(missingShopifyWebhookScopes(['write_orders', 'write_products', 'write_inventory', 'write_fulfillments']), []);
  assert.deepEqual(missingShopifyWebhookScopes([], ['app/uninstalled']), []);
  assert.deepEqual(missingShopifyWebhookScopes(['write_orders'], ['refunds/create', 'orders/updated']), []);
  assert.deepEqual(missingShopifyWebhookScopes(['read_orders'], ['fulfillments/create']), ['read_fulfillments']);
});
