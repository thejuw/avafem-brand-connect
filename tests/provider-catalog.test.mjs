import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createDomain } from '../server/domain.mjs';
import { createProviderCatalog } from '../server/provider-catalog.mjs';
import { createShopifyAdapter } from '../server/integrations/shopify.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

// Synthetic provider/HTTP fixtures only; these are not live-provider acceptance.
const SHOP = TEST_STORES[0].shop;
const completed = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const source = (index = 0, shop = SHOP) => ({ id: `gid://shopify/Product/${1000 + index}`,
  brandProductId: `gid://shopify/Product/${1000 + index}`, source: { provider: 'shopify', shop, productId: `gid://shopify/Product/${1000 + index}` },
  title: `Catalog unit ${index}`, description: '<p>Synthetic catalog description.</p>', sku: `UNIT-${index}`, priceCents: 100,
  currency: 'USD', inventoryQty: 5, images: [`https://example.com/catalog-${index}.jpg`], sourceStatus: 'ACTIVE',
  variants: [{ id: `gid://shopify/ProductVariant/${2000 + index}`, shopifyVariantId: `gid://shopify/ProductVariant/${2000 + index}`,
    sku: `UNIT-${index}`, title: 'Default', price: { amount: 100, currency: 'USD' }, inventory: { qty: 5, policy: 'deny' },
    options: { Title: 'Default Title' }, tracked: true, requiresShipping: true }],
  variantsPageInfo: { hasNextPage: false }, imagesPageInfo: { hasNextPage: false },
  evidence: { ingredients_inci: ['UNTRUSTED_PROVIDER_EVIDENCE'] }, taxCode: 'UNTRUSTED_PROVIDER_TAX', category: 'UNTRUSTED_PROVIDER_CATEGORY',
});
async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const domain = createDomain(db), rows = [], adapters = new Map(), checked = new Map(), snapshots = new Map();
  const calls = { preflight: [], pages: [] };
  for (let index = 0; index < TEST_STORES.length; index++) {
    const store = TEST_STORES[index], brand = await domain.createBrand({ id: `brand_catalog_${index}`, name: store.name, slug: `catalog-unit-${index}`, commissionBps: 1500 });
    rows.push({ shop: store.shop, brand_id: brand.id, state: 'connected' });
    snapshots.set(store.shop, [source(index, store.shop)]);
    adapters.set(store.shop, { shop: store.shop,
      preflight: async () => { calls.preflight.push(store.shop); return { shop: { myshopifyDomain: store.shop, currencyCode: 'USD' }, grantedScopes: [...SHOPIFY_ALLOWED_SCOPES], ...(checked.get(store.shop) ?? {}) }; },
      listCompleteProducts: async input => { calls.pages.push({ shop: store.shop, ...input }); const snapshot = snapshots.get(store.shop);
        return typeof snapshot === 'function' ? snapshot(input) : { shop: store.shop, products: structuredClone(snapshot), completeChildren: true, pageInfo: { hasNextPage: false } }; },
    });
  }
  const stores = { row: async shop => ({ ...rows.find(row => row.shop === shop) }), forShop: async shop => adapters.get(shop) };
  const service = await createProviderCatalog(db, domain, { stores });
  const sync = (shop = SHOP) => service.sync({ shop });
  return { db, domain, service, stores, rows, adapters, checked, snapshots, calls, sync,
    products: (index = 0) => domain.listProducts({ brandId: rows[index].brand_id }),
    mappings: async () => (await db.query('SELECT * FROM provider_catalog_products ORDER BY shop,source_product_id')).rows };
}

