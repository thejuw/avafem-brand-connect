import { randomUUID } from 'node:crypto';
import { TEST_STORES } from './test-stores.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from './integrations/shopify-policy.mjs';

const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const gid = (value, type) => new RegExp(`^gid://shopify/${type}/\\d+$`).test(value ?? '');
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const key = variant => variant.shopifyVariantId ?? variant.id;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const zeroVariants = variants => variants.map(variant => ({ ...variant, inventory: { ...variant.inventory, qty: 0 } }));
const ids = variants => variants.map(key).sort();
const compatible = (canonical, source) => Array.isArray(canonical.variants) && canonical.variants.length > 0
  && canonical.variants.every(variant => gid(key(variant), 'ProductVariant'))
  && JSON.stringify(ids(canonical.variants)) === JSON.stringify(ids(source.variants));

/** Complete authoritative catalog pulls for the three explicit test bindings.
 * No provider write occurs here. Human evidence/tax/category/shipping/review data
 * belongs to the domain and is never replaced by empty provider metadata.
 * Stable product GIDs, not mutable SKUs, identify imported products.
 */
export async function createProviderCatalog(db, domain, { stores } = {}) {
  if (!db?.transaction || !domain?.upsertProduct || !stores?.row || !stores?.forShop)
    fail('PROVIDER_CATALOG_SETUP', 'Bound stores, database and canonical domain are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_catalog_products (
    shop TEXT NOT NULL,source_product_id TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),
    product_id TEXT UNIQUE NOT NULL REFERENCES products(id),source_sku TEXT NOT NULL,
    source_status TEXT NOT NULL,last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),retired_at TIMESTAMPTZ,
    PRIMARY KEY(shop,source_product_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_catalog_locks (
    shop TEXT PRIMARY KEY,token TEXT NOT NULL,lease_until TIMESTAMPTZ NOT NULL
  )`);
  async function assertExternalCatalog(tx,brandId) {
    if(!(await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId])).rows.length)
      fail('CATALOG_TENANT_MISMATCH','The catalog brand no longer exists.');
    if(!(await tx.query("SELECT to_regclass('commerce_brand_policy_versions') AS relation")).rows[0]?.relation)return;
    const config=(await tx.query('SELECT config FROM commerce_brand_policy_versions WHERE brand_id=$1 ORDER BY version DESC LIMIT 1',[brandId])).rows[0]?.config;
    if(config?.model==='first_party'||config?.inventoryAuthority==='native')
      fail('COMMERCE_WORKFLOW_REQUIRED','The native first-party catalog cannot be replaced by an external provider snapshot.');
  }

  function validateProduct(product, shop, seen) {
    const sourceId = product?.source?.productId;
    if (!gid(sourceId, 'Product') || product.source?.provider !== 'shopify' || product.source.shop !== shop
      || (product.id && product.id !== sourceId) || (product.brandProductId && product.brandProductId !== sourceId)
      || seen.products.has(sourceId)) fail('CATALOG_SOURCE_AMBIGUOUS', 'Each source product must have one exact store-bound Shopify product ID.');
    seen.products.add(sourceId);
    if (!['ACTIVE','DRAFT','ARCHIVED'].includes(product.sourceStatus) || product.currency !== 'USD'
      || !text(product.sku, 120) || !text(product.title, 250) || typeof product.description !== 'string'
      || !integer(product.priceCents) || !Array.isArray(product.variants) || !product.variants.length
      || product.variants.length > 2500 || product.variantsPageInfo?.hasNextPage !== false
      || !Array.isArray(product.images) || product.images.length > 2500 || product.imagesPageInfo?.hasNextPage !== false)
      fail('CATALOG_SNAPSHOT_INVALID', 'USD product identity, bounded fields and complete variant/image connections are required.');
    for (const image of product.images) {
      let url; try { url = new URL(image); } catch { /* fail below */ }
      if (!url || url.protocol !== 'https:' || url.username || url.password || String(image).length > 2000)
        fail('CATALOG_SNAPSHOT_INVALID', 'Catalog images must be bounded HTTPS URLs.');
    }
    for (const variant of product.variants) {
      const variantId = key(variant);
      if (!gid(variantId, 'ProductVariant') || (variant.id && variant.id !== variantId)
        || seen.variants.has(variantId) || !text(variant.sku, 120) || seen.skus.has(variant.sku)
        || variant.price?.currency !== 'USD' || !integer(variant.price.amount)
        || !integer(variant.inventory?.qty) || variant.inventory.qty > 1_000_000
        || !['deny','continue'].includes(variant.inventory.policy) || typeof variant.tracked !== 'boolean'
        || typeof variant.requiresShipping !== 'boolean') fail('CATALOG_SOURCE_AMBIGUOUS', 'Unique variant IDs/SKUs and exact USD price/inventory fields are required.');
      seen.variants.add(variantId); seen.skus.add(variant.sku);
    }
    if (product.sku !== product.variants[0].sku || product.priceCents !== product.variants[0].price.amount)
      fail('CATALOG_SOURCE_AMBIGUOUS', 'The canonical SKU and price must match the first complete source variant.');
    const variants = product.variants.map(variant => ({ ...variant,
      inventory: { ...variant.inventory, qty: variant.tracked ? variant.inventory.qty : 0 } }));
    const inventoryQty = variants.reduce((sum, variant) => sum + variant.inventory.qty, 0);
    if (inventoryQty > 1_000_000) fail('CATALOG_SNAPSHOT_INVALID', 'Product stock exceeds the bounded canonical inventory limit.');
    return { sourceId, product: { ...product, sku: product.sku.trim(), title: product.title.trim(),
      description: product.description.replace(/<[^>]*>/g, '').slice(0, 12000), variants, inventoryQty } };
  }
  async function binding(shop) {
    if (!TEST_STORES.some(store => store.shop === shop)) fail('TEST_STORE_REQUIRED', 'Only the three explicitly authorized test stores may sync.', 422);
    const row = await stores.row(shop);
    if (!row || row.shop !== shop || !row.brand_id || row.state === 'disconnected')
      fail('CATALOG_TENANT_MISMATCH', 'A connected immutable store-to-brand binding is required.');
    await db.transaction(tx=>assertExternalCatalog(tx,row.brand_id));
    const brand = await domain.getBrand(row.brand_id);
    if (brand.id !== row.brand_id || brand.status === 'disconnected') fail('CATALOG_TENANT_MISMATCH', 'The canonical brand is disconnected or mismatched.');
    return row;
  }
  async function sync({ shop } = {}) {
    const registry = await binding(shop), token = randomUUID();
    const claim = await db.query(`INSERT INTO provider_catalog_locks(shop,token,lease_until) VALUES($1,$2,now()+interval '10 minutes')
      ON CONFLICT(shop) DO UPDATE SET token=$2,lease_until=now()+interval '10 minutes'
      WHERE provider_catalog_locks.lease_until<now() RETURNING token`, [shop, token]);
    if (!claim.rows.length) fail('CATALOG_SYNC_BUSY', 'This store already has a catalog snapshot in progress.');
    const hold = async () => {
      const current = await binding(shop);
      if (current.brand_id !== registry.brand_id) fail('CATALOG_TENANT_MISMATCH', 'The store binding changed during catalog synchronization.');
      const locked = await db.query(`UPDATE provider_catalog_locks SET lease_until=now()+interval '10 minutes'
        WHERE shop=$1 AND token=$2 AND lease_until>now() RETURNING token`, [shop, token]);
      if (!locked.rows.length) fail('CATALOG_SYNC_BUSY', 'The catalog lease expired; restart with a new complete snapshot.');
    };
    try {
      const adapter = await stores.forShop(shop);
      if (adapter?.shop !== shop || typeof adapter.listCompleteProducts !== 'function')
        fail('CATALOG_COMPLETE_READER_REQUIRED', 'Use this exact store’s complete variant/image catalog reader.');
      const checked = await adapter.preflight();
      if (checked?.shop?.myshopifyDomain !== shop || checked.shop.currencyCode !== 'USD'
        || !Array.isArray(checked.grantedScopes) || checked.grantedScopes.length !== SHOPIFY_ALLOWED_SCOPES.length
        || new Set(checked.grantedScopes).size !== SHOPIFY_ALLOWED_SCOPES.length
        || SHOPIFY_ALLOWED_SCOPES.some(scope => !checked.grantedScopes.includes(scope)))
        fail('CATALOG_SCOPE_POLICY', 'The exact store, USD currency and all fifteen approved scopes must verify.');
      const snapshot = [], cursors = new Set(), seen = { products: new Set(), variants: new Set(), skus: new Set() };
      let after = null, complete = false;
      for (let page = 0; page < 100; page++) {
        await hold();
        const result = await adapter.listCompleteProducts({ first: 10, after });
        if (result?.shop !== shop || result.completeChildren !== true || !Array.isArray(result.products)
          || typeof result.pageInfo?.hasNextPage !== 'boolean' || result.products.length > 10)
          fail('CATALOG_PAGINATION_REQUIRED', 'Complete, store-bound product and child pagination is required before any catalog writes.');
        for (const product of result.products) snapshot.push(validateProduct(product, shop, seen));
        if (!result.pageInfo.hasNextPage) { complete = true; break; }
        const cursor = result.pageInfo.endCursor;
        if (!result.products.length || typeof cursor !== 'string' || !cursor || cursors.has(cursor))
          fail('CATALOG_PAGINATION_REQUIRED', 'Catalog pagination did not make bounded forward progress.');
        cursors.add(cursor); after = cursor;
      }
      if (!complete) fail('CATALOG_LIMIT', 'Catalog exceeds 100 pages of ten products; no catalog changes were applied.');

      // Plan every binding/collision before the first product mutation. Never
      // attach a same-SKU user product unless its exact variant IDs prove identity.
      const canonical = await domain.listProducts({ brandId: registry.brand_id });
      const byId = new Map(canonical.map(product => [product.id, product]));
      const bySku = new Map(canonical.map(product => [product.sku, product]));
      const mappings = (await db.query('SELECT * FROM provider_catalog_products WHERE shop=$1', [shop])).rows;
      const plans = [];
      for (const source of snapshot) {
        const mapping = mappings.find(item => item.source_product_id === source.sourceId);
        if (mapping && (mapping.brand_id !== registry.brand_id || !byId.has(mapping.product_id)))
          fail('CATALOG_TENANT_MISMATCH', 'A source mapping points outside this store’s canonical brand.');
        const prior = mapping ? byId.get(mapping.product_id) : bySku.get(source.product.sku);
        if (!mapping && source.product.sourceStatus !== 'ACTIVE') continue;
        if (!mapping && prior && !compatible(prior, source.product))
          fail('CATALOG_SKU_CONFLICT', 'An unbound canonical SKU does not have the exact source variant IDs; preserve it for human review.');
        const collision = bySku.get(source.product.sku);
        if (collision && prior?.id !== collision.id) fail('CATALOG_SKU_CONFLICT', 'An SKU rename would overwrite a different canonical product.');
        if (prior) {
          const other = (await db.query('SELECT shop,source_product_id FROM provider_catalog_products WHERE product_id=$1', [prior.id])).rows[0];
          if (other && (other.shop !== shop || other.source_product_id !== source.sourceId))
            fail('CATALOG_SOURCE_AMBIGUOUS', 'A canonical product already belongs to another source identity.');
        }
        plans.push({ ...source, mapping, prior });
      }
      const deleted = mappings.filter(mapping => !seen.products.has(mapping.source_product_id));
      for (const mapping of deleted) if (mapping.brand_id !== registry.brand_id || !byId.has(mapping.product_id))
        fail('CATALOG_TENANT_MISMATCH', 'A missing source maps to another tenant or missing canonical product.');

      let importedCount = 0, retiredCount = 0; const products = [];
      const retire = async (prior, sourceId, sourceStatus) => {
        const retired = await domain.upsertProduct(registry.brand_id, prior.sku, { inventoryQty: 0, variants: zeroVariants(prior.variants) },
          {beforeUpsert:tx=>assertExternalCatalog(tx,registry.brand_id)});
        await db.transaction(async tx => {
          await assertExternalCatalog(tx,registry.brand_id);
          await tx.query("UPDATE products SET status='draft',review_note='Source inactive or deleted; unavailable until source restoration and human review.',updated_at=now() WHERE id=$1 AND brand_id=$2", [prior.id, registry.brand_id]);
          await tx.query(`UPDATE provider_catalog_products SET source_status=$3,retired_at=COALESCE(retired_at,now()),last_seen_at=now()
            WHERE shop=$1 AND source_product_id=$2`, [shop, sourceId, sourceStatus]);
        });
        retiredCount++; products.push({ id: retired.id, sourceProductId: sourceId, sku: retired.sku, status: 'draft' });
      };
      for (const plan of plans) {
        await hold();
        if (plan.product.sourceStatus !== 'ACTIVE') { await retire(plan.prior, plan.sourceId, plan.product.sourceStatus); continue; }
        if (plan.prior && plan.prior.sku !== plan.product.sku) {
          // Rename the same canonical row first so upsertProduct preserves its
          // evidence/tax/review metadata rather than creating an SKU duplicate.
          await db.transaction(async tx=>{
            await assertExternalCatalog(tx,registry.brand_id);
            await tx.query('UPDATE products SET sku=$3 WHERE id=$1 AND brand_id=$2', [plan.prior.id, registry.brand_id, plan.product.sku]);
          });
        }
        const product = await domain.upsertProduct(registry.brand_id, plan.product.sku, {
          title: plan.product.title, description: plan.product.description, priceCents: plan.product.priceCents,
          inventoryQty: plan.product.inventoryQty, images: plan.product.images, variants: plan.product.variants,
        },{beforeUpsert:tx=>assertExternalCatalog(tx,registry.brand_id)});
        if (plan.prior && product.id !== plan.prior.id) fail('CATALOG_SOURCE_AMBIGUOUS', 'The canonical product identity changed unexpectedly.');
        await db.transaction(async tx=>{
          await assertExternalCatalog(tx,registry.brand_id);
          await tx.query(`INSERT INTO provider_catalog_products(shop,source_product_id,brand_id,product_id,source_sku,source_status)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(shop,source_product_id) DO UPDATE SET
          source_sku=$5,source_status=$6,last_seen_at=now(),retired_at=NULL`,
        [shop, plan.sourceId, registry.brand_id, product.id, plan.product.sku, plan.product.sourceStatus]);
        });
        importedCount++; products.push({ id: product.id, sourceProductId: plan.sourceId, sku: product.sku, status: product.status });
      }
      for (const mapping of deleted) { await hold(); await retire(byId.get(mapping.product_id), mapping.source_product_id, 'DELETED'); }
      return { test: true, shop, brandId: registry.brand_id, complete: true, sourceProductCount: snapshot.length,
        importedCount, retiredCount, products, limits: { productPages: 100, productsPerPage: 10, childPagesPerProduct: 100, childrenPerPage: 25 },
        warning: 'Authoritative provider catalog pull only; human review is not automatic approval and no provider product was modified.' };
    } finally { await db.query('DELETE FROM provider_catalog_locks WHERE shop=$1 AND token=$2', [shop, token]); }
  }
  async function syncAll() {
    const results = [];
    for (const store of TEST_STORES) {
      try { results.push(await sync({ shop: store.shop })); }
      catch (cause) { results.push({ test: true, shop: store.shop, complete: false, error: {
        code: typeof cause?.code === 'string' && /^[A-Z_]{1,80}$/.test(cause.code) ? cause.code : 'CATALOG_SYNC_FAILED',
        message: 'Catalog synchronization is blocked; no incomplete snapshot was used to infer deletions.' } }); }
    }
    return results;
  }
  return { sync, syncAll };
}
