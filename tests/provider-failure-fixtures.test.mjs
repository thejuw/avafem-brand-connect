import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createProviderFailureFixtures, FAILURE_FIXTURES, failureFixtureCreateInput, failureFixtureSnapshot } from '../server/provider-failure-fixtures.mjs';
import { createShopifyAdapter } from '../server/integrations/shopify.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const page = nodes => ({ pageInfo: { hasNextPage: false }, nodes });
const LOCATION = 'gid://shopify/Location/101';
function product(fixture, index = 0) {
  return { id: `gid://shopify/Product/${200 + index}`, title: fixture.title, description: fixture.description, handle: fixture.handle,
    vendor: fixture.vendor, tags: [...fixture.tags], status: 'ACTIVE', isGiftCard: false, requiresSellingPlan: false,
    variants: page([{ id: `gid://shopify/ProductVariant/${300 + index}`, title: 'Default Title', sku: fixture.sku,
      price: (fixture.priceCents / 100).toFixed(2), inventoryQuantity: 10, inventoryPolicy: 'DENY', selectedOptions: [{ name: 'Title', value: 'Default Title' }],
      inventoryItem: { id: `gid://shopify/InventoryItem/${400 + index}`, sku: fixture.sku, tracked: true, requiresShipping: true,
        inventoryLevels: page([{ location: { id: LOCATION }, quantities: [{ name: 'available', quantity: 10 }] }]) } }]) };
}
async function fixture(t, { canDelete } = {}) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: 'failure-unit-session-only', encryptionKey: 'failure-unit-encryption-only' });
  const products = new Map(), writes = [], reads = [], controls = { loseCreate: false, loseMutation: false, invisibleMutation: false, extraScopes: false, disconnect: false, loseDelete: false, invisibleDelete: false };
  const stored = async shop => { const row = (await db.query('SELECT * FROM provider_failure_fixtures WHERE shop=$1', [shop])).rows[0];
    return row ? { row, details: auth.decrypt(row.details_encrypted), baseline: row.baseline_encrypted ? auth.decrypt(row.baseline_encrypted) : null } : null; };
  const stores = { row: async shop => ({ shop, brand_id: `brand_failure_${FAILURE_FIXTURES.findIndex(value => value.shop === shop)}`, state: controls.disconnect ? 'disconnected' : 'connected' }),
    forShop: async shop => { const fixed = FAILURE_FIXTURES.find(value => value.shop === shop); assert.ok(fixed); return { shop,
      preflight: async () => ({ verified: true, connected: true, shop: { myshopifyDomain: shop, currencyCode: 'USD' }, grantedScopes: [...SHOPIFY_ALLOWED_SCOPES, ...(controls.extraScopes ? ['read_locations'] : [])] }),
      failureFixtureGraphql: async (operation, variables) => {
        if (operation === 'AvafemFailureFixture') { reads.push(shop); assert.equal(variables.identifier.handle, fixed.handle); return { productByIdentifier: structuredClone(products.get(shop) ?? null) }; }
        if (operation === 'AvafemFailureById') { reads.push(`by-id:${variables.id}`); const value = products.get(shop); return { product: value?.id === variables.id ? structuredClone(value) : null }; }
        if (operation === 'AvafemFailureLocations') return { productVariants: page([{ inventoryItem: { inventoryLevels: page([{ location: { id: LOCATION } }]) } }]) };
        const saved = await stored(shop); assert.ok(saved.row.details_encrypted);
        writes.push({ shop, operation, variables: structuredClone(variables) });
        if (operation === 'AvafemFailureCreate') {
          assert.ok(saved.details.createStartedAt); assert.equal(saved.details.creationBaseline.absent, true);
          assert.deepEqual(variables.input, failureFixtureCreateInput(fixed, LOCATION));
          products.set(shop, product(fixed, FAILURE_FIXTURES.indexOf(fixed)));
          if (controls.loseCreate) throw new Error('PRIVATE_PROVIDER_SECRET');
          return { productSet: { product: { id: products.get(shop).id }, userErrors: [] } };
        }
        const current = products.get(shop), variant = current.variants.nodes[0];
        if (operation === 'AvafemFailureDelete') {
          assert.ok(saved.details.deleteStartedAt); assert.equal(saved.details.deleteProductId, current.id);
          assert.deepEqual(variables, { input: { id: current.id } });
          if (controls.invisibleDelete) throw new Error('PRIVATE_DELETE_PROVIDER');
          products.delete(shop); if (controls.loseDelete) throw new Error('PRIVATE_DELETE_PROVIDER');
          return { productDelete: { deletedProductId: current.id, userErrors: [] } };
        }
        const op = saved.details.ops[saved.details.activeScenario]; assert.ok(op?.mutateStartedAt || op?.restoreStartedAt);
        if (controls.invisibleMutation) throw new Error('PRIVATE_PROVIDER_SECRET');
        let payload;
        if (operation === 'AvafemFailurePrice') { variant.price = variables.variants[0].price; payload = 'productVariantsBulkUpdate'; }
        if (operation === 'AvafemFailureStatus') { current.status = variables.product.status; payload = 'productUpdate'; }
        if (operation === 'AvafemFailureStock') {
          const quantity = variables.input.quantities[0];
          assert.equal(quantity.changeFromQuantity, variant.inventoryQuantity); assert.equal(quantity.inventoryItemId, variant.inventoryItem.id);
          assert.equal(quantity.locationId, LOCATION); assert.match(variables.idempotencyKey, /^[a-f0-9-]{36}$/);
          variant.inventoryQuantity = quantity.quantity; variant.inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity = quantity.quantity; payload = 'inventorySetQuantities';
        }
        assert.ok(payload); if (controls.loseMutation) throw new Error('PRIVATE_PROVIDER_SECRET');
        return { [payload]: { userErrors: [] } };
      } }; } };
  const service = await createProviderFailureFixtures(db, auth, { stores, ...(canDelete ? { canDelete } : {}) });
  return { db, auth, stores, service, products, writes, reads, controls, stored };
}
const input = index => ({ shop: FAILURE_FIXTURES[index].shop, confirmTest: true });