test('complete outer pages import draft products with stable source mappings and ignore provider evidence/tax claims', async t => {
  const f = await fixture(t);
  f.snapshots.set(SHOP, ({ after }) => ({ shop: SHOP, completeChildren: true,
    products: [source(after ? 4 : 3)], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'outer-next' } }));
  const result = await f.sync(); assert.equal(result.complete, true); assert.equal(result.test, true);
  assert.equal(result.sourceProductCount, 2); assert.equal(result.importedCount, 2); assert.equal(result.retiredCount, 0);
  assert.deepEqual(f.calls.pages.map(page => page.after), [null, 'outer-next']);
  const products = await f.products(); assert.equal(products.length, 2);
  assert.ok(products.every(product => product.status === 'draft' && product.description === 'Synthetic catalog description.'));
  assert.ok(products.every(product => product.category === '' && product.taxCode === '' && product.evidence.ingredients_inci.length === 0));
  const mappings = await f.mappings(); assert.equal(mappings.length, 2);
  assert.equal(new Set(mappings.map(mapping => mapping.product_id)).size, 2);
  assert.doesNotMatch(JSON.stringify(result), /evidence|description|clientSecret|access_token/);
});

test('commercial resync preserves human evidence, tax classification, review and canonical ID', async t => {
  const f = await fixture(t); await f.sync(); const initial = (await f.products())[0];
  const evidence = { ingredients_inci: ['Synthetic material — not a claim'], certifications: [], claims: [], contraindications: 'Unit review note.' };
  await f.domain.upsertProduct(initial.brandId, initial.sku, { category: 'test-fixtures', taxCode: 'HUMAN-TAX', shippingProfile: 'HUMAN-PROFILE', evidence });
  await f.domain.reviewProduct(initial.id, { status: 'approved', note: 'Human-reviewed synthetic fixture.' });
  const next = source(); next.priceCents = 125; next.variants[0].price.amount = 125; next.variants[0].inventory.qty = 3;
  f.snapshots.set(SHOP, [next]); await f.sync();
  const product = (await f.products())[0]; assert.equal(product.id, initial.id); assert.equal(product.status, 'approved');
  assert.equal(product.priceCents, 125); assert.equal(product.inventoryQty, 3);
  assert.deepEqual(product.evidence, evidence); assert.equal(product.taxCode, 'HUMAN-TAX');
  assert.equal(product.category, 'test-fixtures'); assert.equal(product.shippingProfile, 'HUMAN-PROFILE');
  assert.equal(product.reviewNote, 'Human-reviewed synthetic fixture.'); assert.equal((await f.mappings()).length, 1);
});

test('source SKU changes update the same canonical product instead of creating a duplicate or losing evidence', async t => {
  const f = await fixture(t); await f.sync(); const initial = (await f.products())[0];
  await f.domain.upsertProduct(initial.brandId, initial.sku, { evidence: { ingredients_inci: ['Human material'], claims: [] }, taxCode: 'Human tax' });
  const changed = source(); changed.sku = 'RENAMED-UNIT'; changed.variants[0].sku = changed.sku;
  f.snapshots.set(SHOP, [changed]); await f.sync(); await f.sync();
  const products = await f.products(); assert.equal(products.length, 1); assert.equal(products[0].id, initial.id);
  assert.equal(products[0].sku, 'RENAMED-UNIT'); assert.deepEqual(products[0].evidence.ingredients_inci, ['Human material']);
  assert.equal(products[0].taxCode, 'Human tax'); assert.equal((await f.mappings())[0].source_sku, 'RENAMED-UNIT');
});

test('same-brand preexisting canonical products bind only with exact compatible variant IDs', async t => {
  const f = await fixture(t), input = source();
  const existing = await f.domain.upsertProduct(f.rows[0].brand_id, input.sku, { ...input,
    description: 'Synthetic catalog description.', category: 'Human category', taxCode: 'Human tax',
    evidence: { ingredients_inci: ['Human material'], claims: [] } });
  await f.sync(); assert.equal((await f.products()).length, 1); assert.equal((await f.mappings())[0].product_id, existing.id);
  assert.equal((await f.products())[0].category, 'Human category');
});

test('a conflicting same-SKU user product rejects the entire snapshot plan before any valid product imports', async t => {
  const f = await fixture(t);
  const existing = await f.domain.upsertProduct(f.rows[0].brand_id, 'UNIT-0', { title: 'User-owned unrelated product', priceCents: 900, variants: [] });
  f.snapshots.set(SHOP, [source(9), source(0)]);
  await assert.rejects(f.sync(), { code: 'CATALOG_SKU_CONFLICT' });
  const products = await f.products(); assert.equal(products.length, 1); assert.equal(products[0].id, existing.id);
  assert.equal(products[0].priceCents, 900); assert.equal((await f.mappings()).length, 0);
});

