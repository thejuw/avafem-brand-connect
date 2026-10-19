import { SHOPIFY_ALLOWED_SCOPES, missingShopifyScopes } from './integrations/shopify-policy.mjs';

const description = 'TEST ONLY. Synthetic integration fixture. DO NOT SHIP. Not for customer purchase.';
export const PROVIDER_TEST_FIXTURES = Object.freeze([
  Object.freeze({ shop: 'qpsd02-jz.myshopify.com', handle: 'avafem-connect-test-004-do-not-ship', sku: 'AVF-CONNECT-TEST-004',
    title: 'Avafem Integration Test Item 004 — DO NOT SHIP', vendor: 'Avafem Test', description,
    tags: Object.freeze(['TEST_DO_NOT_SHIP', 'avafem-integration-fixture', 'avafem-test-store-004']), priceCents: 200, initialQuantity: 10 }),
  Object.freeze({ shop: 'ir7112-v1.myshopify.com', handle: 'avafem-connect-test-006-do-not-ship', sku: 'AVF-CONNECT-TEST-006',
    title: 'Avafem Integration Test Item 006 — DO NOT SHIP', vendor: 'Avafem Test', description,
    tags: Object.freeze(['TEST_DO_NOT_SHIP', 'avafem-integration-fixture', 'avafem-test-store-006']), priceCents: 300, initialQuantity: 10 }),
]);
const fields = `id title description handle vendor tags status isGiftCard requiresSellingPlan
  variants(first:2) { pageInfo { hasNextPage } nodes { id title sku price inventoryQuantity inventoryPolicy selectedOptions { name value }
    inventoryItem { sku tracked requiresShipping } } }`;
/** Fixed server-only documents. The adapter accepts these operation keys, never caller GraphQL. */
export const PROVIDER_FIXTURE_QUERIES = Object.freeze({
  AvafemTestFixture: `query AvafemTestFixture($identifier:ProductIdentifierInput!) { productByIdentifier(identifier:$identifier) { ${fields} } }`,
  AvafemTestFixtureById: `query AvafemTestFixtureById($id:ID!) { product(id:$id) { ${fields} } }`,
  AvafemFixtureInventoryLevels: `query AvafemFixtureInventoryLevels($after:String) {
    productVariants(first:25,after:$after) { pageInfo { hasNextPage endCursor } nodes {
      inventoryItem { inventoryLevels(first:10) { nodes { location { id } } } }
    } }
  }`,
  // No identifier/id is supplied: use Shopify's documented CREATE form, not an
  // upsert that could overwrite an existing product appearing after our lookup.
  // https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
  AvafemCreateTestFixture: `mutation AvafemCreateTestFixture($input:ProductSetInput!) {
    productSet(input:$input,synchronous:true) { product { id } userErrors { code field } }
  }`,
});
const idPattern = resource => new RegExp(`^gid://shopify/${resource}/\\d+$`);
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const fixtureFor = shop => {
  const fixture = PROVIDER_TEST_FIXTURES.find(value => value.shop === shop);
  if (!fixture) fail('TEST_FIXTURE_STORE_REQUIRED', 'Fixture setup is restricted to the explicitly approved My Store 4 and My Store 6.', 422);
  return fixture;
};
const publicFixture = fixture => ({ handle: fixture.handle, title: fixture.title, sku: fixture.sku, priceCents: fixture.priceCents,
  initialQuantity: fixture.initialQuantity, tracked: true, requiresShipping: true, inventoryPolicy: 'DENY',
  publishedSalesChannels: null, publicationVerified: false, manualPublicationCheckRequired: true });