test('native Money decimal forms preserve exact fixed cents without accepting subcent or caller-selected prices', () => {
  for (const value of ['1', '1.0', '1.00']) {
    const current = product(FAILURE_FIXTURES[0]); current.variants.nodes[0].price = value;
    assert.equal(failureFixtureSnapshot(current, FAILURE_FIXTURES[0]).priceCents, 100);
  }
  for (const value of ['1.001', '1e0', '0.99', '9.99']) {
    const current = product(FAILURE_FIXTURES[0]); current.variants.nodes[0].price = value;
    assert.throws(() => failureFixtureSnapshot(current, FAILURE_FIXTURES[0]), { code: 'FAILURE_FIXTURE_OWNERSHIP_MISMATCH' });
  }
});

test('failure inspection is lazy and the three distinct fixed fixtures never reuse cash product handles', async t => {
  const f = await fixture(t);
  for (const fixed of FAILURE_FIXTURES) {
    const view = await f.service.inspect({ shop: fixed.shop }); assert.equal(view.state, 'unprepared'); assert.equal(view.fixture, null);
    assert.equal(view.publicationVerified, false); assert.equal(view.baseline, null); assert.equal(view.providerWrites, 0);
    assert.match(fixed.sku, /^AVF-CONNECT-TEST-FAIL-00[246]$/); assert.match(fixed.handle, /^avafem-failure-test-/);
  }
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM provider_failure_fixtures')).rows[0].n, 0); assert.equal(f.writes.length, 0);
});

