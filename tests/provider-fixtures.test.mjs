import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createProviderFixtures, PROVIDER_TEST_FIXTURES, PROVIDER_FIXTURE_QUERIES, providerFixtureCreateInput } from '../server/provider-fixtures.mjs';
import { createShopifyAdapter } from '../server/integrations/shopify.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const A = PROVIDER_TEST_FIXTURES[0], B = PROVIDER_TEST_FIXTURES[1], LOCATION = 'gid://shopify/Location/123456';
function product(fixture, qty = 10) {
  return { id: `gid://shopify/Product/${fixture === A ? 4004 : 6006}`, handle: fixture.handle, title: fixture.title,
    description: fixture.description, vendor: fixture.vendor, tags: [...fixture.tags], status: 'ACTIVE', isGiftCard: false, requiresSellingPlan: false,
    variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/ProductVariant/${fixture === A ? 4004 : 6006}`,
      title: 'Default Title', sku: fixture.sku, price: (fixture.priceCents / 100).toFixed(2), inventoryQuantity: qty, inventoryPolicy: 'DENY',
      selectedOptions: [{ name: 'Title', value: 'Default Title' }], inventoryItem: { sku: fixture.sku, tracked: true, requiresShipping: true } }] } };
}
async function setup(t) {
  const db = await createDatabase({ connectionString: null }); t.after(() => db.close());
  const calls = [], products = new Map(), adapters = new Map();
  let inventory = { nodes: [{ inventoryItem: { inventoryLevels: { nodes: [{ location: { id: LOCATION } }] } } }], pageInfo: { hasNextPage: false } };
  for (const fixture of PROVIDER_TEST_FIXTURES) {
    const adapter = { shop: fixture.shop,
      preflight: async () => ({ connected: true, verified: true, grantedScopes: [...SHOPIFY_ALLOWED_SCOPES],
        shop: { myshopifyDomain: fixture.shop, currencyCode: 'USD' } }),
      fixtureGraphql: async (operation, variables) => {
        calls.push({ shop: fixture.shop, operation, variables: structuredClone(variables) });
        assert.ok(Object.hasOwn(PROVIDER_FIXTURE_QUERIES, operation));
        if (operation === 'AvafemTestFixture') return { productByIdentifier: structuredClone(products.get(fixture.shop) ?? null) };
        if (operation === 'AvafemTestFixtureById') return { product: structuredClone(products.get(fixture.shop) ?? null) };
        if (operation === 'AvafemFixtureInventoryLevels') return { productVariants: structuredClone(inventory) };
        const intent = (await db.query('SELECT * FROM provider_fixture_intents WHERE shop=$1', [fixture.shop])).rows[0];
        assert.equal(intent.state, 'started', 'Durable mutation intent must exist before provider write.');
        assert.ok(intent.mutation_started_at);
        products.set(fixture.shop, product(fixture));
        return { productSet: { product: { id: products.get(fixture.shop).id }, userErrors: [] } };
      },
    };
    adapters.set(fixture.shop, adapter);
  }
  const stores = { row: async shop => ({ shop, brand_id: shop === A.shop ? 'brand_fixture4' : 'brand_fixture6' }),
    forShop: async shop => adapters.get(shop) };
  const service = await createProviderFixtures(db, { stores });
  return { db, calls, products, adapters, stores, service, setInventory: value => { inventory = value; } };
}
const writes = fx => fx.calls.filter(call => call.operation === 'AvafemCreateTestFixture');

test('inspection is the default, fixed Store4/6 plans are distinct, and publication is never claimed verified', async t => {
  const fx = await setup(t);
  const a = await fx.service.run({ shop: A.shop }), b = await fx.service.inspect({ shop: B.shop });
  assert.equal(a.status, 'READY_TO_CREATE'); assert.equal(b.status, 'READY_TO_CREATE');
  assert.equal(a.fixture.priceCents, 200); assert.equal(b.fixture.priceCents, 300);
  assert.equal(a.fixture.sku, 'AVF-CONNECT-TEST-004'); assert.equal(b.fixture.sku, 'AVF-CONNECT-TEST-006');
  assert.notEqual(a.fixture.handle, b.fixture.handle); assert.equal(writes(fx).length, 0);
  for (const view of [a, b]) { assert.equal(view.publicationVerified, false); assert.equal(view.manualPublicationCheckRequired, true); }
  assert.ok(fx.calls.every(call => !/\blocations\s*\(/.test(PROVIDER_FIXTURE_QUERIES[call.operation])));
  assert.equal((await fx.db.query('SELECT shop FROM provider_fixture_intents')).rows.length, 0);
});

test('creation requires explicit boolean test confirmation and refuses Store2 or unknown targets before adapter access', async t => {
  const fx = await setup(t);
  for (const confirmTest of [undefined, false, 'true']) await assert.rejects(fx.service.create({ shop: A.shop, confirmTest }), { code: 'TEST_CONFIRMATION_REQUIRED' });
  for (const shop of ['i4vd1u-s8.myshopify.com', 'other.myshopify.com', undefined])
    await assert.rejects(fx.service.create({ shop, confirmTest: true }), { code: 'TEST_FIXTURE_STORE_REQUIRED' });
  assert.equal(fx.calls.length, 0);
});

test('explicit create uses fixed physical tracked DENY stock10 with a discovered inventory location and never upserts or publishes', async t => {
  const fx = await setup(t);
  for (const fixture of [A, B]) {
    const result = await fx.service.create({ shop: fixture.shop, confirmTest: true });
    assert.equal(result.created, true); assert.equal(result.mutationAttempted, true);
    assert.equal(result.fixture.inventoryQty, 10); assert.equal(result.manualPublicationCheckRequired, true);
    const sent = writes(fx).find(call => call.shop === fixture.shop);
    assert.deepEqual(sent.variables, { input: providerFixtureCreateInput(fixture, LOCATION) });
    assert.equal(sent.variables.identifier, undefined); assert.equal(sent.variables.input.id, undefined);
    assert.doesNotMatch(PROVIDER_FIXTURE_QUERIES.AvafemCreateTestFixture, /identifier:|publishablePublish/);
    assert.equal(sent.variables.input.variants[0].published, undefined);
    const intent = (await fx.db.query('SELECT * FROM provider_fixture_intents WHERE shop=$1', [fixture.shop])).rows[0];
    assert.equal(intent.state, 'verified'); assert.equal(intent.product_id, result.fixture.productId);
  }
  assert.equal(writes(fx).length, 2);
});

test('existing consumed stock, including zero, is inspected without reset; ownership or configuration drift never overwrites', async t => {
  const fx = await setup(t); fx.products.set(A.shop, product(A, 0)); fx.products.set(B.shop, product(B, 8));
  assert.equal((await fx.service.create({ shop: A.shop, confirmTest: true })).fixture.inventoryQty, 0);
  assert.equal((await fx.service.create({ shop: B.shop, confirmTest: true })).fixture.inventoryQty, 8);
  fx.products.get(A.shop).vendor = 'Other Merchant';
  await assert.rejects(fx.service.create({ shop: A.shop, confirmTest: true }), { code: 'FIXTURE_OWNERSHIP_MISMATCH' });
  fx.products.get(B.shop).variants.nodes[0].price = '0.01';
  await assert.rejects(fx.service.create({ shop: B.shop, confirmTest: true }), { code: 'FIXTURE_READBACK_MISMATCH' });
  assert.equal(writes(fx).length, 0);
});

test('concurrent duplicate confirmed requests persist one intent and send one mutation', async t => {
  const fx = await setup(t);
  await Promise.all([fx.service.create({ shop: A.shop, confirmTest: true }), fx.service.create({ shop: A.shop, confirmTest: true })]);
  await fx.service.create({ shop: A.shop, confirmTest: true });
  assert.equal(writes(fx).length, 1); assert.equal((await fx.db.query('SELECT shop FROM provider_fixture_intents')).rows.length, 1);
});

test('timeout after creation reconciles fixed handle without a replacement mutation or stock reset', async t => {
  const fx = await setup(t), adapter = fx.adapters.get(A.shop), original = adapter.fixtureGraphql;
  adapter.fixtureGraphql = async (...args) => { const value = await original(...args); if (args[0] === 'AvafemCreateTestFixture') throw new Error('shpat_SECRET_DO_NOT_ECHO'); return value; };
  const uncertain = await fx.service.create({ shop: A.shop, confirmTest: true });
  assert.equal(uncertain.status, 'OUTCOME_UNCERTAIN'); assert.doesNotMatch(JSON.stringify(uncertain), /shpat_|SECRET/);
  fx.products.get(A.shop).variants.nodes[0].inventoryQuantity = 9;
  const result = await fx.service.create({ shop: A.shop, confirmTest: true });
  assert.equal(result.existing, true); assert.equal(result.fixture.inventoryQty, 9); assert.equal(writes(fx).length, 1);
  assert.equal((await fx.db.query('SELECT state FROM provider_fixture_intents WHERE shop=$1', [A.shop])).rows[0].state, 'verified');
});

test('unknown creation with no handle mapping is never repeated across restart or time advance', async t => {
  const fx = await setup(t), adapter = fx.adapters.get(A.shop), original = adapter.fixtureGraphql;
  adapter.fixtureGraphql = async (op, variables) => {
    if (op !== 'AvafemCreateTestFixture') return original(op, variables);
    fx.calls.push({ shop: A.shop, operation: op, variables }); throw new Error('timeout');
  };
  await fx.service.create({ shop: A.shop, confirmTest: true });
  const restarted = await createProviderFixtures(fx.db, { stores: fx.stores, clock: () => new Date('2027-10-19') });
  const result = await restarted.create({ shop: A.shop, confirmTest: true });
  assert.equal(result.code, 'FIXTURE_CREATION_REVIEW_REQUIRED'); assert.equal(writes(fx).length, 1);
});

test('empty inventory locations or malformed pagination block before creation and require Shopify admin setup', async t => {
  const fx = await setup(t); fx.setInventory({ nodes: [], pageInfo: { hasNextPage: false } });
  await assert.rejects(fx.service.create({ shop: A.shop, confirmTest: true }), { code: 'FIXTURE_LOCATION_UI_REQUIRED' });
  fx.setInventory({ nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } });
  await assert.rejects(fx.service.create({ shop: A.shop, confirmTest: true }), { code: 'FIXTURE_INVENTORY_READ_REQUIRED' });
  assert.equal(writes(fx).length, 0); assert.equal((await fx.db.query('SELECT shop FROM provider_fixture_intents')).rows.length, 0);
});

test('wrong store, currency or extra scopes fail closed before fixture reads and writes', async t => {
  const fx = await setup(t), adapter = fx.adapters.get(A.shop), original = adapter.preflight;
  for (const modify of [value => { value.shop.myshopifyDomain = B.shop; }, value => { value.shop.currencyCode = 'CAD'; },
    value => { value.grantedScopes.push('read_locations'); }, value => { value.grantedScopes = []; }]) {
    adapter.preflight = async () => { const value = await original(); modify(value); return value; };
    await assert.rejects(fx.service.create({ shop: A.shop, confirmTest: true }), { code: 'FIXTURE_PREFLIGHT_BLOCKED' });
  }
  assert.equal(fx.calls.length, 0);
});

test('provider error values are redacted and a rejected or mismatched creation remains a durable inspection-only intent', async t => {
  const fx = await setup(t), adapter = fx.adapters.get(A.shop), original = adapter.fixtureGraphql;
  adapter.fixtureGraphql = async (op, variables) => {
    if (op !== 'AvafemCreateTestFixture') return original(op, variables);
    fx.calls.push({ shop: A.shop, operation: op, variables });
    return { productSet: { product: null, userErrors: [{ code: 'sk_test_SECRET', message: 'PRIVATE ADDRESS', field: ['secret'] }] } };
  };
  const result = await fx.service.create({ shop: A.shop, confirmTest: true });
  assert.deepEqual(result.providerCodes, ['UNKNOWN']); assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|secret/);
  await fx.service.create({ shop: A.shop, confirmTest: true }); assert.equal(writes(fx).length, 1);
});

test('server adapter fixture capability denies non-test/store2/arbitrary operations and modified create payloads before authentication', async () => {
  let tokens = 0, calls = 0;
  const options = { env: {}, shop: A.shop, test: true, getAccessToken: async () => { tokens++; return 'fixture-token'; },
    fetch: async () => { calls++; return { ok: true, json: async () => ({ data: { productByIdentifier: null } }) }; } };
  for (const override of [{ test: false }, { shop: 'i4vd1u-s8.myshopify.com' }])
    await assert.rejects(createShopifyAdapter({ ...options, ...override }).fixtureGraphql('AvafemTestFixture', { identifier: { handle: A.handle } }));
  const adapter = createShopifyAdapter(options);
  await assert.rejects(adapter.fixtureGraphql('mutation Arbitrary { shop { id } }', {}));
  await assert.rejects(adapter.fixtureGraphql('AvafemTestFixture', { identifier: { handle: 'ordinary-product' } }));
  const input = providerFixtureCreateInput(A, LOCATION); input.id = 'gid://shopify/Product/999';
  await assert.rejects(adapter.fixtureGraphql('AvafemCreateTestFixture', { input }));
  assert.equal(tokens, 0); assert.equal(calls, 0);
  assert.deepEqual(await adapter.fixtureGraphql('AvafemTestFixture', { identifier: { handle: A.handle } }), { productByIdentifier: null });
  assert.equal(tokens, 1); assert.equal(calls, 1);
});