export function providerFixtureCreateInput(fixture, locationId) {
  return { handle: fixture.handle, title: fixture.title, vendor: fixture.vendor, descriptionHtml: `<p>${fixture.description}</p>`,
    tags: [...fixture.tags], status: 'ACTIVE', giftCard: false, requiresSellingPlan: false,
    productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
    variants: [{ price: (fixture.priceCents / 100).toFixed(2), inventoryPolicy: 'DENY', taxable: true,
      optionValues: [{ optionName: 'Title', name: 'Default Title' }], inventoryItem: { sku: fixture.sku, tracked: true, requiresShipping: true },
      inventoryQuantities: [{ locationId, name: 'available', quantity: fixture.initialQuantity }] }],
  };
}
function moneyCents(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) return NaN;
  const [whole, fraction = ''] = String(value).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function validate(product, fixture, { created = false } = {}) {
  const variants = product?.variants, variant = variants?.nodes?.[0];
  const owned = product?.handle === fixture.handle && product.vendor === fixture.vendor
    && fixture.tags.every(tag => product.tags?.includes(tag)) && variant?.sku === fixture.sku && variant.inventoryItem?.sku === fixture.sku;
  if (!owned) fail('FIXTURE_OWNERSHIP_MISMATCH', 'The fixed handle belongs to a different or modified product. Nothing was overwritten or restocked.');
  if (!idPattern('Product').test(product.id) || !idPattern('ProductVariant').test(variant.id)
    || product.title !== fixture.title || product.description !== fixture.description || product.status !== 'ACTIVE'
    || product.isGiftCard !== false || product.requiresSellingPlan !== false
    || !Array.isArray(variants.nodes) || variants.nodes.length !== 1 || variants.pageInfo?.hasNextPage !== false
    || variant.title !== 'Default Title' || variant.selectedOptions?.length !== 1
    || variant.selectedOptions[0].name !== 'Title' || variant.selectedOptions[0].value !== 'Default Title'
    || moneyCents(variant.price) !== fixture.priceCents
    || variant.inventoryPolicy !== 'DENY' || variant.inventoryItem?.tracked !== true || variant.inventoryItem.requiresShipping !== true
    || !Number.isSafeInteger(variant.inventoryQuantity) || variant.inventoryQuantity < 0 || variant.inventoryQuantity > fixture.initialQuantity
    || (created && variant.inventoryQuantity !== fixture.initialQuantity))
    fail('FIXTURE_READBACK_MISMATCH', 'The owned fixture does not match the fixed physical test configuration. Nothing was reset or overwritten.');
  return { ...publicFixture(fixture), productId: product.id, variantId: variant.id, inventoryQty: variant.inventoryQuantity, status: 'ACTIVE' };
}
const publication = (fixture, extra = {}) => ({ shop: fixture.shop, test: true, neverRestock: true,
  publicationVerified: false, manualPublicationCheckRequired: true,
  warning: 'The approved fifteen scopes cannot prove zero sales-channel publications. Manually verify zero channels in Shopify admin before checkout; no publication operation is performed.',
  ...extra });
const safeCodes = errors => [...new Set(errors.map(error => error?.code).map(code =>
  ['HANDLE_NOT_UNIQUE', 'INVALID_INPUT', 'INVALID_PRODUCT', 'INVALID_VARIANT', 'MISSING_FIELD_REQUIRED', 'GENERIC_ERROR', 'CAPABILITY_VIOLATION'].includes(code) ? code : 'UNKNOWN'))];

/**
 * No credentials, fetch, account settings, publication, orders or payments here.
 * inspect({shop}) is read-only. create({shop,confirmTest:true}) may create exactly
 * one fixed product, only through its bound registry adapter. A durable intent is
 * committed BEFORE productSet; all replays (including uncertainty) inspect only.
 */