test('prepare persists encrypted absent/native baselines before exactly one dedicated physical creation per store', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const result = await f.service.prepare(input(index)); assert.equal(result.state, 'prepared'); assert.equal(result.providerWrites, 1);
    assert.equal(result.fixture.priceCents, FAILURE_FIXTURES[index].priceCents); assert.equal(result.fixture.inventoryQty, 10);
    assert.equal(result.baselineCaptured, true); assert.deepEqual(result.baseline, result.fixture);
    assert.equal((await f.service.prepare(input(index))).providerWrites, 0);
    const saved = await f.stored(input(index).shop); assert.doesNotMatch(saved.row.baseline_encrypted, /gid:|inventoryQty|AVF-CONNECT/);
    assert.doesNotMatch(saved.row.details_encrypted, /DO NOT SHIP|available|productOptions/);
  }
  assert.equal(f.writes.length, 3); assert.equal(new Set(f.writes.map(write => write.shop)).size, 3);
});

test('explicit confirmations, exact stores, scope ceilings and strict inputs fail before a provider mutation', async t => {
  const f = await fixture(t);
  for (const value of [{}, { ...input(0), confirmTest: false }, { ...input(0), priceCents: 1 }, { ...input(0), shop: 'foreign.myshopify.com' }]) await assert.rejects(f.service.prepare(value));
  f.controls.extraScopes = true; await assert.rejects(f.service.prepare(input(0)), { code: 'FAILURE_FIXTURE_PREFLIGHT' });
  f.controls.extraScopes = false; f.controls.disconnect = true; await assert.rejects(f.service.prepare(input(0)), { code: 'FAILURE_FIXTURE_BINDING' });
  assert.equal(f.writes.length, 0);
});

test('an unclaimed or foreign same-handle product is never adopted, overwritten, restored or restocked', async t => {
  const f = await fixture(t); f.products.set(input(0).shop, product(FAILURE_FIXTURES[0]));
  await assert.rejects(f.service.prepare(input(0)), { code: 'FAILURE_FIXTURE_UNCLAIMED' }); assert.equal(f.writes.length, 0);
  f.products.get(input(0).shop).tags = ['TEST_DO_NOT_SHIP'];
  await assert.rejects(f.service.inspect({ shop: input(0).shop }), { code: 'FAILURE_FIXTURE_OWNERSHIP_MISMATCH' });
  assert.equal(f.writes.length, 0);
});

test('all fixed catalog scenarios mutate once and restore exact native baseline without touching orders or money', async t => {
  const f = await fixture(t); await f.service.prepare(input(0));
  for (const scenario of ['price_changed','out_of_stock','archived']) {
    const changed = await f.service.mutate({ ...input(0), scenario }); assert.equal(changed.cleanupRequired, true); assert.equal(changed.state, 'mutated');
    assert.equal(changed.activeScenario, scenario); assert.equal(changed.phase, 'catalog');
    const count = f.writes.length; await f.service.mutate({ ...input(0), scenario }); assert.equal(f.writes.length, count);
    const restored = await f.service.restore(input(0)); assert.deepEqual(restored.fixture, restored.baseline); assert.equal(restored.cleanupRequired, false);
    await f.service.restore(input(0)); await f.service.mutate({ ...input(0), scenario }); assert.equal(f.writes.length, count + 1, 'Replay after restoration must never start a second cycle');
  }
  assert.equal(f.writes.length, 7);
  for (const table of ['orders','bags','ledger_entries','transfers']) assert.equal((await f.db.query(`SELECT COUNT(*)::int n FROM ${table}`)).rows[0].n, 0);
});

