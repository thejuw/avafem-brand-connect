import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIFIED_STORES, normalizeUnifiedOptions, evaluateUnifiedCart, safeStripeCheckoutUrl,
  unifiedCheckoutLink, unifiedRunRecords, safeUnifiedError,
  configureUnifiedShopifyCredentials, clearUnifiedShopifyForm,
  resolveUnifiedCheckoutReturn, loadUnifiedReturnedRun,
  CASH_RECONCILIATION_NOTICE, unifiedCompletionLabel,
} from './unified-checkout.mjs';

const rawOptions = () => ({
  test: true, blockers: [], warnings: [], stripe: { verified: true, mode: 'test', accountId: 'acct_unitTest' },
  stores: UNIFIED_STORES.map((store, index) => ({
    ...store, brandId: `brand_${index}`, connected: true, configured: true,
    shippingCents: [25, 50, 75][index], commissionBps: 1500, returnWindowDays: 30,
    variants: [{ id: `gid://shopify/ProductVariant/${index + 10}`, sku: `TEST-${index}`, title: 'Default Title', productTitle: 'Test item', priceCents: 100, inventoryQty: 10 }],
  })),
});
const cart = () => rawOptions().stores.map(store => ({ shop: store.shop, variantId: store.variants[0].id, quantity: 1 }));

test('Only the exact three authorized test stores can populate unified options', () => {
  const normalized = normalizeUnifiedOptions(rawOptions());
  assert.deepEqual(normalized.stores.map(store => store.shop), UNIFIED_STORES.map(store => store.shop));
  for (const patch of [value => { value.test = false; }, value => { value.stores[0].shop = 'unrelated.myshopify.com'; }, value => { value.stores[1].shop = value.stores[0].shop; }, value => { value.stores.pop(); }]) {
    const raw = rawOptions(); patch(raw);
    assert.throws(() => normalizeUnifiedOptions(raw), /exact authorized stores/);
  }
});

test('One cart requires all three brands, uses actual cents and never fabricates tax or total', () => {
  const evaluated = evaluateUnifiedCart(normalizeUnifiedOptions(rawOptions()), cart());
  assert.equal(evaluated.valid, true);
  assert.equal(evaluated.subtotalCents, 300);
  assert.equal(evaluated.shippingCents, 150);
  assert.equal(evaluated.taxCents, null); assert.equal(evaluated.totalCents, null);
  assert.equal(evaluated.items.length, 3);
  assert.ok(evaluated.items.every(item => Object.keys(item).sort().join(',') === 'quantity,shop,variantId'));
  assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(rawOptions()), cart().slice(0, 2)).valid, false);
});

test('Brand shipping is charged once even with multiple variants and quantities', () => {
  const raw = rawOptions();
  raw.stores[0].variants.push({ ...raw.stores[0].variants[0], id: 'gid://shopify/ProductVariant/99', sku: 'ANOTHER' });
  const items = cart(); items[0].quantity = 2;
  items.push({ shop: raw.stores[0].shop, variantId: 'gid://shopify/ProductVariant/99', quantity: 3 });
  const result = evaluateUnifiedCart(normalizeUnifiedOptions(raw), items);
  assert.equal(result.valid, true); assert.equal(result.shippingCents, 150); assert.equal(result.subtotalCents, 700);
});

test('Out-of-stock, unknown variants, duplicate rows, excess quantities and disconnected stores block checkout', () => {
  for (const quantity of [0, 6, 1.5]) {
    const items = cart(); items[0].quantity = quantity;
    assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(rawOptions()), items).valid, false);
  }
  for (const mutate of [raw => { raw.stores[0].variants[0].inventoryQty = 0; }, raw => { raw.stores[0].connected = false; }, raw => { raw.stores[0].shippingCents = null; }, raw => { raw.stores[0].commissionBps = 1400; }]) {
    const raw = rawOptions(); mutate(raw);
    assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(raw), cart()).valid, false);
  }
  const duplicate = cart(); duplicate.push(duplicate[0]);
  assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(rawOptions()), duplicate).valid, false);
  const unknown = cart(); unknown[0].variantId = 'gid://shopify/ProductVariant/404';
  assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(rawOptions()), unknown).valid, false);
});

test('Unverified/live Stripe and explicit setup blockers never authorize hosted-session creation', () => {
  for (const mutate of [raw => { raw.stripe.verified = false; }, raw => { raw.stripe.mode = 'live'; }, raw => { raw.blockers = [{ code: 'SETUP', message: 'Setup incomplete' }]; }]) {
    const raw = rawOptions(); mutate(raw);
    assert.equal(evaluateUnifiedCart(normalizeUnifiedOptions(raw), cart()).valid, false);
  }
});

