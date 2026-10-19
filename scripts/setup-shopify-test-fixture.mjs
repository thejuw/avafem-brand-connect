#!/usr/bin/env node
/**
 * Bounded, own-store fixture setup. Inspect is the default; --apply is explicit.
 * No credentials are written, no publication mutations or orders are made.
 * Channel publication must be verified separately in Shopify admin (no extra scopes).
 * productSet: https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
 */
import { pathToFileURL } from 'node:url';
import {
  createShopifyAdapter, loadShopifyClientSecret,
  DEFAULT_SHOPIFY_SHOP, DEFAULT_SHOPIFY_CLIENT_ID, SHOPIFY_SCOPES,
} from '../server/integrations/shopify.mjs';

export const TEST_FIXTURE = Object.freeze({
  shop: DEFAULT_SHOPIFY_SHOP,
  handle: 'avafem-connect-test-do-not-ship',
  sku: 'AVF-CONNECT-TEST-001',
  title: 'Avafem Integration Test Item — DO NOT SHIP',
  vendor: 'Avafem Test',
  description: 'TEST ONLY. Synthetic integration fixture. DO NOT SHIP. Not for customer purchase.',
  tags: Object.freeze(['TEST_DO_NOT_SHIP', 'avafem-integration-fixture']),
  priceCents: 100,
  initialQuantity: 10,
});
const API_VERSION = '2026-10';
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const LOCATION_ID = /^gid:\/\/shopify\/Location\/\d+$/;
const FIXTURE_FIELDS = `
    id title description handle vendor tags status isGiftCard requiresSellingPlan
    variants(first:2) { pageInfo { hasNextPage } nodes {
      id title sku price inventoryQuantity inventoryPolicy selectedOptions { name value }
      inventoryItem { sku tracked requiresShipping }
    } }
`;
// Direct identifier lookup avoids the product search index's eventual consistency.
// https://shopify.dev/docs/api/admin-graphql/latest/queries/productByIdentifier
const FIXTURE_QUERY = `query AvafemTestFixture($identifier:ProductIdentifierInput!) {
  productByIdentifier(identifier:$identifier) { ${FIXTURE_FIELDS} }
}`;
const FIXTURE_ID_QUERY = `query AvafemTestFixtureById($id:ID!) {
  product(id:$id) { ${FIXTURE_FIELDS} }
}`;
// Location IDs come only from existing inventory levels, never the locations query.
const INVENTORY_QUERY = `query AvafemFixtureInventoryLevels($after:String) {
  productVariants(first:25,after:$after) { pageInfo { hasNextPage endCursor } nodes {
    inventoryItem { inventoryLevels(first:10) { nodes { location { id } } } }
  } }
}`;
const CREATE_FIXTURE = `mutation AvafemCreateTestFixture($input:ProductSetInput!,$identifier:ProductSetIdentifiers!) {
  productSet(input:$input,identifier:$identifier,synchronous:true) {
    product { id } userErrors { code field }
  }
}`;
// Pin the documented 2026-10 enum; never print arbitrary upstream strings or messages.
const PRODUCT_SET_CODES = new Set([
  'BARCODE_CHECKSUM_VALIDATION_FAILED', 'BARCODE_VALUE_TOO_LONG', 'BLANK_BARCODE_VALUE',
  'CANNOT_COMBINE_LINKED_AND_NONLINKED_OPTION_VALUES', 'CAPABILITY_VIOLATION',
  'DUPLICATE_BARCODE_VALUE', 'DUPLICATE_LINKED_OPTION', 'DUPLICATED_METAFIELD_VALUE',
  'DUPLICATED_OPTION_NAME', 'DUPLICATED_OPTION_VALUE', 'DUPLICATED_VALUE', 'GENERIC_ERROR',
  'GIFT_CARD_ATTRIBUTE_CANNOT_BE_CHANGED', 'GIFT_CARDS_NOT_ACTIVATED', 'HANDLE_NOT_UNIQUE',
  'ID_NOT_ALLOWED', 'INCOMPATIBLE_BARCODE_FIELDS', 'INPUT_MISMATCH',
  'INVALID_BARCODE_CHARACTERS', 'INVALID_BARCODE_LENGTH', 'INVALID_BARCODE_PREFIX',
  'INVALID_BARCODE_SEPARATORS', 'INVALID_BARCODE_TYPE', 'INVALID_INPUT', 'INVALID_METAFIELD',
  'INVALID_METAFIELD_VALUE_FOR_LINKED_OPTION', 'INVALID_PRODUCT', 'INVALID_VARIANT',
  'INVENTORY_QUANTITIES_LIMIT_EXCEEDED', 'JOB_ERROR', 'LINKED_METAFIELD_DEFINITION_NOT_FOUND',
  'LINKED_OPTIONS_NOT_SUPPORTED_FOR_SHOP', 'METAFIELD_MISMATCH', 'MISSING_FIELD_REQUIRED',
  'NOT_FOUND', 'OPTION_DOES_NOT_EXIST', 'OPTION_VALUE_DOES_NOT_EXIST', 'OPTION_VALUES_MISSING',
  'OPTION_VALUES_OVER_LIMIT', 'OPTIONS_OVER_LIMIT', 'PRODUCT_DOES_NOT_EXIST',
  'PRODUCT_OPTIONS_INPUT_MISSING', 'PRODUCT_SUSPENDED', 'PRODUCT_VARIANT_DOES_NOT_EXIST',
  'TOO_MANY_BARCODES', 'VARIANTS_INPUT_MISSING', 'VARIANTS_OVER_LIMIT',
]);
const INPUT_PATH_FIELDS = new Set([
  'input', 'identifier', 'handle', 'title', 'vendor', 'descriptionHtml', 'tags', 'status',
  'giftCard', 'requiresSellingPlan', 'productOptions', 'position', 'values', 'name', 'variants',
  'price', 'inventoryPolicy', 'published', 'taxable', 'optionValues', 'optionName',
  'inventoryItem', 'sku', 'tracked', 'requiresShipping', 'inventoryQuantities', 'locationId', 'quantity',
]);
function safeUserErrors(errors) {
  return errors.slice(0, 25).map(error => ({
    code: PRODUCT_SET_CODES.has(error?.code) ? error.code : 'UNKNOWN',
    field: Array.isArray(error?.field) ? error.field.slice(0, 20).map(part => {
      const value = String(part);
      return INPUT_PATH_FIELDS.has(value) || /^\d{1,6}$/.test(value) ? value : '<redacted>';
    }) : [],
  }));
}

