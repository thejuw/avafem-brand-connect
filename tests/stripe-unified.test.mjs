import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { createStripeAdapter, STRIPE_API_VERSION, stripeTestRecipientContactEmail } from '../server/integrations/stripe.mjs';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';

const ACCOUNT = 'acct_fixtureConnect123';
const BANK = 'ba_fixtureBank123';
const SESSION = 'cs_test_fixtureCheckout123';
const CHARGE = 'ch_fixtureCharge123';
const PAYMENT = 'pi_fixturePayment123';
const REFUND = 're_fixtureRefund123';
const TRANSFER = 'tr_fixtureTransfer123';
const REVERSAL = 'trr_fixtureReversal123';
const TRANSACTION = 'txn_fixtureBalance123';
const PAYOUT = 'po_fixturePayout123';
const testKey = 'sk_test_fixtureOnly1234567890';

function checkout(overrides = {}) {
  return {
    orderId: 'unified_fixture_1', currency: 'usd', shippingCents: 300, shippingTaxCode: 'txcd_92010001',
    successUrl: 'http://localhost:4317/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'http://localhost:4317/checkout/cancel', customerEmail: 'synthetic@example.test',
    items: ['bloom', 'lunelle', 'hearth'].map((brand, index) => ({
      reference: `bag_${brand}_sku1`, sku: `SKU-${index}`, title: `${brand} TEST fixture`,
      qty: index + 1, unitPriceCents: 100, taxCode: 'txcd_99999999',
      metadata: { health: 'NEVER_FORWARD_PRIVATE_HEALTH' },
    })),
    metadata: { health: 'NEVER_FORWARD_PRIVATE_HEALTH' }, shipTo: { name: 'NEVER_FORWARD_PII' },
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => { calls.push({ name, args }); return typeof result === 'function' ? result(...args) : structuredClone(result); };
  const account = {
    id: ACCOUNT, type: 'express', country: 'US', payouts_enabled: true, capabilities: { transfers: 'active' },
    requirements: { currently_due: [], past_due: [], disabled_reason: null },
    external_accounts: { data: [{ id: BANK, object: 'bank_account', country: 'US', currency: 'usd', default_for_currency: true, status: 'new' }], has_more: false },
  };
  const balance = { object: 'balance', livemode: false, available: [{ amount: 500, currency: 'usd', source_types: { card: 500 } }], pending: [] };
  const client = {
    checkout: { sessions: {
      create: record('checkout.create', { id: SESSION, livemode: false, status: 'open', payment_status: 'unpaid' }),
      retrieve: record('checkout.retrieve', { id: SESSION, livemode: false, collected_information: { shipping_details: { name: 'Test Recipient' } },
        payment_intent: { id: 'pi_fixturePayment123', livemode: false, latest_charge: { id: CHARGE, livemode: false, balance_transaction: { id: TRANSACTION, fee: 34 } } } }),
      listLineItems: record('checkout.lines', { data: [{ id: 'li_fixtureLine123', metadata: { reference: 'bag_bloom_sku1' }, amount_subtotal: 100, amount_tax: 8, amount_total: 108,
        taxes: [{ amount: 8, rate: { id: 'txr_fixtureRate123', percentage: 8.25, country: 'US', state: 'TX' }, taxability_reason: 'standard_rated', taxable_amount: 100 }] }], has_more: true }),
    } },
    charges: { retrieve: record('charge.retrieve', { id: CHARGE, livemode: false }) },
    paymentIntents: {
      capture: record('payment.capture', { id: PAYMENT, livemode: false, status: 'succeeded', amount_received: 900 }),
      cancel: record('payment.cancel', { id: PAYMENT, livemode: false, status: 'canceled', amount_received: 0 }),
    },
    refunds: { retrieve: record('refund.retrieve', { id: REFUND, livemode: false, status: 'succeeded' }) },
    transfers: {
      retrieve: record('transfer.retrieve', { id: TRANSFER, livemode: false }),
      retrieveReversal: record('reversal.retrieve', { id: REVERSAL, transfer: TRANSFER }),
    },
    accounts: { retrieve: record('account.retrieve', () => structuredClone(account)) },
    balance: { retrieve: record('balance.retrieve', () => structuredClone(balance)) },
    balanceTransactions: { retrieve: record('balanceTransaction.retrieve', { id: TRANSACTION, status: 'available', amount: 500, fee: 34, net: 466 }) },
    payouts: {
      create: record('payout.create', { id: PAYOUT, livemode: false, status: 'pending', amount: 85, currency: 'usd', destination: BANK }),
      retrieve: record('payout.retrieve', { id: PAYOUT, livemode: false, status: 'paid' }),
    },
  };
  const registry = new Set([ACCOUNT]);
  const config = { secretKey: testKey, env: {}, client, testConnectedAccountIds: registry, ...overrides };
  return { adapter: createStripeAdapter(config), client, calls, account, balance, registry };
}
const payout = (overrides = {}) => ({ accountId: ACCOUNT, amountCents: 85, orderId: 'unified_fixture_1', bagId: 'bag_bloom', payoutId: 'release1', ...overrides });

test('unified hosted Endive checkout has one fixed basket, native tax and per-session Managed Payments opt-out', async () => {
  assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
  const { adapter, calls } = fixture();
  const created = await adapter.createCheckoutSession(checkout());
  assert.equal(created.id, SESSION);
  assert.equal(calls.length, 1);
  const { args: [params, options] } = calls[0];
  assert.equal(params.mode, 'payment'); assert.equal(params.ui_mode, 'hosted_page');
  assert.deepEqual(params.allowed_payment_method_types, ['card']);
  assert.deepEqual(params.managed_payments, { enabled: false });
  assert.deepEqual(params.automatic_tax, { enabled: true });
  assert.deepEqual(params.shipping_address_collection, { allowed_countries: ['US'] });
  assert.equal(params.line_items.length, 3);
  assert.deepEqual(params.line_items.map(line => line.quantity), [1, 2, 3]);
  assert.deepEqual(params.line_items.map(line => line.price_data.tax_behavior), ['exclusive', 'exclusive', 'exclusive']);
  assert.ok(params.line_items.every(line => line.price_data.product_data.tax_code === 'txcd_99999999'));
  assert.equal(params.shipping_options.length, 1);
  assert.deepEqual(params.shipping_options[0].shipping_rate_data.fixed_amount, { amount: 300, currency: 'usd' });
  assert.equal(params.shipping_options[0].shipping_rate_data.tax_code, 'txcd_92010001');
  assert.equal(params.shipping_options[0].shipping_rate_data.tax_behavior, 'exclusive');
  assert.equal(params.payment_intent_data.transfer_group, 'ORD_unified_fixture_1');
  assert.equal(params.payment_intent_data.capture_method, 'manual');
  assert.equal(params.client_reference_id, 'unified_fixture_1');
  assert.equal(options.idempotencyKey, 'checkout:unified_fixture_1:v1');
  assert.doesNotMatch(JSON.stringify(params), /NEVER_FORWARD|"payment_method_types"|automatic_payment_methods|transfer_data|application_fee|on_behalf_of/);
  assert.equal(params.payment_method_types, undefined);
  assert.equal(params.payment_intent_data.transfer_data, undefined);
  assert.equal(params.customer_email, 'synthetic@example.test');
});

test('checkout retries retain the same stable idempotency key and do not create standalone PaymentIntents', async () => {
  const { adapter, calls } = fixture();
  await adapter.createCheckoutSession(checkout()); await adapter.createCheckoutSession(checkout());
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.name === 'checkout.create'));
  assert.deepEqual(calls[0].args, calls[1].args);
});

