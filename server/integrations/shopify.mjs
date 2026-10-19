import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IntegrationError, IntegrationUnavailableError, UncertainOperationError, invalid } from './errors.mjs';
import { projectBrandBag, shopifyBagTag, safeTrackingUrl } from './projection.mjs';
import { constantTimeEqual, validatePublicHttpsUrl } from './webhooks.mjs';
import { SHOPIFY_ALLOWED_SCOPES, SHOPIFY_WEBHOOK_GRAPHQL_TOPICS, requestedShopifyScopes, missingShopifyScopes } from './shopify-policy.mjs';
import { PROVIDER_FIXTURE_QUERIES, PROVIDER_TEST_FIXTURES, providerFixtureCreateInput } from '../provider-fixtures.mjs';
import { FAILURE_FIXTURE_QUERIES, failureFixtureFor, failureFixtureCreateInput, failureFixtureSnapshot } from '../provider-failure-fixtures.mjs';

const execFileAsync = promisify(execFile);
export const DEFAULT_SHOPIFY_SHOP = 'i4vd1u-s8.myshopify.com';
export const DEFAULT_SHOPIFY_CLIENT_ID = 'e4d70eed35b16d38f81e3af32a35dd65';
export const SHOPIFY_SCOPES = [...SHOPIFY_ALLOWED_SCOPES];
export const SHOPIFY_TOPICS = Object.values(SHOPIFY_WEBHOOK_GRAPHQL_TOPICS);

export function normalizeShop(value) {
  const shop = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw invalid('A canonical *.myshopify.com shop hostname is required.');
  return shop;
}

/** Read a known app secret from macOS Keychain without printing or copying it to a file. */
export async function loadShopifyClientSecret(config = {}) {
  if (config.clientSecret) return config.clientSecret;
  if (config.env?.SHOPIFY_CLIENT_SECRET) return config.env.SHOPIFY_CLIENT_SECRET;
  if (!config.env && process.env.SHOPIFY_CLIENT_SECRET) return process.env.SHOPIFY_CLIENT_SECRET;
  const shop = normalizeShop(config.shop ?? DEFAULT_SHOPIFY_SHOP);
  const clientId = config.clientId ?? DEFAULT_SHOPIFY_CLIENT_ID;
  if (config.useKeychain === false || process.platform !== 'darwin' || shop !== DEFAULT_SHOPIFY_SHOP || clientId !== DEFAULT_SHOPIFY_CLIENT_ID) return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', 'co.avafem.shopify.i4vd1u-s8.client-secret', '-a', DEFAULT_SHOPIFY_CLIENT_ID, '-w'], { timeout: 5000, maxBuffer: 8192 });
    return stdout.trim() || null;
  } catch { return null; }
}

const decimal = amount => (amount / 100).toFixed(2);
function toCents(amount) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(amount))) throw invalid('Shopify returned a non-USD-style money amount.');
  const [whole, fraction = ''] = String(amount).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function shippingAddress(address) {
  for (const key of ['name', 'line1', 'city', 'region', 'postal', 'country']) if (!address[key]) throw invalid(`Shipping ${key} is required.`);
  const parts = address.name.split(/\s+/);
  return {
    firstName: parts.shift(), lastName: parts.join(' ') || 'Customer',
    address1: address.line1, ...(address.line2 ? { address2: address.line2 } : {}),
    city: address.city, provinceCode: address.region, zip: address.postal, countryCode: address.country,
  };
}

const PREFLIGHT = `query AvafemPreflight {
  shop { id name myshopifyDomain currencyCode }
  currentAppInstallation { id app { id title } accessScopes { handle } }
}`;
const ORDER_FIELDS = `id name test sourceIdentifier tags displayFinancialStatus totalPriceSet { shopMoney { amount currencyCode } }`;
const TAX_LINE_FIELDS = `title rate priceSet { shopMoney { amount currencyCode } }`;
const TRANSACTION_FIELDS = `id kind status test gateway manualPaymentGateway amountSet { shopMoney { amount currencyCode } } parentTransaction { id }`;
const REFUND_SHIPPING_FIELDS = `refundShippingLines(first:20) { pageInfo { hasNextPage } nodes { id shippingLine { id } subtotalAmountSet { shopMoney { amount currencyCode } } taxAmountSet { shopMoney { amount currencyCode } } } }`;
const FULFILLMENT_EVENT_FIELDS = `id status happenedAt message`;
const FULFILLMENT_FIELDS = `id status displayStatus createdAt deliveredAt trackingInfo { company number url } fulfillmentLineItems(first:20) { pageInfo { hasNextPage } nodes { quantity lineItem { id sku } } } events(first:20) { pageInfo { hasNextPage } nodes { ${FULFILLMENT_EVENT_FIELDS} } }`;

/** Async Shopify Jobs can use numeric IDs OR UUIDs; never discard a known UUID job.
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel
 */
