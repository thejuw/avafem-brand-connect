import { createShopifyAdapter } from './integrations/shopify.mjs';
import { SHOPIFY_ALLOWED_SCOPES, missingShopifyScopes } from './integrations/shopify-policy.mjs';

export const TEST_STORES = Object.freeze([
  { shop: 'i4vd1u-s8.myshopify.com', name: 'My Store 2', shippingCents: 25 },
  { shop: 'qpsd02-jz.myshopify.com', name: 'My Store 4', shippingCents: 50 },
  { shop: 'ir7112-v1.myshopify.com', name: 'My Store 6', shippingCents: 75 },
]);
const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const assertShop = shop => {
  const store = TEST_STORES.find(item => item.shop === shop);
  if (!store) throw failure('TEST_STORE_REQUIRED', 'Only the three explicitly authorized stores are allowed.', 422);
  return store;
};
const verify = (result, shop) => {
  if (result?.shop?.myshopifyDomain !== shop || result.shop.currencyCode !== 'USD'
    || !Array.isArray(result.grantedScopes) || missingShopifyScopes(result.grantedScopes).length
    || result.grantedScopes.some(scope => !SHOPIFY_ALLOWED_SCOPES.includes(scope)))
    throw failure('SHOPIFY_SCOPE_POLICY', 'Store identity, USD currency and the exact fifteen approved scopes must verify.');
  return result;
};

/** Explicit owner-controlled TEST installations. This is NOT a claim of public
 * distribution or per-merchant OAuth. Each unrelated store has its own client ID
 * and encrypted secret; no token or secret is inherited from My Store 2. */