class FixtureError extends Error {
  constructor(code, message, uncertain = false) {
    super(message); this.code = code; this.uncertain = uncertain;
  }
}
const blocked = (code, message) => new FixtureError(code, message);
const uncertain = () => new FixtureError('OUTCOME_UNCERTAIN', 'Fixture creation is not confirmed. Do not retry the mutation blindly; run --inspect to reconcile the fixed handle first.', true);
const defaultSecretLoader = () => loadShopifyClientSecret({ env: {}, shop: DEFAULT_SHOPIFY_SHOP, clientId: DEFAULT_SHOPIFY_CLIENT_ID });

function validateFixture(product, { newlyCreated = false } = {}) {
  const variant = product?.variants?.nodes?.[0];
  const validQuantity = Number.isSafeInteger(variant?.inventoryQuantity)
    && variant.inventoryQuantity >= 0 && variant.inventoryQuantity <= TEST_FIXTURE.initialQuantity;
  const defaultOptions = variant?.selectedOptions?.length === 1
    && variant.selectedOptions[0].name === 'Title' && variant.selectedOptions[0].value === 'Default Title';
  const owned = product?.handle === TEST_FIXTURE.handle && product?.vendor === TEST_FIXTURE.vendor
    && TEST_FIXTURE.tags.every(tag => product?.tags?.includes(tag))
    && variant?.sku === TEST_FIXTURE.sku && variant?.inventoryItem?.sku === TEST_FIXTURE.sku;
  if (!owned) throw blocked('FIXTURE_OWNERSHIP_MISMATCH', 'The fixed handle is occupied by a product that is not the owned Avafem test fixture. Nothing was changed.');
  if (!PRODUCT_ID.test(product.id) || !VARIANT_ID.test(variant.id)
    || product.title !== TEST_FIXTURE.title || product.description !== TEST_FIXTURE.description
    || product.status !== 'ACTIVE' || product.isGiftCard !== false || product.requiresSellingPlan !== false
    || product.variants.nodes.length !== 1 || product.variants.pageInfo?.hasNextPage !== false
    || !defaultOptions || variant.title !== 'Default Title' || !/^1(?:\.0{1,2})?$/.test(String(variant.price))
    || variant.inventoryPolicy !== 'DENY' || variant.inventoryItem.tracked !== true
    || variant.inventoryItem.requiresShipping !== true || !validQuantity
    || (newlyCreated && variant.inventoryQuantity !== TEST_FIXTURE.initialQuantity)) {
    throw blocked('FIXTURE_READBACK_MISMATCH', 'The owned fixture does not match the bounded physical $1 test configuration. Nothing was reset or overwritten.');
  }
  return {
    productId: product.id, variantId: variant.id, handle: TEST_FIXTURE.handle,
    title: TEST_FIXTURE.title, sku: TEST_FIXTURE.sku, priceCents: TEST_FIXTURE.priceCents,
    inventoryQty: variant.inventoryQuantity, tracked: true, requiresShipping: true,
    status: 'ACTIVE', publishedSalesChannels: null,
  };
}