test('real Endive SDK serializes the unified snapshot colon references and both documented metadata paths without network access', async () => {
  const requests = [];
  const client = new Stripe(testKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      requests.push({ url, method: options.method, body: new URLSearchParams(options.body), headers: options.headers });
      return new Response(JSON.stringify({ id: SESSION, object: 'checkout.session', livemode: false, status: 'open' }),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_offlineFixture123' } });
    }),
  });
  const adapter = createStripeAdapter({ secretKey: testKey, env: {}, client });
  const orderId = 'uco_8889de980cd044e0a0500cb719bc2034';
  const input = checkout({ orderId, items: [100, 200, 300].map((price, index) => ({
    reference: `bag_${'a'.repeat(31)}${index}:0`, sku: `AVF-CONNECT-TEST-00${index * 2 + 2}`,
    title: `Avafem fixed test item ${index} DO NOT SHIP`, qty: 2, unitPriceCents: price, taxCode: 'txcd_99999999',
  })) });
  assert.equal((await adapter.createCheckoutSession(input)).id, SESSION);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/v1/checkout/sessions');
  for (const [index, line] of input.items.entries()) {
    assert.equal(requests[0].body.get(`line_items[${index}][metadata][reference]`), line.reference);
    assert.equal(requests[0].body.get(`line_items[${index}][price_data][product_data][metadata][reference]`), line.reference);
    assert.equal(requests[0].body.get(`line_items[${index}][price_data][unit_amount]`), String(line.unitPriceCents));
  }
  assert.equal(requests[0].body.get('client_reference_id'), orderId);
  assert.equal(requests[0].body.get('payment_intent_data[capture_method]'), 'manual');
});

test('colon allowance is isolated to bounded Checkout line references, not order/provider IDs or unsafe reference characters', async () => {
  const { adapter, calls } = fixture();
  for (const reference of ['x'.repeat(101), 'bag/0', 'bag 0', 'bag\n0', 'bag%3A0', 'bag💰0'])
    await assert.rejects(adapter.createCheckoutSession(checkout({ items: [{ ...checkout().items[0], reference }] })));
  await assert.rejects(adapter.createCheckoutSession(checkout({ orderId: 'order:0' })));
  await assert.rejects(adapter.getCharge('ch_fixture:123'));
  assert.equal(calls.length, 0);
  await adapter.createCheckoutSession(checkout({ items: [{ ...checkout().items[0], reference: `${'a'.repeat(98)}:0` }] }));
  assert.equal(calls.length, 1);
});

