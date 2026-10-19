import { createHash, randomUUID } from 'node:crypto';
import { SHOPIFY_ALLOWED_SCOPES } from './integrations/shopify-policy.mjs';

export const FAILURE_FIXTURES = Object.freeze([
  ['i4vd1u-s8.myshopify.com', '002', 100], ['qpsd02-jz.myshopify.com', '004', 200], ['ir7112-v1.myshopify.com', '006', 300],
].map(([shop, number, priceCents]) => Object.freeze({ shop, number, priceCents,
  handle: `avafem-failure-test-${number}-do-not-ship`, sku: `AVF-CONNECT-TEST-FAIL-${number}`,
  title: `Avafem Failure Test ${number} — DO NOT SHIP`, vendor: 'Avafem Test',
  description: 'DISPOSABLE TEST ONLY. Avafem failure fixture. DO NOT SHIP. Not for customer purchase.',
  tags: Object.freeze(['TEST_DO_NOT_SHIP', 'avafem-failure-fixture', 'avafem-disposable-fixture', `avafem-failure-${number}`]),
})));
const fields = `id title description handle vendor tags status isGiftCard requiresSellingPlan
  variants(first:2) { pageInfo { hasNextPage } nodes { id title sku price inventoryQuantity inventoryPolicy selectedOptions { name value }
    inventoryItem { id sku tracked requiresShipping inventoryLevels(first:2) { pageInfo { hasNextPage } nodes {
      location { id } quantities(names:["available"]) { name quantity }
    } } } } }`;
