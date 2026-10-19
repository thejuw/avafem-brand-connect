import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';
import { APPROVED_TEST_PLATFORM_SWITCH } from '../server/provider-platform-switch.mjs';

// These are isolated HTTP-injection tests, not provider acceptance evidence.
// Every adapter is a mock; no environment, Keychain, running preview or network is used.
const RUN = `uco_${'b'.repeat(32)}`;
const BASE = `/api/unified-checkout/${RUN}`;
const SECRET = 'shpss_UNIT_ONLY_NOT_A_REAL_PROVIDER_SECRET';
const CLIENT = 'a'.repeat(32);
const FAKE_CLIENT_SECRET = 'UNIT_CLIENT_SECRET_NEVER_RETURN';
const data = response => response.json().data;
const status = (response, expected) => assert.equal(response.statusCode, expected, response.body);
const safe = value => {
  const output = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [SECRET, FAKE_CLIENT_SECRET]) assert.ok(!output.includes(secret), 'A synthetic secret escaped the safe response/log boundary.');
  assert.doesNotMatch(output, /"(?:credentials_encrypted|snapshot_encrypted|details_encrypted|client_secret)"/);
};
const cart = () => ({ items: TEST_STORES.map((store, index) => ({ shop: store.shop, variantId: `gid://shopify/ProductVariant/${100 + index}`, quantity: 1 })) });
const platformSwitch = () => ({ ...APPROVED_TEST_PLATFORM_SWITCH, retireRunIds: [RUN], operatorVerifiedNoProviderObjects: true });
const rejectedRecipientRevision = () => ({ shop: TEST_STORES[0].shop, providerRequestId: 'req_98gvn77VCy6nK8', confirmRejectedBeforeCreation: true });
const rejectedRecipientV2 = () => ({ shop: TEST_STORES[0].shop, providerRequestId: 'req_kxW4JTIW5nYP4G', confirmRejectedBeforeCreation: true });
const refundPreview = () => ({ shop: TEST_STORES[0].shop, orderId: 'gid://shopify/Order/1001', items: [{ sku: 'UNIT-SKU', qty: 1 }], shippingCents: 0 });
const automationPolicy = () => ({ confirmTest: true, autoSettle: true, autoPayout: true,
  payoutGates: [0,1,2].map(index => ({ bagId: `bag_unit_${index}`, refundOperationId: `unit_refund_${index}` })) });
const TAX_REPORT = `taxrep_${'d'.repeat(32)}`;
const taxEvidence = () => ({ originalTaxTransactionId: 'tax_unitOriginal123',
  refunds: [{ refundId: 're_unitRefund123', taxTransactionId: 'tax_unitReversal123' }], binding: { kind: 'api_reference' } });
const taxRounding = () => ({ reportId: TAX_REPORT, reportHash: 'c'.repeat(64), operationId: 'unit_platform_rounding', confirmPlatformOnly: true });
const mutations = [
  ['/api/local/provider-test/initialize', { confirmTest: true }],
  ['/api/unified-checkout/sessions', cart()],
  [`${BASE}/reconcile`, {}],
  [`${BASE}/test-clock`, { confirmTestClock: true, now: '2026-11-19T12:00:00.000Z' }],
  [`${BASE}/fulfill`, { bagId: 'bag_unit', operationId: 'unit_operation', items: [{ sku: 'AVF-CONNECT-TEST-0', qty: 1 }], tracking: { number: 'AVAFEM-TEST-UNIT', company: 'Other', url: 'https://example.com/unit' } }],
  [`${BASE}/fulfillment-sync`, { bagId: 'bag_unit' }],
  [`${BASE}/test-delivery`, { bagId: 'bag_unit', operationId: 'unit_delivery', confirmTestDelivery: true }],
  [`${BASE}/refund`, { bagId: 'bag_unit', operationId: 'unit_refund', items: [{ sku: 'AVF-CONNECT-TEST-0', qty: 1 }], refundShipping: false }],
  [`${BASE}/settle`, { confirmTest: true }],
  [`${BASE}/payout`, { bagId: 'bag_unit', operationId: 'unit_payout', confirmTest: true }],
  [`${BASE}/money-reconcile`, {}],
  ['/api/provider-test/recipients/create', { confirmTest: true }],
  ['/api/provider-test/recipients/links', {}],
  ['/api/provider-test/fixtures', { shop: TEST_STORES[1].shop, confirmTest: true }],
  ['/api/provider-test/catalog/sync', { shop: TEST_STORES[0].shop }],
  [`${BASE}/reconciliation-report`, {}],
  [`${BASE}/cancel`, { bagId: 'bag_unit', operationId: 'unit_cancel_operation' }],
  ['/api/provider-test/stores/preflight', { shop: TEST_STORES[0].shop }],
  ['/api/local/provider-test/platform-switch', platformSwitch()],
  ['/api/local/provider-test/recipients/revise-rejected', rejectedRecipientRevision()],
  ['/api/local/provider-test/recipients/revise-v2', rejectedRecipientV2()],
  ['/api/provider-test/refund-preview', refundPreview()],
  [`${BASE}/automation/configure`, automationPolicy()],
  [`${BASE}/automation/disable`, { confirmTest: true }],
  [`${BASE}/refund-proposal/revise`, { bagId: 'bag_unit', operationId: 'unit_refund_proposal', confirmNoProviderWrites: true }],
  [`${BASE}/tax-evidence`, taxEvidence()],
  [`${BASE}/tax-reconciliation-report`, {}],
  [`${BASE}/tax-rounding`, taxRounding()],
  ['/api/provider-test/failure-fixtures/prepare', { shop: TEST_STORES[0].shop, confirmTest: true }],
  ['/api/provider-test/failure-fixtures/mutate', { shop: TEST_STORES[0].shop, scenario: 'out_of_stock', phase: 'catalog', confirmTest: true }],
  ['/api/provider-test/failure-fixtures/restore', { shop: TEST_STORES[0].shop, phase: 'catalog', confirmTest: true }],
  ['/api/provider-test/failure-checkouts', { caseId: 'declined_payment', operationId: 'unit_failure_decline', confirmTest: true }],
  [`/api/provider-test/failure-checkouts/${RUN}/reconcile`, { confirmTest: true }],
  [`/api/provider-test/failure-checkouts/${RUN}/cancel`, { confirmTest: true }],
  ['/api/provider-test/failure-fixtures/cleanup', { shop: TEST_STORES[0].shop, confirmTest: true }],
  ['/api/provider-test/failure-readbacks', { confirmTest: true }],
];
const reads = ['/api/unified-checkout/options', '/api/unified-checkout', BASE, `${BASE}/notifications`,
  '/api/provider-test/recipients/status', '/api/provider-test/recipients/return', '/api/provider-test/recipients/refresh',
  `/api/provider-test/fixtures?shop=${TEST_STORES[1].shop}`, '/api/provider-test/stores',
  `/api/provider-test/recipients/onboard?shop=${TEST_STORES[0].shop}`, `${BASE}/automation`, `${BASE}/tax-reconciliation-report/${TAX_REPORT}`,
  `/api/provider-test/failure-fixtures?shop=${TEST_STORES[0].shop}`, '/api/provider-test/failure-checkouts',
  `/api/provider-test/failure-checkouts/${RUN}`, `/api/provider-test/failure-checkouts/${RUN}/observe`,
  '/api/provider-test/failure-readbacks/fra_unit123456789'];