test('bounded checkout and catalog phase cycles have separate stable stock keys and cannot overlap or restore the wrong phase', async t => {
  const f = await fixture(t); await f.service.prepare(input(1));
  await f.service.mutate({ ...input(1), scenario: 'out_of_stock' });
  await assert.rejects(f.service.mutate({ ...input(1), scenario: 'price_changed', phase: 'checkout' }), { code: 'FAILURE_FIXTURE_DRIFT' });
  await f.service.restore(input(1));
  const current = await f.service.mutate({ ...input(1), scenario: 'out_of_stock', phase: 'checkout' }); assert.equal(current.phase, 'checkout');
  await assert.rejects(f.service.restore(input(1)), { code: 'FAILURE_FIXTURE_PHASE' });
  await f.service.restore({ ...input(1), phase: 'checkout' });
  const stockWrites = f.writes.filter(write => write.operation === 'AvafemFailureStock');
  assert.equal(stockWrites.length, 4); assert.equal(new Set(stockWrites.map(write => write.variables.idempotencyKey)).size, 4);
  assert.ok(stockWrites.every(write => !JSON.stringify(write.variables).includes('compareQuantity')));
  await assert.rejects(f.service.mutate({ ...input(1), scenario: 'archived', phase: 'checkout' }), { code: 'FAILURE_FIXTURE_INPUT' });
});

test('lost creates and lost mutations reconcile existing fixed identities and never repeat their native mutation', async t => {
  const f = await fixture(t); f.controls.loseCreate = true;
  const uncertain = await f.service.prepare(input(2)); assert.equal(uncertain.state, 'creation_uncertain'); assert.equal(f.writes.length, 1);
  f.controls.loseCreate = false; const recovered = await f.service.prepare(input(2)); assert.equal(recovered.state, 'prepared'); assert.equal(f.writes.length, 1);
  f.controls.loseMutation = true; await f.service.mutate({ ...input(2), scenario: 'price_changed' }); assert.equal(f.writes.length, 2);
  f.controls.loseMutation = false; const found = await f.service.mutate({ ...input(2), scenario: 'price_changed' }); assert.equal(found.state, 'mutated'); assert.equal(f.writes.length, 2);
  await f.service.restore(input(2)); assert.equal(f.writes.length, 3);
  assert.doesNotMatch(JSON.stringify(found), /PRIVATE_|details_encrypted|baseline_encrypted/);
});

test('invisible uncertain writes or unrelated drift hold cleanup instead of making a replacement or overwriting native changes', async t => {
  const f = await fixture(t); await f.service.prepare(input(0)); f.controls.invisibleMutation = true;
  await f.service.mutate({ ...input(0), scenario: 'out_of_stock' }); const count = f.writes.length;
  await f.service.mutate({ ...input(0), scenario: 'out_of_stock' }); assert.equal(f.writes.length, count);
  await assert.rejects(f.service.restore(input(0)), { code: 'FAILURE_FIXTURE_DRIFT' }); assert.equal(f.writes.length, count);
  assert.equal((await f.service.inspect({ shop: input(0).shop })).cleanupRequired, true);
});

test('lost restoration readback reconciles the original baseline without repeating a reset', async t => {
  const f = await fixture(t); await f.service.prepare(input(0)); await f.service.mutate({ ...input(0), scenario: 'out_of_stock' });
  f.controls.loseMutation = true; const uncertain = await f.service.restore(input(0)); assert.equal(uncertain.cleanupRequired, true);
  const count = f.writes.length; f.controls.loseMutation = false; const restored = await f.service.restore(input(0));
  assert.equal(restored.cleanupRequired, false); assert.equal(f.writes.length, count); assert.equal(restored.fixture.inventoryQty, 10);
});

test('unexpected native changes after restoration cannot be shown clean or implicitly restored on replay', async t => {
  const f = await fixture(t); await f.service.prepare(input(0)); await f.service.mutate({ ...input(0), scenario: 'price_changed' }); await f.service.restore(input(0));
  const count = f.writes.length; f.products.get(input(0).shop).status = 'ARCHIVED';
  await assert.rejects(f.service.inspect({ shop: input(0).shop }), { code: 'FAILURE_FIXTURE_DRIFT' });
  await assert.rejects(f.service.prepare(input(0)), { code: 'FAILURE_FIXTURE_DRIFT' });
  await assert.rejects(f.service.mutate({ ...input(0), scenario: 'price_changed' }), { code: 'FAILURE_FIXTURE_DRIFT' });
  await assert.rejects(f.service.restore(input(0)), { code: 'FAILURE_FIXTURE_DRIFT' }); assert.equal(f.writes.length, count);
});