test('Hosted continuation accepts only the exact HTTPS Stripe test Checkout session path', () => {
  const url = 'https://checkout.stripe.com/c/pay/cs_test_123abc#test-fragment';
  assert.equal(safeStripeCheckoutUrl(url), url);
  assert.equal(safeStripeCheckoutUrl('https://checkout.stripe.com/pay/cs_test_123abc'), 'https://checkout.stripe.com/pay/cs_test_123abc');
  for (const value of ['http://checkout.stripe.com/c/pay/cs_test_a', 'https://checkout.stripe.com.evil.test/c/pay/cs_test_a', 'https://checkout.stripe.com:444/c/pay/cs_test_a', 'https://secret@checkout.stripe.com/c/pay/cs_test_a', 'https://checkout.stripe.com/c/pay/cs_live_a', 'https://checkout.stripe.com/other', 'https://checkout.stripe.com/c/pay/cs_test_a?secret=unsafe', 'javascript:alert(1)', null]) assert.equal(safeStripeCheckoutUrl(value), null);
  assert.equal(unifiedCheckoutLink({ test: true, state: 'checkout_open', checkoutUrl: url }), url);
  assert.equal(unifiedCheckoutLink({ test: false, state: 'checkout_open', checkoutUrl: url }), null);
  assert.equal(unifiedCheckoutLink({ test: true, state: 'complete', checkoutUrl: url }), null);
});

test('Run records tolerate direct/wrapped lists and UI errors redact credentials', () => {
  assert.deepEqual(unifiedRunRecords({ runs: [null, {}, { id: 'u_1' }] }), [{ id: 'u_1' }]);
  assert.deepEqual(unifiedRunRecords([{ id: 'u_1' }]), [{ id: 'u_1' }]);
  assert.doesNotMatch(safeUnifiedError({ message: 'Failure sk_test_SYNTHETIC whsec_SYNTHETIC shpat_SYNTHETIC' }), /sk_test_|whsec_|shpat_/);
});

const returnedRunId = 'uco_1234567890abcdef1234567890abcdef';
test('Completed unified results distinguish cash lifecycle from separate Stripe Tax reporting certification', () => {
  assert.equal(unifiedCompletionLabel('completed'), 'Cash lifecycle completed');
  for (const state of ['orders_created', 'paid', 'checkout_open', 'needs_review', null])
    assert.equal(unifiedCompletionLabel(state), null, 'Other states cannot claim cash lifecycle completion');
  assert.equal(CASH_RECONCILIATION_NOTICE, 'Cash reconciliation does not certify Stripe Tax reporting allocation; verify it separately.');
  assert.doesNotMatch(CASH_RECONCILIATION_NOTICE, /2.?c|0\.02|uco_/);
});
test('Stripe return routing selects only a bounded saved run and discards all other query data', () => {
  const value = resolveUnifiedCheckoutReturn({ pathname: '/unified-checkout/success', search: `?run=${returnedRunId}&session_id=cs_test_SYNTHETIC&key=sk_test_SYNTHETIC`, hash: '#unused' });
  assert.deepEqual(value, { kind: 'success', runId: returnedRunId, cleanPath: `/unified-checkout/success?run=${returnedRunId}` });
  assert.doesNotMatch(JSON.stringify(value), /cs_test_|sk_test_|session_id|unused/);
  assert.deepEqual(resolveUnifiedCheckoutReturn({ pathname: '/', search: `?checkout_cancelled=${returnedRunId}` }), { kind: 'cancelled', runId: returnedRunId, cleanPath: `/?checkout_cancelled=${returnedRunId}` });
  assert.equal(resolveUnifiedCheckoutReturn({ pathname: '/unified-checkout/cancel', search: `?run=${returnedRunId}` }).kind, 'cancelled');
  assert.equal(resolveUnifiedCheckoutReturn({ pathname: '/', search: `?run=${returnedRunId}` }), null);
  assert.equal(resolveUnifiedCheckoutReturn({ pathname: '/other', search: `?run=${returnedRunId}` }), null);
});

test('Invalid, injected and duplicate return identities never become an API path', async () => {
  for (const search of ['', '?run=../../secret', '?run=sk_test_SYNTHETIC', `?run=${returnedRunId}&run=${returnedRunId}`]) {
    const context = resolveUnifiedCheckoutReturn({ pathname: '/unified-checkout/success', search });
    assert.equal(context.runId, null); assert.equal(context.cleanPath, '/unified-checkout/success');
    await assert.rejects(loadUnifiedReturnedRun(context, () => assert.fail('Invalid return must never request an API')));
  }
});