test('completed deletion snapshots retire only mapped products and never delete user or other-brand products', async t => {
  const f = await fixture(t); f.snapshots.set(SHOP, [source(0), source(3)]); await f.sync();
  const user = await f.domain.upsertProduct(f.rows[0].brand_id, 'USER-ONLY', { title: 'Do not retire', priceCents: 200, inventoryQty: 8 });
  const other = await f.domain.upsertProduct(f.rows[1].brand_id, 'UNIT-3', { title: 'Other tenant', priceCents: 300, inventoryQty: 9 });
  f.snapshots.set(SHOP, [source(0)]); const result = await f.sync(); assert.equal(result.retiredCount, 1);
  const products = await f.products(), retired = products.find(product => product.sku === 'UNIT-3');
  assert.equal(retired.status, 'draft'); assert.equal(retired.inventoryQty, 0); assert.ok(retired.variants.every(variant => variant.inventory.qty === 0));
  assert.equal(products.find(product => product.id === user.id).inventoryQty, 8);
  assert.equal((await f.domain.getProduct(other.id)).inventoryQty, 9);
  assert.equal((await f.mappings()).find(mapping => mapping.product_id === retired.id).source_status, 'DELETED');
  assert.equal(products.length, 3); await f.sync(); assert.equal((await f.products()).length, 3);
});

test('inactive sources retire existing mappings but cannot bind or alter an unmapped canonical user product', async t => {
  const f = await fixture(t); await f.sync();
  const user = await f.domain.upsertProduct(f.rows[0].brand_id, 'UNIT-4', { title: 'User inactive collision', priceCents: 200, inventoryQty: 6 });
  const inactive = source(); inactive.sourceStatus = 'ARCHIVED'; const unbound = source(4); unbound.sourceStatus = 'DRAFT';
  f.snapshots.set(SHOP, [inactive, unbound]); const result = await f.sync();
  assert.equal(result.retiredCount, 1); assert.equal(result.importedCount, 0); assert.equal((await f.mappings()).length, 1);
  assert.equal((await f.domain.getProduct(user.id)).inventoryQty, 6);
  assert.equal((await f.products()).find(product => product.sku === 'UNIT-0').inventoryQty, 0);
});

test('incomplete, cyclic or ambiguous catalog/variant/image snapshots never mutate canonical catalog rows', async t => {
  const f = await fixture(t); await f.sync(); const prior = await f.products();
  const invalid = [];
  const noImages = source(); delete noImages.imagesPageInfo; invalid.push([noImages]);
  const partialVariants = source(); partialVariants.variantsPageInfo.hasNextPage = true; invalid.push([partialVariants]);
  const duplicateSku = source(4); duplicateSku.sku = 'UNIT-0'; duplicateSku.variants[0].sku = 'UNIT-0'; invalid.push([source(), duplicateSku]);
  const duplicateId = source(4); duplicateId.variants[0].id = duplicateId.variants[0].shopifyVariantId = source().variants[0].id; invalid.push([source(), duplicateId]);
  const wrongTenant = source(); wrongTenant.source.shop = TEST_STORES[1].shop; invalid.push([wrongTenant]);
  const wrongCurrency = source(); wrongCurrency.currency = 'CAD'; invalid.push([wrongCurrency]);
  const wrongSource = source(); wrongSource.id = 'gid://shopify/Product/9999'; invalid.push([wrongSource]);
  invalid.push([source(), source()]);
  for (const snapshot of invalid) {
    f.snapshots.set(SHOP, snapshot); await assert.rejects(f.sync()); assert.deepEqual(await f.products(), prior);
  }
  f.snapshots.set(SHOP, () => ({ shop: SHOP, products: [source()], completeChildren: true, pageInfo: { hasNextPage: true, endCursor: 'repeated' } }));
  await assert.rejects(f.sync()); assert.deepEqual(await f.products(), prior);
  f.snapshots.set(SHOP, () => ({ shop: SHOP, products: [], completeChildren: true, pageInfo: { hasNextPage: true } }));
  await assert.rejects(f.sync(), { code: 'CATALOG_PAGINATION_REQUIRED' }); assert.deepEqual(await f.products(), prior);
});