test('same-store concurrent preparations serialize to one durable create and no generalized GraphQL is exposed', async t => {
  const f = await fixture(t); const results = await Promise.allSettled([f.service.prepare(input(0)), f.service.prepare(input(0))]);
  assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(f.writes.length, 1);
  await assert.rejects(f.service.mutate({ ...input(0), scenario: 'price_changed', query: 'PRIVATE_GRAPHQL' }), { code: 'FAILURE_FIXTURE_INPUT' });
});

test('disposable cleanup is default-denied and callback false/throw or active/drifted state never attempts deletion', async t => {
  const f = await fixture(t); await f.service.prepare(input(0)); const count = f.writes.length;
  await assert.rejects(f.service.cleanup(input(0)), { code: 'FAILURE_FIXTURE_DELETE_NOT_AUTHORIZED' }); assert.equal(f.writes.length, count);
  for (const canDelete of [async () => false, async () => { throw new Error('PRIVATE_CALLBACK_SECRET'); }]) {
    const guarded = await createProviderFailureFixtures(f.db, f.auth, { stores: f.stores, canDelete });
    await assert.rejects(guarded.cleanup(input(0)), { code: 'FAILURE_FIXTURE_DELETE_NOT_AUTHORIZED' });
  }
  const guarded = await createProviderFailureFixtures(f.db, f.auth, { stores: f.stores, canDelete: async () => assert.fail('No authorization read should occur while fixture is unrestored') });
  await f.service.mutate({ ...input(0), scenario: 'archived' });
  await assert.rejects(guarded.cleanup(input(0)), { code: 'FAILURE_FIXTURE_CLEANUP_BLOCKED' });
  assert.equal(f.writes.filter(write => write.operation === 'AvafemFailureDelete').length, 0);
});

test('authorized cleanup deletes only its durable restored disposable ID and preserves a permanent non-recreation tombstone', async t => {
  const approvals = [], f = await fixture(t, { canDelete: async value => { approvals.push(value); return true; } });
  const prepared = await f.service.prepare(input(1));
  const result = await f.service.cleanup(input(1)); assert.equal(result.deleted, true); assert.equal(result.state, 'deleted'); assert.equal(result.cleanupRequired, false);
  assert.deepEqual(approvals, [{ shop: input(1).shop, fixture: prepared.baseline }]);
  const count = f.writes.length; const replay = await f.service.cleanup(input(1)); assert.equal(replay.deleted, true); assert.equal(f.writes.length, count);
  assert.equal(approvals.length, 1); assert.equal((await f.service.inspect({ shop: input(1).shop })).deleted, true);
  await assert.rejects(f.service.prepare(input(1)), { code: 'FAILURE_FIXTURE_TOMBSTONE' });
  await assert.rejects(f.service.mutate({ ...input(1), scenario: 'price_changed' }), { code: 'FAILURE_FIXTURE_TOMBSTONE' });
  await assert.rejects(f.service.restore(input(1)), { code: 'FAILURE_FIXTURE_TOMBSTONE' }); assert.equal(f.writes.length, count);
});

test('lost or unknown deletion never retries, reads original product ID only and keeps unresolved cleanup visible', async t => {
  const f = await fixture(t, { canDelete: async () => true }); await f.service.prepare(input(0)); f.controls.invisibleDelete = true;
  const unknown = await f.service.cleanup(input(0)); assert.equal(unknown.state, 'deletion_uncertain'); assert.equal(unknown.cleanupRequired, true);
  const count = f.writes.length, reads = f.reads.length;
  await f.service.cleanup(input(0)); await f.service.inspect({ shop: input(0).shop }); assert.equal(f.writes.length, count);
  assert.ok(f.reads.slice(reads).every(value => value.startsWith('by-id:')));
  await assert.rejects(f.service.prepare(input(0)), { code: 'FAILURE_FIXTURE_TOMBSTONE' });
  f.products.delete(input(0).shop); const resolved = await f.service.cleanup(input(0)); assert.equal(resolved.deleted, true); assert.equal(f.writes.length, count);
  const g = await fixture(t, { canDelete: async () => true }); await g.service.prepare(input(2)); g.controls.loseDelete = true;
  const lost = await g.service.cleanup(input(2)); assert.equal(lost.deleted, true); assert.equal(lost.cleanupRequired, false);
  assert.doesNotMatch(JSON.stringify(lost), /PRIVATE_|details_encrypted|deleteStartedAt/);
});