export function isShopifyJobId(value) {
  return typeof value === 'string' && /^gid:\/\/shopify\/Job\/(?:[0-9]{1,40}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(value);
}

function gid(value, type) {
  if (type === 'Job' ? !isShopifyJobId(value) : !new RegExp(`^gid://shopify/${type}/[A-Za-z0-9-]+$`).test(value ?? '')) throw invalid(`A Shopify ${type} GID is required.`);
  return value;
}
function operationReference(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/.test(value)) throw invalid('A stable, non-sensitive operation ID is required.');
  return value;
}
function positiveQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw invalid('A quantity from 1 through 100 is required.');
  return value;
}
function syntheticTracking(input) {
  // These are synthetic tracking records only, never a carrier label purchase or delivery proof.
  const number = input?.number ?? input?.trackingNumber;
  if (typeof number !== 'string' || !/^AVAFEM-TEST-[A-Z0-9-]{1,80}$/i.test(number)) throw invalid('Synthetic tracking must use an AVAFEM-TEST- number.');
  const company = input.company ?? input.carrier ?? 'Avafem Test (not a carrier)';
  if (typeof company !== 'string' || company.length > 100 || /[\r\n]/.test(company)) throw invalid('A bounded synthetic tracking company is required.');
  const url = input.url ?? input.trackingUrl;
  if (url && !safeTrackingUrl(url)) throw invalid('Tracking URLs must be safe HTTPS URLs.');
  return { number, company, ...(url ? { url: safeTrackingUrl(url) } : {}) };
}
function refundUuid(shop, orderId, operationId) {
  const bytes = createHash('sha256').update(`avafem:refund:${shop}:${orderId}:${operationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Thin Shopify adapter. All network writes are explicit methods; construction/status are local.
 * config.fetch/getSecret/getAccessToken are injectable. Default own-store auth uses the known
 * macOS Keychain entry or environment; unrelated shops must use OAuth-derived tokens.
 * createOrder returns {order,mapping,alreadyExists}; persist mapping before dispatching more work.
 * OUTCOME_UNCERTAIN requires human/worker reconciliation, never automatic retry or tier fallback.
 */
export function createShopifyAdapter(config = {}) {
  const env = config.env ?? process.env;
  const shop = normalizeShop(config.shop ?? env.SHOPIFY_SHOP ?? DEFAULT_SHOPIFY_SHOP);
  const clientId = config.clientId ?? env.SHOPIFY_CLIENT_ID ?? DEFAULT_SHOPIFY_CLIENT_ID;
  const apiVersion = config.apiVersion ?? '2026-10';
  if (!/^20\d{2}-(01|04|07|10)$/.test(apiVersion)) throw invalid('Pin a stable Shopify API version.');
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const requiredScopes = requestedShopifyScopes(config.scopes);
  const tokenMode = config.authMode ?? (shop === DEFAULT_SHOPIFY_SHOP && clientId === DEFAULT_SHOPIFY_CLIENT_ID ? 'client_credentials' : 'authorization_code');
  let cachedToken;
  let tokenExpiresAt = 0;
  let tokenRequest;
  const inFlight = new Set();
  const uncertain = new Set();
  const lifecycleAttempts = new Map();
  const secret = () => config.getSecret ? config.getSecret() : loadShopifyClientSecret({ ...config, env, shop, clientId });
  const environmentTokenShop = normalizeShop(env.SHOPIFY_SHOP ?? DEFAULT_SHOPIFY_SHOP);
  const directToken = () => config.accessToken ?? (shop === environmentTokenShop ? env.SHOPIFY_ACCESS_TOKEN ?? env.SHOPIFY_AVA4_TOKEN : undefined);

  async function timedFetch(url, options) {
    return fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs ?? 15_000) });
  }

  async function getToken() {
    if (config.getAccessToken) return config.getAccessToken(shop);
    if (directToken()) return directToken();
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    if (tokenMode !== 'client_credentials') throw new IntegrationUnavailableError('Shopify', 'Install this brand with authorization-code OAuth and store its offline token.');
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const clientSecret = await secret();
      if (!clientSecret) throw new IntegrationUnavailableError('Shopify');
      let response;
      try {
        response = await timedFetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }) });
      } catch (cause) { throw new IntegrationError('Shopify authentication could not be reached.', { code: 'SHOPIFY_AUTH_UNREACHABLE', retryable: true, cause }); }
      if (!response.ok) throw new IntegrationError('Shopify rejected authentication. Check app installation, credentials and organization membership.', { code: 'SHOPIFY_AUTH_REJECTED', statusCode: 503 });
      const token = await response.json();
      if (!token.access_token || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) throw new IntegrationError('Shopify returned an invalid client-credentials response.', { code: 'SHOPIFY_AUTH_INVALID' });
      cachedToken = token.access_token;
      tokenExpiresAt = Date.now() + Number(token.expires_in) * 1000;
      return cachedToken;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }

  async function graphql(query, variables = {}, writeReference) {
    const write = typeof writeReference === 'string' ? { operation: 'orderCreate', reference: writeReference, payload: 'orderCreate', resource: 'order' } : writeReference;
    const mutationResult = data => write && data?.[write.payload]?.[write.resource]?.id;
    // Authentication happens first: an auth error cannot mean an order was created.
    const token = await getToken();
    let response;
    let json;
    try {
      response = await timedFetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) });
      if (write && response.status >= 500) throw new UncertainOperationError('Shopify', write.operation, write.reference);
      if (!response.ok) throw new IntegrationError('Shopify API request was rejected.', { code: response.status === 401 ? 'SHOPIFY_DISCONNECTED' : 'SHOPIFY_HTTP_ERROR', statusCode: response.status === 401 ? 401 : 502, retryable: !writeReference && (response.status === 429 || response.status >= 500), details: { upstreamStatus: response.status } });
      json = await response.json();
    } catch (cause) {
      if (cause instanceof IntegrationError) throw cause;
      if (write) throw new UncertainOperationError('Shopify', write.operation, write.reference, cause);
      throw new IntegrationError('Shopify could not be reached.', { code: 'SHOPIFY_UNREACHABLE', retryable: true, cause });
    }
    if (json.errors?.length) {
      // GraphQL schema errors use camelCase codes (e.g. undefinedField). Keep only
      // bounded schema identifiers, NEVER raw messages/paths/query/variables or
      // arbitrary extension values, which can contain shopper data or credentials.
      const schemaIdentifier = value => typeof value === 'string' && /^[_A-Za-z][_0-9A-Za-z]{0,79}$/.test(value)
        && !/(?:sk|rk|pk)_(?:test|live)_|shpat_|shpca_|shpss_|whsec_|bearer|secret/i.test(value);
      const safeCodes = json.errors.map(error => error?.extensions?.code).filter(code => schemaIdentifier(code) && /^[A-Z_]{1,80}$/.test(code)).slice(0, 10);
      const schemaErrors = json.errors.slice(0, 10).map(error => Object.fromEntries(
        ['code', 'typeName', 'fieldName', 'argumentName'].filter(key => schemaIdentifier(error?.extensions?.[key]))
          .map(key => [key, error.extensions[key]]),
      )).filter(error => Object.keys(error).length);
      if (write && !mutationResult(json.data) && !(safeCodes.length === json.errors.length && safeCodes.every(c => ['THROTTLED', 'ACCESS_DENIED', 'SHOP_INACTIVE'].includes(c)))) throw new UncertainOperationError('Shopify', write.operation, write.reference);
      if (!mutationResult(json.data)) throw new IntegrationError('Shopify returned GraphQL errors.', { code: 'SHOPIFY_GRAPHQL_ERROR', retryable: !write && safeCodes.includes('THROTTLED'), details: { codes: safeCodes, ...(schemaErrors.length ? { schemaErrors } : {}) } });
    }
    return json.data;
  }

  // Server-only fixture capability. No caller-provided document, credentials or
  // generalized browser GraphQL endpoint: these four fixed documents only.
  async function fixtureGraphql(operation, variables = {}) {
    if (config.test !== true || !PROVIDER_TEST_FIXTURES.some(fixture => fixture.shop === shop)
      || !Object.hasOwn(PROVIDER_FIXTURE_QUERIES, operation)) throw invalid('Fixture operations require an explicitly configured My Store 4 or 6 test adapter and an approved fixed operation.');
    const fixture = PROVIDER_TEST_FIXTURES.find(value => value.shop === shop);
    const exact = expected => JSON.stringify(variables) === JSON.stringify(expected);
    if (operation === 'AvafemTestFixture' && !exact({ identifier: { handle: fixture.handle } })) throw invalid('Only the fixed test fixture handle may be inspected.');
    if (operation === 'AvafemTestFixtureById' && (Object.keys(variables).length !== 1 || !/^gid:\/\/shopify\/Product\/\d+$/.test(variables.id ?? ''))) throw invalid('A single product ID is required for test-fixture readback.');
    if (operation === 'AvafemFixtureInventoryLevels' && (Object.keys(variables).length !== 1 || !Object.hasOwn(variables, 'after')
      || (variables.after !== null && (typeof variables.after !== 'string' || variables.after.length > 1000)))) throw invalid('A bounded inventory cursor is required.');
    if (operation === 'AvafemCreateTestFixture') {
      const locationId = variables.input?.variants?.[0]?.inventoryQuantities?.[0]?.locationId;
      if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId ?? '') || !exact({ input: providerFixtureCreateInput(fixture, locationId) }))
        throw invalid('Only the fixed test fixture create payload is permitted; existing products cannot be updated.');
    }
    const write = operation === 'AvafemCreateTestFixture'
      ? { operation: 'productSet', reference: `fixture:${shop}`, payload: 'productSet', resource: 'product' } : undefined;
    return graphql(PROVIDER_FIXTURE_QUERIES[operation], variables, write);
  }

  /** Dedicated failure-fixture capability, separate from cash fixture setup.
   * Only fixed server documents/values; never caller GraphQL, old cash products,
   * arbitrary inventory, publication changes, deletion, orders or payments.
   */
  async function failureFixtureGraphql(operation, variables = {}) {
    if (config.test !== true || !Object.hasOwn(FAILURE_FIXTURE_QUERIES, operation)) throw invalid('Only an explicit TEST adapter and a fixed failure-fixture operation are allowed.');
    const fixture = failureFixtureFor(shop), exact = expected => JSON.stringify(variables) === JSON.stringify(expected);
    if (operation === 'AvafemFailureFixture') {
      if (!exact({ identifier: { handle: fixture.handle } })) throw invalid('Only the dedicated fixed failure handle may be inspected.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables);
    }
    if (operation === 'AvafemFailureLocations') {
      if (Object.keys(variables).length !== 1 || !Object.hasOwn(variables, 'after') || (variables.after !== null
        && (typeof variables.after !== 'string' || !variables.after || variables.after.length > 1000))) throw invalid('A bounded location-discovery cursor is required.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables);
    }
    if (operation === 'AvafemFailureById') {
      if (Object.keys(variables).length !== 1 || !/^gid:\/\/shopify\/Product\/[0-9]{1,40}$/.test(variables.id ?? '')) throw invalid('Only an exact original product GID can be read.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables);
    }
    const checked = await preflight();
    if (!checked.verified || !checked.connected || checked.shop.currencyCode !== 'USD'
      || checked.grantedScopes.length !== SHOPIFY_ALLOWED_SCOPES.length || new Set(checked.grantedScopes).size !== SHOPIFY_ALLOWED_SCOPES.length
      || SHOPIFY_ALLOWED_SCOPES.some(scope => !checked.grantedScopes.includes(scope))) throw invalid('Fresh exact-store USD and fifteen-scope verification is required.');
    const lookup = await graphql(FAILURE_FIXTURE_QUERIES.AvafemFailureFixture, { identifier: { handle: fixture.handle } });
    if (!lookup || !Object.hasOwn(lookup, 'productByIdentifier')) throw invalid('The fixed failure-fixture lookup is incomplete.');
    if (operation === 'AvafemFailureCreate') {
      const locationId = variables.input?.variants?.[0]?.inventoryQuantities?.[0]?.locationId;
      if (lookup.productByIdentifier !== null || !/^gid:\/\/shopify\/Location\/[0-9]{1,40}$/.test(locationId ?? '')
        || !exact({ input: failureFixtureCreateInput(fixture, locationId) })) throw invalid('Only an absent dedicated failure fixture can be created with its fixed physical payload.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables, { operation: 'productSet', reference: `failure-fixture:${shop}`, payload: 'productSet', resource: 'product' });
    }
    const current = failureFixtureSnapshot(lookup.productByIdentifier, fixture);
    if (operation === 'AvafemFailureDelete') {
      if (current.priceCents !== fixture.priceCents || current.inventoryQty !== 10 || current.status !== 'ACTIVE'
        || !exact({ input: { id: current.productId } })) throw invalid('Only this exact disposable fixed product at its restored baseline can be deleted.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables, { operation: 'productDelete', reference: `failure-delete:${shop}`, payload: 'productDelete', resource: 'deletedProductId' });
    }
    if (operation === 'AvafemFailurePrice') {
      const price = variables.variants?.[0]?.price;
      if (![fixture.priceCents, fixture.priceCents + 1].map(value => (value / 100).toFixed(2)).includes(price)
        || !exact({ productId: current.productId, variants: [{ id: current.variantId, price }] })) throw invalid('Only the fixed dedicated variant baseline or one-cent test price is allowed.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables, { operation: 'productVariantsBulkUpdate', reference: `failure-price:${shop}`, payload: 'productVariantsBulkUpdate', resource: 'product' });
    }
    if (operation === 'AvafemFailureStatus') {
      const status = variables.product?.status;
      if (!['ACTIVE','ARCHIVED'].includes(status) || !exact({ product: { id: current.productId, status } })) throw invalid('Only the dedicated product ACTIVE/ARCHIVED test states are allowed.');
      return graphql(FAILURE_FIXTURE_QUERIES[operation], variables, { operation: 'productUpdate', reference: `failure-status:${shop}`, payload: 'productUpdate', resource: 'product' });
    }
    const quantity = variables.input?.quantities?.[0]?.quantity, key = variables.idempotencyKey;
    if (operation !== 'AvafemFailureStock' || ![0,10].includes(quantity) || typeof key !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)
      || !['catalog','checkout'].some(phase => ['mutate','restore'].some(step => exact({ idempotencyKey: key, input: { name: 'available', reason: 'correction',
        referenceDocumentUri: `gid://avafem/FailureFixture/${fixture.number}-${phase}-${step}`,
        quantities: [{ inventoryItemId: current.inventoryItemId, locationId: current.locationId, quantity, changeFromQuantity: current.inventoryQty }],
      } })))) throw invalid('Only the dedicated native inventory identity, exact current CAS and fixed zero/ten quantities are allowed.');
    return graphql(FAILURE_FIXTURE_QUERIES[operation], variables,
      { operation: 'inventorySetQuantities', reference: key, payload: 'inventorySetQuantities', resource: 'inventoryAdjustmentGroup' });
  }

  async function status() {
    const available = Boolean(config.getAccessToken || directToken() || (tokenMode === 'client_credentials' && await secret()));
    return { provider: 'shopify', available, configured: available, connected: false, verified: false, shop, apiVersion, authMode: tokenMode, message: available ? 'Credentials available; run preflight to verify connection.' : 'Shopify credentials unavailable.' };
  }

  async function preflight() {
    const data = await graphql(PREFLIGHT);
    if (data.shop?.myshopifyDomain !== shop) throw new IntegrationError('Shopify store identity did not match configuration.', { code: 'SHOPIFY_SHOP_MISMATCH' });
    const grantedScopes = data.currentAppInstallation.accessScopes.map(s => s.handle);
    const missingScopes = missingShopifyScopes(grantedScopes, requiredScopes);
    const unexpectedScopes = grantedScopes.filter(scope => !SHOPIFY_ALLOWED_SCOPES.includes(scope));
    return { provider: 'shopify', available: true, connected: true, verified: !missingScopes.length && !unexpectedScopes.length,
      shop: data.shop, app: data.currentAppInstallation.app, grantedScopes, missingScopes, unexpectedScopes,
      installationId: data.currentAppInstallation.id, locations: [], apiVersion, tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null };
  }

  async function listProducts({ first = 20, after = null } = {}) {
    first = Math.min(25, Math.max(1, Number(first) || 20));
    const data = await graphql(`query AvafemProducts($first:Int!,$after:String) {
      shop { currencyCode }
      products(first:$first,after:$after) { pageInfo { hasNextPage endCursor } nodes {
        id title descriptionHtml handle status images(first:5) { nodes { url altText } }
        variants(first:10) { pageInfo { hasNextPage endCursor } nodes {
          id title sku price inventoryQuantity inventoryPolicy selectedOptions { name value }
          inventoryItem { id tracked requiresShipping }
        } }
      } }
    }`, { first, after });
    const products = data.products.nodes.map(product => ({
      brandProductId: product.id, id: product.id, title: product.title, description: product.descriptionHtml,
      sku: product.variants.nodes[0]?.sku || `${product.handle}-${product.variants.nodes[0]?.id.split('/').at(-1) ?? 'default'}`, priceCents: toCents(product.variants.nodes[0]?.price ?? '0'),
      inventoryQty: product.variants.nodes.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0),
      currency: data.shop.currencyCode, images: product.images.nodes.map(i => i.url),
      status: 'in_review', sourceStatus: product.status,
      variants: product.variants.nodes.map(v => ({ id: v.id, shopifyVariantId: v.id, sku: v.sku || `${product.handle}-${v.id.split('/').at(-1)}`, title: v.title, price: { amount: toCents(v.price), currency: data.shop.currencyCode }, inventory: { qty: v.inventoryQuantity ?? 0, policy: v.inventoryPolicy.toLowerCase() }, options: Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value])), inventoryItemId: v.inventoryItem.id, tracked: v.inventoryItem.tracked, requiresShipping: v.inventoryItem.requiresShipping })),
      variantsPageInfo: product.variants.pageInfo,
      evidence: { ingredients_inci: [], certifications: [], claims: [], contraindications: '' },
      source: { provider: 'shopify', shop, productId: product.id },
    }));
    return { products, pageInfo: data.products.pageInfo, shop, warnings: products.filter(p => p.variantsPageInfo?.hasNextPage).map(p => ({ productId: p.id, code: 'VARIANT_PAGINATION_REQUIRED', message: 'Additional variants remain; import this product only after fetching all variant pages.' })) };
  }

  /** Complete children for one bounded product page; callers must also exhaust
   * the outer product connection before inferring deletion. read_products only.
   * Images remain the existing adapter's ImageConnection (deprecated but present
   * in the pinned schema), not publication/files/location APIs.
   * https://shopify.dev/docs/api/admin-graphql/latest/objects/Product
   * https://shopify.dev/docs/api/usage/pagination-graphql
   */
  async function listCompleteProducts({ first = 10, after = null } = {}) {
    first = Math.min(10, Math.max(1, Number(first) || 10));
    const fields = `id title sku price inventoryQuantity inventoryPolicy selectedOptions { name value }
      inventoryItem { id tracked requiresShipping }`;
    const data = await graphql(`query AvafemCompleteProducts($first:Int!,$after:String) {
      shop { currencyCode }
      products(first:$first,after:$after,sortKey:ID) { pageInfo { hasNextPage endCursor } nodes {
        id title descriptionHtml handle status updatedAt
        images(first:25) { pageInfo { hasNextPage endCursor } nodes { id url altText } }
        variants(first:25) { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
      } }
    }`, { first, after });
    const incomplete = () => new IntegrationError('A complete, stable product/variant/image snapshot is required.', { code: 'SHOPIFY_CATALOG_INCOMPLETE', statusCode: 409 });
    const connection = value => {
      if (!Array.isArray(value?.nodes) || typeof value.pageInfo?.hasNextPage !== 'boolean'
        || (value.pageInfo.hasNextPage && (!value.nodes.length || typeof value.pageInfo.endCursor !== 'string' || !value.pageInfo.endCursor))) throw incomplete();
      return value;
    };
    if (data?.shop?.currencyCode !== 'USD') throw new IntegrationError('Only USD catalog snapshots are supported.', { code: 'SHOPIFY_CATALOG_CURRENCY', statusCode: 409 });
    connection(data.products);
    const products = [];
    const ids = new Set();
    for (const product of data.products.nodes) {
      if (!/^gid:\/\/shopify\/Product\/\d+$/.test(product?.id ?? '') || ids.has(product.id)
        || !Number.isFinite(Date.parse(product.updatedAt))) throw incomplete();
      ids.add(product.id);
      let variants = connection(product.variants), images = connection(product.images);
      const allVariants = [...variants.nodes], allImages = [...images.nodes];
      const seenVariants = new Set(), seenImages = new Set();
      for (let page = 1; variants.pageInfo.hasNextPage || images.pageInfo.hasNextPage; page++) {
        if (page >= 100) throw incomplete();
        const withVariants = variants.pageInfo.hasNextPage, withImages = images.pageInfo.hasNextPage;
        if ((withVariants && seenVariants.has(variants.pageInfo.endCursor)) || (withImages && seenImages.has(images.pageInfo.endCursor))) throw incomplete();
        if (withVariants) seenVariants.add(variants.pageInfo.endCursor);
        if (withImages) seenImages.add(images.pageInfo.endCursor);
        const next = await graphql(`query AvafemCompleteProductChildren($id:ID!,$variantAfter:String,$imageAfter:String,$withVariants:Boolean!,$withImages:Boolean!) {
          shop { currencyCode }
          product(id:$id) { id updatedAt
            variants(first:25,after:$variantAfter) @include(if:$withVariants) { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
            images(first:25,after:$imageAfter) @include(if:$withImages) { pageInfo { hasNextPage endCursor } nodes { id url altText } }
          }
        }`, { id: product.id, variantAfter: withVariants ? variants.pageInfo.endCursor : null,
          imageAfter: withImages ? images.pageInfo.endCursor : null, withVariants, withImages });
        if (next?.shop?.currencyCode !== 'USD' || next.product?.id !== product.id || next.product.updatedAt !== product.updatedAt) throw incomplete();
        if (withVariants) { variants = connection(next.product.variants); allVariants.push(...variants.nodes); }
        if (withImages) { images = connection(next.product.images); allImages.push(...images.nodes); }
      }
      if (!allVariants.length || new Set(allVariants.map(variant => variant.id)).size !== allVariants.length
        || new Set(allImages.map(image => image.id ?? image.url)).size !== allImages.length) throw incomplete();
      const normalizedVariants = allVariants.map(variant => {
        if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id ?? '') || !variant.inventoryItem
          || !Array.isArray(variant.selectedOptions) || !['DENY','CONTINUE'].includes(variant.inventoryPolicy)
          || (variant.inventoryQuantity != null && !Number.isSafeInteger(variant.inventoryQuantity))) throw incomplete();
        return { id: variant.id, shopifyVariantId: variant.id, sku: variant.sku || `${product.handle}-${variant.id.split('/').at(-1)}`,
          title: variant.title, price: { amount: toCents(variant.price), currency: 'USD' },
          inventory: { qty: variant.inventoryItem.tracked ? Math.max(0, variant.inventoryQuantity ?? 0) : 0, policy: variant.inventoryPolicy.toLowerCase() },
          options: Object.fromEntries(variant.selectedOptions.map(option => [option.name, option.value])),
          inventoryItemId: variant.inventoryItem.id, tracked: variant.inventoryItem.tracked, requiresShipping: variant.inventoryItem.requiresShipping };
      });
      products.push({ id: product.id, brandProductId: product.id, title: product.title, description: product.descriptionHtml,
        sku: normalizedVariants[0].sku, priceCents: normalizedVariants[0].price.amount,
        inventoryQty: normalizedVariants.reduce((sum, variant) => sum + variant.inventory.qty, 0), currency: 'USD',
        images: allImages.map(image => image.url), sourceStatus: product.status, sourceUpdatedAt: product.updatedAt,
        variants: normalizedVariants, variantsPageInfo: { hasNextPage: false }, imagesPageInfo: { hasNextPage: false },
        source: { provider: 'shopify', shop, productId: product.id } });
    }
    return { products, pageInfo: data.products.pageInfo, shop, completeChildren: true,
      limits: { productsPerPage: 10, childPagesPerProduct: 100, childrenPerPage: 25 } };
  }

  /** Fresh single-variant snapshot for the explicitly bounded own-store test checkout. */
  async function getVariant(variantId) {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId ?? '')) throw invalid('A Shopify variant GID is required.');
    const data = await graphql(`query AvafemTestVariant($id:ID!) {
      shop { currencyCode }
      productVariant(id:$id) { id sku title price inventoryQuantity inventoryPolicy
        product { title status } inventoryItem { tracked requiresShipping }
      }
    }`, { id: variantId });
    const variant = data.productVariant;
    if (!variant) return null;
    return { id: variant.id, sku: variant.sku, title: variant.title, productTitle: variant.product.title,
      productStatus: variant.product.status, priceCents: toCents(variant.price), currency: data.shop.currencyCode,
      inventoryQty: variant.inventoryQuantity, inventoryPolicy: variant.inventoryPolicy, tracked: variant.inventoryItem.tracked, requiresShipping: variant.inventoryItem.requiresShipping };
  }

  /** Internal verification payload; callers must redact synthetic shipping/contact fields. */
  async function getOrderDetails(orderId) {
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId ?? '')) throw invalid('A Shopify order GID is required.');
    const data = await graphql(`query AvafemTestOrderReadback($id:ID!) { order(id:$id) {
      ${ORDER_FIELDS} email taxesIncluded
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      shippingAddress { firstName lastName address1 address2 city provinceCode countryCodeV2 zip }
      lineItems(first:10) { pageInfo { hasNextPage } nodes { sku quantity variant { id } originalUnitPriceSet { shopMoney { amount currencyCode } } taxLines { ${TAX_LINE_FIELDS} } } }
      shippingLines(first:10) { pageInfo { hasNextPage } nodes { id title originalPriceSet { shopMoney { amount currencyCode } } taxLines { ${TAX_LINE_FIELDS} } } }
      transactions(first:10) { id kind status test gateway amountSet { shopMoney { amount currencyCode } } }
    } }`, { id: orderId });
    return data.order;
  }

  async function findOrder(bagOrId, mappedOrderId) {
    const bagId = typeof bagOrId === 'string' ? bagOrId : bagOrId.bag_id ?? bagOrId.id;
    if (!bagId) throw invalid('Bag ID is required for reconciliation.');
    const mapped = mappedOrderId ?? (config.getOrderMapping ? await config.getOrderMapping(bagId, shop) : null);
    const orderId = typeof mapped === 'string' ? mapped : mapped?.orderId ?? mapped?.externalOrderId;
    if (orderId) {
      const data = await graphql(`query AvafemMappedOrder($id:ID!) { order(id:$id) { ${ORDER_FIELDS} } }`, { id: orderId });
      if (data.order && data.order.sourceIdentifier !== bagId) throw new IntegrationError('Shopify order mapping belongs to another Bag.', { code: 'SHOPIFY_MAPPING_MISMATCH', statusCode: 409 });
      if (data.order) uncertain.delete(bagId);
      return data.order;
    }
    const data = await graphql(`query AvafemFindOrder($query:String!) { orders(first:10,query:$query) { nodes { ${ORDER_FIELDS} } } }`, { query: `status:any tag:${shopifyBagTag(bagId)}` });
    const matches = data.orders.nodes.filter(order => order.sourceIdentifier === bagId && order.tags.includes(shopifyBagTag(bagId)));
    if (matches.length > 1) throw new IntegrationError('Multiple Shopify orders match this Bag. Human reconciliation is required.', { code: 'SHOPIFY_DUPLICATE_ORDERS', statusCode: 409 });
    if (matches.length === 1) uncertain.delete(bagId);
    return matches[0] ?? null;
  }

  async function createOrder(bag, options = {}) {
    const safe = projectBrandBag(bag, options);
    if (!safe.paid && options.paid !== true) throw invalid('Only a paid Bag can be pushed to Shopify.');
    if (inFlight.has(safe.bag_id) || uncertain.has(safe.bag_id)) throw new UncertainOperationError('Shopify', 'orderCreate', safe.bag_id);
    const test = options.test ?? config.test ?? true;
    if (!test && config.allowLiveWrites !== true) throw invalid('Live Shopify order writes require explicit configuration opt-in.');
    if (safe.currency !== 'USD') throw invalid('This initial connector supports USD Bags only.');
    const inventoryBehaviour = options.inventoryBehaviour ?? 'BYPASS';
    if (!['BYPASS', 'DECREMENT_OBEYING_POLICY', 'DECREMENT_IGNORING_POLICY'].includes(inventoryBehaviour)) throw invalid('Invalid inventory behavior.');
    const tag = shopifyBagTag(safe.bag_id);
    const relayDomain = config.relayDomain ?? 'relay.avafem.com';
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(relayDomain)) throw invalid('Relay email domain is invalid.');
    const relay = options.relayEmail ?? safe.relay_email ?? `bag-${createHash('sha256').update(safe.bag_id).digest('hex').slice(0, 24)}@${relayDomain}`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(relay)) throw invalid('A valid brand relay address is required.');
    const total = safe.items.reduce((sum, item) => sum + item.unit_price * item.qty, 0) + safe.shipping_paid + safe.tax;
    if (!Number.isSafeInteger(total) || total < 1) throw invalid('Bag total must be a positive integer in cents.');
    const money = amount => ({ shopMoney: { amount: decimal(amount), currencyCode: safe.currency } });
    // Native allocations preserve Stripe's ITEM versus SHIPPING tax for Shopify refunds.
    // Shopify splits order.taxLines across taxable merchandise; never put shipping tax there.
    // https://shopify.dev/docs/api/admin-graphql/latest/input-objects/OrderCreateOrderInput
    // Native mode requires BOTH lineTaxLines:{[sku]:[{title,rate,amountCents}]} and
    // shippingTaxLines:[] (also explicit empty arrays for zero tax). Amounts are full-line
    // amounts across quantity, NOT per-unit amounts. Rates are actual provider rates.
    // Legacy options.taxLines is retained solely for the older order-level-tax caller.
    let taxTotal = 0;
    function projectTaxLines(lines) {
      if (!Array.isArray(lines) || lines.length > 50) throw invalid('Explicit bounded authoritative tax lines are required.');
      return lines.map(line => {
        if (!line || !Number.isSafeInteger(line.amountCents) || line.amountCents < 0 || !Number.isFinite(line.rate) || line.rate < 0 || line.rate > 1 || typeof line.title !== 'string' || !line.title.trim()) throw invalid('A valid authoritative tax line is required.');
        taxTotal += line.amountCents;
        if (!Number.isSafeInteger(taxTotal)) throw invalid('Authoritative tax cents exceed the supported range.');
        return { title: line.title.trim().slice(0, 100), rate: line.rate, priceSet: money(line.amountCents) };
      });
    }
    const nativeTax = Object.hasOwn(options, 'lineTaxLines') || Object.hasOwn(options, 'shippingTaxLines');
    let taxLines = [];
    let lineTaxLines;
    let shippingTaxLines;
    if (nativeTax) {
      if (Object.hasOwn(options, 'taxLines') || !Object.hasOwn(options, 'lineTaxLines') || !Object.hasOwn(options, 'shippingTaxLines')) throw invalid('Do not mix order-level taxes with complete native item and shipping tax allocations.');
      const allocations = options.lineTaxLines;
      if (!allocations || typeof allocations !== 'object' || Array.isArray(allocations) || ![Object.prototype, null].includes(Object.getPrototypeOf(allocations))) throw invalid('Native item taxes must be a complete per-SKU allocation.');
      const skus = safe.items.map(item => item.sku);
      const keys = Object.keys(allocations);
      if (skus.some(sku => !sku) || new Set(skus).size !== skus.length || keys.length !== skus.length || keys.some(sku => !skus.includes(sku))) throw invalid('Native tax allocations must match every unique Bag SKU exactly.');
      lineTaxLines = safe.items.map(item => projectTaxLines(allocations[item.sku]));
      shippingTaxLines = projectTaxLines(options.shippingTaxLines);
      if (!safe.shipping_paid && shippingTaxLines.length) throw invalid('Shipping tax requires a positive original shipping charge.');
    } else taxLines = projectTaxLines(options.taxLines ?? []);
    if (safe.tax !== taxTotal) throw invalid('Provide authoritative Shopify tax lines matching the Bag tax total.');
    const order = {
      currency: safe.currency, email: relay, shippingAddress: shippingAddress(safe.ship_to),
      lineItems: safe.items.map((item, index) => ({ ...(item.variant_id ? { variantId: item.variant_id } : { title: item.title || item.sku, sku: item.sku }), quantity: item.qty, priceSet: money(item.unit_price), requiresShipping: true, taxable: nativeTax ? lineTaxLines[index].length > 0 : safe.tax > 0, ...(nativeTax ? { taxLines: lineTaxLines[index] } : {}) })),
      ...(safe.shipping_paid ? { shippingLines: [{ title: safe.shipping_method, priceSet: money(safe.shipping_paid), ...(nativeTax ? { taxLines: shippingTaxLines } : {}) }] } : {}),
      ...(nativeTax ? { taxesIncluded: false } : {}),
      ...(taxLines.length ? { taxLines } : {}),
      transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'manual', test, amountSet: money(total) }],
      tags: ['avafem', tag, ...(test ? ['TEST_DO_NOT_SHIP'] : [])], sourceIdentifier: safe.bag_id,
      note: `${test ? 'TEST_DO_NOT_SHIP — ' : ''}Avafem ${safe.order_ref || 'order'} / ${safe.bag_id}`.slice(0, 255), test,
      customAttributes: [{ key: 'avafem_bag_id', value: safe.bag_id }],
    };
    inFlight.add(safe.bag_id);
    try {
      const existing = await findOrder(safe.bag_id);
      if (existing) return { order: existing, mapping: { bagId: safe.bag_id, shop, orderId: existing.id }, alreadyExists: true };
      const data = await graphql(`mutation AvafemCreateOrder($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput) { orderCreate(order:$order,options:$options) { order { ${ORDER_FIELDS} } userErrors { field code message } } }`, { order, options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour } }, safe.bag_id);
      const result = data?.orderCreate;
      if (result?.userErrors?.length && !result.order?.id) throw new IntegrationError('Shopify rejected the order. Inspect the field errors before changing the Bag.', { code: 'SHOPIFY_ORDER_REJECTED', statusCode: 422, details: { errors: result.userErrors.map(e => ({ field: e.field, code: e.code, message: String(e.message).slice(0, 400) })) } });
      if (!result?.order?.id) throw new UncertainOperationError('Shopify', 'orderCreate', safe.bag_id);
      return { order: result.order, mapping: { bagId: safe.bag_id, shop, orderId: result.order.id }, alreadyExists: false };
    } catch (error) {
      if (error.requiresReconciliation) uncertain.add(safe.bag_id);
      throw error;
    } finally { inFlight.delete(safe.bag_id); }
  }

  async function getFulfillments(orderId) {
    const data = await graphql(`query AvafemFulfillments($id:ID!) { order(id:$id) { id fulfillments(first:50) { id status createdAt deliveredAt trackingInfo { company number url } fulfillmentLineItems(first:100) { nodes { quantity lineItem { sku } } } } fulfillmentOrders(first:50) { nodes { id status assignedLocation { name location { id } } } } } }`, { id: orderId });
    if (!data.order) return null;
    return { orderId, fulfillments: data.order.fulfillments.map(f => ({ id: f.id, status: f.status, createdAt: f.createdAt, deliveredAt: f.deliveredAt, tracking: f.trackingInfo.map(t => ({ carrier: t.company, trackingNumber: t.number, trackingUrl: safeTrackingUrl(t.url) })), items: f.fulfillmentLineItems.nodes.map(i => ({ sku: i.lineItem.sku, qty: i.quantity })) })), fulfillmentOrders: data.order.fulfillmentOrders.nodes };
  }

  /**
   * INTERNAL provider lifecycle contract (raw Shopify objects; redact before returning to a client).
   * getOrderOperations(orderId) returns an order plus operationsComplete. This deliberately bounded
   * test harness rejects incomplete pages instead of silently acting on a partial snapshot.
   * Every lifecycle write fetches order.test === true and requires a stable operationId.
   * The caller MUST durably reserve the operation + immutable request before calling, persist all
   * returned IDs, and reconcile an OUTCOME_UNCERTAIN from this read API, NEVER blindly recreate.
   * Only refundCreate has provider-native idempotency; the in-memory replay guard is NOT durable.
   * No method buys labels, sends customer notifications, refunds Stripe, or pays a brand.
   */
  async function getOrderOperations(orderId) {
    gid(orderId, 'Order');
    const data = await graphql(`query AvafemOrderOperations($id:ID!) { order(id:$id) {
      ${ORDER_FIELDS} cancelledAt currencyCode presentmentCurrencyCode displayFulfillmentStatus refundable
      totalRefundedSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      lineItems(first:50) { pageInfo { hasNextPage } nodes { id sku quantity currentQuantity refundableQuantity unfulfilledQuantity variant { id } originalUnitPriceSet { shopMoney { amount currencyCode } } } }
      transactions { ${TRANSACTION_FIELDS} }
      refunds { id note createdAt totalRefundedSet { shopMoney { amount currencyCode } }
        ${REFUND_SHIPPING_FIELDS}
        refundLineItems(first:20) { pageInfo { hasNextPage } nodes { quantity restockType lineItem { id } subtotalSet { shopMoney { amount currencyCode } } totalTaxSet { shopMoney { amount currencyCode } } } }
        transactions(first:20) { pageInfo { hasNextPage } nodes { ${TRANSACTION_FIELDS} } }
      }
      fulfillmentOrders(first:10) { pageInfo { hasNextPage } nodes { id status requestStatus supportedActions { action }
        assignedLocation { location { id } }
        lineItems(first:20) { pageInfo { hasNextPage } nodes { id totalQuantity remainingQuantity lineItem { id sku } } }
      } }
      fulfillments(first:10) { ${FULFILLMENT_FIELDS} }
      fulfillmentsCount { count precision }
    } }`, { id: orderId });
    const order = data?.order;
    if (!order) return null;
    if (order.id !== orderId) throw new IntegrationError('Shopify order identity did not match the request.', { code: 'SHOPIFY_ORDER_MISMATCH', statusCode: 409 });
    const complete = order.lineItems?.pageInfo?.hasNextPage === false && order.fulfillmentOrders?.pageInfo?.hasNextPage === false
      && order.fulfillmentOrders?.nodes?.every(fo => fo.lineItems?.pageInfo?.hasNextPage === false)
      && order.fulfillments?.every(f => f.fulfillmentLineItems?.pageInfo?.hasNextPage === false && f.events?.pageInfo?.hasNextPage === false)
      && order.refunds?.every(r => r.refundLineItems?.pageInfo?.hasNextPage === false && r.transactions?.pageInfo?.hasNextPage === false && r.refundShippingLines?.pageInfo?.hasNextPage === false)
      && order.fulfillmentsCount?.precision === 'EXACT' && order.fulfillmentsCount.count === order.fulfillments.length;
    return { ...order, operationsComplete: Boolean(complete) };
  }

  async function testOrder(orderId) {
    const order = await getOrderOperations(orderId);
    if (!order || order.test !== true) throw new IntegrationError('Lifecycle writes are restricted to verified Shopify test orders.', { code: 'SHOPIFY_TEST_ORDER_REQUIRED', statusCode: 409 });
    if (!order.operationsComplete) throw new IntegrationError('Complete Shopify lifecycle pagination is required before writing.', { code: 'SHOPIFY_PAGINATION_REQUIRED', statusCode: 409 });
    if (order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD') throw invalid('This bounded lifecycle harness supports USD test orders only.');
    return order;
  }

  /**
   * Read-only native tax/rounding preview BEFORE an external Stripe refund.
   * {orderId,lineItems:[{lineItemId,quantity}],shippingAmountCents:0}.
   * Returns the raw SuggestedRefund plus orderId/shop/operationsComplete; its refundLineItems
   * is an ARRAY (not a connection). The caller must compare all native amounts with the
   * immutable Stripe allocations; a mismatch must hold the refund before moving any money.
   * Already-created native refunds use their own authoritative evidence, not this preview.
   * https://shopify.dev/docs/api/admin-graphql/latest/objects/SuggestedRefund
   * https://shopify.dev/docs/api/admin-graphql/latest/objects/ShippingRefund
   */
  async function getSuggestedRefund({ orderId, lineItems, shippingAmountCents = 0 } = {}) {
    gid(orderId, 'Order');
    if (!Number.isSafeInteger(shippingAmountCents) || shippingAmountCents < 0 || shippingAmountCents > 10000) throw invalid('Explicit shipping preview cents must be from zero through $100.');
    if (!Array.isArray(lineItems) || lineItems.length > 20 || (!lineItems.length && !shippingAmountCents)) throw invalid('A bounded refund item subset or positive shipping-only amount is required.');
    const requested = lineItems.map(item => ({ lineItemId: gid(item?.lineItemId, 'LineItem'), quantity: positiveQuantity(item?.quantity), restockType: 'NO_RESTOCK' }));
    if (new Set(requested.map(item => item.lineItemId)).size !== requested.length) throw invalid('Duplicate refund preview items are not allowed.');
    const current = await testOrder(orderId);
    for (const item of requested) {
      const line = current.lineItems.nodes.find(value => value.id === item.lineItemId);
      if (!line || item.quantity > line.refundableQuantity) throw invalid('Refund preview quantity exceeds this order line refundable quantity.');
    }
    const fields = `shopMoney { amount currencyCode }`;
    const data = await graphql(`query AvafemSuggestedRefund($id:ID!,$lineItems:[RefundLineItemInput!]!,$shippingAmount:Money) {
      order(id:$id) { id test currencyCode presentmentCurrencyCode
        suggestedRefund(refundLineItems:$lineItems,shippingAmount:$shippingAmount) {
          amountSet { ${fields} } subtotalSet { ${fields} } discountedSubtotalSet { ${fields} }
          totalTaxSet { ${fields} } maximumRefundableSet { ${fields} }
          totalDutiesSet { ${fields} } totalCartDiscountAmountSet { ${fields} }
          refundLineItems { quantity restockType lineItem { id } subtotalSet { ${fields} } totalTaxSet { ${fields} } }
          shipping { amountSet { ${fields} } taxSet { ${fields} } maximumRefundableSet { ${fields} } }
        }
      }
    }`, { id: orderId, lineItems: requested, shippingAmount: decimal(shippingAmountCents) });
    const order = data?.order;
    const suggestion = order?.suggestedRefund;
    const invalidPreview = () => new IntegrationError('Shopify returned an incomplete or mismatched native refund preview. No external refund may proceed.', { code: 'SHOPIFY_REFUND_PREVIEW_INVALID', statusCode: 409 });
    if (order?.id !== orderId || order.test !== true || order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD'
      || !suggestion || !Array.isArray(suggestion.refundLineItems) || suggestion.refundLineItems.length !== requested.length) throw invalidPreview();
    const seen = new Set();
    const monetaryFields = ['amountSet', 'subtotalSet', 'discountedSubtotalSet', 'totalTaxSet', 'maximumRefundableSet', 'totalDutiesSet', 'totalCartDiscountAmountSet'].map(key => suggestion[key]);
    for (const line of suggestion.refundLineItems) {
      const match = requested.find(item => item.lineItemId === line.lineItem?.id);
      if (!match || seen.has(line.lineItem.id) || line.quantity !== match.quantity) throw invalidPreview();
      seen.add(line.lineItem.id);
      monetaryFields.push(line.subtotalSet, line.totalTaxSet);
    }
    monetaryFields.push(suggestion.shipping?.amountSet, suggestion.shipping?.taxSet, suggestion.shipping?.maximumRefundableSet);
    try {
      for (const value of monetaryFields) {
        if (value?.shopMoney?.currencyCode !== 'USD') throw invalidPreview();
        const amount = toCents(value.shopMoney.amount);
        if (!Number.isSafeInteger(amount) || amount < 0) throw invalidPreview();
      }
      if (toCents(suggestion.amountSet.shopMoney.amount) > 10000
        || toCents(suggestion.amountSet.shopMoney.amount) > toCents(suggestion.maximumRefundableSet.shopMoney.amount)
        || toCents(suggestion.shipping.amountSet.shopMoney.amount) !== shippingAmountCents) throw invalidPreview();
    } catch { throw invalidPreview(); }
    return { ...suggestion, orderId, shop, operationsComplete: true };
  }

  async function lifecycleWrite({ operation, operationId, orderId, query, variables, payload, resource, errors = 'userErrors', binding }) {
    operationReference(operationId);
    const key = `${operation}:${orderId}:${operationId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(variables)).digest('hex');
    const prior = lifecycleAttempts.get(key);
    if (prior && prior.fingerprint !== fingerprint) throw new IntegrationError('The Shopify operation ID cannot be reused with different parameters.', { code: 'SHOPIFY_OPERATION_MISMATCH', statusCode: 409 });
    if (prior?.result) return prior.result;
    if (prior) throw new UncertainOperationError('Shopify', operation, operationId);
    lifecycleAttempts.set(key, { fingerprint, binding });
    try {
      const data = await graphql(query, variables, { operation, reference: operationId, payload, resource });
      const result = data?.[payload];
      if (result?.[errors]?.length && !result?.[resource]?.id) {
        throw new IntegrationError('Shopify rejected the test lifecycle operation. Review provider state before changing the request.', { code: 'SHOPIFY_LIFECYCLE_REJECTED', statusCode: 422, details: { operation, errorCount: result[errors].length } });
      }
      if (!result?.[resource]?.id) throw new UncertainOperationError('Shopify', operation, operationId);
      if (resource === 'job' && !isShopifyJobId(result.job.id)) throw new UncertainOperationError('Shopify', operation, operationId);
      const output = { [resource]: result[resource], operationId, orderId, shop };
      lifecycleAttempts.set(key, { fingerprint, binding, result: output });
      return output;
    } catch (error) {
      if (!error.requiresReconciliation) lifecycleAttempts.delete(key);
      throw error;
    }
  }

  /** Explicit subset only: {orderId,fulfillmentOrderId,items:[{fulfillmentOrderLineItemId,qty}],tracking,operationId}. */
  async function createPartialFulfillment({ orderId, fulfillmentOrderId, items, tracking, operationId } = {}) {
    gid(orderId, 'Order'); gid(fulfillmentOrderId, 'FulfillmentOrder'); operationReference(operationId);
    const trackingInfo = syntheticTracking(tracking);
    if (!Array.isArray(items) || !items.length || items.length > 20) throw invalid('An explicit bounded fulfillment item subset is required.');
    const requested = items.map(item => ({ id: gid(item.fulfillmentOrderLineItemId, 'FulfillmentOrderLineItem'), quantity: positiveQuantity(item.qty) }));
    if (new Set(requested.map(item => item.id)).size !== requested.length) throw invalid('Duplicate fulfillment line items are not allowed.');
    // Location.isFulfillmentService requires the explicitly unapproved read_locations
    // scope. Instead, verify the exact approved installation ceiling: it grants only
    // merchant-managed FO visibility/write, never assigned/third-party FO permissions.
    // The provider still enforces the fulfillment order's native CREATE_FULFILLMENT.
    const installation = await preflight();
    if (installation.verified !== true || installation.unexpectedScopes.length
      || missingShopifyScopes(installation.grantedScopes, ['read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders']).length)
      throw new IntegrationError('Verified merchant-managed-only fulfillment scopes are required before creating a test fulfillment.', { code: 'SHOPIFY_FULFILLMENT_SCOPE_REQUIRED', statusCode: 409 });
    const order = await testOrder(orderId);
    if (order.cancelledAt) throw invalid('A cancelled test order cannot be fulfilled.');
    const fo = order.fulfillmentOrders.nodes.find(item => item.id === fulfillmentOrderId);
    if (!fo || !fo.assignedLocation?.location?.id || !fo.supportedActions?.some(item => item.action === 'CREATE_FULFILLMENT')) throw new IntegrationError('A fulfillable merchant-managed fulfillment order belonging to this test order is required.', { code: 'SHOPIFY_FULFILLMENT_UNAVAILABLE', statusCode: 409 });
    gid(fo.assignedLocation.location.id, 'Location');
    for (const item of requested) {
      const line = fo.lineItems.nodes.find(line => line.id === item.id);
      if (!line || item.quantity > line.remainingQuantity) throw invalid('Fulfillment quantity exceeds this fulfillment order line remainder.');
    }
    // https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
    return lifecycleWrite({ operation: 'fulfillmentCreate', operationId, orderId, payload: 'fulfillmentCreate', resource: 'fulfillment',
      query: `mutation AvafemTestFulfillment($fulfillment:FulfillmentInput!,$message:String) { fulfillmentCreate(fulfillment:$fulfillment,message:$message) { fulfillment { ${FULFILLMENT_FIELDS} } userErrors { field message } } }`,
      variables: { fulfillment: { notifyCustomer: false, trackingInfo, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId, fulfillmentOrderLineItems: requested }] }, message: `AVAFEM TEST ONLY / ${operationId}` } });
  }

  /** {orderId,fulfillmentId,tracking,operationId}; synthetic updates never assert carrier delivery. */
  async function updateTracking({ orderId, fulfillmentId, tracking, operationId } = {}) {
    gid(orderId, 'Order'); gid(fulfillmentId, 'Fulfillment'); operationReference(operationId);
    const trackingInfoInput = syntheticTracking(tracking);
    const order = await testOrder(orderId);
    if (!order.fulfillments.some(item => item.id === fulfillmentId && item.status !== 'CANCELLED')) throw invalid('An active fulfillment belonging to this test order is required.');
    return lifecycleWrite({ operation: 'fulfillmentTrackingInfoUpdate', operationId, orderId, payload: 'fulfillmentTrackingInfoUpdate', resource: 'fulfillment',
      query: `mutation AvafemTestTracking($fulfillmentId:ID!,$trackingInfoInput:FulfillmentTrackingInput!,$notifyCustomer:Boolean) { fulfillmentTrackingInfoUpdate(fulfillmentId:$fulfillmentId,trackingInfoInput:$trackingInfoInput,notifyCustomer:$notifyCustomer) { fulfillment { ${FULFILLMENT_FIELDS} } userErrors { field message } } }`,
      variables: { fulfillmentId, trackingInfoInput, notifyCustomer: false } });
  }

  /**
   * Explicit Shopify TEST delivery record, NOT a physical/carrier-confirmed delivery.
   * {orderId,fulfillmentId,operationId}; the caller must durably reserve the operation first.
   * No timestamp override is accepted: happenedAt is provider-facing wall time, not a test clock.
   * The immutable event message is the reconciliation marker after an unknown write outcome.
   */
  async function createTestDeliveryEvent({ orderId, fulfillmentId, operationId } = {}) {
    gid(orderId, 'Order'); gid(fulfillmentId, 'Fulfillment'); operationReference(operationId);
    const order = await testOrder(orderId);
    const fulfillment = order.fulfillments.find(item => item.id === fulfillmentId && item.status === 'SUCCESS');
    if (order.cancelledAt || !fulfillment || !fulfillment.trackingInfo?.length) throw invalid('An active successful fulfillment belonging to this test order with synthetic tracking is required.');
    for (const entry of fulfillment.trackingInfo) syntheticTracking(entry);
    const message = `AVAFEM SHOPIFY TEST DELIVERY / ${operationId} / NOT CARRIER VERIFIED`;
    const matches = fulfillment.events.nodes.filter(event => event.message === message);
    if (matches.length > 1 || (matches.length === 1 && matches[0].status !== 'DELIVERED')) throw new IntegrationError('Shopify test delivery markers conflict. Reconcile provider events before proceeding.', { code: 'SHOPIFY_DELIVERY_MARKER_CONFLICT', statusCode: 409 });
    const label = { evidenceLabel: 'shopify_test_delivery_event', carrierVerified: false };
    if (matches.length === 1) return { fulfillmentEvent: matches[0], operationId, orderId, shop, alreadyExists: true, ...label };
    const prior = lifecycleAttempts.get(`fulfillmentEventCreate:${orderId}:${operationId}`);
    if (prior && prior.binding !== fulfillmentId) throw new IntegrationError('The Shopify operation ID cannot be reused for another fulfillment.', { code: 'SHOPIFY_OPERATION_MISMATCH', statusCode: 409 });
    if (prior?.result) return { ...prior.result, ...label };
    if (prior) throw new UncertainOperationError('Shopify', 'fulfillmentEventCreate', operationId);
    if (fulfillment.displayStatus === 'DELIVERED' || fulfillment.events.nodes.some(event => event.status === 'DELIVERED')) throw new IntegrationError('A delivery was already recorded under another operation. Reconcile it instead of creating another event.', { code: 'SHOPIFY_DELIVERY_ALREADY_RECORDED', statusCode: 409 });
    // https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentEventCreate
    const result = await lifecycleWrite({ operation: 'fulfillmentEventCreate', operationId, orderId, payload: 'fulfillmentEventCreate', resource: 'fulfillmentEvent', binding: fulfillmentId,
      query: `mutation AvafemTestDeliveryEvent($fulfillmentEvent:FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent:$fulfillmentEvent) { fulfillmentEvent { ${FULFILLMENT_EVENT_FIELDS} } userErrors { field message } } }`,
      variables: { fulfillmentEvent: { fulfillmentId, status: 'DELIVERED', happenedAt: new Date().toISOString(), message } } });
    return { ...result, ...label };
  }

  /**
   * Manual external-payment bookkeeping ONLY; the orchestrator separately refunds Stripe/Tax.
   * {orderId,operationId,lineItems:[{lineItemId,qty,restockType:'NO_RESTOCK'}],amountCents,parentTransactionId,shippingCents:0}.
   * shippingCents is the explicit TAX-EXCLUSIVE shipping refund; amountCents includes all refunded
   * merchandise/shipping/tax. Returned refundShippingLines preserve native Shopify tax amounts;
   * the orchestrator must compare them with its authoritative Stripe allocation, never invent tax.
   * NO_RESTOCK prevents invented stock when the original order used BYPASS. Restocking is a
   * separate explicitly planned inventory test, not inferred from a financial refund.
   */
  async function createManualRefund({ orderId, operationId, lineItems, amountCents, parentTransactionId, shippingCents = 0 } = {}) {
    gid(orderId, 'Order'); gid(parentTransactionId, 'OrderTransaction'); operationReference(operationId);
    if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 10000) throw invalid('A positive test refund amount up to $100 is required.');
    if (!Number.isSafeInteger(shippingCents) || shippingCents < 0 || shippingCents > amountCents) throw invalid('Explicit shipping refund cents must be nonnegative and no greater than the total refund.');
    if (!Array.isArray(lineItems) || (!lineItems.length && !shippingCents) || lineItems.length > 20) throw invalid('Explicit test refund line items or a positive shipping-only refund are required.');
    const refundLineItems = lineItems.map(item => {
      if (item.restockType && item.restockType !== 'NO_RESTOCK') throw invalid('This bounded manual refund requires explicit NO_RESTOCK.');
      return { lineItemId: gid(item.lineItemId, 'LineItem'), quantity: positiveQuantity(item.qty), restockType: 'NO_RESTOCK' };
    });
    if (new Set(refundLineItems.map(item => item.lineItemId)).size !== refundLineItems.length) throw invalid('Duplicate refund line items are not allowed.');
    const order = await testOrder(orderId);
    if (shippingCents) {
      const original = order.totalShippingPriceSet?.shopMoney;
      if (original?.currencyCode !== 'USD') throw invalid('The original USD shipping amount is required for a shipping refund.');
      const alreadyRefunded = order.refunds.flatMap(refund => refund.refundShippingLines.nodes).reduce((sum, line) => {
        if (line.subtotalAmountSet?.shopMoney?.currencyCode !== 'USD') throw invalid('Refunded shipping must be denominated in USD.');
        return sum + toCents(line.subtotalAmountSet.shopMoney.amount);
      }, 0);
      if (shippingCents > toCents(original.amount) - alreadyRefunded) throw invalid('Shipping refund exceeds the remaining original shipping charge.');
    }
    const parent = order.transactions.find(tx => tx.id === parentTransactionId && ['SALE', 'CAPTURE'].includes(tx.kind) && tx.status === 'SUCCESS' && tx.test === true && tx.gateway === 'manual' && tx.manualPaymentGateway === true);
    if (!parent || parent.amountSet?.shopMoney?.currencyCode !== 'USD') throw invalid('A successful test manual payment from this order is required.');
    const refunded = order.transactions.filter(tx => tx.parentTransaction?.id === parentTransactionId && tx.kind === 'REFUND' && ['SUCCESS', 'PENDING', 'AWAITING_RESPONSE'].includes(tx.status)).reduce((sum, tx) => sum + toCents(tx.amountSet.shopMoney.amount), 0);
    if (amountCents > toCents(parent.amountSet.shopMoney.amount) - refunded) throw invalid('Refund exceeds the original manual payment remainder.');
    for (const item of refundLineItems) {
      const line = order.lineItems.nodes.find(line => line.id === item.lineItemId);
      if (!line || item.quantity > line.refundableQuantity) throw invalid('Refund quantity exceeds this order line refundable quantity.');
    }
    // Native idempotency is mandatory since 2026-04. Persist operationId + immutable payload.
    // https://shopify.dev/docs/api/admin-graphql/latest/mutations/refundCreate
    const result = await lifecycleWrite({ operation: 'refundCreate', operationId, orderId, payload: 'refundCreate', resource: 'refund',
      query: `mutation AvafemTestManualRefund($input:RefundInput!,$idempotencyKey:String!) { refundCreate(input:$input) @idempotent(key:$idempotencyKey) { refund { id note totalRefundedSet { shopMoney { amount currencyCode } } ${REFUND_SHIPPING_FIELDS} refundLineItems(first:20) { pageInfo { hasNextPage } nodes { quantity lineItem { id } subtotalSet { shopMoney { amount currencyCode } } totalTaxSet { shopMoney { amount currencyCode } } } } transactions(first:20) { pageInfo { hasNextPage } nodes { ${TRANSACTION_FIELDS} } } } userErrors { field message } } }`,
      variables: { idempotencyKey: refundUuid(shop, orderId, operationId), input: { orderId, currency: 'USD', notify: false, allowOverRefunding: false, note: `AVAFEM TEST MANUAL REFUND / ${operationId}`, refundLineItems, ...(shippingCents ? { shipping: { amount: decimal(shippingCents) } } : {}), transactions: [{ orderId, parentId: parentTransactionId, kind: 'REFUND', gateway: 'manual', amount: decimal(amountCents) }] } } });
    if (shippingCents) {
      const refund = result.refund;
      let verified = refund.refundShippingLines?.pageInfo?.hasNextPage === false && refund.transactions?.pageInfo?.hasNextPage === false;
      try {
        const returnedShipping = refund.refundShippingLines.nodes.reduce((sum, line) => {
          if (line.subtotalAmountSet?.shopMoney?.currencyCode !== 'USD' || line.taxAmountSet?.shopMoney?.currencyCode !== 'USD') throw invalid('Unexpected refund shipping currency.');
          toCents(line.taxAmountSet.shopMoney.amount); // Preserve actual provider tax; never derive a rate.
          return sum + toCents(line.subtotalAmountSet.shopMoney.amount);
        }, 0);
        const transactions = refund.transactions.nodes;
        verified &&= returnedShipping === shippingCents && refund.totalRefundedSet?.shopMoney?.currencyCode === 'USD'
          && toCents(refund.totalRefundedSet.shopMoney.amount) === amountCents && transactions.length === 1
          && transactions[0].kind === 'REFUND' && transactions[0].status === 'SUCCESS' && transactions[0].test === true
          && transactions[0].gateway === 'manual' && transactions[0].parentTransaction?.id === parentTransactionId
          && transactions[0].amountSet?.shopMoney?.currencyCode === 'USD' && toCents(transactions[0].amountSet.shopMoney.amount) === amountCents;
      } catch { verified = false; }
      if (!verified) throw new UncertainOperationError('Shopify', 'refundCreate', operationId);
    }
    return result;
  }

  /** Cancel without a Shopify gateway refund; persist returned job.id then poll getJob + order. */
  async function cancelOrder({ orderId, operationId, restock = false, reason = 'OTHER' } = {}) {
    gid(orderId, 'Order'); operationReference(operationId);
    if (restock !== false || reason !== 'OTHER') throw invalid('This bounded test cancellation uses OTHER and never implicitly restocks.');
    const order = await testOrder(orderId);
    if (order.cancelledAt) return { order, operationId, orderId, shop, alreadyCancelled: true };
    if (order.fulfillments.some(item => item.status !== 'CANCELLED')) throw invalid('This bounded cancellation requires an unfulfilled test order.');
    // Explicitly do not refund the manual record or an unrelated payment gateway.
    return lifecycleWrite({ operation: 'orderCancel', operationId, orderId, payload: 'orderCancel', resource: 'job', errors: 'orderCancelUserErrors',
      query: `mutation AvafemTestCancel($orderId:ID!,$notifyCustomer:Boolean,$refundMethod:OrderCancelRefundMethodInput!,$restock:Boolean!,$reason:OrderCancelReason!,$staffNote:String) { orderCancel(orderId:$orderId,notifyCustomer:$notifyCustomer,refundMethod:$refundMethod,restock:$restock,reason:$reason,staffNote:$staffNote) { job { id done } orderCancelUserErrors { field code message } } }`,
      variables: { orderId, notifyCustomer: false, refundMethod: { originalPaymentMethodsRefund: false }, restock: false, reason: 'OTHER', staffNote: `AVAFEM TEST ONLY / ${operationId}` } });
  }

  async function getJob(jobId) {
    gid(jobId, 'Job');
    const data = await graphql(`query AvafemTestJob($id:ID!) { job(id:$id) { id done } }`, { id: jobId });
    if (data?.job && data.job.id !== jobId) throw new IntegrationError('Shopify job identity did not match the request.', { code: 'SHOPIFY_JOB_MISMATCH', statusCode: 409 });
    return data?.job ?? null;
  }

  async function verifyWebhook(rawBody, header) {
    const key = config.webhookSecret ?? env.SHOPIFY_WEBHOOK_SECRET ?? await secret();
    if (!key || typeof header !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
    const expected = createHmac('sha256', key).update(rawBody).digest();
    return constantTimeEqual(expected, Buffer.from(header, 'base64'));
  }

  async function registerWebhooks(callbackUrl, { topics = SHOPIFY_TOPICS } = {}) {
    await validatePublicHttpsUrl(callbackUrl, { resolve: config.resolve });
    if (topics.some(t => !SHOPIFY_TOPICS.includes(t))) throw invalid('Unsupported Shopify webhook topic. Compliance webhooks belong in app configuration.');
    const results = [];
    for (const topic of topics) {
      const data = await graphql(`mutation AvafemSubscribe($topic:WebhookSubscriptionTopic!,$input:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$input) { webhookSubscription { id topic uri } userErrors { field message } } }`, { topic, input: { uri: callbackUrl } });
      if (data.webhookSubscriptionCreate.userErrors.length) throw new IntegrationError('Shopify rejected a webhook subscription.', { code: 'SHOPIFY_WEBHOOK_REJECTED', details: { topic } });
      results.push(data.webhookSubscriptionCreate.webhookSubscription);
    }
    return results;
  }

  return { provider: 'shopify', shop, apiVersion, status, preflight, fixtureGraphql, failureFixtureGraphql, listProducts, listCompleteProducts, getVariant, getOrderDetails, createOrder, findOrder, getFulfillments, getOrderOperations, getSuggestedRefund, createPartialFulfillment, updateTracking, createTestDeliveryEvent, createManualRefund, cancelOrder, getJob, verifyWebhook, registerWebhooks };
}

/**
 * OAuth authorization-code helpers for unrelated merchant stores. State is single-use and
 * bound to a shop for ten minutes. Supply a durable stateStore implementing set/get/delete
 * in deployment; the default in-memory store is suitable only for this local prototype.
 * Exchange returns sensitive token material to the server caller, never to the browser.
 */
export function createShopifyOAuthHelpers({ clientId, clientSecret, redirectUri, scopes = SHOPIFY_SCOPES, fetch: fetchImpl = globalThis.fetch, stateStore = new Map(), timeoutMs = 15_000 } = {}) {
  scopes = requestedShopifyScopes(scopes);
  if (!clientId || !clientSecret) throw new IntegrationUnavailableError('Shopify OAuth');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:') throw invalid('Shopify OAuth redirect URI must use HTTPS.');
  function authorizationUrl(shopInput) {
    const shop = normalizeShop(shopInput);
    const state = randomBytes(32).toString('hex');
    stateStore.set(state, { shop, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: clientId, scope: scopes.join(','), redirect_uri: redirect.href, state }).toString();
    return { url: url.href, state, expiresAt: Date.now() + 10 * 60_000 };
  }
  function verifyCallback(input) {
    const params = input instanceof URLSearchParams ? new URLSearchParams(input) : new URLSearchParams(input);
    const entries = [...params.entries()];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw invalid('Duplicate OAuth callback parameters are not allowed.');
    const state = params.get('state');
    const pending = state && stateStore.get(state);
    if (!pending || pending.expiresAt < Date.now()) throw invalid('OAuth state is missing, expired or already used.');
    const shop = normalizeShop(params.get('shop'));
    if (shop !== pending.shop) throw invalid('OAuth state does not match this shop.');
    const timestamp = Number(params.get('timestamp'));
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) throw invalid('OAuth callback timestamp is stale.');
    const hmac = params.get('hmac');
    if (!hmac || !/^[a-f0-9]{64}$/i.test(hmac)) throw invalid('OAuth HMAC is invalid.');
    params.delete('hmac');
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => `${key}=${value}`).join('&');
    const digest = createHmac('sha256', clientSecret).update(message).digest('hex');
    if (!constantTimeEqual(hmac.toLowerCase(), digest)) throw invalid('OAuth HMAC is invalid.');
    if (!params.get('code')) throw invalid('OAuth authorization code is missing.');
    stateStore.delete(state);
    return { shop, code: params.get('code') };
  }
  async function exchangeCallback(params) {
    const { shop, code } = verifyCallback(params);
    const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, expiring: '1' }) });
    if (!response.ok) throw new IntegrationError('Shopify OAuth token exchange failed. Restart authorization.', { code: 'SHOPIFY_OAUTH_REJECTED' });
    const token = await response.json();
    if (!token.access_token || !token.refresh_token) throw new IntegrationError('Shopify OAuth did not return an expiring offline token pair.', { code: 'SHOPIFY_OAUTH_INVALID' });
    const grantedScopes = String(token.scope ?? '').split(',');
    const missing = scopes.filter(s => !grantedScopes.includes(s) && !(s.startsWith('read_') && grantedScopes.includes(`write_${s.slice(5)}`)));
    if (missing.length) throw new IntegrationError('Shopify OAuth did not grant required scopes.', { code: 'SHOPIFY_SCOPES_MISSING', details: { missingScopes: missing } });
    return { shop, accessToken: token.access_token, refreshToken: token.refresh_token, grantedScopes, expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(), refreshTokenExpiresIn: token.refresh_token_expires_in };
  }
  return { authorizationUrl, verifyCallback, exchangeCallback };
}