test('unified factory passes its real generated snapshot through the real Stripe adapter and SDK to an offline Session transport', async t => {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const requests = []; let session;
  const client = new Stripe(testKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      const path = new URL(url).pathname, body = new URLSearchParams(options.body ?? '');
      requests.push({ path, method: options.method, body }); let value;
      if (path === '/v1/account') value = { id: ACCOUNT, object: 'account', country: 'US', charges_enabled: true, payouts_enabled: false };
      else if (path === '/v1/checkout/sessions' && options.method === 'POST') {
        session = { id: SESSION, object: 'checkout.session', livemode: false, status: 'open', payment_status: 'unpaid',
          client_reference_id: body.get('client_reference_id'), url: `https://checkout.stripe.com/c/pay/${SESSION}`, expires_at: 9999999999 };
        value = session;
      } else if (path === `/v1/checkout/sessions/${SESSION}` && options.method === 'GET') value = session;
      else throw new Error(`Unexpected offline SDK path ${path}`);
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const stripe = createStripeAdapter({ secretKey: testKey, env: {}, client });
  const stores = {
    row: async shop => ({ brand_id: `brand_fixture_${TEST_STORES.findIndex(value => value.shop === shop)}`,
      shipping_cents: TEST_STORES.find(value => value.shop === shop).shippingCents, commission_bps: 1500, return_window_days: 30 }),
    preflight: async () => ({ verified: true }),
    forShop: async shop => ({ getVariant: async variantId => ({ id: variantId, currency: 'USD', productStatus: 'ACTIVE', tracked: true,
      requiresShipping: true, inventoryPolicy: 'DENY', inventoryQty: 10, priceCents: (TEST_STORES.findIndex(value => value.shop === shop) + 1) * 100,
      sku: `AVF-CONNECT-TEST-${TEST_STORES.findIndex(value => value.shop === shop)}`, productTitle: 'Avafem TEST ONLY DO NOT SHIP' }) }),
  };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => stripe });
  const result = await unified.create({ items: TEST_STORES.map((store, index) => ({ shop: store.shop,
    variantId: `gid://shopify/ProductVariant/${100 + index}`, quantity: 2 })) }, 'offline_sdk_contract_fixture_1');
  assert.equal(result.state, 'checkout_open'); assert.equal(result.lastError, null);
  const snapshot = unified.runtime.decode(await unified.runtime.read(result.id)).snapshot;
  const posts = requests.filter(value => value.path === '/v1/checkout/sessions' && value.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].body.get('client_reference_id'), result.id);
  for (const [index, bag] of snapshot.bags.entries()) {
    assert.equal(bag.items[0].reference, `${bag.id}:0`);
    assert.equal(posts[0].body.get(`line_items[${index}][metadata][reference]`), bag.items[0].reference);
  }
  assert.equal((await db.query('SELECT id FROM orders')).rows.length, 0, 'An open offline Session is not a captured payment or paid order.');
});

test('checkout rejects unbounded or invalid basket/tax/currency/URL input before any provider call', async () => {
  const cases = [
    { orderId: '../escape' }, { captureMethod: 'automatic_async' }, { items: [] }, { items: new Array(101).fill(checkout().items[0]) },
    { items: [{ ...checkout().items[0], taxCode: undefined }] },
    { items: [{ ...checkout().items[0], reference: undefined }] },
    { items: [checkout().items[0], checkout().items[0]] },
    { items: [{ ...checkout().items[0], qty: 1.2 }] }, { items: [{ ...checkout().items[0], qty: 1001 }] },
    { items: [{ ...checkout().items[0], unitPriceCents: 0 }] },
    { items: [{ ...checkout().items[0], unitPriceCents: Number.MAX_SAFE_INTEGER, qty: 2 }] },
    { shippingTaxCode: undefined }, { shippingCents: -1 }, { currency: 'eur' },
    { successUrl: 'http://outside.example.test/success' }, { cancelUrl: 'https://user:password@example.test/' },
    { successUrl: 'javascript:alert(1)' }, { customerEmail: 'invalid' },
  ];
  for (const input of cases) {
    const { adapter, calls } = fixture();
    await assert.rejects(adapter.createCheckoutSession(checkout(input)));
    assert.equal(calls.length, 0, JSON.stringify(input));
  }
});

test('new checkout and reconciliation helpers reject live configuration even with allowLive override', async () => {
  const { adapter, calls } = fixture({ secretKey: 'sk_live_fixtureOnly1234567890', allowLive: true });
  for (const invoke of [
    () => adapter.createCheckoutSession(checkout()), () => adapter.getCheckoutSession(SESSION),
    () => adapter.listCheckoutLineItems(SESSION), () => adapter.getCharge(CHARGE), () => adapter.getRefund(REFUND),
    () => adapter.getTransfer(TRANSFER), () => adapter.getReversal(TRANSFER, REVERSAL),
    () => adapter.getBalance(), () => adapter.getBalanceTransaction(TRANSACTION),
    () => adapter.createTestPayout(payout()), () => adapter.getPayout(PAYOUT, { accountId: ACCOUNT }),
    () => adapter.getTestConnectedAccount(ACCOUNT),
    () => adapter.capturePaymentIntent({ paymentIntentId: PAYMENT, orderId: 'unified_fixture_1', amountCents: 900 }),
    () => adapter.cancelPaymentIntent({ paymentIntentId: PAYMENT, orderId: 'unified_fixture_1' }),
  ]) await assert.rejects(invoke(), /test-only/);
  assert.equal(calls.length, 0);
});

test('test readbacks expose actual expanded payment, fee, shipping and tax line evidence without flattening pagination', async () => {
  const { adapter, calls } = fixture();
  const session = await adapter.getCheckoutSession(SESSION);
  assert.equal(session.collected_information.shipping_details.name, 'Test Recipient');
  assert.equal(session.payment_intent.latest_charge.balance_transaction.fee, 34);
  assert.deepEqual(calls[0].args, [SESSION, { expand: ['payment_intent.latest_charge.balance_transaction', 'total_details.breakdown', 'shipping_cost.taxes'] }]);
  const lines = await adapter.listCheckoutLineItems(SESSION, { startingAfter: 'li_fixturePrior123', limit: 3 });
  assert.equal(lines.has_more, true);
  assert.equal(lines.data[0].amount_tax, 8);
  assert.equal(lines.data[0].taxes[0].rate.percentage, 8.25);
  assert.equal(lines.data[0].metadata.reference, 'bag_bloom_sku1');
  assert.deepEqual(calls[1].args, [SESSION, { limit: 3, starting_after: 'li_fixturePrior123', expand: ['data.price.product', 'data.taxes'] }]);
});

