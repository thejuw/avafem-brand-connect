import test from 'node:test';
import assert from 'node:assert/strict';
import { main, runShopifyTestFixture, TEST_FIXTURE } from '../scripts/setup-shopify-test-fixture.mjs';
import { DEFAULT_SHOPIFY_CLIENT_ID, SHOPIFY_SCOPES } from '../server/integrations/shopify.mjs';

const SECRET = 'mock-fixture-client-secret-DO-NOT-LOG';
const TOKEN = 'mock-fixture-access-token-DO-NOT-LOG';
const LOCATION = 'gid://shopify/Location/567';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const fixture = (quantity = 10) => ({
  id: 'gid://shopify/Product/123', title: TEST_FIXTURE.title, description: TEST_FIXTURE.description,
  handle: TEST_FIXTURE.handle, vendor: TEST_FIXTURE.vendor, tags: [...TEST_FIXTURE.tags],
  status: 'ACTIVE', isGiftCard: false, requiresSellingPlan: false,
  variants: { pageInfo: { hasNextPage: false }, nodes: [{
    id: 'gid://shopify/ProductVariant/456', title: 'Default Title', sku: TEST_FIXTURE.sku,
    price: '1.00', inventoryQuantity: quantity, inventoryPolicy: 'DENY',
    selectedOptions: [{ name: 'Title', value: 'Default Title' }],
    inventoryItem: { sku: TEST_FIXTURE.sku, tracked: true, requiresShipping: true },
  }] },
});

