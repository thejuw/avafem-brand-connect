import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createDomain } from '../server/domain.mjs';
import { createTestStores, TEST_STORES } from '../server/test-stores.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const clientId = 'a'.repeat(32);
const secret = index => `fixture_private_shop_secret_${index}_not_real`;
const checked = shop => ({ verified: true, shop: { myshopifyDomain: shop, currencyCode: 'USD' }, installationId: `gid://shopify/AppInstallation/${TEST_STORES.findIndex(item => item.shop === shop) + 1}`, app: { id: 'gid://shopify/App/1' }, grantedScopes: [...SHOPIFY_ALLOWED_SCOPES] });

async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  await db.query("CREATE TABLE connector_state(provider TEXT PRIMARY KEY,brand_id TEXT,details JSONB NOT NULL DEFAULT '{}')");
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const domain = createDomain(db); const configs = []; const state = { patch: null, ownReads: 0 };
  const ownShopify = { shop: TEST_STORES[0].shop, preflight: async () => { state.ownReads++; return checked(TEST_STORES[0].shop); } };
  const adapterFactory = config => {
    configs.push(config);
    return { shop: config.shop, preflight: async () => ({ ...checked(config.shop), ...(state.patch ?? {}) }) };
  };
  const service = await createTestStores(db, auth, domain, { ownShopify, adapterFactory });
  const setup = index => service.configure({ shop: TEST_STORES[index].shop, clientId, clientSecret: secret(index), confirmOwnedStore: true });
  return { db, auth, domain, configs, state, service, ownShopify, setup };
}

test('test-store construction and GET/list are lazy and never create brands or claim connections', async t => {
  const f = await fixture(t);
  const list = await f.service.list();
  assert.equal(list.length, 3); assert.ok(list.every(store => store.state === 'uninitialized' && !store.configured && !store.connected));
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM brands')).rows[0].n, 0);
  assert.equal(f.configs.length, 0); assert.equal(f.state.ownReads, 0);
  await assert.rejects(f.service.forShop(TEST_STORES[1].shop), { code: 'TEST_STORES_NOT_INITIALIZED' });
  await assert.rejects(f.setup(1), { code: 'TEST_STORES_NOT_INITIALIZED' });
  assert.equal(f.configs.length, 0, 'Uninitialized configuration must be rejected before a provider preflight.');
  await f.service.initialize(); await f.service.initialize();
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM brands')).rows[0].n, 3);
  assert.equal(new Set((await f.service.list()).map(store => store.brandId)).size, 3);
});

test('three store bindings retain explicit 15%/30-day/shipping fixture settings without remapping an existing Store2 brand', async t => {
  const f = await fixture(t);
  const prior = await f.domain.createBrand({ name: 'Existing own-store fixture', slug: 'existing-own-store-fixture', commissionBps: 1500, supportEmail: 'test@example.com' });
  await f.db.query('INSERT INTO connector_state(provider,brand_id) VALUES($1,$2)', ['shopify', prior.id]);
  const list = await f.service.initialize();
  assert.equal(list[0].brandId, prior.id);
  assert.deepEqual(list.map(store => store.shippingCents), [25, 50, 75]);
  assert.ok(list.every(store => store.commissionBps === 1500 && store.returnWindowDays === 30));
  assert.equal(await f.service.forShop(TEST_STORES[0].shop), f.ownShopify);
  await assert.rejects(f.service.configure({ shop: TEST_STORES[0].shop, clientId, clientSecret: secret(0), confirmOwnedStore: true }), { code: 'OWN_STORE_ALREADY_CONFIGURED' });
});

test('Store4/6 credentials are independently encrypted and cannot inherit Store2 environment, Keychain or adapters', async t => {
  const f = await fixture(t); await f.service.initialize();
  for (const index of [1, 2]) await assert.rejects(f.service.forShop(TEST_STORES[index].shop), { code: 'SHOPIFY_TEST_CREDENTIALS_REQUIRED' });
  assert.equal(await f.service.findShop(TEST_STORES[1].shop), null);
  const four = await f.setup(1), six = await f.setup(2);
  assert.equal(four.secretReturned, false); assert.equal(six.secretReturned, false);
  assert.doesNotMatch(JSON.stringify([four, six, await f.service.list()]), /fixture_private_shop_secret|credentials_encrypted|access_token|clientSecret/);
  const rows = (await f.db.query('SELECT * FROM provider_test_stores ORDER BY shop')).rows;
  assert.ok(rows.every(row => !JSON.stringify(row).includes('fixture_private_shop_secret')));
  const configured = rows.filter(row => row.credentials_encrypted);
  assert.equal(configured.length, 2); assert.notEqual(configured[0].credentials_encrypted, configured[1].credentials_encrypted);
  for (const config of f.configs) {
    assert.deepEqual(config.env, {}); assert.equal(config.useKeychain, false); assert.equal(config.authMode, 'client_credentials');
    const index = TEST_STORES.findIndex(store => store.shop === config.shop);
    assert.equal(await config.getSecret(), secret(index));
  }
  const reopened = await createTestStores(f.db, f.auth, f.domain, { ownShopify: f.ownShopify, adapterFactory: config => { f.configs.push(config); return { shop: config.shop }; } });
  assert.equal((await reopened.forShop(TEST_STORES[1].shop)).shop, TEST_STORES[1].shop);
  assert.equal(await f.configs.at(-1).getSecret(), secret(1));
  assert.notEqual(await reopened.forShop(TEST_STORES[1].shop), f.ownShopify);
  await assert.rejects(reopened.forShop('unrelated-brand.myshopify.com'), { code: 'TEST_STORE_REQUIRED' });
});