function publicationCheckRequired(report, fixture, { created = false, existing = false } = {}) {
  return {
    ...report, status: 'PUBLICATION_VERIFICATION_REQUIRED', code: 'MANUAL_PUBLICATION_CHECK_REQUIRED',
    created, existing, fixture,
    message: created
      ? 'Fixture creation and physical $1 inventory readback are confirmed. Sales-channel publication is unknown: verify zero channels manually in Shopify admin before using it. No publication mutation or stock reset was performed.'
      : 'The owned physical $1 fixture exists and was not changed or restocked. Sales-channel publication is unknown: verify zero channels manually in Shopify admin before using it.',
  };
}

/** Injectable I/O is for unit tests; target store/client/API version are never configurable. */
export async function runShopifyTestFixture({ apply = false, fetch: fetchImpl = globalThis.fetch, loadSecret = defaultSecretLoader, timeoutMs = 15_000 } = {}) {
  const report = {
    mode: apply ? 'apply' : 'inspect', shop: TEST_FIXTURE.shop,
    action: 'none', mutationAttempted: false, created: false, existing: false, neverRestock: true,
  };
  let token;
  let tokenExpiresAt = 0;
  const timedFetch = (url, options) => fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 30_000) return token;
    let secret;
    try { secret = await loadSecret(); } catch { throw blocked('CREDENTIALS_UNAVAILABLE', 'The known My Store 2 Keychain credential could not be loaded.'); }
    if (typeof secret !== 'string' || !secret) throw blocked('CREDENTIALS_UNAVAILABLE', 'The known My Store 2 Keychain credential is unavailable.');
    let response;
    let body;
    try {
      response = await timedFetch(`https://${TEST_FIXTURE.shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: DEFAULT_SHOPIFY_CLIENT_ID, client_secret: secret }),
      });
      secret = undefined;
      if (!response.ok) throw blocked('AUTH_REJECTED', 'My Store 2 rejected authentication. No fixture mutation was sent.');
      body = await response.json();
    } catch (error) {
      secret = undefined;
      if (error instanceof FixtureError) throw error;
      throw blocked('AUTH_UNAVAILABLE', 'My Store 2 authentication could not be verified. No fixture mutation was sent.');
    }
    if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 60) {
      throw blocked('AUTH_INVALID', 'My Store 2 returned an invalid expiring authentication response.');
    }
    token = body.access_token;
    tokenExpiresAt = Date.now() + Number(body.expires_in) * 1000;
    return token;
  }
  async function graphql(query, variables, write = false) {
    const accessToken = await getToken();
    let response;
    let body;
    if (write) { report.mutationAttempted = true; report.action = 'create'; }
    try {
      response = await timedFetch(`https://${TEST_FIXTURE.shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw write ? uncertain() : blocked('READ_REJECTED', 'Shopify rejected a required read. No additional mutation was attempted.');
      body = await response.json();
    } catch (error) {
      if (error instanceof FixtureError) throw error;
      throw write ? uncertain() : blocked('READ_UNAVAILABLE', 'A required Shopify read could not be verified. No additional mutation was attempted.');
    }
    if (body?.errors?.length || !body?.data) throw write ? uncertain() : blocked('READ_GRAPHQL_ERROR', 'A required Shopify read returned errors. No additional mutation was attempted.');
    return body.data;
  }
  async function findFixture() {
    const data = await graphql(FIXTURE_QUERY, { identifier: { handle: TEST_FIXTURE.handle } });
    if (!Object.hasOwn(data, 'productByIdentifier')) throw blocked('LOOKUP_INCOMPLETE', 'Direct lookup of the fixed handle was not confirmed. Nothing was changed.');
    const product = data.productByIdentifier;
    if (product !== null && (typeof product !== 'object' || product.handle !== TEST_FIXTURE.handle)) throw blocked('LOOKUP_MISMATCH', 'Direct lookup did not match the fixed fixture handle. Nothing was changed.');
    return product;
  }
  async function findInventoryLocation() {
    let after = null;
    const seenCursors = new Set();
    for (let page = 0; page < 20; page++) {
      const data = await graphql(INVENTORY_QUERY, { after });
      const variants = data?.productVariants;
      if (!Array.isArray(variants?.nodes)) throw blocked('INVENTORY_READ_INVALID', 'Existing product inventory levels could not be read.');
      for (const variant of variants.nodes) {
        for (const level of variant.inventoryItem?.inventoryLevels?.nodes ?? []) {
          if (LOCATION_ID.test(level.location?.id)) return level.location.id;
        }
      }
      if (variants.pageInfo?.hasNextPage === false) break;
      const cursor = variants.pageInfo?.endCursor;
      if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw blocked('INVENTORY_PAGINATION_INVALID', 'Inventory pagination could not be safely continued.');
      seenCursors.add(cursor); after = cursor;
    }
    throw blocked('NO_INVENTORY_LOCATION', 'No usable location ID was found on existing product inventory levels. No locations scope or invented location ID will be used.');
  }
  try {
    if (typeof apply !== 'boolean') throw blocked('INVALID_MODE', 'Apply must be an explicit boolean.');
    const adapter = createShopifyAdapter({
      env: {}, shop: DEFAULT_SHOPIFY_SHOP, clientId: DEFAULT_SHOPIFY_CLIENT_ID,
      apiVersion: API_VERSION, scopes: SHOPIFY_SCOPES, getAccessToken: getToken, fetch: fetchImpl, timeoutMs,
    });
    const preflight = await adapter.preflight();
    if (!preflight.verified || !preflight.connected || preflight.missingScopes?.length || preflight.unexpectedScopes?.length
      || preflight.shop?.myshopifyDomain !== TEST_FIXTURE.shop || preflight.shop?.currencyCode !== 'USD') {
      throw blocked('PREFLIGHT_BLOCKED', 'Exact-store, USD, approved-scope preflight did not pass. No fixture mutation was sent.');
    }
    const existing = await findFixture();
    if (existing) return publicationCheckRequired(report, validateFixture(existing), { existing: true });
    const locationId = await findInventoryLocation();
    if (!apply) return {
      ...report, status: 'READY_TO_CREATE',
      message: 'Read-only inspection passed. --apply would create one $1 physical test fixture with tracked stock 10, without any publication mutation. A separate manual zero-channel publication check in Shopify admin will be required after creation. No product mutation was sent.',
      fixture: { handle: TEST_FIXTURE.handle, title: TEST_FIXTURE.title, sku: TEST_FIXTURE.sku, priceCents: 100, initialQuantity: 10, requiresShipping: true, publishedSalesChannels: null },
    };
    // Recheck after location discovery: never intentionally upsert an existing product.
    const appeared = await findFixture();
    if (appeared) return publicationCheckRequired(report, validateFixture(appeared), { existing: true });
    const data = await graphql(CREATE_FIXTURE, {
      identifier: { handle: TEST_FIXTURE.handle },
      input: {
        handle: TEST_FIXTURE.handle, title: TEST_FIXTURE.title, vendor: TEST_FIXTURE.vendor,
        descriptionHtml: `<p>${TEST_FIXTURE.description}</p>`, tags: [...TEST_FIXTURE.tags], status: 'ACTIVE',
        giftCard: false, requiresSellingPlan: false,
        productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
        variants: [{
          // Variant `published` is not sales-channel publication; Shopify rejects
          // unpublishing the sole default variant. Never publish the product to a
          // channel here. Channel state requires a separate manual admin check:
          // querying publication counts would require an unapproved extra scope.
          price: '1.00', inventoryPolicy: 'DENY', taxable: true,
          optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          inventoryItem: { sku: TEST_FIXTURE.sku, tracked: true, requiresShipping: true },
          inventoryQuantities: [{ locationId, name: 'available', quantity: TEST_FIXTURE.initialQuantity }],
        }],
      },
    }, true);
    if (!Array.isArray(data.productSet?.userErrors)) throw uncertain();
    if (data.productSet.userErrors.length) {
      report.userErrors = safeUserErrors(data.productSet.userErrors);
      const definiteRejection = data.productSet.product === null
        && data.productSet.userErrors.every(error => PRODUCT_SET_CODES.has(error?.code) && !['GENERIC_ERROR', 'JOB_ERROR'].includes(error.code));
      if (definiteRejection) return {
        ...report, status: 'REJECTED', code: 'PRODUCT_SET_REJECTED',
        message: 'Shopify explicitly rejected fixture input and returned no product. Review the safe error codes and field paths, then run --inspect before considering another apply. No automatic retry was performed.',
      };
      throw uncertain();
    }
    const createdId = data.productSet?.product?.id;
    if (!PRODUCT_ID.test(createdId)) throw uncertain();
    let readback;
    try {
      // Use the returned product ID directly; never rely on search-index visibility.
      const readbackData = await graphql(FIXTURE_ID_QUERY, { id: createdId });
      readback = validateFixture(readbackData.product, { newlyCreated: true });
      if (readback.productId !== createdId) throw uncertain();
    } catch { throw uncertain(); }
    return publicationCheckRequired(report, readback, { created: true });
  } catch (error) {
    if (error instanceof FixtureError) return { ...report, status: error.uncertain ? 'OUTCOME_UNCERTAIN' : 'BLOCKED', code: error.code, message: error.message };
    // Never serialize upstream errors, request bodies, tokens, or Keychain exceptions.
    return { ...report, status: report.mutationAttempted ? 'OUTCOME_UNCERTAIN' : 'BLOCKED', code: report.mutationAttempted ? 'OUTCOME_UNCERTAIN' : 'PREFLIGHT_UNAVAILABLE', message: report.mutationAttempted ? uncertain().message : 'Required Shopify preflight could not be verified. No fixture mutation was sent.' };
  } finally { token = undefined; }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { exitCode: 0, output: 'Usage: node scripts/setup-shopify-test-fixture.mjs [--inspect | --apply]\nDefault: read-only --inspect on My Store 2. --apply creates only the fixed $1 test fixture, with no publication mutation. Channel state must be manually checked in Shopify admin. No orders or payments.' };
  }
  if (argv.length > 1 || (argv.length === 1 && !['--inspect', '--apply'].includes(argv[0]))) return { exitCode: 2, output: 'Invalid arguments. Use --inspect (default), --apply, or --help. Store/client overrides are not accepted.' };
  const report = await runShopifyTestFixture({ ...dependencies, apply: argv[0] === '--apply' });
  return { exitCode: ['BLOCKED', 'REJECTED', 'PUBLICATION_VERIFICATION_REQUIRED'].includes(report.status) ? 2 : report.status === 'OUTCOME_UNCERTAIN' ? 3 : 0, output: JSON.stringify(report, null, 2) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