test('read methods use exact official SDK object methods and preserve raw provider evidence', async () => {
  const { adapter, calls } = fixture();
  await adapter.getCharge(CHARGE); await adapter.getRefund(REFUND); await adapter.getTransfer(TRANSFER);
  await adapter.getReversal(TRANSFER, REVERSAL);
  const balance = await adapter.getBalance(); assert.equal(balance.livemode, false);
  await adapter.getBalance({ accountId: ACCOUNT });
  const transaction = await adapter.getBalanceTransaction(TRANSACTION, { accountId: ACCOUNT });
  assert.equal(transaction.net, 466);
  assert.deepEqual(calls.map(call => call.name), ['charge.retrieve', 'refund.retrieve', 'transfer.retrieve', 'reversal.retrieve', 'balance.retrieve', 'balance.retrieve', 'balanceTransaction.retrieve']);
  assert.deepEqual(calls[3].args, [TRANSFER, REVERSAL, { expand: ['balance_transaction'] }]);
  assert.deepEqual(calls[4].args, [{}, {}]);
  assert.deepEqual(calls[5].args, [{}, { stripeAccount: ACCOUNT }]);
  assert.deepEqual(calls[6].args, [TRANSACTION, {}, { stripeAccount: ACCOUNT }]);
});

test('invalid IDs, live sessions and empty connected contexts cannot trigger reads or fall back to platform', async () => {
  const { adapter, calls } = fixture();
  for (const invoke of [
    () => adapter.getCheckoutSession('cs_live_fixtureCheckout123'), () => adapter.getCheckoutSession('cs_test_fixture/escape'),
    () => adapter.listCheckoutLineItems(SESSION, { limit: 101 }), () => adapter.listCheckoutLineItems(SESSION, { startingAfter: 'ch_wrongId123' }),
    () => adapter.getCharge('pi_fixtureWrong123'), () => adapter.getRefund('re_bad'),
    () => adapter.getTransfer('tr_sandbox_bloom'), () => adapter.getReversal(TRANSFER, 'trr_../bad'),
    () => adapter.getBalance({ accountId: null }), () => adapter.getBalance({ accountId: '' }),
    () => adapter.getBalance({ accountId: 'acct_sandbox_bloom' }),
    () => adapter.getBalanceTransaction('txn_bad'), () => adapter.getBalanceTransaction(TRANSACTION, { accountId: '' }),
    () => adapter.getPayout(PAYOUT), () => adapter.getPayout(PAYOUT, { accountId: null }),
  ]) await assert.rejects(invoke());
  assert.equal(calls.length, 0);
});

test('top-level and nested live readbacks fail closed, including list expansions', async () => {
  for (const configure of [
    client => { client.checkout.sessions.retrieve = async () => ({ id: SESSION, livemode: true }); },
    client => { client.checkout.sessions.retrieve = async () => ({ id: SESSION, livemode: false, payment_intent: { livemode: true } }); },
  ]) {
    const { adapter, client } = fixture(); configure(client);
    await assert.rejects(adapter.getCheckoutSession(SESSION), { code: 'STRIPE_MODE_MISMATCH' });
  }
  const { adapter, client } = fixture();
  client.checkout.sessions.listLineItems = async () => ({ data: [{ price: { livemode: true } }], has_more: false });
  await assert.rejects(adapter.listCheckoutLineItems(SESSION), { code: 'STRIPE_MODE_MISMATCH' });
});

test('mismatched provider object IDs and cross-transfer reversal readbacks are rejected', async () => {
  const { adapter, client } = fixture();
  client.charges.retrieve = async () => ({ id: 'ch_otherCharge123', livemode: false });
  await assert.rejects(adapter.getCharge(CHARGE), { code: 'STRIPE_READBACK_MISMATCH' });
  client.transfers.retrieveReversal = async () => ({ id: REVERSAL, transfer: 'tr_otherTransfer123' });
  await assert.rejects(adapter.getReversal(TRANSFER, REVERSAL), { code: 'STRIPE_READBACK_MISMATCH' });
});

test('raw test-connected-account evidence preserves metadata and requirements without changing normalized legacy contract', async () => {
  const { adapter, account } = fixture();
  account.metadata = { integration: 'avafem', brand_id: 'brand_test_bloom', shop: 'fixture.myshopify.com' };
  account.details_submitted = true;
  const raw = await adapter.getTestConnectedAccount(ACCOUNT);
  assert.deepEqual(raw.metadata, account.metadata);
  assert.equal(raw.details_submitted, true);
  assert.equal(raw.capabilities.transfers, 'active');
  assert.equal(raw.payouts_enabled, true);
  assert.deepEqual(raw.requirements.currently_due, []);
  const normalized = await adapter.getConnectedAccount(ACCOUNT);
  assert.equal(normalized.payoutsEnabled, true);
  assert.equal(normalized.transfersCapability, 'active');
  assert.equal(normalized.metadata, undefined);
});

test('test connected-account recovery listing reads complete bounded pages with raw metadata and exact creation filters', async () => {
  const { adapter, client } = fixture(), calls = [];
  const first = { id: 'acct_firstFixture123', created: 100, metadata: { integration: 'avafem', brand_id: 'brand_fixture' } };
  const second = { id: 'acct_secondFixture123', created: 110, metadata: { integration: 'avafem', brand_id: 'brand_other' } };
  client.accounts.list = async params => { calls.push(params); return calls.length === 1 ? { data: [first], has_more: true } : { data: [second], has_more: false }; };
  assert.deepEqual(await adapter.listTestConnectedAccounts({ createdAfter: 90, createdBefore: 120 }), [first, second]);
  assert.deepEqual(calls, [{ limit: 100, created: { gte: 90, lte: 120 } },
    { limit: 100, created: { gte: 90, lte: 120 }, starting_after: first.id }]);
  await assert.rejects(adapter.listTestConnectedAccounts({ createdAfter: 121, createdBefore: 120 }));
  assert.equal(calls.length, 2);
});