test('store identity, disconnected tenant, USD and exact scope verification fail closed before product reads', async t => {
  const f = await fixture(t);
  for (const patch of [{ shop: { myshopifyDomain: TEST_STORES[1].shop, currencyCode: 'USD' } },
    { shop: { myshopifyDomain: SHOP, currencyCode: 'CAD' } }, { grantedScopes: SHOPIFY_ALLOWED_SCOPES.slice(1) },
    { grantedScopes: [...SHOPIFY_ALLOWED_SCOPES, 'read_locations'] }, { grantedScopes: SHOPIFY_ALLOWED_SCOPES.map(() => SHOPIFY_ALLOWED_SCOPES[0]) }]) {
    f.checked.set(SHOP, patch); await assert.rejects(f.sync(), { code: 'CATALOG_SCOPE_POLICY' });
  }
  assert.equal(f.calls.pages.length, 0); assert.equal((await f.products()).length, 0);
  f.checked.clear(); f.rows[0].state = 'disconnected'; await assert.rejects(f.sync(), { code: 'CATALOG_TENANT_MISMATCH' });
  await assert.rejects(f.sync('foreign.myshopify.com'), { code: 'TEST_STORE_REQUIRED' });
});

test('syncAll uses distinct brand bindings and safe per-store failures without cross-tenant SKU collisions', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) { const input = source(index, TEST_STORES[index].shop); input.sku = input.variants[0].sku = 'SHARED-SKU'; f.snapshots.set(TEST_STORES[index].shop, [input]); }
  const results = await f.service.syncAll(); assert.ok(results.every(result => result.complete));
  assert.equal(new Set((await f.mappings()).map(mapping => mapping.brand_id)).size, 3);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM products')).rows[0].n, 3);
  f.adapters.get(TEST_STORES[1].shop).listCompleteProducts = async () => { throw new Error('PRIVATE_UPSTREAM_TOKEN_MUST_NOT_ESCAPE'); };
  const errors = await f.service.syncAll(); assert.equal(errors[1].complete, false);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_UPSTREAM_TOKEN/); assert.ok(errors[0].complete && errors[2].complete);
});

test('a concurrent same-store sync cannot interleave or infer deletions from another unfinished snapshot', async t => {
  const f = await fixture(t); let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  f.snapshots.set(SHOP, async () => { started(); await new Promise(resolve => { release = resolve; }); return { shop: SHOP, completeChildren: true, products: [source()], pageInfo: { hasNextPage: false } }; });
  const first = f.sync(); await reading;
  await assert.rejects(f.sync(), { code: 'CATALOG_SYNC_BUSY' }); assert.equal((await f.products()).length, 0);
  release(); assert.equal((await first).importedCount, 1); assert.equal((await f.products()).length, 1);
});

const rawVariant = index => ({ id: `gid://shopify/ProductVariant/${5000 + index}`, title: 'Default', sku: `RAW-${index}`, price: '1.25',
  inventoryQuantity: 5, inventoryPolicy: 'DENY', selectedOptions: [{ name: 'Title', value: 'Default Title' }],
  inventoryItem: { id: `gid://shopify/InventoryItem/${6000 + index}`, tracked: true, requiresShipping: true } });
const rawProduct = () => ({ id: 'gid://shopify/Product/7000', title: 'Complete raw fixture', descriptionHtml: '<p>Raw fixture</p>', handle: 'raw-fixture', status: 'ACTIVE',
  updatedAt: '2026-10-19T12:00:00.000Z', variants: completed([rawVariant(0)]), images: completed([{ id: 'gid://shopify/ProductImage/8000', url: 'https://example.com/raw-0.jpg' }]) });