export const FAILURE_FIXTURE_QUERIES = Object.freeze({
  AvafemFailureFixture: `query AvafemFailureFixture($identifier:ProductIdentifierInput!) { productByIdentifier(identifier:$identifier) { ${fields} } }`,
  AvafemFailureById: `query AvafemFailureById($id:ID!) { product(id:$id) { ${fields} } }`,
  AvafemFailureLocations: `query AvafemFailureLocations($after:String) { productVariants(first:25,after:$after) { pageInfo { hasNextPage endCursor }
    nodes { inventoryItem { inventoryLevels(first:10) { nodes { location { id } } } } } } }`,
  AvafemFailureCreate: `mutation AvafemFailureCreate($input:ProductSetInput!) { productSet(input:$input,synchronous:true) { product { id } userErrors { code field } } }`,
  AvafemFailurePrice: `mutation AvafemFailurePrice($productId:ID!,$variants:[ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false) { product { id } productVariants { id price } userErrors { code field } } }`,
  AvafemFailureStatus: `mutation AvafemFailureStatus($product:ProductUpdateInput!) { productUpdate(product:$product) { product { id status } userErrors { field message } } }`,
  AvafemFailureDelete: `mutation AvafemFailureDelete($input:ProductDeleteInput!) { productDelete(input:$input,synchronous:true) { deletedProductId userErrors { field message } } }`,
  // 2026-10 input schema uses changeFromQuantity, NOT obsolete compareQuantity.
  // https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryQuantityInput
  AvafemFailureStock: `mutation AvafemFailureStock($input:InventorySetQuantitiesInput!,$idempotencyKey:String!) {
    inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey) {
      inventoryAdjustmentGroup { createdAt reason referenceDocumentUri changes { name delta } } userErrors { code field }
    } }`,
});
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const gid = (value, kind) => typeof value === 'string' && new RegExp(`^gid://shopify/${kind}/[0-9]{1,40}$`).test(value);
export const failureFixtureFor = shop => {
  const fixture = FAILURE_FIXTURES.find(value => value.shop === shop);
  if (!fixture) fail('FAILURE_FIXTURE_STORE_REQUIRED', 'Only the three exact approved test stores are allowed.', 422);
  return fixture;
};
export function failureFixtureCreateInput(fixture, locationId) {
  return { handle: fixture.handle, title: fixture.title, descriptionHtml: `<p>${fixture.description}</p>`, vendor: fixture.vendor,
    tags: [...fixture.tags], status: 'ACTIVE', giftCard: false, requiresSellingPlan: false,
    productOptions: [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }],
    variants: [{ price: (fixture.priceCents / 100).toFixed(2), inventoryPolicy: 'DENY', taxable: true,
      optionValues: [{ optionName: 'Title', name: 'Default Title' }], inventoryItem: { sku: fixture.sku, tracked: true, requiresShipping: true },
      inventoryQuantities: [{ locationId, name: 'available', quantity: 10 }] }],
  };
}
export function failureFixtureSnapshot(product, fixture) {
  const variant = product?.variants?.nodes?.[0], inventory = variant?.inventoryItem;
  const levels = inventory?.inventoryLevels, level = levels?.nodes?.[0];
  const available = level?.quantities?.find(value => value.name === 'available')?.quantity;
  const parts = typeof variant?.price === 'string' && /^\d+(?:\.\d{1,2})?$/.test(variant.price) ? variant.price.split('.') : null;
  const price = parts ? Number(parts[0]) * 100 + Number((parts[1] ?? '').padEnd(2, '0')) : NaN;
  if (!gid(product?.id, 'Product') || product.handle !== fixture.handle || product.title !== fixture.title || product.vendor !== fixture.vendor
    || product.description !== fixture.description || !fixture.tags.every(tag => product.tags?.includes(tag))
    || product.isGiftCard !== false || product.requiresSellingPlan !== false || !['ACTIVE', 'ARCHIVED'].includes(product.status)
    || product.variants?.pageInfo?.hasNextPage !== false || product.variants.nodes.length !== 1 || !gid(variant?.id, 'ProductVariant')
    || variant.sku !== fixture.sku || variant.title !== 'Default Title' || variant.selectedOptions?.length !== 1
    || variant.selectedOptions[0].name !== 'Title' || variant.selectedOptions[0].value !== 'Default Title'
    || ![fixture.priceCents, fixture.priceCents + 1].includes(price) || variant.inventoryPolicy !== 'DENY'
    || !gid(inventory?.id, 'InventoryItem') || inventory.sku !== fixture.sku || inventory.tracked !== true || inventory.requiresShipping !== true
    || levels?.pageInfo?.hasNextPage !== false || levels.nodes.length !== 1 || !gid(level?.location?.id, 'Location')
    || !Number.isSafeInteger(available) || available < 0 || available > 10 || variant.inventoryQuantity !== available)
    fail('FAILURE_FIXTURE_OWNERSHIP_MISMATCH', 'The exact disposable fixture identity or bounded native configuration does not verify. Nothing was overwritten.');
  return { productId: product.id, variantId: variant.id, inventoryItemId: inventory.id, locationId: level.location.id,
    priceCents: price, inventoryQty: available, status: product.status, sku: fixture.sku, handle: fixture.handle };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = value => { const bytes = createHash('sha256').update(value).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; };
const cleanInput = (value, keys) => { if (!value || Object.keys(value).some(key => !keys.includes(key))) fail('FAILURE_FIXTURE_INPUT', 'Only the fixed test operation fields are accepted.', 422); };

/** Dedicated disposable products only, never completed-run products or orders.
 * Every phase has a durable encrypted intent before its ONE provider mutation.
 * Repeated/uncertain calls only inspect, never blindly recreate or reset stock.
 * Each fixed scenario is one cycle per store; restoration is separately explicit.
 */
export async function createProviderFailureFixtures(db, auth, { stores, clock = () => new Date(), canDelete = async () => false } = {}) {
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !stores?.row || !stores?.forShop || typeof canDelete !== 'function') fail('FAILURE_FIXTURE_SETUP', 'Encrypted storage and exact-store adapters are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_failure_fixtures (
    shop TEXT PRIMARY KEY,brand_id TEXT NOT NULL,state TEXT NOT NULL,baseline_encrypted TEXT,details_encrypted TEXT NOT NULL,
    lock_token TEXT,lease_until TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const now = () => { const value = new Date(clock()); if (!Number.isFinite(value.getTime())) fail('FAILURE_FIXTURE_CLOCK', 'A valid wall clock is required.'); return value; };
  async function adapterFor(fixture) {
    const row = await stores.row(fixture.shop);
    if (!row?.brand_id || row.shop !== fixture.shop || row.state === 'disconnected') fail('FAILURE_FIXTURE_BINDING', 'An active exact brand/store binding is required.');
    const adapter = await stores.forShop(fixture.shop), checked = await adapter.preflight();
    if (adapter.shop !== fixture.shop || typeof adapter.failureFixtureGraphql !== 'function' || checked.verified !== true || checked.connected !== true
      || checked.shop?.myshopifyDomain !== fixture.shop || checked.shop.currencyCode !== 'USD' || !Array.isArray(checked.grantedScopes)
      || checked.grantedScopes.length !== SHOPIFY_ALLOWED_SCOPES.length || new Set(checked.grantedScopes).size !== SHOPIFY_ALLOWED_SCOPES.length
      || SHOPIFY_ALLOWED_SCOPES.some(scope => !checked.grantedScopes.includes(scope))) fail('FAILURE_FIXTURE_PREFLIGHT', 'Exact test-store identity, USD and all fifteen approved scopes must verify.');
    return { adapter, registry: row };
  }
  const rowFor = async shop => (await db.query('SELECT * FROM provider_failure_fixtures WHERE shop=$1', [shop])).rows[0];
  const lookup = async (adapter, fixture) => {
    const result = await adapter.failureFixtureGraphql('AvafemFailureFixture', { identifier: { handle: fixture.handle } });
    if (!result || !Object.hasOwn(result, 'productByIdentifier')) fail('FAILURE_FIXTURE_READ', 'The exact native handle lookup did not complete.');
    return result.productByIdentifier;
  };
  const readById = async (adapter, productId) => {
    const result = await adapter.failureFixtureGraphql('AvafemFailureById', { id: productId });
    if (!result || !Object.hasOwn(result, 'product') || (result.product !== null && result.product?.id !== productId)) fail('FAILURE_FIXTURE_READ', 'Original product-GID deletion readback did not verify.');
    return result.product;
  };
  const decode = row => ({ details: auth.decrypt(row.details_encrypted), baseline: row.baseline_encrypted ? auth.decrypt(row.baseline_encrypted) : null });
  const summary = (fixture, row, current, writes = 0) => {
    const decoded = row ? decode(row) : { details: {}, baseline: null };
    return { shop: fixture.shop, test: true, state: row?.state ?? 'unprepared', fixture: current,
      baselineCaptured: Boolean(decoded.baseline), baseline: decoded.baseline,
      cleanupRequired: Boolean(decoded.details.activeScenario || decoded.details.createUncertain || (decoded.details.createStartedAt && !decoded.baseline)
        || (decoded.details.deleteStartedAt && !decoded.details.deletedAt)),
      deleted: Boolean(decoded.details.deletedAt), deletionAttempted: Boolean(decoded.details.deleteStartedAt),
      activeScenario: decoded.details.ops?.[decoded.details.activeScenario]?.scenario ?? null,
      phase: decoded.details.ops?.[decoded.details.activeScenario]?.phase ?? decoded.details.lastPhase ?? 'catalog',
      completedScenarios: Object.keys(decoded.details.ops ?? {}).filter(key => decoded.details.ops[key].restored === true),
      providerWrites: writes, publicationVerified: false, manualPublicationCheckRequired: true, disposable: true,
      warning: 'Dedicated synthetic fixture only. Verify zero Shopify sales-channel publications manually. No order, payment or publication API is called. Cleanup is permanent, separately server-authorized and only for this disposable product.' };
  };
  async function inspect(input = {}) {
    cleanInput(input, ['shop','phase']); if (input.phase !== undefined && !['catalog','checkout'].includes(input.phase)) fail('FAILURE_FIXTURE_INPUT', 'Only the fixed catalog/checkout phases are allowed.', 422);
    const fixture = failureFixtureFor(input.shop), { adapter, registry } = await adapterFor(fixture), row = await rowFor(fixture.shop);
    if (row && row.brand_id !== registry.brand_id) fail('FAILURE_FIXTURE_BINDING', 'The original fixture brand binding cannot change.');
    const decoded = row ? decode(row) : null;
    const product = decoded?.details.deleteStartedAt ? await readById(adapter, decoded.baseline.productId) : await lookup(adapter, fixture);
    const current = product ? failureFixtureSnapshot(product, fixture) : null;
    if (decoded?.details.deleteStartedAt) {
      if (current && (decoded.details.deletedAt || !sameIdentity(current, decoded.baseline))) fail('FAILURE_FIXTURE_DELETION_CHANGED', 'The original deletion proof no longer matches its immutable target.');
      return summary(fixture, row, current);
    }
    if (row && decode(row).baseline) {
      const state = decode(row);
      if (!current || !sameIdentity(current, state.baseline)) fail('FAILURE_FIXTURE_IDENTITY_CHANGED', 'The original disposable product identity cannot change.');
      if (!state.details.activeScenario && !equal(current, state.baseline)) fail('FAILURE_FIXTURE_DRIFT', 'An unowned native change cannot be reported as a restored baseline.');
    }
    return summary(fixture, row, current);
  }
  function sameIdentity(a, b) { return ['productId','variantId','inventoryItemId','locationId','sku','handle'].every(key => a[key] === b[key]); }
  async function locked(input, action) {
    const fixture = failureFixtureFor(input.shop), { adapter, registry } = await adapterFor(fixture), token = randomUUID();
    await db.query(`INSERT INTO provider_failure_fixtures(shop,brand_id,state,details_encrypted) VALUES($1,$2,'unprepared',$3) ON CONFLICT DO NOTHING`,
      [fixture.shop, registry.brand_id, auth.encrypt({ ops: {} })]);
    const row = (await db.query(`UPDATE provider_failure_fixtures SET lock_token=$2,lease_until=$3 WHERE shop=$1
      AND (lock_token IS NULL OR lease_until<$4) RETURNING *`, [fixture.shop, token, new Date(now().getTime() + 240_000), now()])).rows[0];
    if (!row) fail('FAILURE_FIXTURE_BUSY', 'This fixture is already being processed.');
    try {
      if (row.brand_id !== registry.brand_id) fail('FAILURE_FIXTURE_BINDING', 'The original fixture brand binding cannot change.');
      const state = decode(row);
      const save = async value => {
        row.state = value;
        const saved = await db.query(`UPDATE provider_failure_fixtures SET state=$3,baseline_encrypted=$4,details_encrypted=$5,updated_at=$6
          WHERE shop=$1 AND lock_token=$2 AND lease_until>$6 RETURNING shop`, [fixture.shop, token, value,
          state.baseline ? auth.encrypt(state.baseline) : null, auth.encrypt(state.details), now()]);
        if (!saved.rows.length) fail('FAILURE_FIXTURE_LEASE_LOST', 'The fixture lease expired; reconcile its existing intent.');
        row.baseline_encrypted = state.baseline ? auth.encrypt(state.baseline) : null; row.details_encrypted = auth.encrypt(state.details);
      };
      return await action({ fixture, adapter, row, ...state, save, setBaseline: value => { state.baseline = value; } });
    } finally { await db.query('UPDATE provider_failure_fixtures SET lock_token=NULL,lease_until=NULL WHERE shop=$1 AND lock_token=$2', [fixture.shop, token]); }
  }
  async function discoverLocation(adapter) {
    let after = null; const seen = new Set();
    for (let index = 0; index < 20; index++) {
      const variants = (await adapter.failureFixtureGraphql('AvafemFailureLocations', { after }))?.productVariants;
      if (!Array.isArray(variants?.nodes)) break;
      for (const variant of variants.nodes) for (const level of variant.inventoryItem?.inventoryLevels?.nodes ?? []) if (gid(level.location?.id, 'Location')) return level.location.id;
      if (variants.pageInfo?.hasNextPage === false) break;
      const cursor = variants.pageInfo?.endCursor; if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) break; seen.add(cursor); after = cursor;
    }
    fail('FAILURE_FIXTURE_LOCATION', 'A native existing inventory location is required; no extra location scope or invented ID is used.');
  }
  async function prepare(input = {}) {
    cleanInput(input, ['shop','confirmTest']); if (input.confirmTest !== true) fail('TEST_CONFIRMATION_REQUIRED', 'Explicit test confirmation is required.', 422);
    return locked(input, async ctx => {
      if (ctx.details.deleteStartedAt) fail('FAILURE_FIXTURE_TOMBSTONE', 'Deletion has a durable tombstone; this fixture cannot be recreated.');
      let product = await lookup(ctx.adapter, ctx.fixture);
      if (ctx.baseline) { const current = product ? failureFixtureSnapshot(product, ctx.fixture) : null;
        if (!current || !sameIdentity(current, ctx.baseline)) fail('FAILURE_FIXTURE_IDENTITY_CHANGED', 'The original disposable product is unavailable; no replacement is created.');
        if (!ctx.details.activeScenario && !equal(current, ctx.baseline)) fail('FAILURE_FIXTURE_DRIFT', 'An unrelated native change is not a clean prepared baseline.');
        return summary(ctx.fixture, ctx.row, current); }
      if (product && !ctx.details.createStartedAt) fail('FAILURE_FIXTURE_UNCLAIMED', 'An existing handle has no durable create provenance; it will not be adopted or overwritten.');
      if (!product && ctx.details.createStartedAt) { ctx.details.createUncertain = true; await ctx.save('creation_uncertain'); return summary(ctx.fixture, ctx.row, null); }
      let writes = 0;
      if (!product) {
        const locationId = await discoverLocation(ctx.adapter);
        if (await lookup(ctx.adapter, ctx.fixture)) fail('FAILURE_FIXTURE_UNCLAIMED', 'A product appeared before creation; nothing was overwritten.');
        ctx.details.creationBaseline = { absent: true, locationId, input: failureFixtureCreateInput(ctx.fixture, locationId) };
        ctx.details.createStartedAt = now().toISOString(); await ctx.save('creating'); writes++;
        try { const result = await ctx.adapter.failureFixtureGraphql('AvafemFailureCreate', { input: ctx.details.creationBaseline.input });
          if (!gid(result?.productSet?.product?.id, 'Product') || !Array.isArray(result.productSet.userErrors) || result.productSet.userErrors.length) throw new Error();
          ctx.details.createdProductId = result.productSet.product.id; await ctx.save('creation_readback');
        } catch { ctx.details.createUncertain = true; await ctx.save('creation_uncertain'); return summary(ctx.fixture, ctx.row, null, writes); }
        product = await lookup(ctx.adapter, ctx.fixture);
      }
      const current = failureFixtureSnapshot(product, ctx.fixture);
      if ((ctx.details.createdProductId && current.productId !== ctx.details.createdProductId) || current.priceCents !== ctx.fixture.priceCents
        || current.inventoryQty !== 10 || current.status !== 'ACTIVE') fail('FAILURE_FIXTURE_BASELINE', 'The created native baseline does not match the fixed fixture plan.');
      ctx.setBaseline(current); ctx.details.createUncertain = false; ctx.details.createdProductId = current.productId; await ctx.save('prepared');
      return summary(ctx.fixture, ctx.row, current, writes);
    });
  }
  const target = (baseline, scenario) => ({ ...baseline, ...(scenario === 'price_changed' ? { priceCents: baseline.priceCents + 1 }
    : scenario === 'out_of_stock' ? { inventoryQty: 0 } : { status: 'ARCHIVED' }) });
  async function writeState(ctx, desired, op, phase, current) {
    op[`${phase}StartedAt`] = now().toISOString(); await ctx.save(phase === 'mutate' ? 'mutation_pending' : 'restore_pending');
    let operation, variables;
    if (op.scenario === 'price_changed') { operation = 'AvafemFailurePrice'; variables = { productId: current.productId, variants: [{ id: current.variantId, price: (desired.priceCents / 100).toFixed(2) }] }; }
    else if (op.scenario === 'archived') { operation = 'AvafemFailureStatus'; variables = { product: { id: current.productId, status: desired.status } }; }
    else { operation = 'AvafemFailureStock'; variables = { idempotencyKey: uuid(`avafem-failure:${ctx.fixture.shop}:${op.phase}:${op.scenario}:${phase}`), input: {
      name: 'available', reason: 'correction', referenceDocumentUri: `gid://avafem/FailureFixture/${ctx.fixture.number}-${op.phase}-${phase}`,
      quantities: [{ inventoryItemId: current.inventoryItemId, locationId: current.locationId, quantity: desired.inventoryQty, changeFromQuantity: current.inventoryQty }],
    } }; }
    try { const result = await ctx.adapter.failureFixtureGraphql(operation, variables);
      const payload = result?.[operation === 'AvafemFailurePrice' ? 'productVariantsBulkUpdate' : operation === 'AvafemFailureStatus' ? 'productUpdate' : 'inventorySetQuantities'];
      if (!payload || !Array.isArray(payload.userErrors) || payload.userErrors.length) throw new Error();
    } catch { op.uncertain = true; await ctx.save('needs_review'); return false; }
    return true;
  }
  async function mutate(input = {}) {
    cleanInput(input, ['shop','scenario','phase','confirmTest']); const phase = input.phase ?? 'catalog';
    if (input.confirmTest !== true || !['catalog','checkout'].includes(phase) || !['price_changed','out_of_stock','archived'].includes(input.scenario)
      || (phase === 'checkout' && input.scenario === 'archived')) fail('FAILURE_FIXTURE_INPUT', 'Select a fixed scenario/phase with explicit test confirmation.', 422);
    return locked(input, async ctx => {
      if (ctx.details.deleteStartedAt) fail('FAILURE_FIXTURE_TOMBSTONE', 'A deleted or deletion-uncertain fixture cannot be mutated.');
      if (!ctx.baseline) fail('FAILURE_FIXTURE_BASELINE', 'Prepare and verify the dedicated native baseline first.');
      const current = failureFixtureSnapshot(await lookup(ctx.adapter, ctx.fixture), ctx.fixture);
      if (!sameIdentity(current, ctx.baseline)) fail('FAILURE_FIXTURE_IDENTITY_CHANGED', 'The original disposable identity cannot change.');
      const key = `${phase}:${input.scenario}`, expected = target(ctx.baseline, input.scenario), prior = ctx.details.ops[key];
      if (prior) { if (prior.restored && !equal(current, ctx.baseline)) fail('FAILURE_FIXTURE_DRIFT', 'A replay cannot adopt or overwrite an unrelated native change.');
        if (!prior.restored && equal(current, expected)) { prior.verified = true; prior.uncertain = false; await ctx.save('mutated'); }
        return summary(ctx.fixture, ctx.row, current); }
      if (ctx.details.activeScenario || !equal(current, ctx.baseline)) fail('FAILURE_FIXTURE_DRIFT', 'Restore the earlier fixture state before another scenario; unrelated changes are never overwritten.');
      const op = { scenario: input.scenario, phase, expected, verified: false, restored: false };
      ctx.details.ops[key] = op; ctx.details.activeScenario = key; ctx.details.lastPhase = phase;
      const sent = await writeState(ctx, expected, op, 'mutate', current);
      if (!sent) return summary(ctx.fixture, ctx.row, current, 1);
      const observed = failureFixtureSnapshot(await lookup(ctx.adapter, ctx.fixture), ctx.fixture);
      if (equal(observed, expected)) { op.verified = true; await ctx.save('mutated'); } else { op.uncertain = true; await ctx.save('needs_review'); }
      return summary(ctx.fixture, ctx.row, observed, 1);
    });
  }
  async function restore(input = {}) {
    cleanInput(input, ['shop','phase','confirmTest']); const phase = input.phase ?? 'catalog';
    if (input.confirmTest !== true || !['catalog','checkout'].includes(phase)) fail('TEST_CONFIRMATION_REQUIRED', 'Explicit restoration confirmation and a fixed phase are required.', 422);
    return locked(input, async ctx => {
      if (ctx.details.deleteStartedAt) fail('FAILURE_FIXTURE_TOMBSTONE', 'A deleted or deletion-uncertain fixture cannot be restored.');
      if (!ctx.baseline) fail('FAILURE_FIXTURE_BASELINE', 'The encrypted native baseline is required.');
      const current = failureFixtureSnapshot(await lookup(ctx.adapter, ctx.fixture), ctx.fixture), scenario = ctx.details.activeScenario;
      if (!sameIdentity(current, ctx.baseline)) fail('FAILURE_FIXTURE_IDENTITY_CHANGED', 'The original disposable identity cannot change.');
      if (!scenario) { if (!equal(current, ctx.baseline)) fail('FAILURE_FIXTURE_DRIFT', 'An unowned native change cannot be restored automatically.'); return summary(ctx.fixture, ctx.row, current); }
      const op = ctx.details.ops[scenario];
      if (op.phase !== phase) fail('FAILURE_FIXTURE_PHASE', 'Restore the saved active phase, not a different cycle.');
      if (equal(current, ctx.baseline) && (op.verified || op.restoreStartedAt)) { op.restored = true; op.uncertain = false; ctx.details.activeScenario = null; await ctx.save('prepared'); return summary(ctx.fixture, ctx.row, current); }
      if (!equal(current, op.expected)) fail('FAILURE_FIXTURE_DRIFT', 'An uncertain or unrelated native state requires review, not an overwrite.');
      op.verified = true;
      if (op.restoreStartedAt) { await ctx.save('needs_review'); return summary(ctx.fixture, ctx.row, current); }
      const sent = await writeState(ctx, ctx.baseline, op, 'restore', current);
      if (!sent) return summary(ctx.fixture, ctx.row, current, 1);
      const observed = failureFixtureSnapshot(await lookup(ctx.adapter, ctx.fixture), ctx.fixture);
      if (equal(observed, ctx.baseline)) { op.restored = true; op.uncertain = false; ctx.details.activeScenario = null; await ctx.save('prepared'); }
      else { op.uncertain = true; await ctx.save('needs_review'); }
      return summary(ctx.fixture, ctx.row, observed, 1);
    });
  }
  async function cleanup(input = {}) {
    cleanInput(input, ['shop','confirmTest']); if (input.confirmTest !== true) fail('TEST_CONFIRMATION_REQUIRED', 'Explicit disposable deletion confirmation is required.', 422);
    return locked(input, async ctx => {
      if (!ctx.baseline) fail('FAILURE_FIXTURE_BASELINE', 'The original encrypted native baseline is required.');
      if (ctx.details.deleteStartedAt) {
        const native = await readById(ctx.adapter, ctx.baseline.productId);
        if (native === null) { ctx.details.deletedAt ??= now().toISOString(); await ctx.save('deleted'); return summary(ctx.fixture, ctx.row, null); }
        if (ctx.details.deletedAt) fail('FAILURE_FIXTURE_DELETION_CHANGED', 'A previously confirmed absent product must not reappear in provider readback.');
        const current = failureFixtureSnapshot(native, ctx.fixture);
        if (!sameIdentity(current, ctx.baseline)) fail('FAILURE_FIXTURE_IDENTITY_CHANGED', 'The original deletion target cannot change.');
        await ctx.save('deletion_uncertain'); return summary(ctx.fixture, ctx.row, current);
      }
      const current = failureFixtureSnapshot(await lookup(ctx.adapter, ctx.fixture), ctx.fixture);
      if (!equal(current, ctx.baseline) || ctx.details.activeScenario || Object.values(ctx.details.ops).some(op => op.restored !== true))
        fail('FAILURE_FIXTURE_CLEANUP_BLOCKED', 'Every saved phase must be restored and the exact owned ACTIVE ten-stock baseline must verify before cleanup.');
      let approved = false;
      try { approved = await canDelete({ shop: ctx.fixture.shop, fixture: structuredClone(ctx.baseline) }) === true; } catch { /* fail closed */ }
      if (!approved) fail('FAILURE_FIXTURE_DELETE_NOT_AUTHORIZED', 'Fresh server-side proof of cancelled/expired authorizations and no captures/orders is required.');
      const fresh = failureFixtureSnapshot(await readById(ctx.adapter, ctx.baseline.productId), ctx.fixture);
      if (!equal(fresh, ctx.baseline)) fail('FAILURE_FIXTURE_CLEANUP_BLOCKED', 'The owned native baseline changed during deletion authorization.');
      ctx.details.deleteStartedAt = now().toISOString(); ctx.details.deleteProductId = ctx.baseline.productId; await ctx.save('deleting');
      try {
        const result = await ctx.adapter.failureFixtureGraphql('AvafemFailureDelete', { input: { id: ctx.baseline.productId } });
        if (result?.productDelete?.deletedProductId !== ctx.baseline.productId || !Array.isArray(result.productDelete.userErrors) || result.productDelete.userErrors.length) throw new Error();
      } catch { await ctx.save('deletion_uncertain'); }
      // Never re-dispatch. Even a lost response is resolved only by original GID.
      let native;
      try { native = await readById(ctx.adapter, ctx.baseline.productId); }
      catch { await ctx.save('deletion_uncertain'); return summary(ctx.fixture, ctx.row, current, 1); }
      if (native === null) { ctx.details.deletedAt = now().toISOString(); await ctx.save('deleted'); return summary(ctx.fixture, ctx.row, null, 1); }
      await ctx.save('deletion_uncertain'); return summary(ctx.fixture, ctx.row, failureFixtureSnapshot(native, ctx.fixture), 1);
    });
  }
  return { inspect, prepare, mutate, restore, cleanup };
}