test('connected-account listing rejects live configuration, incomplete metadata/cursors, and truncation at the hard100-page ceiling', async () => {
  const live = fixture({ secretKey: 'sk_live_fixtureOnly123', allowLive: true });
  await assert.rejects(live.adapter.listTestConnectedAccounts()); assert.equal(live.calls.length, 0);
  for (const page of [{ data: [], has_more: true }, { data: [{ id: ACCOUNT, created: 100 }], has_more: false },
    { data: [{ id: ACCOUNT, created: 100, metadata: {}, livemode: true }], has_more: false }]) {
    const fx = fixture(); fx.client.accounts.list = async () => page;
    await assert.rejects(fx.adapter.listTestConnectedAccounts());
  }
  const fx = fixture(); let pages = 0;
  fx.client.accounts.list = async () => ({ data: [{ id: `acct_pageFixture${String(pages++).padStart(4, '0')}`, created: 100, metadata: {} }], has_more: true });
  await assert.rejects(fx.adapter.listTestConnectedAccounts(), { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED' }); assert.equal(pages, 100);
});

test('real SDK serializes new test Express synthetic contact email under keyv2 while explicit legacy revision preserves original no-email keyv1', async () => {
  const requests = [], brandId = 'brand_realSdkRecipient123';
  const client = new Stripe(testKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      requests.push({ path: new URL(url).pathname, body: new URLSearchParams(options.body), headers: new Headers(options.headers) });
      return new Response(JSON.stringify({ id: ACCOUNT, object: 'account', type: 'express', metadata: { brand_id: brandId, integration: 'avafem' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const adapter = createStripeAdapter({ secretKey: testKey, env: {}, client });
  await adapter.createExpressAccount({ brandId, country: 'US', manualPayouts: true });
  await adapter.createExpressAccount({ brandId, country: 'US', manualPayouts: true, parameterRevision: 1 });
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.path === '/v1/accounts'));
  assert.equal(requests[0].body.get('email'), stripeTestRecipientContactEmail(brandId));
  assert.match(requests[0].body.get('email'), /^avafem-test-[a-f0-9]{24}@example\.com$/);
  assert.equal(requests[0].headers.get('idempotency-key'), `brand-account:${brandId}:v2`);
  assert.equal(requests[1].body.get('email'), null); assert.equal(requests[1].headers.get('idempotency-key'), `brand-account:${brandId}:v1`);
  for (const request of requests) {
    assert.equal(request.body.get('type'), 'express'); assert.equal(request.body.get('country'), 'US');
    assert.equal(request.body.get('capabilities[transfers][requested]'), 'true');
    assert.equal(request.body.get('settings[payouts][schedule][interval]'), 'manual');
    assert.doesNotMatch(request.body.toString(), /tos_acceptance|external_account|business_type|card_payments/);
  }
});

test('email-bearing revision is test-only and rejects nonfixture contact email or unknown revision before provider access', async () => {
  const fx = fixture(); let creates = 0; fx.client.accounts.create = async () => { creates++; return { id: ACCOUNT }; };
  await assert.rejects(fx.adapter.createExpressAccount({ brandId: 'brand_fixture', email: 'real-person@company.com', parameterRevision: 2 }));
  await assert.rejects(fx.adapter.createExpressAccount({ brandId: 'brand_fixture', parameterRevision: 3 }));
  const live = fixture({ secretKey: 'sk_live_fixtureOnly123', allowLive: true });
  await assert.rejects(live.adapter.createExpressAccount({ brandId: 'brand_fixture', parameterRevision: 2 }));
  assert.equal(creates, 0); assert.equal(live.calls.length, 0);
  assert.notEqual(stripeTestRecipientContactEmail('brand_fixtureA'), stripeTestRecipientContactEmail('brand_fixtureB'));
});

const v2Recipient = (brandId = 'brand_v2Fixture') => ({ id: ACCOUNT, object: 'v2.core.account', livemode: false, dashboard: 'express',
  applied_configurations: ['recipient'], identity: { country: 'US' }, metadata: { integration: 'avafem', brand_id: brandId },
  defaults: { currency: 'usd', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
  configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'restricted' } } } } } });

test('real Endive SDK serializes API-v2 Express recipient revision3, scoped separate manual balance settings and documented v2 onboarding without agreements', async () => {
  const requests = [], brandId = 'brand_v2Fixture';
  const client = new Stripe(testKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      const parsed = new URL(url), headers = new Headers(options.headers);
      const body = options.body ? headers.get('content-type')?.includes('json') ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(options.body)) : null;
      requests.push({ path: parsed.pathname, method: options.method, query: parsed.searchParams, headers, body });
      let response;
      if (parsed.pathname === '/v2/core/accounts' && options.method === 'GET') response = { data: [], next_page_url: null };
      else if (parsed.pathname.startsWith('/v2/core/accounts')) response = v2Recipient(brandId);
      else if (parsed.pathname === '/v1/balance_settings') response = { object: 'balance_settings', payments: { payouts: { schedule: { interval: 'manual' } } } };
      else if (parsed.pathname === '/v2/core/account_links') response = { object: 'v2.core.account_link', account: ACCOUNT, livemode: false,
        url: 'https://accounts.stripe.com/r/fixture', expires_at: '2026-10-20T00:00:00.000Z' };
      else assert.fail(`Unexpected offline SDK request ${parsed.pathname}`);
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const adapter = createStripeAdapter({ secretKey: testKey, env: {}, client });
  await adapter.listTestConnectedAccountsV2();
  await adapter.createExpressRecipientV2({ brandId, parameterRevision: 3, manualPayouts: true });
  await adapter.configureTestRecipientManualPayouts({ accountId: ACCOUNT, brandId });
  await adapter.createRecipientOnboardingLinkV2({ accountId: ACCOUNT, requestId: 'link_v2Fixture', refreshUrl: 'http://localhost:4317/refresh', returnUrl: 'http://localhost:4317/return' });
  const create = requests.find(item => item.path === '/v2/core/accounts' && item.method === 'POST');
  const listings = requests.filter(item => item.path === '/v2/core/accounts' && item.method === 'GET');
  assert.equal(listings.length, 2); assert.deepEqual(listings.map(item => item.query.get('limit')), ['20', '20']);
  assert.deepEqual(listings.map(item => item.query.get('closed')), ['false', 'true']);
  assert.equal(create.headers.get('stripe-version'), STRIPE_API_VERSION); assert.equal(create.headers.get('idempotency-key'), `brand-account:${brandId}:v3`);
  assert.deepEqual(create.body, { contact_email: stripeTestRecipientContactEmail(brandId), dashboard: 'express', identity: { country: 'US' },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    defaults: { currency: 'usd', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    metadata: { integration: 'avafem', brand_id: brandId }, include: ['configuration.recipient', 'identity', 'defaults', 'requirements'] });
  const schedule = requests.find(item => item.path === '/v1/balance_settings' && item.method === 'POST');
  assert.deepEqual(schedule.body, { 'payments[payouts][schedule][interval]': 'manual' });
  assert.equal(schedule.headers.get('stripe-account'), ACCOUNT); assert.equal(schedule.headers.get('idempotency-key'), `recipient-manual:${ACCOUNT}:v1`);
  assert.ok(requests.some(item => item.path === '/v1/balance_settings' && item.method === 'GET' && item.headers.get('stripe-account') === ACCOUNT));
  const link = requests.find(item => item.path === '/v2/core/account_links');
  assert.deepEqual(link.body, { account: ACCOUNT, use_case: { type: 'account_onboarding', account_onboarding: {
    refresh_url: 'http://localhost:4317/refresh', return_url: 'http://localhost:4317/return' } } });
  assert.doesNotMatch(JSON.stringify(requests.map(item => item.body)), /tos_acceptance|attestations|entity_type|business_details|external_account|merchant|card_payments/);
});

test('API-v2 account recovery paginates active and closed accounts with exact page tokens and rejects incomplete or unsafe cursors', async () => {
  const fx = fixture(), pages = [];
  fx.client.v2 = { core: { accounts: { list: async params => {
    pages.push(params);
    return params.closed ? { data: [], next_page_url: null } : params.page
      ? { data: [{ ...v2Recipient(), id: 'acct_v2SecondFixture', created: '2026-10-19T12:01:00Z' }], next_page_url: null }
      : { data: [{ ...v2Recipient(), created: '2026-10-19T12:00:00Z' }], next_page_url: '/v2/core/accounts?page=page_fixture2&limit=20&closed=false' };
  } } } };
  assert.equal((await fx.adapter.listTestConnectedAccountsV2()).length, 2);
  assert.deepEqual(pages, [{ limit: 20, closed: false }, { limit: 20, closed: false, page: 'page_fixture2' }, { limit: 20, closed: true }]);
  for (const patch of [{ next_page_url: 'https://evil.example/v2/core/accounts?page=page_fixture2' }, { next_page_url: '/v1/accounts?page=page_fixture2' },
    { next_page_url: undefined }, { data: [{ ...v2Recipient(), created: 'not-a-time' }], next_page_url: null },
    { data: Array.from({ length: 21 }, (_, index) => ({ ...v2Recipient(), id: `acct_oversizeFixture${index}`, created: '2026-10-19T12:00:00Z' })), next_page_url: null },
    { data: [{ ...v2Recipient(), livemode: true, created: '2026-10-19T12:00:00Z' }], next_page_url: null }]) {
    fx.client.v2.core.accounts.list = async () => ({ data: [{ ...v2Recipient(), created: '2026-10-19T12:00:00Z' }], ...patch });
    await assert.rejects(fx.adapter.listTestConnectedAccountsV2());
  }
});

test('v2 recipient setup validates test-only identity and responsibilities and cannot change schedules for mismatched or live accounts', async () => {
  const fx = fixture(); let writes = 0;
  fx.client.v2 = { core: { accounts: { retrieve: async () => v2Recipient() } } };
  fx.client.balanceSettings = { update: async () => { writes++; return {}; }, retrieve: async () => ({ payments: { payouts: { schedule: { interval: 'daily' } } } }) };
  await assert.rejects(fx.adapter.configureTestRecipientManualPayouts({ accountId: ACCOUNT, brandId: 'brand_wrongFixture' })); assert.equal(writes, 0);
  for (const patch of [{ dashboard: 'full' }, { identity: { country: 'CA' } }, { applied_configurations: ['merchant', 'recipient'] },
    { defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } } }, { livemode: true }]) {
    fx.client.v2.core.accounts.retrieve = async () => ({ ...v2Recipient(), ...patch });
    await assert.rejects(fx.adapter.configureTestRecipientManualPayouts({ accountId: ACCOUNT, brandId: 'brand_v2Fixture' })); assert.equal(writes, 0);
  }
  fx.client.v2.core.accounts.retrieve = async () => v2Recipient();
  await assert.rejects(fx.adapter.configureTestRecipientManualPayouts({ accountId: ACCOUNT, brandId: 'brand_v2Fixture' }), /manual payout schedule/); assert.equal(writes, 1);
  for (const params of [{ country: 'CA' }, { email: 'owner@real.example' }, { parameterRevision: 2 }, { manualPayouts: false }])
    await assert.rejects(fx.adapter.createExpressRecipientV2({ brandId: 'brand_v2Fixture', ...params }));
  const live = fixture({ secretKey: 'sk_live_fixtureOnly123', allowLive: true });
  await assert.rejects(live.adapter.createExpressRecipientV2({ brandId: 'brand_v2Fixture' })); assert.equal(live.calls.length, 0);
});