function adapterFixture(read) {
  const calls = [], adapter = createShopifyAdapter({ env: {}, accessToken: 'UNIT_MOCK_TOKEN', useKeychain: false,
    fetch: async (_url, options) => { const input = JSON.parse(options.body); calls.push(input);
      assert.match(input.query, /^query /); assert.doesNotMatch(input.query, /locations\s*\(|publications|customer|email|shippingAddress/);
      return new Response(JSON.stringify({ data: await read(input, calls.length) }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  return { adapter, calls };
}

test('complete Shopify reader exhausts independent variant/image cursors and retains every child without writes', async () => {
  const initial = rawProduct(); initial.variants.pageInfo = { hasNextPage: true, endCursor: 'variant-1' }; initial.images.pageInfo = { hasNextPage: true, endCursor: 'image-1' };
  const f = adapterFixture((input, count) => {
    if (count === 1) return { shop: { currencyCode: 'USD' }, products: completed([initial]) };
    assert.equal(input.variables.id, initial.id);
    if (count === 2) {
      assert.equal(input.variables.variantAfter, 'variant-1'); assert.equal(input.variables.imageAfter, 'image-1');
      return { shop: { currencyCode: 'USD' }, product: { id: initial.id, updatedAt: initial.updatedAt, variants: completed([rawVariant(1)]),
        images: { nodes: [{ id: 'gid://shopify/ProductImage/8001', url: 'https://example.com/raw-1.jpg' }], pageInfo: { hasNextPage: true, endCursor: 'image-2' } } } };
    }
    assert.equal(input.variables.withVariants, false); assert.equal(input.variables.withImages, true); assert.equal(input.variables.imageAfter, 'image-2');
    return { shop: { currencyCode: 'USD' }, product: { id: initial.id, updatedAt: initial.updatedAt,
      images: completed([{ id: 'gid://shopify/ProductImage/8002', url: 'https://example.com/raw-2.jpg' }]) } };
  });
  const result = await f.adapter.listCompleteProducts({ first: 25 }); assert.equal(result.completeChildren, true); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].variables.first, 10); assert.equal(result.products[0].variants.length, 2); assert.equal(result.products[0].images.length, 3);
  assert.deepEqual(result.products[0].variantsPageInfo, { hasNextPage: false }); assert.deepEqual(result.products[0].imagesPageInfo, { hasNextPage: false });
  assert.equal(result.products[0].inventoryQty, 10); assert.equal(result.products[0].source.productId, initial.id);
});

test('complete Shopify reader rejects cursor stalls, changed product timestamps, duplicate children and incomplete page flags', async () => {
  for (const mode of ['cursor', 'changed', 'duplicate', 'missing']) {
    const initial = rawProduct(); initial.variants.pageInfo = { hasNextPage: true, endCursor: 'variant-1' };
    const f = adapterFixture((_input, count) => {
      if (count === 1) return { shop: { currencyCode: 'USD' }, products: completed([initial]) };
      const variants = completed([rawVariant(mode === 'duplicate' ? 0 : 1)]);
      if (mode === 'cursor') variants.pageInfo = { hasNextPage: true, endCursor: 'variant-1' };
      if (mode === 'missing') delete variants.pageInfo;
      return { shop: { currencyCode: 'USD' }, product: { id: initial.id,
        updatedAt: mode === 'changed' ? '2026-10-19T12:01:00.000Z' : initial.updatedAt, variants } };
    });
    await assert.rejects(f.adapter.listCompleteProducts(), { code: 'SHOPIFY_CATALOG_INCOMPLETE' }); assert.ok(f.calls.length <= 2);
  }
});

test('complete Shopify reader keeps untracked/negative stock conservative and never invents availability', async () => {
  const initial = rawProduct(); initial.variants.nodes[0].inventoryItem.tracked = false; initial.variants.nodes[0].inventoryQuantity = 99;
  const f = adapterFixture(() => ({ shop: { currencyCode: 'USD' }, products: completed([initial]) }));
  const result = await f.adapter.listCompleteProducts(); assert.equal(result.products[0].inventoryQty, 0); assert.equal(result.products[0].variants[0].inventory.qty, 0);
  initial.variants.nodes[0].inventoryItem.tracked = true; initial.variants.nodes[0].inventoryQuantity = -4;
  assert.equal((await f.adapter.listCompleteProducts()).products[0].inventoryQty, 0);
});
