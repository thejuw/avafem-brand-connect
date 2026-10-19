import { invalid } from './errors.mjs';

/** User-approved ceiling, not a claim that every scope is needed by every workflow. */
export const SHOPIFY_ALLOWED_SCOPES = Object.freeze([
  'read_products', 'write_products',
  'read_inventory', 'write_inventory',
  'read_orders', 'write_orders',
  'read_draft_orders', 'write_draft_orders',
  'read_fulfillments', 'write_fulfillments',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_shipping', 'read_customers', 'write_customers',
]);

/** Exact approved subscriptions. Product deletion requires separate catalog reconciliation. */
export const SHOPIFY_ALLOWED_WEBHOOK_TOPICS = Object.freeze([
  'orders/updated', 'orders/cancelled', 'refunds/create', 'fulfillments/create',
  'products/update', 'inventory_levels/update', 'app/uninstalled',
]);

export const SHOPIFY_WEBHOOK_GRAPHQL_TOPICS = Object.freeze({
  'orders/updated': 'ORDERS_UPDATED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'refunds/create': 'REFUNDS_CREATE',
  'fulfillments/create': 'FULFILLMENTS_CREATE',
  'products/update': 'PRODUCTS_UPDATE',
  'inventory_levels/update': 'INVENTORY_LEVELS_UPDATE',
  'app/uninstalled': 'APP_UNINSTALLED',
});

const allowedScopes = new Set(SHOPIFY_ALLOWED_SCOPES);
const allowedTopics = new Set(SHOPIFY_ALLOWED_WEBHOOK_TOPICS);
const webhookScopes = Object.freeze({
  'orders/updated': 'read_orders',
  'orders/cancelled': 'read_orders',
  'refunds/create': 'read_orders',
  'fulfillments/create': 'read_fulfillments',
  'products/update': 'read_products',
  'inventory_levels/update': 'read_inventory',
});

function scopeHandles(input, { allowObjects = false } = {}) {
  const values = typeof input === 'string'
    ? input.trim().split(/[\s,]+/).filter(Boolean)
    : input instanceof Set ? [...input] : input;
  if (!Array.isArray(values)) throw invalid('Shopify scopes must be a list or comma-separated string.');
  const handles = values.map(value => allowObjects && value && typeof value === 'object' ? value.handle : value);
  if (handles.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))) {
    throw invalid('Shopify scopes contain an invalid handle.');
  }
  return [...new Set(handles)];
}

/**
 * Validate OAuth/configuration input against the explicit ceiling. Return canonical order,
 * preserve subsets, and never expand a request with implied reads or additional scopes.
 * An omitted argument requests exactly the user-approved list; null/malformed input fails.
 */
export function requestedShopifyScopes(input = SHOPIFY_ALLOWED_SCOPES) {
  const requested = scopeHandles(input);
  if (requested.some(scope => !allowedScopes.has(scope))) throw invalid('Shopify scope request exceeds the approved allowlist.');
  const requestedSet = new Set(requested);
  return SHOPIFY_ALLOWED_SCOPES.filter(scope => requestedSet.has(scope));
}

/**
 * Evidence-only normalization for granted accessScopes/token.scope, not OAuth requests.
 * Shopify write scopes imply their matching read. Unknown grants remain visible for audit,
 * but no unknown scope is inferred and no grant is ever acquired by calling this function.
 */
export function normalizeShopifyGrantedScopes(input = []) {
  const granted = new Set(scopeHandles(input, { allowObjects: true }));
  for (const scope of [...granted]) {
    if (!allowedScopes.has(scope) || !scope.startsWith('write_')) continue;
    const read = `read_${scope.slice(6)}`;
    if (allowedScopes.has(read)) granted.add(read);
  }
  return [...granted].sort();
}

export function missingShopifyScopes(granted, required = SHOPIFY_ALLOWED_SCOPES) {
  const normalized = new Set(normalizeShopifyGrantedScopes(granted));
  return requestedShopifyScopes(required).filter(scope => !normalized.has(scope));
}

export function requestedShopifyWebhookTopics(input = SHOPIFY_ALLOWED_WEBHOOK_TOPICS) {
  if (!Array.isArray(input) || input.some(topic => typeof topic !== 'string' || !allowedTopics.has(topic))) {
    throw invalid('Shopify webhook request exceeds the approved topic allowlist.');
  }
  const requested = new Set(input);
  return SHOPIFY_ALLOWED_WEBHOOK_TOPICS.filter(topic => requested.has(topic));
}

export function shopifyWebhookTopicEnum(topic) {
  if (!allowedTopics.has(topic)) throw invalid('Shopify webhook topic is not approved.');
  return SHOPIFY_WEBHOOK_GRAPHQL_TOPICS[topic];
}

/** Scope readiness only; does not certify offline auth, protected-data access, or staff rights. */
export function missingShopifyWebhookScopes(granted, topics = SHOPIFY_ALLOWED_WEBHOOK_TOPICS) {
  const required = [...new Set(requestedShopifyWebhookTopics(topics).map(topic => webhookScopes[topic]).filter(Boolean))];
  return missingShopifyScopes(granted, required);
}

/**
 * Scope-derived capabilities, never permission to dispatch a write. FulfillmentService
 * read/write is distinct from merchant-managed FulfillmentOrder read/write. Customer
 * profile CRUD is distinct from order shipping addresses; read_shipping covers carriers.
 */
export function shopifyScopeCapabilities(granted = []) {
  const normalized = normalizeShopifyGrantedScopes(granted);
  const has = scope => normalized.includes(scope);
  return {
    grantedScopes: normalized,
    unexpectedScopes: normalized.filter(scope => !allowedScopes.has(scope)),
    missingScopes: missingShopifyScopes(normalized),
    readProducts: has('read_products'), writeProducts: has('write_products'),
    readInventory: has('read_inventory'), writeInventory: has('write_inventory'),
    readOrders: has('read_orders'), createOrders: has('write_orders'),
    readDraftOrders: has('read_draft_orders'), writeDraftOrders: has('write_draft_orders'),
    readFulfillmentServices: has('read_fulfillments'), writeFulfillmentServices: has('write_fulfillments'),
    readMerchantManagedFulfillmentOrders: has('read_merchant_managed_fulfillment_orders'),
    writeMerchantManagedFulfillmentOrders: has('write_merchant_managed_fulfillment_orders'),
    readCarrierServices: has('read_shipping'),
    readCustomerProfiles: has('read_customers'), writeCustomerProfiles: has('write_customers'),
    missingWebhookScopes: missingShopifyWebhookScopes(normalized),
  };
}