test('Success and cancel returns only GET the exact existing test run and never dispatch', async () => {
  for (const kind of ['success', 'cancelled']) {
    const saved = { id: returnedRunId, test: true, state: kind === 'success' ? 'paid' : 'checkout_open' };
    let calls = 0;
    const result = await loadUnifiedReturnedRun({ kind, runId: returnedRunId }, async (path, options) => {
      calls++; assert.equal(path, `/api/unified-checkout/${returnedRunId}`);
      assert.deepEqual(options, { method: 'GET', cache: 'no-store', referrerPolicy: 'no-referrer' });
      assert.ok(!options.body); assert.doesNotMatch(path, /reconcile|sessions|pay/);
      return saved;
    });
    assert.equal(result, saved); assert.equal(calls, 1);
    assert.equal(result.state, saved.state, 'Return never promotes the state to paid');
  }
});

test('A return cannot display an unverified or different test run as its result', async () => {
  for (const saved of [{ id: returnedRunId, test: false }, { id: 'uco_abcdefabcdefabcdefabcdefabcdefab', test: true }, null])
    await assert.rejects(loadUnifiedReturnedRun({ runId: returnedRunId }, async () => saved), /could not be verified/);
});

function credentialsForm() {
  const fields = {
    shopifyClientId: { value: 'public-app-id' },
    shopifyClientSecret: { value: 'SYNTHETIC_SHOPIFY_SECRET_NOT_REAL' },
    confirmOwnedStore: { checked: true },
  };
  return { fields, form: { elements: { namedItem: name => fields[name] }, reset() { fields.shopifyClientId.value = ''; fields.shopifyClientSecret.value = ''; fields.confirmOwnedStore.checked = false; } } };
}
test('Local exact-store credentials travel only in request body and return safe encrypted-storage metadata', async () => {
  const { form, fields } = credentialsForm();
  const result = await configureUnifiedShopifyCredentials({ form, shop: UNIFIED_STORES[1].shop, enabled: true, hostname: '127.0.0.1', request: async (path, options) => {
    assert.equal(path, '/api/local/shopify-test-credentials');
    assert.equal(options.method, 'POST'); assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.body, { shop: UNIFIED_STORES[1].shop, clientId: 'public-app-id', clientSecret: 'SYNTHETIC_SHOPIFY_SECRET_NOT_REAL', confirmOwnedStore: true });
    return { verified: true, shop: UNIFIED_STORES[1].shop, secretStorage: 'server encrypted database', secretReturned: false, clientSecret: 'MUST_NOT_RETURN' };
  } });
  assert.equal(fields.shopifyClientSecret.value, '');
  assert.equal(result.verified, true); assert.ok(!('clientSecret' in result));
});
test('Other stores, remote hosts, brand/non-owner context and unchecked ownership never submit credentials', async () => {
  for (const changes of [{ enabled: false }, { hostname: 'example.com' }, { shop: UNIFIED_STORES[0].shop }, { shop: 'other.myshopify.com' }]) {
    const fixture = credentialsForm();
    await assert.rejects(configureUnifiedShopifyCredentials({ form: fixture.form, shop: UNIFIED_STORES[1].shop, enabled: true, hostname: 'localhost', request: () => assert.fail('No credential request permitted'), ...changes }));
    assert.equal(fixture.fields.shopifyClientSecret.value, '');
  }
  const fixture = credentialsForm(); fixture.fields.confirmOwnedStore.checked = false;
  await assert.rejects(configureUnifiedShopifyCredentials({ form: fixture.form, shop: UNIFIED_STORES[2].shop, enabled: true, hostname: 'localhost', request: () => assert.fail('Ownership must be confirmed') }));
});
test('Credential failures and close clear DOM fields and cannot echo raw secrets into messages', async () => {
  const fixture = credentialsForm();
  await assert.rejects(configureUnifiedShopifyCredentials({ form: fixture.form, shop: UNIFIED_STORES[2].shop, enabled: true, hostname: 'localhost', request: () => { throw new Error('SYNTHETIC_SHOPIFY_SECRET_NOT_REAL'); } }), error => !error.message.includes('SYNTHETIC_SHOPIFY_SECRET_NOT_REAL'));
  assert.equal(fixture.fields.shopifyClientSecret.value, '');
  const closed = credentialsForm(); clearUnifiedShopifyForm(closed.form);
  assert.equal(closed.fields.shopifyClientSecret.value, '');
});