async function fixture(t) {
  const logs = [], factories = [], calls = { shopReads: 0, stripeReads: 0, sessions: 0, orders: 0, money: 0 };
  const state = { mode: 'test', checked: {}, sessions: new Map() };
  const adapters = new Map(TEST_STORES.map((store, index) => {
    const variant = { id: `gid://shopify/ProductVariant/${100 + index}`, sku: `AVF-CONNECT-TEST-${index}`,
      title: 'Default', productTitle: `Distinct fixture ${index} — DO NOT SHIP`, productStatus: 'ACTIVE',
      priceCents: 100 + index * 50, currency: 'USD', inventoryQty: 10, inventoryPolicy: 'DENY', tracked: true, requiresShipping: true };
    return [store.shop, { shop: store.shop, status: async () => ({ shop: store.shop, configured: true, available: true }),
      preflight: async () => { calls.shopReads++; return { shop: { myshopifyDomain: store.shop, currencyCode: 'USD' },
        grantedScopes: [...SHOPIFY_ALLOWED_SCOPES], installationId: `gid://shopify/AppInstallation/${1000 + index}`,
        ...state.checked[store.shop] }; },
      getVariant: async id => { calls.shopReads++; assert.equal(id, variant.id); return structuredClone(variant); },
      listProducts: async () => { calls.shopReads++; return { products: [{ title: variant.productTitle, sourceStatus: 'ACTIVE',
        variantsPageInfo: { hasNextPage: false }, variants: [{ shopifyVariantId: variant.id, sku: variant.sku, title: 'Default',
          tracked: true, requiresShipping: true, inventory: { policy: 'deny', qty: 10 }, price: { amount: variant.priceCents, currency: 'USD' } }] }], pageInfo: { hasNextPage: false } }; },
      createOrder: async () => { calls.orders++; assert.fail('An open hosted checkout must never dispatch Shopify.'); },
    }];
  }));
  const stripe = {
    status: async () => ({ configured: true, mode: state.mode, verified: true }),
    preflight: async () => { calls.stripeReads++; return { verified: true, mode: state.mode, accountId: 'acct_unitplatform123' }; },
    createCheckoutSession: async input => {
      calls.sessions++;
      assert.equal(input.captureMethod, 'manual'); assert.equal(input.shippingCents, 150);
      assert.equal(input.items.length, 3);
      const session = { id: `cs_test_unit${calls.sessions}`, url: `https://checkout.stripe.com/c/pay/cs_test_unit${calls.sessions}`,
        livemode: false, status: 'open', client_reference_id: input.orderId, expires_at: 9999999999, client_secret: FAKE_CLIENT_SECRET };
      state.sessions.set(session.id, session); return structuredClone(session);
    },
    getCheckoutSession: async id => { calls.stripeReads++; return structuredClone(state.sessions.get(id)); },
    createExpressAccount: async () => { calls.money++; assert.fail('Recipient creation is not part of these security fixtures.'); },
    createTransfer: async () => { calls.money++; assert.fail('No transfer is permitted in route fixtures.'); },
    createRefund: async () => { calls.money++; assert.fail('No refund is permitted in route fixtures.'); },
  };
  const app = await createApp({ worker: false, seed: false, connectionString: null,
    shopifyOAuth: { env: {} }, integrations: { serverEnv: {}, stripe, shopify: adapters.get(TEST_STORES[0].shop) },
    logger: { level: 'trace', stream: { write: chunk => logs.push(String(chunk)) } },
    testStores: { adapterFactory: options => { factories.push(options); assert.ok(adapters.has(options.shop)); return adapters.get(options.shop); } },
  });
  t.after(() => app.close()); await app.ready();
  const request = options => app.inject({ ...options, headers: { host: 'localhost:4317', ...options.headers } });
  const session = await request({ method: 'GET', url: '/api/session' }); status(session, 200);
  const cookie = String(session.headers['set-cookie']).split(';')[0], csrf = data(session).csrfToken;
  const owner = options => request({ ...options, headers: { cookie, 'x-csrf-token': csrf, ...options.headers } });
  const initialize = () => owner({ method: 'POST', url: '/api/local/provider-test/initialize', payload: { confirmTest: true } });
  const configure = shop => owner({ method: 'POST', url: '/api/local/shopify-test-credentials', payload: { shop, clientId: CLIENT, clientSecret: SECRET, confirmOwnedStore: true } });
  const ready = async () => { status(await initialize(), 200); for (const store of TEST_STORES.slice(1)) status(await configure(store.shop), 200); };
  return { app, ...app.avafem, request, owner, cookie, csrf, initialize, configure, ready, calls, state, logs, factories };
}

test('uninitialized provider reads are safe and never create store bindings, brands, sessions or money', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const options = await f.owner({ method: 'GET', url: '/api/unified-checkout/options' }); status(options, 200); safe(options.body);
    assert.equal(data(options).test, true); assert.equal(data(options).stores.length, 3);
    assert.ok(data(options).stores.every(store => store.state === 'uninitialized' && store.brandId === null && !store.connected));
    assert.equal(data(options).blockers.filter(blocker => blocker.code === 'TEST_STORES_NOT_INITIALIZED').length, 3);
  }
  const list = await f.owner({ method: 'GET', url: '/api/unified-checkout' }); status(list, 200); assert.deepEqual(data(list), []);
  for (const url of [BASE, `${BASE}/notifications`]) status(await f.owner({ method: 'GET', url }), 404);
  for (const table of ['brands', 'provider_test_stores', 'unified_checkout_runs']) assert.equal((await f.db.query(`SELECT COUNT(*)::int n FROM ${table}`)).rows[0].n, 0);
  assert.equal(f.calls.shopReads, 0); assert.equal(f.factories.length, 0);
  assert.equal(f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('store initialization requires explicit true confirmation and is idempotent without provider access', async t => {
  const f = await fixture(t);
  for (const payload of [{}, { confirmTest: false }, { confirmTest: true, live: true }])
    status(await f.owner({ method: 'POST', url: '/api/local/provider-test/initialize', payload }), 422);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM brands')).rows[0].n, 0);
  const first = await f.initialize(); status(first, 200);
  assert.deepEqual(data(first).map(store => store.shop), TEST_STORES.map(store => store.shop));
  assert.deepEqual(data(first).map(store => store.shippingCents), [25, 50, 75]);
  assert.ok(data(first).every(store => store.commissionBps === 1500 && store.returnWindowDays === 30));
  const again = await f.initialize(); status(again, 200);
  assert.deepEqual(data(again).map(store => store.brandId), data(first).map(store => store.brandId));
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM brands')).rows[0].n, 3);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.money, 0);
});

test('every provider read rejects unauthenticated, tenant and brand bearer access before any provider call', async t => {
  const f = await fixture(t);
  const tenant = await f.auth.createSession({ brandId: 'unrelated_unit_tenant' });
  const brand = await f.domain.createBrand({ name: 'Unrelated Unit Tenant', slug: 'unrelated-unit-tenant', commissionBps: 1500 });
  const credential = await f.auth.createCredential(brand.id);
  for (const url of reads) {
    status(await f.request({ method: 'GET', url }), 401);
    const scoped = await f.request({ method: 'GET', url, headers: { cookie: `avf_session=${tenant.token}` } });
    status(scoped, 403); assert.equal(scoped.json().error.code, 'ADMIN_REQUIRED');
    const bearer = await f.request({ method: 'GET', url, headers: { authorization: `Bearer ${credential.apiKey}` } });
    status(bearer, 403); assert.equal(bearer.json().error.code, 'BROWSER_SESSION_REQUIRED');
  }
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.money, 0);
});

test('every provider mutation enforces owner, CSRF, actual loopback peer, host and origin boundaries', async t => {
  const f = await fixture(t), tenant = await f.auth.createSession({ brandId: 'unrelated_unit_tenant' });
  for (const [url, payload] of mutations) {
    status(await f.request({ method: 'POST', url, payload }), 401);
    const noCsrf = await f.request({ method: 'POST', url, payload, headers: { cookie: f.cookie } });
    status(noCsrf, 403); assert.equal(noCsrf.json().error.code, 'CSRF_REQUIRED');
    status(await f.request({ method: 'POST', url, payload, headers: { cookie: `avf_session=${tenant.token}`, 'x-csrf-token': tenant.csrfToken } }), 403);
    const remote = await f.owner({ method: 'POST', url, payload, remoteAddress: '198.51.100.8', headers: { 'x-forwarded-for': '127.0.0.1' } });
    status(remote, 403); assert.equal(remote.json().error.code, 'LOCAL_TEST_ONLY');
    status(await f.owner({ method: 'POST', url, payload, headers: { host: 'public.example' } }), 403);
    status(await f.owner({ method: 'POST', url, payload, headers: { origin: 'https://untrusted.example' } }), 403);
  }
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.money, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM provider_test_stores')).rows[0].n, 0);
});

test('read-only routes also reject remote owners and forwarded loopback headers', async t => {
  const f = await fixture(t);
  for (const url of reads) {
    status(await f.owner({ method: 'GET', url, remoteAddress: '198.51.100.8', headers: { 'x-forwarded-for': '127.0.0.1' } }), 403);
    status(await f.owner({ method: 'GET', url, headers: { host: 'public.example' } }), 403);
    status(await f.owner({ method: 'GET', url, headers: { origin: 'https://untrusted.example' } }), 403);
  }
  assert.equal(f.calls.shopReads + f.calls.stripeReads, 0);
});