test('a v1 type-none financial projection can pay only when authoritative v2 control proves Express, with no fabricated type', async () => {
  const fx = fixture(); fx.account.type = 'none'; fx.client.v2 = { core: { accounts: { retrieve: async () => v2Recipient() } } };
  await fx.adapter.createTestPayout(payout()); assert.equal(fx.account.type, 'none');
  assert.equal(fx.calls.filter(call => call.name === 'payout.create').length, 1);
  fx.client.v2.core.accounts.retrieve = async () => ({ ...v2Recipient(), dashboard: 'full' });
  await assert.rejects(fx.adapter.createTestPayout(payout())); assert.equal(fx.calls.filter(call => call.name === 'payout.create').length, 1);
});

test('payout requires explicit newly authorized test recipient registry, including awaited callback', async () => {
  for (const registry of [undefined, [], new Set(), () => false, async () => 'true']) {
    const { adapter, calls } = fixture({ testConnectedAccountIds: registry });
    await assert.rejects(adapter.createTestPayout(payout()), /explicitly authorized/);
    assert.equal(calls.length, 0);
  }
  const checked = [];
  const { adapter, calls } = fixture({ testConnectedAccountIds: async accountId => { checked.push(accountId); return accountId === ACCOUNT; } });
  await adapter.createTestPayout(payout());
  assert.deepEqual(checked, [ACCOUNT]); assert.equal(calls.at(-1).name, 'payout.create');
  const denied = fixture();
  await assert.rejects(denied.adapter.createTestPayout(payout({ accountId: 'acct_unknownConnect123' })), /explicitly authorized/);
  assert.equal(denied.calls.length, 0);
});