export async function createTestStores(db, auth, domain, { ownShopify, adapterFactory = createShopifyAdapter } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS provider_test_stores (
    shop TEXT PRIMARY KEY, brand_id TEXT UNIQUE NOT NULL REFERENCES brands(id),
    client_id TEXT, credentials_encrypted TEXT, verified_details JSONB,
    state TEXT NOT NULL DEFAULT 'unconfigured', installed_at TIMESTAMPTZ,
    shipping_cents INTEGER NOT NULL, commission_bps INTEGER NOT NULL DEFAULT 1500,
    return_window_days INTEGER NOT NULL DEFAULT 30, connected_account_id TEXT,
    connected_account_created_in_test BOOLEAN NOT NULL DEFAULT false,
    connected_account_verified BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const cached = new Map();
  async function initialize() { for (const store of TEST_STORES) {
    if ((await db.query('SELECT shop FROM provider_test_stores WHERE shop=$1', [store.shop])).rows.length) continue;
    const prior = store === TEST_STORES[0]
      ? (await db.query("SELECT brand_id FROM connector_state WHERE provider='shopify'")).rows[0]?.brand_id : null;
    const slug = `avafem-provider-test-${store.name.split(' ').at(-1)}`;
    const existing = (await domain.listBrands()).find(brand => brand.slug === slug);
    const brand = prior ? await domain.getBrand(prior) : existing ?? await domain.createBrand({
      name: `Avafem Test — ${store.name}`, slug, commissionBps: 1500, connectionTier: 'shopify',
      returnWindowDays: 30, shippingTable: [{ country: 'US', priceCents: store.shippingCents }],
      supportEmail: 'test@example.com',
    });
    if (!prior && !existing) await domain.updateBrand(brand.id, { connectionTier: 'shopify', commissionBps: 1500,
      returnWindowDays: 30, shippingTable: [{ country: 'US', priceCents: store.shippingCents }], supportEmail: 'test@example.com' });
    await db.query(`INSERT INTO provider_test_stores(shop,brand_id,shipping_cents)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [store.shop, brand.id, store.shippingCents]);
  } return list(); }
  const row = async shop => {
    assertShop(shop);
    const record = (await db.query('SELECT * FROM provider_test_stores WHERE shop=$1', [shop])).rows[0];
    if (!record) throw failure('TEST_STORES_NOT_INITIALIZED', 'Initialize the three owner-controlled test-store bindings first.');
    return record;
  };
  const safe = record => ({ shop: record.shop, brandId: record.brand_id,
    name: assertShop(record.shop).name, configured: record.shop === TEST_STORES[0].shop
      ? true : Boolean(record.credentials_encrypted), connected: record.state === 'connected',
    state: record.state, authMode: 'owner_client_credentials_test',
    shippingCents: record.shipping_cents, commissionBps: record.commission_bps,
    returnWindowDays: record.return_window_days, installationId: record.verified_details?.installationId ?? null,
    appId: record.verified_details?.app?.id ?? null, clientId: record.client_id ?? null,
    connectedAccountId: record.connected_account_id ?? null,
    connectedAccountVerified: record.connected_account_verified === true,
    warning: 'Owner-controlled test installation only. Does not certify public-app/OAuth onboarding. Shipping amounts are explicit test-fixture flat rates.',
  });
  async function forShop(shop) {
    const record = await row(shop);
    if (record.state === 'disconnected') throw failure('SHOPIFY_DISCONNECTED', 'This test store is disconnected.');
    if (shop === TEST_STORES[0].shop) return ownShopify;
    if (!record.credentials_encrypted || !record.client_id) throw failure('SHOPIFY_TEST_CREDENTIALS_REQUIRED', 'Install this store’s own test app and configure its credentials through the masked local form.');
    if (!cached.has(shop)) cached.set(shop, adapterFactory({ env: {}, shop, clientId: record.client_id,
      authMode: 'client_credentials', test: true, useKeychain: false,
      getSecret: () => auth.decrypt(record.credentials_encrypted).clientSecret }));
    return cached.get(shop);
  }
  async function preflight(shop) {
    const adapter = await forShop(shop);
    const checked = verify(await adapter.preflight(), shop);
    const brand = await domain.getBrand((await row(shop)).brand_id);
    if (['paused', 'disconnected'].includes(brand.status))
      throw failure('TEST_BRAND_NOT_ACCEPTING_ORDERS', 'This brand is paused or disconnected; do not authorize or capture a new checkout.');
    await db.query(`UPDATE provider_test_stores SET state='connected',verified_details=$2,
      installed_at=COALESCE(installed_at,now()),updated_at=now() WHERE shop=$1`, [shop, JSON.stringify(checked)]);
    await domain.updateBrand((await row(shop)).brand_id, { connectionTier: 'shopify', connectionHealthy: true });
    return { ...safe(await row(shop)), verified: true, grantedScopes: checked.grantedScopes };
  }
  async function configure({ shop, clientId, clientSecret, confirmOwnedStore }) {
    assertShop(shop);
    await row(shop);
    if (shop === TEST_STORES[0].shop) throw failure('OWN_STORE_ALREADY_CONFIGURED', 'My Store 2 uses its existing server-side configuration.');
    if (confirmOwnedStore !== true || !/^[a-f0-9]{32}$/.test(clientId ?? '')
      || typeof clientSecret !== 'string' || clientSecret.length < 16 || clientSecret.length > 500
      || /\s/.test(clientSecret))
      throw failure('SHOPIFY_TEST_SETUP_INVALID', 'Confirm ownership and enter this exact store’s own app client ID and secret.', 422);
    const candidate = adapterFactory({ env: {}, shop, clientId, test: true, authMode: 'client_credentials',
      useKeychain: false, getSecret: () => clientSecret });
    const checked = verify(await candidate.preflight(), shop);
    await db.query(`UPDATE provider_test_stores SET client_id=$2,credentials_encrypted=$3,
      verified_details=$4,state='connected',installed_at=now(),updated_at=now() WHERE shop=$1`,
    [shop, clientId, auth.encrypt({ clientSecret }), JSON.stringify(checked)]);
    cached.set(shop, candidate);
    await domain.updateBrand((await row(shop)).brand_id, { connectionTier: 'shopify', connectionHealthy: true });
    return { ...safe(await row(shop)), verified: true, secretStorage: 'server encrypted database', secretReturned: false };
  }
  async function list() {
    const records = (await db.query('SELECT * FROM provider_test_stores ORDER BY shop')).rows;
    return TEST_STORES.map(store => records.find(record => record.shop === store.shop))
      .map((record, index) => record ? safe(record) : { ...TEST_STORES[index], brandId: null, configured: false,
        connected: false, state: 'uninitialized', commissionBps: 1500, returnWindowDays: 30, connectedAccountVerified: false });
  }
  async function disconnect(shop, occurredAt) {
    const record = await row(shop);
    if (!occurredAt || !Number.isFinite(new Date(occurredAt).getTime())) throw failure('INSTALLATION_EVENT_REVIEW', 'Uninstall occurrence time is required.');
    if (record.installed_at && new Date(occurredAt) < new Date(record.installed_at)) return { ignored: true };
    cached.delete(shop);
    await db.query("UPDATE provider_test_stores SET state='disconnected',credentials_encrypted=NULL,updated_at=now() WHERE shop=$1", [shop]);
    await domain.updateBrand(record.brand_id, { status: 'disconnected', connectionHealthy: false });
    return { disconnected: true, shop };
  }
  async function findShop(shop) {
    if (!TEST_STORES.some(store => store.shop === shop)) return null;
    const record = (await db.query('SELECT * FROM provider_test_stores WHERE shop=$1', [shop])).rows[0];
    if (!record) return null;
    // Unconfigured Store4/6 cannot authenticate webhooks using the Store2 secret.
    return record.shop === TEST_STORES[0].shop || record.credentials_encrypted ? safe(record) : null;
  }
  async function bindConnectedAccount(shop, account, { createdInTest = false } = {}) {
    const record = await row(shop);
    if (createdInTest !== true || !/^acct_[A-Za-z0-9]{8,}$/.test(account?.id ?? '')
      || account.metadata?.integration !== 'avafem' || account.metadata?.brand_id !== record.brand_id)
      throw failure('TEST_ACCOUNT_BINDING_REQUIRED', 'Only a newly created, metadata-bound Avafem test recipient can be bound.');
    if (record.connected_account_id && record.connected_account_id !== account.id)
      throw failure('TEST_ACCOUNT_ALREADY_BOUND', 'Preserve the original connected-account mapping.');
    await db.query(`UPDATE provider_test_stores SET connected_account_id=$2,
      connected_account_created_in_test=true,updated_at=now() WHERE shop=$1`, [shop, account.id]);
    return safe(await row(shop));
  }
  async function verifyConnectedAccount(shop, account) {
    const record = await row(shop);
    if (record.connected_account_id !== account.id || record.connected_account_created_in_test !== true
      || account.metadata?.brand_id !== record.brand_id || account.metadata?.integration !== 'avafem')
      throw failure('TEST_ACCOUNT_BINDING_REQUIRED', 'Connected account does not match its immutable test-store binding.');
    const ready = account.capabilities?.transfers === 'active' && account.payouts_enabled === true
      && !account.requirements?.disabled_reason && (account.requirements?.currently_due?.length ?? 0) === 0;
    await db.query('UPDATE provider_test_stores SET connected_account_verified=$2,updated_at=now() WHERE shop=$1', [shop, ready]);
    return { ...safe(await row(shop)), ready, currentlyDue: account.requirements?.currently_due ?? [] };
  }
  const authorizedTestAccounts = async () => (await db.query(`SELECT connected_account_id FROM provider_test_stores
    WHERE connected_account_created_in_test=true AND connected_account_verified=true`)).rows.map(record => record.connected_account_id);
  return { initialize, list, row, forShop, preflight, configure, disconnect, findShop, bindConnectedAccount, verifyConnectedAccount, authorizedTestAccounts };
}