test('local Shopify setup verifies each exact store with its own adapter and stores only encrypted secrets', async t => {
  const f = await fixture(t); status(await f.initialize(), 200);
  const response = await f.configure(TEST_STORES[1].shop); status(response, 200); safe(response.body);
  assert.equal(data(response).shop, TEST_STORES[1].shop); assert.equal(data(response).verified, true);
  assert.equal(data(response).secretReturned, false); assert.equal(data(response).secretStorage, 'server encrypted database');
  assert.equal(f.factories.length, 1);
  const options = f.factories[0];
  assert.deepEqual(options.env, {}); assert.equal(options.useKeychain, false); assert.equal(options.test, true);
  assert.equal(options.authMode, 'client_credentials'); assert.equal(options.clientId, CLIENT); assert.equal(options.getSecret(), SECRET);
  const rows = (await f.db.query('SELECT * FROM provider_test_stores ORDER BY shop')).rows;
  const stored = rows.find(row => row.shop === TEST_STORES[1].shop);
  assert.ok(stored.credentials_encrypted); assert.ok(!stored.credentials_encrypted.includes(SECRET));
  assert.deepEqual(f.auth.decrypt(stored.credentials_encrypted), { clientSecret: SECRET });
  assert.equal(rows.find(row => row.shop === TEST_STORES[2].shop).credentials_encrypted, null);
  const view = await f.owner({ method: 'GET', url: '/api/unified-checkout/options' }); status(view, 200); safe(view.body);
  assert.equal(data(view).stores.find(store => store.shop === TEST_STORES[1].shop).connected, true);
  assert.equal(data(view).stores.find(store => store.shop === TEST_STORES[2].shop).connected, false);
  safe(f.logs.join('')); assert.equal(f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('Shopify credential setup requires owner CSRF and never accepts remote credential submission', async t => {
  const f = await fixture(t), url = '/api/local/shopify-test-credentials';
  const payload = { shop: TEST_STORES[1].shop, clientId: CLIENT, clientSecret: SECRET, confirmOwnedStore: true };
  status(await f.request({ method: 'POST', url, payload }), 401);
  status(await f.request({ method: 'POST', url, payload, headers: { cookie: f.cookie } }), 403);
  const tenant = await f.auth.createSession({ brandId: 'other_tenant' });
  status(await f.request({ method: 'POST', url, payload, headers: { cookie: `avf_session=${tenant.token}`, 'x-csrf-token': tenant.csrfToken } }), 403);
  status(await f.owner({ method: 'POST', url, payload, remoteAddress: '198.51.100.8' }), 403);
  assert.equal(f.factories.length, 0); safe(f.logs.join(''));
});

test('unsupported store, missing ownership, live overrides and My Store 2 credential replacement are denied', async t => {
  const f = await fixture(t); status(await f.initialize(), 200);
  const url = '/api/local/shopify-test-credentials';
  const valid = { shop: TEST_STORES[1].shop, clientId: CLIENT, clientSecret: SECRET, confirmOwnedStore: true };
  for (const payload of [{ ...valid, shop: 'foreign.myshopify.com' }, { ...valid, confirmOwnedStore: false }, { ...valid, live: true }, { ...valid, clientId: 'not-a-client-id' }]) {
    const response = await f.owner({ method: 'POST', url, payload }); status(response, 422); safe(response.body);
  }
  const ownStore = await f.configure(TEST_STORES[0].shop); status(ownStore, 409);
  assert.equal(ownStore.json().error.code, 'OWN_STORE_ALREADY_CONFIGURED'); assert.equal(f.factories.length, 0); safe(f.logs.join(''));
});

test('wrong provider identity, currency or extra scopes cannot persist candidate credentials', async t => {
  const f = await fixture(t); status(await f.initialize(), 200); const shop = TEST_STORES[1].shop;
  for (const patch of [{ shop: { myshopifyDomain: TEST_STORES[2].shop, currencyCode: 'USD' } },
    { shop: { myshopifyDomain: shop, currencyCode: 'CAD' } }, { grantedScopes: [...SHOPIFY_ALLOWED_SCOPES, 'read_locations'] }]) {
    f.state.checked[shop] = patch;
    const response = await f.configure(shop); status(response, 409); assert.equal(response.json().error.code, 'SHOPIFY_SCOPE_POLICY'); safe(response.body);
    assert.equal((await f.testStores.row(shop)).credentials_encrypted, null);
  }
  safe(f.logs.join('')); assert.equal(f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('a mocked hosted cart exposes unknown tax/total, durable safe IDs and idempotent readback without payment', async t => {
  const f = await fixture(t); await f.ready();
  const create = payload => f.owner({ method: 'POST', url: '/api/unified-checkout/sessions', payload,
    headers: { 'idempotency-key': 'unit_route_cart_request_123' } });
  const response = await create(cart()); status(response, 200); safe(response.body);
  const result = data(response); assert.equal(result.test, true); assert.equal(result.state, 'checkout_open');
  assert.equal(result.bags.length, 3); assert.equal(result.amounts.subtotalCents, 450); assert.equal(result.amounts.shippingCents, 150);
  assert.equal(result.amounts.taxCents, null); assert.equal(result.amounts.totalCents, null);
  assert.match(result.checkoutUrl, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  assert.equal(result.stripe.paymentIntentId, null); assert.equal(result.stripe.chargeId, null);
  const again = await create(cart()); status(again, 200); assert.equal(data(again).id, result.id); assert.equal(f.calls.sessions, 1);
  const read = await f.owner({ method: 'GET', url: `/api/unified-checkout/${result.id}` }); status(read, 200); safe(read.body);
  const list = await f.owner({ method: 'GET', url: '/api/unified-checkout' }); status(list, 200); assert.equal(data(list)[0].id, result.id); safe(list.body);
  const reconcile = await f.owner({ method: 'POST', url: `/api/unified-checkout/${result.id}/reconcile`, payload: {} }); status(reconcile, 200);
  assert.equal(data(reconcile).state, 'checkout_open'); assert.equal(f.calls.sessions, 1); assert.equal(f.calls.orders + f.calls.money, 0);
  const notice = await f.owner({ method: 'GET', url: `/api/unified-checkout/${result.id}/notifications` }); status(notice, 200); assert.deepEqual(data(notice), []);
  safe(f.logs.join(''));
});

test('caller amounts, live mode, unsupported shops, duplicate lines and missing idempotency are rejected before session creation', async t => {
  const f = await fixture(t); await f.ready();
  const create = (payload, withKey = true) => f.owner({ method: 'POST', url: '/api/unified-checkout/sessions', payload,
    headers: withKey ? { 'idempotency-key': 'unit_route_rejected_cart_123' } : {} });
  for (const payload of [{ ...cart(), amountCents: 1 }, { ...cart(), live: true }, { ...cart(), shipTo: { country: 'US' } },
    { items: cart().items.map((item, index) => index ? item : { ...item, shop: 'foreign.myshopify.com' }) },
    { items: cart().items.map(item => ({ ...item, quantity: 6 })) }, { items: cart().items.slice(0, 2) },
    { items: [...cart().items, cart().items[0]] }]) status(await create(payload), 422);
  status(await create(cart(), false), 422); assert.equal(f.calls.sessions, 0);
  f.state.mode = 'live'; const live = await create(cart()); status(live, 409); assert.equal(live.json().error.code, 'STRIPE_TEST_REQUIRED');
  assert.equal(f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('strict lifecycle route schemas reject hidden overrides and pass only their bounded service contracts', async t => {
  const f = await fixture(t), received = [];
  const handlers = [
    [f.unifiedCheckout, 'reconcile', `${BASE}/reconcile`, {}, RUN],
    [f.unifiedCheckout, 'setTestClock', `${BASE}/test-clock`, mutations[3][1], [RUN, mutations[3][1]]],
    [f.providerFulfillment, 'fulfill', `${BASE}/fulfill`, mutations[4][1]],
    [f.providerFulfillment, 'sync', `${BASE}/fulfillment-sync`, mutations[5][1]],
    [f.providerFulfillment, 'deliver', `${BASE}/test-delivery`, mutations[6][1]],
    [f.providerMoney, 'refund', `${BASE}/refund`, mutations[7][1]],
    [f.providerMoney, 'settle', `${BASE}/settle`, { confirmTest: true }, { runId: RUN }],
    [f.providerMoney, 'payout', `${BASE}/payout`, mutations[9][1], { runId: RUN, bagId: 'bag_unit', operationId: 'unit_payout' }],
    [f.providerMoney, 'reconcile', `${BASE}/money-reconcile`, {}, { runId: RUN }],
    [f.providerMoney, 'createRecipients', '/api/provider-test/recipients/create', { confirmTest: true }, { confirmTest: true }],
    [f.providerMoney, 'recipientLinks', '/api/provider-test/recipients/links', {}, { baseUrl: 'http://127.0.0.1:4317' }],
    [f.providerMoney, 'cancel', `${BASE}/cancel`, { bagId: 'bag_unit', operationId: 'unit_cancel_operation' }],
    [f.testStores, 'preflight', '/api/provider-test/stores/preflight', { shop: TEST_STORES[0].shop }, TEST_STORES[0].shop],
  ];
  for (const [service, method, url, payload, expected] of handlers) {
    const original = service[method];
    service[method] = async (...args) => { received.push({ method, args }); return { contractFixture: method, test: true }; };
    t.after(() => { service[method] = original; });
    const count = received.length;
    status(await f.owner({ method: 'POST', url, payload: { ...payload, live: true } }), 422); assert.equal(received.length, count);
    const response = await f.owner({ method: 'POST', url, payload }); status(response, 200);
    assert.deepEqual(data(response), { contractFixture: method, test: true });
    const actual = received.at(-1).args;
    assert.deepEqual(actual, method === 'setTestClock' ? expected : [expected ?? { runId: RUN, ...payload }]);
  }
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('explicit confirmations cannot be false or omitted for clock, delivery, recipient creation, settlement or payout', async t => {
  const f = await fixture(t);
  for (const index of [3, 6, 8, 9, 11]) {
    const [url, original] = mutations[index];
    const field = Object.keys(original).find(key => key.startsWith('confirm'));
    const missing = { ...original }; delete missing[field];
    for (const payload of [missing, { ...original, [field]: false }]) status(await f.owner({ method: 'POST', url, payload }), 422);
  }
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.money, 0);
});

test('paused or disconnected canonical brands fail checkout preflight before a new hosted Session can authorize payment', async t => {
  const f = await fixture(t); await f.ready();
  const brandId = (await f.testStores.row(TEST_STORES[1].shop)).brand_id;
  for (const brandStatus of ['paused', 'disconnected']) {
    await f.domain.updateBrand(brandId, { status: brandStatus });
    const options = await f.owner({ method: 'GET', url: '/api/unified-checkout/options' }); status(options, 200);
    assert.ok(data(options).blockers.some(blocker => blocker.shop === TEST_STORES[1].shop && blocker.code === 'TEST_BRAND_NOT_ACCEPTING_ORDERS'));
    assert.equal(data(options).stores.find(store => store.shop === TEST_STORES[1].shop).connected, false);
    const checkout = await f.owner({ method: 'POST', url: '/api/unified-checkout/sessions', payload: cart(),
      headers: { 'idempotency-key': `unit_paused_brand_${brandStatus}_request` } });
    status(checkout, 409); assert.equal(checkout.json().error.code, 'TEST_BRAND_NOT_ACCEPTING_ORDERS');
    assert.equal(f.calls.sessions + f.calls.orders + f.calls.money, 0);
    assert.equal((await f.domain.getBrand(brandId)).status, brandStatus, 'A healthy remote preflight must never silently unpause a brand.');
  }
  assert.equal((await f.db.query('SELECT COUNT(*)::int n FROM unified_checkout_runs')).rows[0].n, 0);
});

test('fixture inspect/create, catalog sync and reconciliation-report routes expose only bounded local-owner contracts', async t => {
  const f = await fixture(t), received = [];
  const inspect = f.providerFixtures.inspect, create = f.providerFixtures.create;
  const catalog = f.providerCatalog.sync, report = f.providerReconciliation.reconcile;
  t.after(() => { f.providerFixtures.inspect = inspect; f.providerFixtures.create = create;
    f.providerCatalog.sync = catalog; f.providerReconciliation.reconcile = report; });
  f.providerFixtures.inspect = async input => { received.push(['inspect', input]); return { test: true, shop: input.shop, found: false, publicationVerified: false }; };
  f.providerFixtures.create = async input => { received.push(['create', input]); return { test: true, shop: input.shop, mutationAttempted: false, manualPublicationCheckRequired: true }; };
  f.providerCatalog.sync = async input => { received.push(['catalog', input]); return { test: true, shop: input.shop, complete: true, sourceProductCount: 0 }; };
  f.providerReconciliation.reconcile = async input => { received.push(['report', input]); return { test: true, runId: input.runId, status: 'pending', matched: false }; };
  const shop = TEST_STORES[1].shop;
  const view = await f.owner({ method: 'GET', url: `/api/provider-test/fixtures?shop=${shop}` }); status(view, 200);
  assert.deepEqual(received.pop(), ['inspect', { shop }]); assert.equal(data(view).publicationVerified, false);
  for (const query of ['', `?shop=${TEST_STORES[0].shop}`, '?shop=foreign.myshopify.com'])
    status(await f.owner({ method: 'GET', url: `/api/provider-test/fixtures${query}` }), 422);
  for (const payload of [{ shop }, { shop, confirmTest: false }, { shop, confirmTest: true, live: true },
    { shop: TEST_STORES[0].shop, confirmTest: true }])
    status(await f.owner({ method: 'POST', url: '/api/provider-test/fixtures', payload }), 422);
  assert.equal(received.length, 0);
  const created = await f.owner({ method: 'POST', url: '/api/provider-test/fixtures', payload: { shop, confirmTest: true } }); status(created, 200);
  assert.deepEqual(received.pop(), ['create', { shop, confirmTest: true }]); assert.equal(data(created).manualPublicationCheckRequired, true);
  for (const payload of [{ shop: 'foreign.myshopify.com' }, { shop, brandId: 'other_tenant' }, { shop, products: [] }])
    status(await f.owner({ method: 'POST', url: '/api/provider-test/catalog/sync', payload }), 422);
  const synced = await f.owner({ method: 'POST', url: '/api/provider-test/catalog/sync', payload: { shop } }); status(synced, 200);
  assert.deepEqual(received.pop(), ['catalog', { shop }]); assert.equal(data(synced).complete, true);
  status(await f.owner({ method: 'POST', url: `${BASE}/reconciliation-report`, payload: { repairLedger: true } }), 422);
  const reported = await f.owner({ method: 'POST', url: `${BASE}/reconciliation-report`, payload: {} }); status(reported, 200);
  assert.deepEqual(received.pop(), ['report', { runId: RUN }]); assert.equal(data(reported).matched, false);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('live-mode apps and remote listeners with local bootstrap fail before database/provider initialization', async () => {
  await assert.rejects(createApp({ config: { mode: 'live' } }), /sandbox-only/);
  await assert.rejects(createApp({ config: { host: '0.0.0.0', allowLocalBootstrap: true } }), /loopback listener/);
  await assert.rejects(createApp({ config: { publicBaseUrl: 'https://public.example', allowLocalBootstrap: true } }), /Disable local owner bootstrap/);
});

test('the one fixed platform-switch route requires owner CSRF and loopback origin before calling its service', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/platform-switch', received = [];
  assert.equal(typeof f.providerPlatformSwitch?.switchPlatform, 'function', 'createApp must construct and decorate the service.');
  const original = f.providerPlatformSwitch.switchPlatform;
  f.providerPlatformSwitch.switchPlatform = async input => { received.push(input); return { switchId: 'platform_switch_unit', test: true }; };
  t.after(() => { f.providerPlatformSwitch.switchPlatform = original; });
  const payload = platformSwitch(), tenant = await f.auth.createSession({ brandId: 'unrelated_platform_tenant' });
  status(await f.request({ method: 'POST', url, payload }), 401);
  const csrf = await f.request({ method: 'POST', url, payload, headers: { cookie: f.cookie } }); status(csrf, 403);
  assert.equal(csrf.json().error.code, 'CSRF_REQUIRED');
  const brand = await f.request({ method: 'POST', url, payload, headers: { cookie: `avf_session=${tenant.token}`, 'x-csrf-token': tenant.csrfToken } });
  status(brand, 403); assert.equal(brand.json().error.code, 'ADMIN_REQUIRED');
  const foreignOrigin = await f.owner({ method: 'POST', url, payload, headers: { origin: 'https://untrusted.example' } });
  status(foreignOrigin, 403); assert.equal(foreignOrigin.json().error.code, 'ORIGIN_DENIED');
  const remote = await f.owner({ method: 'POST', url, payload, remoteAddress: '198.51.100.8', headers: { 'x-forwarded-for': '127.0.0.1' } });
  status(remote, 403); assert.equal(remote.json().error.code, 'LOCAL_TEST_ONLY');
  status(await f.owner({ method: 'POST', url, payload, headers: { host: 'public.example' } }), 403);
  assert.equal(received.length, 0);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('platform-switch route rejects unknown fields, changed account/proof literals and false or missing attestation', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/platform-switch', received = [];
  const original = f.providerPlatformSwitch.switchPlatform;
  f.providerPlatformSwitch.switchPlatform = async input => { received.push(input); return { switchId: 'platform_switch_unit', test: true }; };
  t.after(() => { f.providerPlatformSwitch.switchPlatform = original; });
  const valid = platformSwitch();
  const missingAttestation = { ...valid }; delete missingAttestation.operatorVerifiedNoProviderObjects;
  for (const payload of [{ ...valid, live: true }, { ...valid, resetAttempts: true },
    { ...valid, fromAccountId: valid.toAccountId }, { ...valid, toAccountId: 'acct_unapproved123' },
    { ...valid, providerRejectedRequestId: 'req_unapproved123' }, { ...valid, operatorVerifiedNoProviderObjects: false },
    missingAttestation, { ...valid, retireRunIds: [] }, { ...valid, retireRunIds: ['uco_malformed'] },
    { ...valid, retireRunIds: Array.from({ length: 21 }, () => RUN) }]) {
    const response = await f.owner({ method: 'POST', url, payload }); status(response, 422);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR'); safe(response.body);
  }
  assert.equal(received.length, 0); assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('an authorized fixed platform-switch payload is passed unchanged and only its safe switch ID is audited', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/platform-switch', received = [], audits = [];
  const original = f.providerPlatformSwitch.switchPlatform, originalAudit = f.auth.audit;
  f.providerPlatformSwitch.switchPlatform = async input => { received.push(input); return {
    switchId: 'platform_switch_unit', ...APPROVED_TEST_PLATFORM_SWITCH, retiredRunIds: input.retireRunIds,
    archivedRecipientAttempts: 1, test: true, replayed: false, providerObjectsCreated: 0,
    verification: 'explicit_operator_attestation_not_automatic_discovery',
  }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ role: ctx.role, owner: ctx.owner, action, target }); };
  t.after(() => { f.providerPlatformSwitch.switchPlatform = original; f.auth.audit = originalAudit; });
  const payload = platformSwitch(), response = await f.owner({ method: 'POST', url, payload }); status(response, 200); safe(response.body);
  assert.deepEqual(received, [payload]); assert.equal(data(response).providerObjectsCreated, 0);
  assert.equal(data(response).verification, 'explicit_operator_attestation_not_automatic_discovery');
  assert.deepEqual(audits, [{ role: 'admin', owner: true, action: 'provider_test.platform_switch_recorded', target: 'platform_switch_unit' }]);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('rejected-recipient revision requires owner CSRF and loopback origin before invoking provider money', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/recipients/revise-rejected', received = [];
  const original = f.providerMoney.reviseRejectedRecipient;
  f.providerMoney.reviseRejectedRecipient = async input => { received.push(input); return { shop: input.shop, accountId: 'acct_unitRevision123', parameterRevision: 2, test: true }; };
  t.after(() => { f.providerMoney.reviseRejectedRecipient = original; });
  const payload = rejectedRecipientRevision(), tenant = await f.auth.createSession({ brandId: 'unrelated_revision_tenant' });
  status(await f.request({ method: 'POST', url, payload }), 401);
  const csrf = await f.request({ method: 'POST', url, payload, headers: { cookie: f.cookie } }); status(csrf, 403);
  assert.equal(csrf.json().error.code, 'CSRF_REQUIRED');
  const brand = await f.request({ method: 'POST', url, payload, headers: { cookie: `avf_session=${tenant.token}`, 'x-csrf-token': tenant.csrfToken } });
  status(brand, 403); assert.equal(brand.json().error.code, 'ADMIN_REQUIRED');
  const foreign = await f.owner({ method: 'POST', url, payload, headers: { origin: 'https://untrusted.example' } });
  status(foreign, 403); assert.equal(foreign.json().error.code, 'ORIGIN_DENIED');
  const remote = await f.owner({ method: 'POST', url, payload, remoteAddress: '198.51.100.8', headers: { 'x-forwarded-for': '127.0.0.1' } });
  status(remote, 403); assert.equal(remote.json().error.code, 'LOCAL_TEST_ONLY');
  status(await f.owner({ method: 'POST', url, payload, headers: { host: 'public.example' } }), 403);
  assert.equal(received.length, 0); assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('rejected-recipient revision permits only the fixed shop/rejection proof and exact explicit confirmation', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/recipients/revise-rejected', received = [];
  const original = f.providerMoney.reviseRejectedRecipient;
  f.providerMoney.reviseRejectedRecipient = async input => { received.push(input); return { shop: input.shop, parameterRevision: 2, test: true }; };
  t.after(() => { f.providerMoney.reviseRejectedRecipient = original; });
  const valid = rejectedRecipientRevision(), missing = { ...valid }; delete missing.confirmRejectedBeforeCreation;
  for (const payload of [{ ...valid, shop: TEST_STORES[1].shop }, { ...valid, shop: 'foreign.myshopify.com' },
    { ...valid, providerRequestId: 'req_differentProof' }, { ...valid, confirmRejectedBeforeCreation: false }, missing,
    { ...valid, live: true }, { ...valid, contactEmail: 'caller@example.com' }, { ...valid, parameterRevision: 99 },
    { ...valid, forceRetry: true }, { ...valid, accountId: 'acct_callerSupplied123' }]) {
    const response = await f.owner({ method: 'POST', url, payload }); status(response, 422);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR'); safe(response.body);
  }
  assert.equal(received.length, 0); assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('authorized rejected-recipient revision delegates unchanged proof and audits only the fixed shop', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/recipients/revise-rejected', received = [], audits = [];
  const original = f.providerMoney.reviseRejectedRecipient, originalAudit = f.auth.audit;
  f.providerMoney.reviseRejectedRecipient = async input => { received.push(input); return { shop: input.shop,
    accountId: 'acct_unitRevision123', parameterRevision: 2, test: true }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, role: ctx.role, action, target }); };
  t.after(() => { f.providerMoney.reviseRejectedRecipient = original; f.auth.audit = originalAudit; });
  const payload = rejectedRecipientRevision(), response = await f.owner({ method: 'POST', url, payload }); status(response, 200); safe(response.body);
  assert.deepEqual(received, [payload]); assert.equal(data(response).parameterRevision, 2); assert.equal(data(response).accountId, 'acct_unitRevision123');
  assert.deepEqual(audits, [{ owner: true, role: 'admin', action: 'provider_test.rejected_recipient_revision', target: TEST_STORES[0].shop }]);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('Accounts v2 rejected-recipient revision accepts only its fixed proof and exact payload and keeps a stable shop audit', async t => {
  const f = await fixture(t), url = '/api/local/provider-test/recipients/revise-v2', received = [], audits = [];
  const original = f.providerMoney.reviseRejectedRecipientV2, originalAudit = f.auth.audit;
  f.providerMoney.reviseRejectedRecipientV2 = async input => { received.push(input); return { shop: input.shop, accountId: 'acct_unitV2recipient123', parameterRevision: 3, test: true }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, action, target }); };
  t.after(() => { f.providerMoney.reviseRejectedRecipientV2 = original; f.auth.audit = originalAudit; });
  const valid = rejectedRecipientV2(), missing = { ...valid }; delete missing.confirmRejectedBeforeCreation;
  for (const payload of [{ ...valid, providerRequestId: rejectedRecipientRevision().providerRequestId },
    { ...valid, shop: TEST_STORES[1].shop }, { ...valid, confirmRejectedBeforeCreation: false }, missing,
    { ...valid, live: true }, { ...valid, dashboard: 'caller-overridden' }, { ...valid, contactEmail: 'caller@example.com' },
    { ...valid, parameterRevision: 4 }]) status(await f.owner({ method: 'POST', url, payload }), 422);
  assert.equal(received.length, 0);
  const response = await f.owner({ method: 'POST', url, payload: valid }); status(response, 200); safe(response.body);
  assert.deepEqual(received, [valid]); assert.equal(data(response).parameterRevision, 3);
  assert.deepEqual(audits, [{ owner: true, action: 'provider_test.rejected_recipient_accounts_v2_revision', target: TEST_STORES[0].shop }]);
  assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('refund preview is an owner-only read of an exact complete tagged TEST order with unique mapped SKUs and no caller financial overrides', async t => {
  const f = await fixture(t), url = '/api/provider-test/refund-preview', previews = [], reads = [];
  const original = f.testStores.forShop;
  let order = { id: refundPreview().orderId, test: true, operationsComplete: true, tags: ['TEST_DO_NOT_SHIP'],
    lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1002', sku: 'UNIT-SKU' }] } };
  f.testStores.forShop = async shop => ({
    getOrderOperations: async id => { reads.push({ shop, id }); return structuredClone(order); },
    getSuggestedRefund: async input => { previews.push(input); return { test: true, orderId: input.orderId, previewOnly: true }; },
  });
  t.after(() => { f.testStores.forShop = original; });
  const valid = refundPreview();
  for (const payload of [{ ...valid, shop: 'foreign.myshopify.com' }, { ...valid, amountCents: 1 },
    { ...valid, orderId: 'not-an-order' }, { ...valid, shippingCents: -1 }, { ...valid, shippingCents: 10001 },
    { ...valid, items: [{ sku: 'UNIT-SKU', qty: 0 }] }, { ...valid, items: [{ sku: 'UNIT-SKU', qty: 6 }] },
    { ...valid, items: [{ sku: 'UNIT-SKU', qty: 1, lineItemId: 'caller-selected' }] },
    { ...valid, items: [valid.items[0], valid.items[0]] }]) status(await f.owner({ method: 'POST', url, payload }), 422);
  assert.equal(reads.length, 0); assert.equal(previews.length, 0);
  const response = await f.owner({ method: 'POST', url, payload: valid }); status(response, 200);
  assert.deepEqual(reads, [{ shop: TEST_STORES[0].shop, id: valid.orderId }]);
  assert.deepEqual(previews, [{ orderId: valid.orderId, lineItems: [{ lineItemId: 'gid://shopify/LineItem/1002', quantity: 1 }], shippingAmountCents: 0 }]);
  for (const patch of [{ test: false }, { operationsComplete: false }, { tags: [] }]) {
    const prior = order; order = { ...order, ...patch };
    status(await f.owner({ method: 'POST', url, payload: valid }), 409); order = prior;
  }
  order.lineItems.nodes.push({ id: 'gid://shopify/LineItem/1003', sku: 'UNIT-SKU' });
  status(await f.owner({ method: 'POST', url, payload: valid }), 422); assert.equal(previews.length, 1);
  assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('hosted onboarding redirect is local-owner only, selects the requested exact shop, and rejects unknown query fields or non-Stripe origins', async t => {
  const f = await fixture(t), received = [];
  const original = f.providerMoney.recipientLinks;
  let url = 'https://connect.stripe.com/setup/UNIT_FAKE_ONE_USE_CAPABILITY';
  f.providerMoney.recipientLinks = async input => { received.push(input); return [
    { shop: TEST_STORES[1].shop, url: 'https://connect.stripe.com/setup/UNIT_OTHER_FAKE_CAPABILITY' }, { shop: TEST_STORES[0].shop, url },
  ]; };
  t.after(() => { f.providerMoney.recipientLinks = original; });
  for (const query of ['', '?shop=foreign.myshopify.com', `?shop=${TEST_STORES[0].shop}&redirect=https://untrusted.example`])
    status(await f.owner({ method: 'GET', url: `/api/provider-test/recipients/onboard${query}` }), 422);
  assert.equal(received.length, 0);
  const path = `/api/provider-test/recipients/onboard?shop=${TEST_STORES[0].shop}`;
  const response = await f.owner({ method: 'GET', url: path }); status(response, 302);
  assert.equal(response.headers.location, url); assert.deepEqual(received, [{ baseUrl: 'http://127.0.0.1:4317' }]);
  url = 'https://accounts.stripe.com/r/acct_UNITTESTRECIPIENT123#alu_test_UNIT_FAKE_CAPABILITY';
  const v2 = await f.owner({ method: 'GET', url: path }); status(v2, 302);
  assert.equal(v2.headers.location, url, 'Official Accounts v2 origin/path and its synthetic fragment must be retained.');
  for (const invalid of ['https://untrusted.example/setup/UNIT', 'https://connect.stripe.com.untrusted.example/setup/UNIT',
    'http://connect.stripe.com/setup/UNIT', 'https://user:UNIT_FAKE_PASSWORD@connect.stripe.com/setup/UNIT',
    'https://connect.stripe.com:8443/setup/UNIT', 'https://connect.stripe.com/not-setup/UNIT',
    'https://accounts.stripe.com/setup/UNIT', 'https://accounts.stripe.com/r/acct_bad',
    'https://accounts.stripe.com/r/not_an_account', 'https://accounts.stripe.com:8443/r/acct_UNITTESTRECIPIENT123',
    'https://accounts.stripe.com.untrusted.example/r/acct_UNITTESTRECIPIENT123']) {
    url = invalid; const rejected = await f.owner({ method: 'GET', url: path }); status(rejected, 409);
    assert.equal(rejected.headers.location, undefined);
  }
  assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('automation routes require a strict three-Bag TEST policy, pass unchanged inputs, and audit only stable policy/run IDs', async t => {
  const f = await fixture(t), calls = [], audits = [];
  assert.equal(typeof f.providerAutomation?.configure, 'function');
  const original = { configure: f.providerAutomation.configure, disable: f.providerAutomation.disable, get: f.providerAutomation.get, audit: f.auth.audit };
  f.providerAutomation.configure = async input => { calls.push(['configure', input]); return { runId: input.runId, policyId: 'autopol_unit', test: true, enabled: true }; };
  f.providerAutomation.disable = async input => { calls.push(['disable', input]); return { runId: input.runId, policyId: 'autopol_unit', test: true, enabled: false }; };
  f.providerAutomation.get = async runId => { calls.push(['get', runId]); return { runId, test: true, configured: false, enabled: false }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, action, target }); };
  t.after(() => { Object.assign(f.providerAutomation, { configure: original.configure, disable: original.disable, get: original.get }); f.auth.audit = original.audit; });
  const valid = automationPolicy(), url = `${BASE}/automation/configure`;
  for (const payload of [{ ...valid, confirmTest: false }, { ...valid, autoSettle: false }, { ...valid, autoPayout: false },
    { ...valid, live: true }, { ...valid, payoutGates: valid.payoutGates.slice(0,2) },
    { ...valid, payoutGates: [...valid.payoutGates, valid.payoutGates[0]] },
    { ...valid, payoutGates: valid.payoutGates.map(gate => ({ ...gate, expectedCents: 1 })) },
    { ...valid, payoutGates: valid.payoutGates.map(gate => ({ ...gate, refundOperationId: 'unsafe operation !' })) }])
    status(await f.owner({ method: 'POST', url, payload }), 422);
  assert.equal(calls.length, 0);
  const configured = await f.owner({ method: 'POST', url, payload: valid }); status(configured, 200);
  assert.deepEqual(calls.pop(), ['configure', { runId: RUN, ...valid }]); assert.equal(data(configured).enabled, true);
  for (const payload of [{ confirmTest: false }, { confirmTest: true, enabled: true }])
    status(await f.owner({ method: 'POST', url: `${BASE}/automation/disable`, payload }), 422);
  const disabled = await f.owner({ method: 'POST', url: `${BASE}/automation/disable`, payload: { confirmTest: true } }); status(disabled, 200);
  assert.deepEqual(calls.pop(), ['disable', { runId: RUN, confirmTest: true }]); assert.equal(data(disabled).enabled, false);
  const view = await f.owner({ method: 'GET', url: `${BASE}/automation` }); status(view, 200);
  assert.deepEqual(calls.pop(), ['get', RUN]); assert.equal(data(view).enabled, false);
  assert.deepEqual(audits, [
    { owner: true, action: 'provider_test.money_automation_configured', target: 'autopol_unit' },
    { owner: true, action: 'provider_test.money_automation_disabled', target: RUN },
  ]);
  assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('API provider diagnostics expose only bounded approved request IDs/codes and never raw details, causes or credential-like code values', async t => {
  const f = await fixture(t), original = f.providerMoney.createRecipients;
  let code = 'STRIPE_REQUEST_FAILED', details = { requestId: 'req_UNITREQUEST123', stripeCode: 'parameter_invalid',
    raw: SECRET, clientSecret: FAKE_CLIENT_SECRET, providerMessage: SECRET };
  f.providerMoney.createRecipients = async () => { throw Object.assign(new Error('Provider request was rejected; no success was recorded.'), {
    code, statusCode: 502, details, cause: { message: SECRET, raw: FAKE_CLIENT_SECRET },
  }); };
  t.after(() => { f.providerMoney.createRecipients = original; });
  const request = () => f.owner({ method: 'POST', url: '/api/provider-test/recipients/create', payload: { confirmTest: true } });
  for (const approved of ['STRIPE_REQUEST_FAILED', 'RECIPIENT_CREATION_UNCERTAIN', 'RECIPIENT_REVISION_UNCERTAIN', 'RECIPIENT_RETRY_UNCERTAIN']) {
    code = approved; const response = await request(); status(response, 502); safe(response.body);
    assert.deepEqual(response.json().error, { code, message: 'Provider request was rejected; no success was recorded.',
      requestId: 'req_UNITREQUEST123', stripeCode: 'parameter_invalid' });
  }
  code = 'UNRELATED_UNIT_ERROR'; const unrelated = await request(); status(unrelated, 502);
  assert.equal(unrelated.json().error.requestId, undefined); assert.equal(unrelated.json().error.stripeCode, undefined); safe(unrelated.body);
  code = 'STRIPE_REQUEST_FAILED';
  for (const bad of [
    { requestId: 'https://example.com/req_UNIT', stripeCode: 'not a safe identifier' },
    { requestId: `req_${'X'.repeat(101)}`, stripeCode: 'X'.repeat(81) },
    { requestId: `req_${SECRET}`, stripeCode: SECRET },
    { requestId: 'invalid', stripeCode: 'sk_test_UNIT_SYNTHETIC_KEY_NEVER_ECHO' },
    { requestId: 'invalid', stripeCode: 'whsec_UNIT_SYNTHETIC_SECRET_NEVER_ECHO' },
    { requestId: 'invalid', stripeCode: 'client_secret_UNIT_SYNTHETIC_NEVER_ECHO' },
  ]) {
    details = { ...bad, raw: SECRET }; const response = await request(); status(response, 502);
    assert.equal(response.json().error.requestId, undefined); assert.equal(response.json().error.stripeCode, undefined); safe(response.body);
    assert.ok(!response.body.includes(bad.stripeCode));
  }
  safe(f.logs.join('')); assert.equal(f.calls.stripeReads + f.calls.money + f.calls.sessions, 0);
});

test('unwritten refund proposal revision requires local owner CSRF, exact confirmation and a strict no-provider-write contract', async t => {
  const f = await fixture(t), calls = [], audits = [];
  const url = `${BASE}/refund-proposal/revise`;
  const valid = { bagId: 'bag_unit', operationId: 'unit_refund_proposal', confirmNoProviderWrites: true };
  const original = f.providerMoney.reviseRefundProposal, audit = f.auth.audit;
  f.providerMoney.reviseRefundProposal = async input => {
    calls.push(input); return { test: true, runId: input.runId, bagId: input.bagId, operationId: input.operationId,
      revised: true, providerWrites: false };
  };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, action, target }); };
  t.after(() => { f.providerMoney.reviseRefundProposal = original; f.auth.audit = audit; });
  const tenant = await f.auth.createSession({ brandId: 'unrelated_revision_tenant' });
  const brand = await f.domain.createBrand({ name: 'Revision Unit Tenant', slug: 'revision-unit-tenant', commissionBps: 1500 });
  const credential = await f.auth.createCredential(brand.id);
  status(await f.request({ method: 'POST', url, payload: valid }), 401);
  for (const options of [
    { headers: { cookie: f.cookie } },
    { headers: { cookie: f.cookie, 'x-csrf-token': 'invalid_csrf' } },
    { headers: { cookie: `avf_session=${tenant.token}`, 'x-csrf-token': tenant.csrfToken } },
    { headers: { authorization: `Bearer ${credential.apiKey}` } },
  ]) status(await f.request({ method: 'POST', url, payload: valid, ...options }), 403);
  for (const options of [
    { remoteAddress: '198.51.100.8', headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { host: 'public.example' } },
    { headers: { origin: 'https://untrusted.example' } },
  ]) status(await f.owner({ method: 'POST', url, payload: valid, ...options }), 403);
  for (const payload of [
    { bagId: valid.bagId, operationId: valid.operationId },
    { ...valid, confirmNoProviderWrites: false }, { ...valid, confirmNoProviderWrites: 'true' },
    { ...valid, bagId: '' }, { ...valid, bagId: 'b'.repeat(201) },
    { ...valid, operationId: 'short' }, { ...valid, operationId: 'unsafe operation !' },
    { ...valid, operationId: 'x'.repeat(121) },
    { ...valid, live: true }, { ...valid, runId: 'uco_other' }, { ...valid, amountCents: 1 },
    { ...valid, items: [{ sku: 'UNIT-SKU', qty: 1 }] }, { ...valid, refundShipping: true },
    { ...valid, allowProviderWrites: true }, { ...valid, stripeRefundId: 're_unit_fake' },
  ]) status(await f.owner({ method: 'POST', url, payload }), 422);
  assert.equal(calls.length, 0); assert.equal(audits.length, 0);
  const response = await f.owner({ method: 'POST', url, payload: valid }); status(response, 200); safe(response.body);
  assert.deepEqual(calls, [{ runId: RUN, ...valid }]);
  assert.deepEqual(data(response), { test: true, runId: RUN, bagId: valid.bagId, operationId: valid.operationId,
    revised: true, providerWrites: false });
  assert.deepEqual(audits, [{ owner: true, action: 'provider_test.unwritten_refund_proposal_revised', target: `${RUN}:${valid.operationId}` }]);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
  safe(f.logs.join(''));
});

test('tax evidence and reporting routes delegate exact owner-controlled bindings without accepting caller tax amounts', async t => {
  const f = await fixture(t), calls = [], audits = [];
  const service = f.providerTaxReconciliation;
  assert.equal(typeof service?.configureEvidence, 'function'); assert.equal(typeof service?.reconcile, 'function');
  const original = { configureEvidence: service.configureEvidence, reconcile: service.reconcile, audit: f.auth.audit };
  service.configureEvidence = async input => { calls.push(['configure', input]); return { test: true, runId: input.runId, evidenceId: 'taxevidence_unit', configured: true, providerWrites: false }; };
  service.reconcile = async input => { calls.push(['reconcile', input]); return { test: true, runId: input.runId, reportId: TAX_REPORT, reportHash: 'c'.repeat(64), status: 'tax_review', providerWrites: false }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, action, target }); };
  t.after(() => { Object.assign(service, { configureEvidence: original.configureEvidence, reconcile: original.reconcile }); f.auth.audit = original.audit; });
  const brand = await f.domain.createBrand({ name: 'Tax Unit Tenant', slug: 'tax-unit-tenant', commissionBps: 1500 });
  const credential = await f.auth.createCredential(brand.id);
  for (const [url, payload] of mutations.slice(-3)) {
    const bearer = await f.request({ method: 'POST', url, payload, headers: { authorization: `Bearer ${credential.apiKey}` } });
    status(bearer, 403); assert.equal(bearer.json().error.code, 'BROWSER_SESSION_REQUIRED');
  }
  const valid = taxEvidence();
  for (const payload of [
    { ...valid, amountCents: 1 }, { ...valid, taxCents: 1 }, { ...valid, live: true }, { ...valid, runId: RUN },
    { ...valid, originalTaxTransactionId: 'pi_unitPayment123' }, { ...valid, originalTaxTransactionId: 'tax_bad/path' },
    { ...valid, refunds: [{ ...valid.refunds[0], amountCents: 1 }] },
    { ...valid, refunds: [{ ...valid.refunds[0], refundId: 'tax_unitOriginal123' }] },
    { ...valid, binding: { kind: 'api_reference', confirmedByOwner: true } },
    { ...valid, binding: { kind: 'operator_dashboard', artifactRef: 'unit_tax_snapshot', evidenceSha256: 'e'.repeat(64), confirmedByOwner: false } },
    { ...valid, binding: { kind: 'operator_dashboard', artifactRef: 'unit_tax_snapshot', evidenceSha256: 'not-a-sha256', confirmedByOwner: true } },
    { ...valid, binding: { kind: 'operator_dashboard', evidenceSha256: 'e'.repeat(64), confirmedByOwner: true } },
    { ...valid, binding: { kind: 'caller_asserted_amount', amount: 1 } },
  ]) { const response = await f.owner({ method: 'POST', url: `${BASE}/tax-evidence`, payload }); status(response, 422); safe(response.body); }
  for (const payload of [{ taxCents: 1 }, { repairLedger: true }, { createReversal: true }, { live: true }])
    status(await f.owner({ method: 'POST', url: `${BASE}/tax-reconciliation-report`, payload }), 422);
  assert.equal(calls.length, 0); assert.equal(audits.length, 0);
  const configured = await f.owner({ method: 'POST', url: `${BASE}/tax-evidence`, payload: valid }); status(configured, 200); safe(configured.body);
  assert.deepEqual(calls.pop(), ['configure', { runId: RUN, ...valid }]); assert.equal(data(configured).providerWrites, false);
  const dashboard = { ...valid, binding: { kind: 'operator_dashboard', artifactRef: 'unit_tax_snapshot', evidenceSha256: 'e'.repeat(64), confirmedByOwner: true } };
  const attested = await f.owner({ method: 'POST', url: `${BASE}/tax-evidence`, payload: dashboard }); status(attested, 200);
  assert.deepEqual(calls.pop(), ['configure', { runId: RUN, ...dashboard }]);
  const report = await f.owner({ method: 'POST', url: `${BASE}/tax-reconciliation-report`, payload: {} }); status(report, 200); safe(report.body);
  assert.deepEqual(calls.pop(), ['reconcile', { runId: RUN }]); assert.equal(data(report).reportId, TAX_REPORT);
  assert.deepEqual(audits, [
    { owner: true, action: 'provider_test.tax_evidence_bound', target: RUN },
    { owner: true, action: 'provider_test.tax_evidence_bound', target: RUN },
  ]);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0); safe(f.logs.join(''));
});

test('tax report reads and platform-only rounding verify report-to-run identity before delegating a local record', async t => {
  const f = await fixture(t), calls = [], audits = []; const service = f.providerTaxReconciliation;
  assert.equal(typeof service?.getReport, 'function'); assert.equal(typeof service?.recordRounding, 'function');
  const original = { getReport: service.getReport, recordRounding: service.recordRounding, audit: f.auth.audit };
  let reportRun = RUN;
  service.getReport = async input => { calls.push(['get', input]); return { test: true, runId: reportRun, reportId: input.reportId, reportHash: 'c'.repeat(64), status: 'tax_review', platformOnly: true }; };
  service.recordRounding = async input => { calls.push(['rounding', input]); return { test: true, runId: RUN, reportId: input.reportId,
    operationId: input.operationId, platformOnly: true, providerWrites: false, roundingRecordId: 'taxrounding_unit' }; };
  f.auth.audit = async (ctx, action, target) => { audits.push({ owner: ctx.owner, action, target }); };
  t.after(() => { Object.assign(service, { getReport: original.getReport, recordRounding: original.recordRounding }); f.auth.audit = original.audit; });
  const url = `${BASE}/tax-reconciliation-report/${TAX_REPORT}`;
  const read = await f.owner({ method: 'GET', url }); status(read, 200); assert.deepEqual(calls.pop(), ['get', { reportId: TAX_REPORT }]); safe(read.body);
  reportRun = `uco_${'e'.repeat(32)}`;
  const foreignRead = await f.owner({ method: 'GET', url }); assert.ok([404,409].includes(foreignRead.statusCode), foreignRead.body);
  const foreignMutation = await f.owner({ method: 'POST', url: `${BASE}/tax-rounding`, payload: taxRounding() });
  assert.ok([404,409].includes(foreignMutation.statusCode), foreignMutation.body);
  assert.ok(calls.every(call => call[0] === 'get')); assert.equal(audits.length, 0);
  reportRun = RUN; calls.length = 0;
  const response = await f.owner({ method: 'POST', url: `${BASE}/tax-rounding`, payload: taxRounding() }); status(response, 200); safe(response.body);
  assert.equal(calls[0][0], 'get'); assert.deepEqual(calls[0][1], { reportId: TAX_REPORT }); assert.equal(calls[1][0], 'rounding'); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], taxRounding());
  assert.equal(data(response).providerWrites, false); assert.equal(data(response).platformOnly, true);
  assert.deepEqual(audits, [{ owner: true, action: 'provider_test.platform_tax_rounding_recorded', target: `${RUN}:${taxRounding().operationId}` }]);
  assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0); safe(f.logs.join(''));
});

test('tax rounding rejects all caller money, provider-write flags, malformed hashes and missing explicit platform-only confirmation', async t => {
  const f = await fixture(t), calls = []; const service = f.providerTaxReconciliation;
  const original = { getReport: service.getReport, recordRounding: service.recordRounding };
  service.getReport = async input => { calls.push(['get', input]); return { runId: RUN, reportId: input.reportId }; };
  service.recordRounding = async input => { calls.push(['rounding', input]); return { test: true, providerWrites: false }; };
  t.after(() => Object.assign(service, original));
  const valid = taxRounding(), missing = { ...valid }; delete missing.confirmPlatformOnly;
  for (const payload of [
    missing, { ...valid, confirmPlatformOnly: false }, { ...valid, confirmPlatformOnly: 'true' },
    { ...valid, reportHash: 'a'.repeat(63) }, { ...valid, reportHash: 'g'.repeat(64) },
    { ...valid, reportId: '' }, { ...valid, operationId: 'short' }, { ...valid, operationId: 'unsafe operation' }, { ...valid, operationId: 'x'.repeat(101) },
    ...['amountCents', 'taxCents', 'deltaCents', 'platformTaxRoundingCents', 'refundCents', 'shippingCents', 'rawAmount', 'amount'].map(key => ({ ...valid, [key]: 1 })),
    { ...valid, live: true }, { ...valid, runId: RUN }, { ...valid, createReversal: true }, { ...valid, issueRefund: true },
    { ...valid, transferToBrand: true }, { ...valid, updateShopify: true }, { ...valid, stripeRefundId: 're_unitRefund123' },
  ]) { const response = await f.owner({ method: 'POST', url: `${BASE}/tax-rounding`, payload }); status(response, 422); safe(response.body); }
  assert.equal(calls.length, 0); assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('tax route failures never expose raw evidence, addresses, secrets or provider response bodies in HTTP or logs', async t => {
  const f = await fixture(t); const service = f.providerTaxReconciliation; const original = service.reconcile;
  service.reconcile = async () => { throw Object.assign(new Error('Tax evidence requires review; no provider writes were attempted.'), {
    code: 'TAX_EVIDENCE_REVIEW', statusCode: 409, details: { raw: SECRET, customer: { address: FAKE_CLIENT_SECRET }, proof: SECRET }, cause: new Error(FAKE_CLIENT_SECRET),
  }); };
  t.after(() => { service.reconcile = original; });
  const response = await f.owner({ method: 'POST', url: `${BASE}/tax-reconciliation-report`, payload: {} }); status(response, 409); safe(response.body);
  assert.deepEqual(response.json().error, { code: 'TAX_EVIDENCE_REVIEW', message: 'Tax evidence requires review; no provider writes were attempted.' });
  safe(f.logs.join('')); assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});

test('dedicated failure-test routes accept only fixed TEST cases, phases and stores and delegate no caller money or provider code', async t => {
  const f = await fixture(t), calls = [];
  const fixtures = f.app.avafem.providerFailureFixtures, checkouts = f.app.avafem.providerFailureCheckouts, readbacks = f.app.avafem.providerFailureReadbacks;
  for (const [service, methods] of [[fixtures, ['inspect','prepare','mutate','restore','cleanup']], [checkouts, ['create','get','list','observe','reconcile','cancel']], [readbacks, ['run','get']]]) {
    for (const method of methods) { const original = service[method]; service[method] = async input => { calls.push({ method, input }); return { test: true, id: RUN, status: 'unit_verified' }; };
      t.after(() => { service[method] = original; }); }
  }
  const rows = [
    ['GET', `/api/provider-test/failure-fixtures?shop=${TEST_STORES[1].shop}`, undefined, 'inspect', { shop: TEST_STORES[1].shop, phase: 'catalog' }],
    ['POST', '/api/provider-test/failure-fixtures/prepare', { shop: TEST_STORES[1].shop, confirmTest: true }, 'prepare'],
    ['POST', '/api/provider-test/failure-fixtures/mutate', { shop: TEST_STORES[1].shop, scenario: 'price_changed', phase: 'checkout', confirmTest: true }, 'mutate'],
    ['POST', '/api/provider-test/failure-fixtures/restore', { shop: TEST_STORES[1].shop, phase: 'checkout', confirmTest: true }, 'restore'],
    ['POST', '/api/provider-test/failure-checkouts', { caseId: 'stock_changed_004', operationId: 'unit_failure_case_004', confirmTest: true }, 'create'],
    ['GET', `/api/provider-test/failure-checkouts/${RUN}`, undefined, 'get', { runId: RUN }],
    ['GET', `/api/provider-test/failure-checkouts/${RUN}/observe`, undefined, 'observe', { runId: RUN }],
    ['POST', `/api/provider-test/failure-checkouts/${RUN}/reconcile`, { confirmTest: true }, 'reconcile', { runId: RUN, confirmTest: true }],
    ['POST', `/api/provider-test/failure-checkouts/${RUN}/cancel`, { confirmTest: true }, 'cancel', { runId: RUN, confirmTest: true }],
    ['POST', '/api/provider-test/failure-fixtures/cleanup', { shop: TEST_STORES[1].shop, confirmTest: true }, 'cleanup'],
    ['POST', '/api/provider-test/failure-readbacks', { confirmTest: true }, 'run'],
    ['GET', '/api/provider-test/failure-readbacks/fra_unit123456789', undefined, 'get', { reportId: 'fra_unit123456789' }],
  ];
  for (const [method, url, payload, expectedMethod, expected] of rows) {
    const response = await f.owner({ method, url, ...(payload ? { payload } : {}) }); status(response, 200); safe(response.body);
    assert.deepEqual(calls.at(-1), { method: expectedMethod, input: expected ?? payload });
  }
  const before = calls.length;
  for (const [url, payload] of [
    ['/api/provider-test/failure-fixtures/prepare', { shop: TEST_STORES[1].shop, confirmTest: false }],
    ['/api/provider-test/failure-fixtures/mutate', { shop: 'unrelated.myshopify.com', scenario: 'out_of_stock', confirmTest: true }],
    ['/api/provider-test/failure-fixtures/mutate', { shop: TEST_STORES[1].shop, scenario: 'delete_all', confirmTest: true }],
    ['/api/provider-test/failure-fixtures/restore', { shop: TEST_STORES[1].shop, phase: 'unknown', confirmTest: true }],
    ['/api/provider-test/failure-checkouts', { caseId: 'paid_checkout', operationId: 'unit_failure_case_004', confirmTest: true }],
    ['/api/provider-test/failure-checkouts', { caseId: 'stock_changed_004', operationId: 'unit_failure_case_004', confirmTest: true, amountCents: 1 }],
    ['/api/provider-test/failure-fixtures/mutate', { shop: TEST_STORES[1].shop, scenario: 'out_of_stock', confirmTest: true, graphql: 'mutation { unsafe }' }],
    [`/api/provider-test/failure-checkouts/${RUN}/reconcile`, { confirmTest: true, capture: true }],
  ]) status(await f.owner({ method: 'POST', url, payload }), 422);
  assert.equal(calls.length, before); assert.equal(f.calls.shopReads + f.calls.stripeReads + f.calls.sessions + f.calls.orders + f.calls.money, 0);
});