function provider(options = {}) {
  const calls = [];
  let product = options.existing ?? null;
  let lookups = 0;
  let inventoryPages = 0;
  let mutations = 0;
  const fetch = async (url, request) => {
    assert.equal(new URL(url).hostname, TEST_FIXTURE.shop);
    assert.equal(request.redirect, 'error');
    if (url.endsWith('/oauth/access_token')) {
      const body = new URLSearchParams(request.body);
      assert.equal(body.get('client_id'), DEFAULT_SHOPIFY_CLIENT_ID);
      assert.equal(body.get('client_secret'), SECRET);
      assert.equal(body.get('grant_type'), 'client_credentials');
      calls.push({ type: 'auth' });
      if (options.authError) throw new Error(`${SECRET} ${TOKEN}`);
      return json({ access_token: TOKEN, expires_in: 3600 });
    }
    assert.equal(request.headers['x-shopify-access-token'], TOKEN);
    assert.ok(url.endsWith('/admin/api/2026-10/graphql.json'));
    const payload = JSON.parse(request.body);
    calls.push(payload);
    assert.doesNotMatch(payload.query, /\blocations\s*\(|read_locations|read_publications|resourcePublicationsCount|availablePublicationsCount|publishablePublish|orderCreate|fulfillmentCreate/);
    if (payload.query.includes('AvafemPreflight')) return json({ data: {
      shop: { myshopifyDomain: options.wrongShop ? 'other.myshopify.com' : TEST_FIXTURE.shop, currencyCode: options.currency ?? 'USD' },
      currentAppInstallation: { app: { id: 'gid://shopify/App/77', title: 'Avafem Test Connector' }, accessScopes: (options.scopes ?? SHOPIFY_SCOPES).map(handle => ({ handle })) },
    } });
    if (payload.query.includes('AvafemTestFixtureById')) {
      assert.match(payload.query, /product\(id:\$id\)/);
      assert.equal(payload.variables.id, fixture().id);
      if (options.readbackError) throw new Error(`${SECRET} ${TOKEN}`);
      return json({ data: { product: options.missingIdReadback ? null : product } });
    }
    if (payload.query.includes('AvafemTestFixture')) {
      lookups++;
      assert.match(payload.query, /productByIdentifier\(identifier:\$identifier\)/);
      assert.doesNotMatch(payload.query, /products\s*\(|query:/);
      assert.deepEqual(payload.variables, { identifier: { handle: TEST_FIXTURE.handle } });
      if (options.appearBeforeWrite && lookups === 2) product = fixture(4);
      return json({ data: options.missingDirectLookup ? {} : { productByIdentifier: product } });
    }
    if (payload.query.includes('AvafemFixtureInventoryLevels')) {
      inventoryPages++;
      if (options.pagedInventory && inventoryPages === 1) return json({ data: { productVariants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } } });
      return json({ data: { productVariants: {
        nodes: options.noLocation ? [] : [{ inventoryItem: { inventoryLevels: { nodes: [{ location: { id: options.location ?? LOCATION } }] } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    }
    if (payload.query.includes('AvafemCreateTestFixture')) {
      mutations++;
      assert.equal(product, null, 'Existing products must never be intentionally updated');
      if (options.createUserError || options.userErrors) return json({ data: { productSet: {
        product: options.errorsWithProduct ? { id: fixture().id } : null,
        userErrors: options.userErrors ?? [{ code: 'INVALID_INPUT', field: ['input', 'variants', '0', 'published'], message: SECRET }],
      } } });
      product = fixture();
      if (options.timeoutOnCreate) throw new Error(`${SECRET} ${TOKEN}`);
      if (options.createStatus) return json({ upstreamSecret: SECRET }, options.createStatus);
      if (options.graphqlCreateError) return json({ errors: [{ message: SECRET }] });
      if (options.badReadback) product.variants.nodes[0].price = '2.00';
      return json({ data: { productSet: { product: { id: product.id }, userErrors: [] } } });
    }
    assert.fail('Unexpected network operation');
  };
  return { calls, fetch, loadSecret: async () => SECRET, get mutations() { return mutations; } };
}

test('default inspect exchanges only mock credentials and performs no GraphQL mutation', async () => {
  const mock = provider();
  const report = await runShopifyTestFixture(mock);
  assert.equal(report.status, 'READY_TO_CREATE');
  assert.equal(report.mode, 'inspect');
  assert.equal(report.mutationAttempted, false);
  assert.equal(mock.mutations, 0);
  assert.ok(mock.calls.some(call => call.query?.includes('inventoryLevels')));
  assert.ok(mock.calls.every(call => !call.query || !/^mutation\b/.test(call.query)));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${TOKEN}|${LOCATION}`));
});

test('apply confirms one fixed physical $1 fixture but requires manual publication verification', async () => {
  const mock = provider();
  const report = await runShopifyTestFixture({ ...mock, apply: true });
  assert.equal(report.status, 'PUBLICATION_VERIFICATION_REQUIRED');
  assert.equal(report.code, 'MANUAL_PUBLICATION_CHECK_REQUIRED');
  assert.equal(report.created, true);
  assert.equal(report.existing, false);
  assert.equal(report.neverRestock, true);
  assert.equal(report.action, 'create');
  assert.equal(report.mutationAttempted, true);
  assert.equal(report.fixture.inventoryQty, 10);
  assert.equal(report.fixture.publishedSalesChannels, null);
  assert.match(report.message, /unknown.*verify zero channels manually/i);
  assert.equal(mock.mutations, 1);
  const write = mock.calls.find(call => call.query?.startsWith('mutation'));
  assert.match(write.query, /productSet\(input:\$input,identifier:\$identifier,synchronous:true\)/);
  assert.deepEqual(write.variables.identifier, { handle: TEST_FIXTURE.handle });
  const { input } = write.variables;
  assert.equal(input.handle, TEST_FIXTURE.handle);
  assert.equal(input.title, TEST_FIXTURE.title);
  assert.equal(input.vendor, 'Avafem Test');
  assert.equal(input.status, 'ACTIVE');
  assert.deepEqual(input.tags, ['TEST_DO_NOT_SHIP', 'avafem-integration-fixture']);
  assert.deepEqual(input.productOptions, [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }]);
  assert.deepEqual(input.variants, [{
    price: '1.00', inventoryPolicy: 'DENY', taxable: true,
    optionValues: [{ optionName: 'Title', name: 'Default Title' }],
    inventoryItem: { sku: TEST_FIXTURE.sku, tracked: true, requiresShipping: true },
    inventoryQuantities: [{ locationId: LOCATION, name: 'available', quantity: 10 }],
  }]);
  assert.equal(Object.hasOwn(input.variants[0], 'published'), false, 'Never override publication on the sole default variant');
  assert.doesNotMatch(JSON.stringify(input), /publication|health|read_locations/i);
  assert.ok(mock.calls.every(call => !call.query || !/publishablePublish|publicationCreate|productPublish/.test(call.query)), 'Product sales-channel publication must never be requested');
  assert.equal(mock.calls.filter(call => call.query?.includes('AvafemTestFixture')).length, 3);
  assert.equal(mock.calls.filter(call => call.query?.includes('productByIdentifier')).length, 2);
  const idReadback = mock.calls.find(call => call.query?.includes('AvafemTestFixtureById'));
  assert.deepEqual(idReadback.variables, { id: 'gid://shopify/Product/123' });
});

test('existing valid fixture is not updated or restocked even when stock has been used up', async () => {
  for (const quantity of [0, 4, 10]) {
    const mock = provider({ existing: fixture(quantity) });
    const report = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(report.status, 'PUBLICATION_VERIFICATION_REQUIRED');
    assert.equal(report.code, 'MANUAL_PUBLICATION_CHECK_REQUIRED');
    assert.equal(report.created, false);
    assert.equal(report.existing, true);
    assert.equal(report.neverRestock, true);
    assert.equal(report.action, 'none');
    assert.equal(report.fixture.publishedSalesChannels, null);
    assert.equal(report.fixture.inventoryQty, quantity);
    assert.equal(report.mutationAttempted, false);
    assert.equal(mock.mutations, 0);
    assert.ok(!mock.calls.some(call => call.query?.includes('AvafemFixtureInventoryLevels')));
  }
});

test('existing unrelated handle is blocked without overwriting or reading a new location', async () => {
  for (const change of [p => { p.vendor = 'Other'; }, p => { p.tags = []; }, p => { p.variants.nodes[0].sku = 'OTHER'; }]) {
    const product = fixture(); change(product);
    const mock = provider({ existing: product });
    const result = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.code, 'FIXTURE_OWNERSHIP_MISMATCH');
    assert.equal(mock.mutations, 0);
  }
});

test('owned fixture with wrong price, nonphysical stock or missing physical readback proof is blocked', async () => {
  const changes = [
    p => { p.variants.nodes[0].price = '10.00'; }, p => { p.variants.nodes[0].inventoryItem.requiresShipping = false; },
    p => { p.variants.nodes[0].inventoryItem.tracked = false; }, p => { p.variants.nodes[0].inventoryPolicy = 'CONTINUE'; },
    p => { p.variants.nodes[0].inventoryQuantity = 11; }, p => { p.status = 'DRAFT'; },
    p => { p.variants.pageInfo.hasNextPage = true; }, p => { p.variants.nodes.push(p.variants.nodes[0]); },
  ];
  for (const change of changes) {
    const product = fixture(); change(product);
    const mock = provider({ existing: product });
    const result = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.code, 'FIXTURE_READBACK_MISMATCH');
    assert.equal(mock.mutations, 0);
  }
});

test('publication remains unknown without requesting unapproved fields, scopes or CLI override', async () => {
  assert.ok(!SHOPIFY_SCOPES.includes('read_publications'));
  const mock = provider({ existing: fixture() });
  const report = await runShopifyTestFixture(mock);
  assert.equal(report.status, 'PUBLICATION_VERIFICATION_REQUIRED');
  assert.equal(report.fixture.publishedSalesChannels, null);
  assert.equal(report.mutationAttempted, false);
  const cli = await main(['--inspect'], provider({ existing: fixture() }));
  assert.equal(cli.exitCode, 2);
  const override = await main(['--publication-verified'], { loadSecret: () => assert.fail('No secret should load for an unsupported override') });
  assert.equal(override.exitCode, 2);
});

test('scope ceiling/missing grants, wrong shop and non-USD prevent all fixture mutations', async () => {
  for (const options of [{ scopes: [...SHOPIFY_SCOPES, 'read_locations'] }, { scopes: ['read_products'] }, { wrongShop: true }, { currency: 'CAD' }]) {
    const mock = provider(options);
    const report = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(report.status, 'BLOCKED'); assert.equal(mock.mutations, 0);
    assert.ok(!mock.calls.some(call => call.query?.includes('AvafemTestFixture')));
  }
});

test('location is derived from existing inventory levels across pages, not invented or queried as locations', async () => {
  const mock = provider({ pagedInventory: true });
  const report = await runShopifyTestFixture({ ...mock, apply: true });
  assert.equal(report.status, 'PUBLICATION_VERIFICATION_REQUIRED');
  const inventoryCalls = mock.calls.filter(call => call.query?.includes('AvafemFixtureInventoryLevels'));
  assert.deepEqual(inventoryCalls.map(call => call.variables), [{ after: null }, { after: 'next' }]);
  for (const options of [{ noLocation: true }, { location: 'invented-id' }]) {
    const noLocation = provider(options);
    const blocked = await runShopifyTestFixture({ ...noLocation, apply: true });
    assert.equal(blocked.code, 'NO_INVENTORY_LOCATION'); assert.equal(noLocation.mutations, 0);
  }
});

test('missing direct handle lookup proof and concurrent appearance never cause an overwrite', async () => {
  const incomplete = provider({ missingDirectLookup: true });
  assert.equal((await runShopifyTestFixture({ ...incomplete, apply: true })).code, 'LOOKUP_INCOMPLETE');
  assert.equal(incomplete.mutations, 0);
  const appeared = provider({ appearBeforeWrite: true });
  const result = await runShopifyTestFixture({ ...appeared, apply: true });
  assert.equal(result.status, 'PUBLICATION_VERIFICATION_REQUIRED'); assert.equal(result.existing, true); assert.equal(result.fixture.inventoryQty, 4); assert.equal(appeared.mutations, 0);
});

test('timeout, HTTP failure, GraphQL errors and invalid direct-ID readback are uncertain without retries', async () => {
  for (const options of [{ timeoutOnCreate: true }, { createStatus: 503 }, { createStatus: 429 }, { graphqlCreateError: true }, { readbackError: true }, { missingIdReadback: true }, { badReadback: true }]) {
    const mock = provider(options);
    const report = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(report.status, 'OUTCOME_UNCERTAIN'); assert.equal(report.code, 'OUTCOME_UNCERTAIN');
    assert.equal(report.mutationAttempted, true); assert.equal(mock.mutations, 1);
    assert.match(report.message, /--inspect/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${TOKEN}`));
  }
});

test('definite productSet validation errors with no product are REJECTED with safe codes and field paths', async () => {
  const mock = provider({ createUserError: true });
  const report = await runShopifyTestFixture({ ...mock, apply: true });
  assert.equal(report.status, 'REJECTED'); assert.equal(report.code, 'PRODUCT_SET_REJECTED');
  assert.equal(report.mutationAttempted, true); assert.equal(mock.mutations, 1);
  assert.deepEqual(report.userErrors, [{ code: 'INVALID_INPUT', field: ['input', 'variants', '0', 'published'] }]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${TOKEN}|message.*${SECRET}`));
  assert.match(report.message, /--inspect/);
  const cli = await main(['--apply'], provider({ createUserError: true }));
  assert.equal(cli.exitCode, 2); assert.equal(JSON.parse(cli.output).status, 'REJECTED');
});

test('unknown/generic/job or partial-product userErrors remain uncertain and never print raw diagnostics', async () => {
  const cases = [
    { userErrors: [{ code: 'GENERIC_ERROR', field: ['input'] }] },
    { userErrors: [{ code: 'JOB_ERROR', field: ['input'] }] },
    { userErrors: [{ code: SECRET, field: ['input', SECRET, TOKEN], message: SECRET }] },
    { createUserError: true, errorsWithProduct: true },
  ];
  for (const options of cases) {
    const mock = provider(options);
    const report = await runShopifyTestFixture({ ...mock, apply: true });
    assert.equal(report.status, 'OUTCOME_UNCERTAIN'); assert.equal(mock.mutations, 1);
    assert.ok(report.userErrors.length > 0);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${TOKEN}`));
  }
  const sanitized = await runShopifyTestFixture({ ...provider(cases[2]), apply: true });
  assert.deepEqual(sanitized.userErrors, [{ code: 'UNKNOWN', field: ['input', '<redacted>', '<redacted>'] }]);
});

test('next invocation reconciles a fixture created before a lost response instead of retrying productSet', async () => {
  const mock = provider({ timeoutOnCreate: true });
  const first = await runShopifyTestFixture({ ...mock, apply: true });
  assert.equal(first.status, 'OUTCOME_UNCERTAIN');
  const callCount = mock.calls.length;
  const next = await runShopifyTestFixture({ ...mock, apply: true });
  assert.equal(next.status, 'PUBLICATION_VERIFICATION_REQUIRED');
  assert.equal(next.existing, true);
  assert.equal(next.mutationAttempted, false);
  assert.equal(mock.mutations, 1);
  const newGraphqlCalls = mock.calls.slice(callCount).filter(call => call.query);
  assert.equal(newGraphqlCalls.length, 2);
  assert.match(newGraphqlCalls[0].query, /AvafemPreflight/);
  assert.match(newGraphqlCalls[1].query, /AvafemTestFixture/);
});

test('credential and upstream exceptions never expose secrets; no environment is required in tests', async () => {
  const missing = provider();
  const unavailable = await runShopifyTestFixture({ ...missing, apply: true, loadSecret: async () => { throw new Error(SECRET); } });
  assert.equal(unavailable.code, 'CREDENTIALS_UNAVAILABLE'); assert.equal(missing.calls.length, 0);
  const failed = await runShopifyTestFixture({ ...provider({ authError: true }), apply: true });
  assert.equal(failed.code, 'AUTH_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify([unavailable, failed]), new RegExp(`${SECRET}|${TOKEN}`));
});

test('CLI defaults inspect, requires explicit --apply and refuses store/credential overrides without I/O', async () => {
  const inspect = provider();
  const result = await main([], inspect);
  assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.output).mode, 'inspect'); assert.equal(inspect.mutations, 0);
  const apply = provider();
  const created = await main(['--apply'], apply);
  assert.equal(created.exitCode, 2); assert.equal(JSON.parse(created.output).status, 'PUBLICATION_VERIFICATION_REQUIRED');
  for (const args of [['--shop=other.myshopify.com'], ['--apply', '--inspect'], ['--secret=do-not-log'], ['--help']]) {
    const cli = await main(args, { fetch: () => assert.fail('No request should be made'), loadSecret: () => assert.fail('No secret should be loaded') });
    assert.equal(cli.exitCode, args[0] === '--help' ? 0 : 2);
    assert.doesNotMatch(cli.output, /do-not-log/);
  }
  const blocked = await main(['--apply'], provider({ noLocation: true }));
  assert.equal(blocked.exitCode, 2);
  const unknown = await main(['--apply'], provider({ timeoutOnCreate: true }));
  assert.equal(unknown.exitCode, 3);
});