test('configuration verifies exact shop/USD/scope ceiling before saving, without echoing submitted secrets', async t => {
  const f = await fixture(t); await f.service.initialize();
  for (const patch of [
    { shop: { myshopifyDomain: TEST_STORES[0].shop, currencyCode: 'USD' } },
    { shop: { myshopifyDomain: TEST_STORES[1].shop, currencyCode: 'CAD' } },
    { grantedScopes: SHOPIFY_ALLOWED_SCOPES.filter(scope => scope !== 'write_orders') },
    { grantedScopes: [...SHOPIFY_ALLOWED_SCOPES, 'read_locations'] },
  ]) {
    f.state.patch = patch;
    await assert.rejects(f.setup(1), error => error.code === 'SHOPIFY_SCOPE_POLICY' && !error.message.includes(secret(1)));
    assert.equal((await f.service.row(TEST_STORES[1].shop)).credentials_encrypted, null);
  }
  f.state.patch = null;
  await assert.rejects(f.service.configure({ shop: TEST_STORES[1].shop, clientId, clientSecret: secret(1), confirmOwnedStore: false }), { code: 'SHOPIFY_TEST_SETUP_INVALID' });
  assert.equal((await f.setup(1)).connected, true);
  const metadata = await f.service.preflight(TEST_STORES[1].shop);
  assert.equal(metadata.installationId, 'gid://shopify/AppInstallation/2');
  assert.deepEqual(metadata.grantedScopes, SHOPIFY_ALLOWED_SCOPES);
});

test('disconnect clears credentials and denies access while an old uninstall cannot retire a new installation', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.setup(1);
  const before = await f.service.row(TEST_STORES[1].shop);
  assert.equal((await f.service.disconnect(TEST_STORES[1].shop, new Date(new Date(before.installed_at).getTime() - 1000).toISOString())).ignored, true);
  assert.equal((await f.service.row(TEST_STORES[1].shop)).state, 'connected');
  await assert.rejects(f.service.disconnect(TEST_STORES[1].shop), { code: 'INSTALLATION_EVENT_REVIEW' });
  await f.service.disconnect(TEST_STORES[1].shop, new Date(new Date(before.installed_at).getTime() + 1000).toISOString());
  const row = await f.service.row(TEST_STORES[1].shop);
  assert.equal(row.credentials_encrypted, null); assert.equal(row.state, 'disconnected');
  await assert.rejects(f.service.forShop(TEST_STORES[1].shop), { code: 'SHOPIFY_DISCONNECTED' });
  assert.equal(await f.service.findShop(TEST_STORES[1].shop), null);
  assert.equal((await f.domain.getBrand(row.brand_id)).status, 'disconnected');
});

test('only newly created metadata-bound test recipients can be authorized and original account mapping is immutable', async t => {
  const f = await fixture(t); await f.service.initialize(); const shop = TEST_STORES[1].shop; const row = await f.service.row(shop);
  const account = { id: 'acct_fixtureRecipient1', metadata: { integration: 'avafem', brand_id: row.brand_id }, capabilities: { transfers: 'active' }, payouts_enabled: true, requirements: { currently_due: [], disabled_reason: null } };
  await assert.rejects(f.service.bindConnectedAccount(shop, account), { code: 'TEST_ACCOUNT_BINDING_REQUIRED' });
  await assert.rejects(f.service.bindConnectedAccount(shop, { ...account, metadata: { ...account.metadata, brand_id: 'another_brand' } }, { createdInTest: true }), { code: 'TEST_ACCOUNT_BINDING_REQUIRED' });
  await f.service.bindConnectedAccount(shop, account, { createdInTest: true });
  assert.deepEqual(await f.service.authorizedTestAccounts(), []);
  assert.equal((await f.service.verifyConnectedAccount(shop, { ...account, requirements: { currently_due: ['external_account'] } })).ready, false);
  assert.equal((await f.service.verifyConnectedAccount(shop, account)).ready, true);
  assert.deepEqual(await f.service.authorizedTestAccounts(), [account.id]);
  await assert.rejects(f.service.bindConnectedAccount(shop, { ...account, id: 'acct_fixtureRecipient2' }, { createdInTest: true }), { code: 'TEST_ACCOUNT_ALREADY_BOUND' });
  await assert.rejects(f.service.verifyConnectedAccount(TEST_STORES[2].shop, account), { code: 'TEST_ACCOUNT_BINDING_REQUIRED' });
});