test('payout preflights actual recipient capability, bank and available balance and preserves pending status', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.createTestPayout(payout({ metadata: { health: 'NEVER_FORWARD_PRIVATE_HEALTH' } }));
  assert.equal(result.status, 'pending', 'Creating a payout does not establish bank arrival.');
  assert.deepEqual(calls.map(call => call.name), ['account.retrieve', 'balance.retrieve', 'payout.create']);
  assert.deepEqual(calls[1].args, [{}, { stripeAccount: ACCOUNT }]);
  assert.deepEqual(calls[2].args, [{ amount: 85, currency: 'usd', method: 'standard', destination: BANK, source_type: 'card',
    metadata: { order_id: 'unified_fixture_1', bag_id: 'bag_bloom', payout_id: 'release1', integration: 'avafem' } },
  { stripeAccount: ACCOUNT, idempotencyKey: 'payout:bag_bloom:release1:v1' }]);
  assert.doesNotMatch(JSON.stringify(calls), /NEVER_FORWARD/);
  assert.equal((await adapter.getPayout(PAYOUT, { accountId: ACCOUNT })).status, 'paid');
  assert.deepEqual(calls.at(-1).args, [PAYOUT, { expand: ['balance_transaction'] }, { stripeAccount: ACCOUNT }]);
});

test('unready account and unsupported bank never issue a payout or change accounts/settings/terms', async () => {
  for (const change of [
    account => { account.id = 'acct_otherConnect123'; }, account => { account.type = 'standard'; },
    account => { account.country = 'CA'; }, account => { account.payouts_enabled = false; },
    account => { account.capabilities.transfers = 'pending'; }, account => { account.requirements.currently_due = ['external_account']; },
    account => { account.requirements.disabled_reason = 'requirements.past_due'; }, account => { account.requirements.past_due = ['individual.id_number']; },
    account => { account.external_accounts.has_more = true; }, account => { account.external_accounts.data = []; },
    account => { account.external_accounts.data[0].currency = 'eur'; }, account => { account.external_accounts.data[0].country = 'CA'; },
    account => { account.external_accounts.data[0].status = 'errored'; },
  ]) {
    const { adapter, calls, account } = fixture(); change(account);
    await assert.rejects(adapter.createTestPayout(payout()));
    assert.ok(calls.every(call => call.name === 'account.retrieve'));
  }
});

test('payout rejects pending-only, insufficient total/card balance and unbound destinations', async () => {
  for (const change of [
    balance => { balance.available = []; balance.pending = [{ amount: 999, currency: 'usd' }]; },
    balance => { balance.available[0].amount = 84; },
    balance => { balance.available[0].source_types.card = 84; },
    balance => { balance.available[0].source_types = {}; },
  ]) {
    const { adapter, calls, balance } = fixture(); change(balance);
    await assert.rejects(adapter.createTestPayout(payout()), /available USD card balance/);
    assert.equal(calls.some(call => call.name === 'payout.create'), false);
  }
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.createTestPayout(payout({ destination: 'ba_otherBank123' })), /destination/);
  assert.equal(calls.some(call => call.name === 'payout.create'), false);
});