export async function createProviderFixtures(db, { stores, clock = () => new Date() } = {}) {
  if (!db?.query || !db?.transaction || !stores?.forShop || !stores?.row) fail('FIXTURE_SETUP_REQUIRED', 'A database and bound test-store registry are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_fixture_intents (
    shop TEXT PRIMARY KEY,brand_id TEXT NOT NULL,handle TEXT NOT NULL,sku TEXT NOT NULL,
    state TEXT NOT NULL,mutation_started_at TIMESTAMPTZ NOT NULL,product_id TEXT,variant_id TEXT,last_error JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  async function adapterFor(fixture) {
    const row = await stores.row(fixture.shop);
    if (!row?.brand_id) fail('FIXTURE_BINDING_REQUIRED', 'An immutable brand/store binding is required.');
    const adapter = await stores.forShop(fixture.shop);
    if (adapter?.shop !== fixture.shop || typeof adapter.fixtureGraphql !== 'function') fail('FIXTURE_ADAPTER_REQUIRED', 'This bound test adapter does not provide the approved fixture operations.', 503);
    const result = await adapter.preflight();
    if (result?.verified !== true || result.connected !== true || result.shop?.myshopifyDomain !== fixture.shop || result.shop.currencyCode !== 'USD'
      || !Array.isArray(result.grantedScopes) || missingShopifyScopes(result.grantedScopes).length
      || result.grantedScopes.some(scope => !SHOPIFY_ALLOWED_SCOPES.includes(scope)))
      fail('FIXTURE_PREFLIGHT_BLOCKED', 'Exact-store identity, USD and the approved scope ceiling must verify before fixture access.');
    return { adapter, row };
  }
  const intentFor = async fixture => (await db.query('SELECT * FROM provider_fixture_intents WHERE shop=$1', [fixture.shop])).rows[0];
  async function find(adapter, fixture) {
    const data = await adapter.fixtureGraphql('AvafemTestFixture', { identifier: { handle: fixture.handle } });
    if (!data || !Object.hasOwn(data, 'productByIdentifier') || (data.productByIdentifier !== null && data.productByIdentifier?.handle !== fixture.handle))
      fail('FIXTURE_LOOKUP_INCOMPLETE', 'Direct lookup of the fixed fixture handle could not be verified.');
    return data.productByIdentifier;
  }
  async function location(adapter) {
    let after = null; const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const variants = (await adapter.fixtureGraphql('AvafemFixtureInventoryLevels', { after }))?.productVariants;
      if (!Array.isArray(variants?.nodes)) fail('FIXTURE_INVENTORY_READ_REQUIRED', 'Existing inventory levels could not be verified.');
      for (const variant of variants.nodes) for (const level of variant.inventoryItem?.inventoryLevels?.nodes ?? [])
        if (idPattern('Location').test(level.location?.id)) return level.location.id;
      if (variants.pageInfo?.hasNextPage === false) break;
      const cursor = variants.pageInfo?.endCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) fail('FIXTURE_INVENTORY_READ_REQUIRED', 'Inventory pagination could not be verified.');
      seen.add(cursor); after = cursor;
    }
    fail('FIXTURE_LOCATION_UI_REQUIRED', 'No existing inventory-level location was found. Configure a location/inventory through Shopify admin; no extra location scope or invented ID will be used.');
  }
  async function existingReport(adapter, fixture, intent, product) {
    const view = validate(product, fixture);
    if (intent && (intent.handle !== fixture.handle || intent.sku !== fixture.sku || (intent.product_id && intent.product_id !== view.productId)))
      fail('FIXTURE_INTENT_MISMATCH', 'Preserve the original fixture identity; no replacement will be created.');
    if (intent) await db.query(`UPDATE provider_fixture_intents SET state='verified',product_id=$2,variant_id=$3,last_error=NULL,updated_at=$4 WHERE shop=$1`,
      [fixture.shop, view.productId, view.variantId, new Date(clock())]);
    return publication(fixture, { status: 'PUBLICATION_VERIFICATION_REQUIRED', code: 'MANUAL_PUBLICATION_CHECK_REQUIRED',
      fixture: view, existing: true, created: false, mutationAttempted: false });
  }
  async function inspect({ shop } = {}) {
    const fixture = fixtureFor(shop), { adapter, row } = await adapterFor(fixture), intent = await intentFor(fixture);
    if (intent && intent.brand_id !== row.brand_id) fail('FIXTURE_BINDING_REQUIRED', 'Preserve the fixture intent’s original brand/store binding.');
    const product = await find(adapter, fixture);
    if (product) return existingReport(adapter, fixture, intent, product);
    if (intent) return publication(fixture, { status: 'OUTCOME_UNCERTAIN', code: 'FIXTURE_CREATION_REVIEW_REQUIRED',
      fixture: publicFixture(fixture), existing: false, created: false, mutationAttempted: false,
      message: 'An original fixture creation intent exists but the fixed handle is not confirmed. Inspect/reconcile manually; no replacement mutation will be sent.' });
    await location(adapter);
    return publication(fixture, { status: 'READY_TO_CREATE', fixture: publicFixture(fixture), created: false, existing: false, mutationAttempted: false });
  }
  async function create({ shop, confirmTest } = {}) {
    const fixture = fixtureFor(shop);
    if (confirmTest !== true) fail('TEST_CONFIRMATION_REQUIRED', 'Explicit confirmation is required to create this fixed test fixture.', 422);
    const { adapter, row } = await adapterFor(fixture);
    const intent = await intentFor(fixture), current = await find(adapter, fixture);
    if (intent && intent.brand_id !== row.brand_id) fail('FIXTURE_BINDING_REQUIRED', 'Preserve the original fixture brand/store binding.');
    if (current) return existingReport(adapter, fixture, intent, current);
    if (intent) return inspect({ shop });
    const locationId = await location(adapter);
    const appeared = await find(adapter, fixture);
    if (appeared) return existingReport(adapter, fixture, null, appeared);
    const claim = await db.query(`INSERT INTO provider_fixture_intents(shop,brand_id,handle,sku,state,mutation_started_at)
      VALUES($1,$2,$3,$4,'started',$5) ON CONFLICT DO NOTHING RETURNING shop`, [shop, row.brand_id, fixture.handle, fixture.sku, new Date(clock())]);
    if (!claim.rows.length) return inspect({ shop });
    let createdId;
    try {
      const data = await adapter.fixtureGraphql('AvafemCreateTestFixture', { input: providerFixtureCreateInput(fixture, locationId) });
      const response = data?.productSet;
      createdId = response?.product?.id;
      if (!idPattern('Product').test(createdId ?? '') || !Array.isArray(response.userErrors) || response.userErrors.length) {
        const codes = Array.isArray(response?.userErrors) ? safeCodes(response.userErrors) : ['UNKNOWN'];
        await db.query("UPDATE provider_fixture_intents SET state='uncertain',last_error=$2 WHERE shop=$1", [shop, JSON.stringify({ code: 'FIXTURE_CREATE_UNVERIFIED', providerCodes: codes })]);
        return publication(fixture, { status: 'OUTCOME_UNCERTAIN', code: 'FIXTURE_CREATE_UNVERIFIED', providerCodes: codes,
          fixture: publicFixture(fixture), created: false, existing: false, mutationAttempted: true });
      }
      await db.query("UPDATE provider_fixture_intents SET product_id=$2,state='created' WHERE shop=$1", [shop, createdId]);
      const product = (await adapter.fixtureGraphql('AvafemTestFixtureById', { id: createdId }))?.product;
      if (product?.id !== createdId) fail('FIXTURE_READBACK_MISMATCH', 'Created fixture ID readback did not match.');
      const view = validate(product, fixture, { created: true });
      const byHandle = await find(adapter, fixture);
      if (byHandle?.id !== createdId) fail('FIXTURE_READBACK_MISMATCH', 'Created fixture handle did not match its provider ID.');
      validate(byHandle, fixture);
      await db.query(`UPDATE provider_fixture_intents SET state='verified',variant_id=$2,last_error=NULL,updated_at=$3 WHERE shop=$1`, [shop, view.variantId, new Date(clock())]);
      return publication(fixture, { status: 'PUBLICATION_VERIFICATION_REQUIRED', code: 'MANUAL_PUBLICATION_CHECK_REQUIRED',
        fixture: view, created: true, existing: false, mutationAttempted: true });
    } catch {
      await db.query("UPDATE provider_fixture_intents SET state='uncertain',last_error=$2 WHERE shop=$1", [shop, JSON.stringify({ code: 'FIXTURE_OUTCOME_UNCERTAIN' })]);
      return publication(fixture, { status: 'OUTCOME_UNCERTAIN', code: 'FIXTURE_OUTCOME_UNCERTAIN',
        fixture: publicFixture(fixture), created: false, existing: false, mutationAttempted: true,
        message: 'Creation or readback is uncertain. Preserve the original intent and inspect the fixed handle; never blindly repeat creation.' });
    }
  }
  const run = input => input?.confirmTest === true ? create(input) : inspect(input);
  return { inspect, create, run };
}