test('real adapter failure capability has fixed operation/identity/value guards and current native CAS schema without extra scopes', async () => {
  const fixed = FAILURE_FIXTURES[0], current = product(fixed), calls = [];
  const adapter = createShopifyAdapter({ env: {}, test: true, accessToken: 'unit_fixture_token', fetch: async (_url, init) => {
    const payload = JSON.parse(init.body); calls.push(payload); let data;
    if (payload.query.includes('AvafemPreflight')) data = { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: fixed.shop, currencyCode: 'USD' }, currentAppInstallation: { id: 'gid://shopify/AppInstallation/1', app: {}, accessScopes: SHOPIFY_ALLOWED_SCOPES.map(handle => ({ handle })) } };
    else if (payload.query.startsWith('query')) data = { productByIdentifier: current };
    else if (payload.query.includes('AvafemFailureDelete')) data = { productDelete: { deletedProductId: current.id, userErrors: [] } };
    else data = { inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: '2026-10-19T12:00:00Z' }, userErrors: [] } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(adapter.failureFixtureGraphql('query arbitrary', {})); assert.equal(calls.length, 0);
  await assert.rejects(adapter.failureFixtureGraphql('AvafemFailureFixture', { identifier: { handle: 'avafem-connect-test-002-do-not-ship' } })); assert.equal(calls.length, 0);
  const variables = { idempotencyKey: 'd2541548-93a1-5f0d-94d0-4b3e9b102205', input: { name: 'available', reason: 'correction',
    referenceDocumentUri: 'gid://avafem/FailureFixture/002-checkout-mutate', quantities: [{ inventoryItemId: current.variants.nodes[0].inventoryItem.id, locationId: LOCATION, quantity: 0, changeFromQuantity: 10 }] } };
  await adapter.failureFixtureGraphql('AvafemFailureStock', variables);
  const write = calls.at(-1); assert.match(write.query, /@idempotent\(key:\$idempotencyKey\)/); assert.deepEqual(write.variables, variables);
  assert.doesNotMatch(write.query, /read_locations|isFulfillmentService|compareQuantity|ignoreCompareQuantity|orderCreate|productDelete/);
  const count = calls.filter(call => call.query.startsWith('mutation')).length;
  for (const change of [value => { value.input.quantities[0].inventoryItemId = 'gid://shopify/InventoryItem/999'; },
    value => { value.input.quantities[0].changeFromQuantity = 9; }, value => { value.input.quantities[0].quantity = 11; },
    value => { value.input.ignoreCompareQuantity = true; }, value => { value.idempotencyKey = 'caller_key'; }]) {
    const bad = structuredClone(variables); change(bad); await assert.rejects(adapter.failureFixtureGraphql('AvafemFailureStock', bad));
  }
  assert.equal(calls.filter(call => call.query.startsWith('mutation')).length, count);
  await assert.rejects(adapter.failureFixtureGraphql('AvafemFailureDelete', { input: { id: 'gid://shopify/Product/999' } }));
  assert.equal(calls.filter(call => call.query.startsWith('mutation')).length, count);
  await adapter.failureFixtureGraphql('AvafemFailureDelete', { input: { id: current.id } });
  assert.match(calls.at(-1).query, /productDelete\(input:\$input,synchronous:true\)/);
  assert.deepEqual(calls.at(-1).variables, { input: { id: current.id } });
});