test('payout amounts, context, business IDs and destination formats validate before provider access', async () => {
  const { adapter, calls } = fixture();
  for (const input of [{ accountId: '' }, { accountId: 'acct_sandbox_bloom' }, { amountCents: 0 }, { amountCents: 1.1 },
    { currency: 'eur' }, { destination: 'card_fixtureCard123' }, { payoutId: undefined }, { bagId: '../bad' }]) {
    await assert.rejects(adapter.createTestPayout(payout(input)));
  }
  assert.equal(calls.length, 0);
});

test('provider failure never fabricates checkout, refund, transfer or bank-payout acceptance', async () => {
  const { adapter, client } = fixture();
  client.payouts.create = async () => { throw Object.assign(new Error('RAW_PROVIDER_SECRET_DO_NOT_EXPOSE'), { code: 'balance_insufficient', type: 'StripeInvalidRequestError', requestId: 'req_fixture123' }); };
  await assert.rejects(adapter.createTestPayout(payout()), cause => {
    assert.equal(cause.code, 'STRIPE_REQUEST_FAILED');
    assert.equal(cause.details.stripeCode, 'balance_insufficient');
    assert.equal(cause.details.requestId, 'req_fixture123');
    assert.doesNotMatch(cause.message, /RAW_PROVIDER_SECRET/);
    return true;
  });
});

test('unified manual authorization remains distinct from payment, and automatic capture requires explicit selection', async () => {
  const { adapter, client, calls } = fixture();
  client.checkout.sessions.retrieve = async () => ({ id: SESSION, livemode: false, status: 'complete', payment_status: 'unpaid',
    payment_intent: { id: PAYMENT, livemode: false, status: 'requires_capture', amount_capturable: 900, amount_received: 0 } });
  const session = await adapter.getCheckoutSession(SESSION);
  assert.equal(session.payment_intent.status, 'requires_capture');
  assert.equal(session.payment_status, 'unpaid');
  assert.equal(session.payment_intent.amount_received, 0);
  assert.equal(calls.length, 0, 'Readback does not automatically capture or create orders.');
  await adapter.createCheckoutSession(checkout({ captureMethod: 'automatic' }));
  assert.equal(calls[0].args[0].payment_intent_data.capture_method, 'automatic');
});

test('capture and authorization cancel use exact provider APIs, stable separate keys and test-mode guards', async () => {
  const { adapter, calls } = fixture();
  const captured = await adapter.capturePaymentIntent({ paymentIntentId: PAYMENT, orderId: 'unified_fixture_1', amountCents: 900 });
  assert.equal(captured.amount_received, 900); assert.equal(captured.status, 'succeeded');
  const canceled = await adapter.cancelPaymentIntent({ paymentIntentId: PAYMENT, orderId: 'unified_fixture_1' });
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.amount_received, 0);
  assert.deepEqual(calls, [
    { name: 'payment.capture', args: [PAYMENT, { amount_to_capture: 900 }, { idempotencyKey: 'capture:unified_fixture_1:v1' }] },
    { name: 'payment.cancel', args: [PAYMENT, {}, { idempotencyKey: 'cancel:unified_fixture_1:v1' }] },
  ]);
  for (const input of [{ paymentIntentId: 'pi_bad', orderId: 'order1', amountCents: 1 },
    { paymentIntentId: PAYMENT, orderId: '../bad', amountCents: 1 },
    { paymentIntentId: PAYMENT, orderId: 'order1', amountCents: 0 },
    { paymentIntentId: PAYMENT, orderId: 'order1', amountCents: 1.1 }]) {
    await assert.rejects(adapter.capturePaymentIntent(input));
  }
  await assert.rejects(adapter.cancelPaymentIntent({ paymentIntentId: 'pi_bad', orderId: 'order1' }));
  await assert.rejects(adapter.cancelPaymentIntent({ paymentIntentId: PAYMENT, orderId: '../bad' }));
  assert.equal(calls.length, 2);
  const live = fixture({ secretKey: 'sk_live_fixtureOnly1234567890', allowLive: true });
  await assert.rejects(live.adapter.capturePaymentIntent({ paymentIntentId: PAYMENT, orderId: 'order1', amountCents: 1 }), /test-only/);
  await assert.rejects(live.adapter.cancelPaymentIntent({ paymentIntentId: PAYMENT, orderId: 'order1' }), /test-only/);
  assert.equal(live.calls.length, 0);
});

test('capture and cancel cannot fabricate a matching success from live, mismatched or failed readbacks', async () => {
  const { adapter, client } = fixture();
  client.paymentIntents.capture = async () => ({ id: PAYMENT, livemode: true, status: 'succeeded' });
  await assert.rejects(adapter.capturePaymentIntent({ paymentIntentId: PAYMENT, orderId: 'order1', amountCents: 1 }), { code: 'STRIPE_MODE_MISMATCH' });
  client.paymentIntents.cancel = async () => ({ id: 'pi_otherPayment123', livemode: false, status: 'canceled' });
  await assert.rejects(adapter.cancelPaymentIntent({ paymentIntentId: PAYMENT, orderId: 'order1' }), { code: 'STRIPE_READBACK_MISMATCH' });
  client.paymentIntents.capture = async () => { throw new Error('provider timeout'); };
  await assert.rejects(adapter.capturePaymentIntent({ paymentIntentId: PAYMENT, orderId: 'order1', amountCents: 1 }), { code: 'STRIPE_REQUEST_FAILED' });
});
