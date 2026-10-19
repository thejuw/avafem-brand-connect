import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Stripe from 'stripe';
import {
  createShopifyAdapter, createShopifyOAuthHelpers, createStripeAdapter, STRIPE_API_VERSION, projectBrandBag,
  projectOutboundEvent, shopifyBagTag, signOutboundWebhook, verifyOutboundWebhook,
  validatePublicHttpsUrl, isPublicIp, classifyDeliveryResponse, deliverOutboundWebhook,
} from '../server/integrations/index.mjs';

const bag = () => ({
  id: 'bag_fixture_01', orderId: 'ord_fixture_01', orderRef: 'AVF-1001', brandId: 'brand_fixture',
  status: 'awaiting_shipment', sandbox: true, paid: true,
  items: [{ sku: 'BRAND-ONE', title: 'Fixture item', qty: 1, unitPriceCents: 100, shopifyVariantId: 'gid://shopify/ProductVariant/123', symptoms: 'PRIVATE_HEALTH' }],
  shipTo: { name: 'Synthetic Shopper', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US', phone: 'PRIVATE_PHONE', cycle: 'PRIVATE_HEALTH' },
  shippingCents: 0, taxCents: 0, shippingMethod: 'standard',
  email: 'PRIVATE_EMAIL@example.com', customer: { symptoms: 'PRIVATE_HEALTH', email: 'PRIVATE_EMAIL@example.com' },
  cycle: 'PRIVATE_HEALTH', notes: 'PRIVATE_HEALTH', health: { diagnosis: 'PRIVATE_HEALTH' },
});
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const shopOrder = () => ({ id: 'gid://shopify/Order/123', name: '#1001', sourceIdentifier: 'bag_fixture_01', tags: ['avafem', shopifyBagTag('bag_fixture_01')], test: true, displayFinancialStatus: 'PAID' });

test('Bag and outbound projections exclude private profile fields, phone, email and free-form notes', () => {
  const projected = projectBrandBag(bag());
  const serialized = JSON.stringify(projected);
  assert.equal(projected.ship_to.name, 'Synthetic Shopper');
  assert.equal(projected.items[0].unit_price, 100);
  assert.doesNotMatch(serialized, /PRIVATE_|symptoms|diagnosis|customer|cycle|notes|phone/);
  const event = projectOutboundEvent({ id: 'evt_1', type: 'bag.created', data: { bag: bag(), health: 'PRIVATE_HEALTH' }, customer: { email: 'PRIVATE_EMAIL' } });
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|health|customer|cycle/);
});

test('Shopify absent credentials is unavailable and never invents a connection', async () => {
  const adapter = createShopifyAdapter({ env: {}, useKeychain: false, fetch: () => assert.fail('No request should be made') });
  assert.equal((await adapter.status()).available, false);
  await assert.rejects(adapter.preflight(), { code: 'INTEGRATION_UNAVAILABLE' });
});

test('Unrelated Shopify brands default to authorization-code OAuth and cannot inherit own-store env tokens', async () => {
  const adapter = createShopifyAdapter({ shop: 'another-brand.myshopify.com', env: { SHOPIFY_ACCESS_TOKEN: 'own-shop-token', SHOPIFY_CLIENT_SECRET: 'own-app-secret' }, useKeychain: false, fetch: () => assert.fail('Wrong-store credentials must never be sent') });
  const status = await adapter.status();
  assert.equal(status.authMode, 'authorization_code');
  assert.equal(status.available, false);
  await assert.rejects(adapter.preflight(), /authorization-code OAuth/);
});

test('Shopify external order uses stable short tags, both test flags and relay email with no PII extras', async () => {
  const calls = [];
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    if (payload.query.includes('AvafemFindOrder')) return jsonResponse({ data: { orders: { nodes: [] } } });
    return jsonResponse({ data: { orderCreate: { order: shopOrder(), userErrors: [] } } });
  } });
  const result = await adapter.createOrder(bag());
  assert.equal(result.mapping.orderId, 'gid://shopify/Order/123');
  const { order, options } = calls.at(-1).variables;
  assert.equal(order.test, true); assert.equal(order.transactions[0].test, true);
  assert.equal(order.transactions[0].gateway, 'manual');
  assert.equal(order.transactions[0].amountSet.shopMoney.amount, '1.00');
  assert.equal(order.sourceIdentifier, bag().id);
  assert.ok(order.tags.every(tag => tag.length <= 40));
  assert.match(order.email, /^bag-[a-f0-9]+@relay\.avafem\.com$/);
  assert.deepEqual(options, { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: 'BYPASS' });
  assert.doesNotMatch(JSON.stringify(order), /PRIVATE_|health|cycle|symptoms|diagnosis|phone/);
  assert.equal(calls.length, 2);
});

test('Shopify finds already-mapped Bag before creating and does not create a duplicate', async () => {
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => {
    assert.match(JSON.parse(options.body).query, /AvafemFindOrder/);
    return jsonResponse({ data: { orders: { nodes: [shopOrder()] } } });
  } });
  assert.equal((await adapter.createOrder(bag())).alreadyExists, true);
});

test('Shopify timeout has uncertain outcome and a second create is blocked without any request', async () => {
  let creates = 0;
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.query.includes('AvafemFindOrder')) return jsonResponse({ data: { orders: { nodes: [] } } });
    creates++; throw new DOMException('Fixture timeout', 'TimeoutError');
  } });
  await assert.rejects(adapter.createOrder(bag()), e => e.code === 'OUTCOME_UNCERTAIN' && e.requiresReconciliation && e.retryable === false);
  await assert.rejects(adapter.createOrder(bag()), { code: 'OUTCOME_UNCERTAIN' });
  assert.equal(creates, 1);
});

test('Shopify uncertainty clears only when reconciliation finds the created order', async () => {
  let created = false;
  let reads = 0;
  let creates = 0;
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => {
    if (JSON.parse(options.body).query.includes('AvafemFindOrder')) {
      reads++;
      return jsonResponse({ data: { orders: { nodes: created ? [shopOrder()] : [] } } });
    }
    creates++; created = true;
    throw new Error('Success response was lost');
  } });
  await assert.rejects(adapter.createOrder(bag()), { code: 'OUTCOME_UNCERTAIN' });
  assert.equal((await adapter.findOrder(bag().id)).id, shopOrder().id);
  assert.equal((await adapter.createOrder(bag())).alreadyExists, true);
  assert.equal(creates, 1); assert.equal(reads, 3);
});

test('Shopify 5xx and resolver error are uncertain, not automatic retry/fallback', async () => {
  for (const response of [() => jsonResponse({}, 503), () => jsonResponse({ errors: [{ message: 'Internal resolver error' }] })]) {
    const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async (_url, options) => JSON.parse(options.body).query.includes('AvafemFindOrder') ? jsonResponse({ data: { orders: { nodes: [] } } }) : response() });
    await assert.rejects(adapter.createOrder(bag()), { code: 'OUTCOME_UNCERTAIN' });
  }
});

test('Shopify rejects invented tax lines, live writes and unpaid Bags before creating', async () => {
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: () => assert.fail('No request should be made') });
  await assert.rejects(adapter.createOrder({ ...bag(), taxCents: 8 }), /authoritative/);
  await assert.rejects(adapter.createOrder(bag(), { test: false }), /Live Shopify/);
  await assert.rejects(adapter.createOrder({ ...bag(), paid: false }), /paid Bag/);
});

test('Shopify preflight obtains expiring own-store credentials once without exposing them', async () => {
  let tokenCalls = 0;
  const adapter = createShopifyAdapter({ env: {}, useKeychain: false, clientSecret: 'fixture-secret', fetch: async (url, options) => {
    if (url.includes('/oauth/access_token')) {
      tokenCalls++; assert.match(String(options.body), /grant_type=client_credentials/);
      return jsonResponse({ access_token: 'fixture-token', expires_in: 86399, scope: 'write_orders' });
    }
    return jsonResponse({ data: { shop: { myshopifyDomain: 'i4vd1u-s8.myshopify.com' }, currentAppInstallation: { app: { title: 'Fixture' }, accessScopes: [{ handle: 'write_orders' }] }, locations: { nodes: [] } } });
  } });
  const result = await adapter.preflight(); await adapter.preflight();
  assert.equal(result.connected, true); assert.equal(tokenCalls, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token|fixture-secret/);
  assert.ok(!result.missingScopes.includes('read_orders'));
});

test('Shopify product import uses canonical nested variant money/inventory and flags remaining pages', async () => {
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'fixture-token', fetch: async () => jsonResponse({ data: {
    shop: { currencyCode: 'USD' }, products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      id: 'gid://shopify/Product/123', title: 'Fixture', descriptionHtml: '<p>Fixture</p>', handle: 'fixture', status: 'ACTIVE',
      images: { nodes: [{ url: 'https://cdn.shopify.com/fixture.jpg' }] },
      variants: { pageInfo: { hasNextPage: true, endCursor: 'remaining' }, nodes: [{ id: 'gid://shopify/ProductVariant/456', title: 'M', sku: '', price: '24.00', inventoryQuantity: 7, inventoryPolicy: 'DENY', selectedOptions: [{ name: 'Size', value: 'M' }], inventoryItem: { id: 'gid://shopify/InventoryItem/789', tracked: true, requiresShipping: true } }] },
    }] },
  } }) });
  const result = await adapter.listProducts(); const product = result.products[0];
  assert.equal(product.sku, 'fixture-456');
  assert.deepEqual(product.variants[0].price, { amount: 2400, currency: 'USD' });
  assert.deepEqual(product.variants[0].inventory, { qty: 7, policy: 'deny' });
  assert.equal(product.variants[0].shopifyVariantId, 'gid://shopify/ProductVariant/456');
  assert.equal(product.variants[0].priceCents, undefined);
  assert.equal(result.warnings[0].code, 'VARIANT_PAGINATION_REQUIRED');
});

test('Shopify webhook verification uses raw bytes and rejects malformed HMACs', async () => {
  const adapter = createShopifyAdapter({ env: {}, clientSecret: 'fixture-secret', useKeychain: false });
  const raw = Buffer.from('{ "fixture": true }');
  const signature = createHmac('sha256', 'fixture-secret').update(raw).digest('base64');
  assert.equal(await adapter.verifyWebhook(raw, signature), true);
  assert.equal(await adapter.verifyWebhook(Buffer.from('{"fixture":true}'), signature), false);
  assert.equal(await adapter.verifyWebhook(raw, 'bad'), false);
});

test('Shopify webhook verification honors the advertised environment signing-secret override', async () => {
  const adapter = createShopifyAdapter({ env: { SHOPIFY_WEBHOOK_SECRET: 'fixture-webhook-override' }, clientSecret: 'different-app-secret', useKeychain: false });
  const raw = Buffer.from('{"id":123}');
  const valid = createHmac('sha256', 'fixture-webhook-override').update(raw).digest('base64');
  const wrong = createHmac('sha256', 'different-app-secret').update(raw).digest('base64');
  assert.equal(await adapter.verifyWebhook(raw, valid), true);
  assert.equal(await adapter.verifyWebhook(raw, wrong), false);
});

test('Unrelated-store OAuth binds single-use state, HMAC, timestamp and exact shop', () => {
  const secret = 'fixture-secret';
  const oauth = createShopifyOAuthHelpers({ clientId: 'fixture-client', clientSecret: secret, redirectUri: 'https://avafem.example/callback' });
  const { state, url } = oauth.authorizationUrl('brand-fixture.myshopify.com');
  assert.equal(new URL(url).hostname, 'brand-fixture.myshopify.com');
  const params = new URLSearchParams({ code: 'fixture-code', shop: 'brand-fixture.myshopify.com', state, timestamp: String(Math.floor(Date.now() / 1000)) });
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${k}=${v}`).join('&');
  params.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  const tampered = new URLSearchParams(params); tampered.set('shop', 'attacker.myshopify.com');
  assert.throws(() => oauth.verifyCallback(tampered), /does not match/);
  assert.deepEqual(oauth.verifyCallback(params), { shop: 'brand-fixture.myshopify.com', code: 'fixture-code' });
  assert.throws(() => oauth.verifyCallback(params), /already used/);
});

test('Outbound HMAC enforces exact bytes and five-minute past/future tolerance', () => {
  const raw = Buffer.from('{ "id":"evt_fixture" }');
  const header = signOutboundWebhook(raw, 'fixture-secret', 1000);
  assert.equal(verifyOutboundWebhook(raw, header, 'fixture-secret', { now: 1200 }), true);
  assert.equal(verifyOutboundWebhook(raw, header, 'fixture-secret', { now: 1301 }), false);
  assert.equal(verifyOutboundWebhook(raw, header, 'fixture-secret', { now: 699 }), false);
  assert.equal(verifyOutboundWebhook(Buffer.from('{}'), header, 'fixture-secret', { now: 1000 }), false);
  assert.equal(verifyOutboundWebhook(raw, `${header},t=1000`, 'fixture-secret', { now: 1000 }), false);
});

test('Webhook destinations reject private, reserved, mapped and mixed DNS addresses', async () => {
  for (const ip of ['127.0.0.1', '10.2.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:0db8::1', '2002:7f00:1::1']) assert.equal(isPublicIp(ip), false, ip);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2001:4860:4860::8888'), true);
  for (const url of ['http://public.example/hooks', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://user:pass@public.example/hook', 'https://[::ffff:7f00:1]/hook']) await assert.rejects(validatePublicHttpsUrl(url));
  await assert.rejects(validatePublicHttpsUrl('https://public.example/hook', { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /private/);
  const checked = await validatePublicHttpsUrl('https://public.example/hook', { resolve: async () => [{ address: '8.8.8.8', family: 4 }] });
  assert.equal(checked.addresses[0].address, '8.8.8.8');
});

test('Webhook delivery pins validated DNS address, strips health extras and never follows redirects', async () => {
  let captured;
  const result = await deliverOutboundWebhook({
    url: 'https://public.example/hook', secret: 'fixture-secret', event: { id: 'evt_1', type: 'bag.created', sandbox: true, data: { bag: bag(), health: 'PRIVATE_HEALTH' } },
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_url, options, callback) => {
      options.lookup('public.example', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
      const request = new EventEmitter();
      request.end = body => { captured = { body, options }; callback({ statusCode: 302, resume() {} }); };
      return request;
    },
  });
  assert.equal(result.ok, false); assert.equal(result.retryable, false);
  assert.doesNotMatch(captured.body.toString(), /PRIVATE_|health|cycle/);
  assert.equal(JSON.parse(captured.body).sandbox, true);
  assert.equal(verifyOutboundWebhook(captured.body, captured.options.headers['avafem-signature'], 'fixture-secret'), true);
  assert.equal(classifyDeliveryResponse(429).retryable, true);
  assert.equal(classifyDeliveryResponse(401).retryable, false);
});

test('Stripe is unavailable without credentials and live keys require explicit opt-in', async () => {
  const adapter = createStripeAdapter({ env: {} });
  assert.equal(adapter.status().available, false);
  await assert.rejects(adapter.preflight(), { code: 'INTEGRATION_UNAVAILABLE' });
  assert.throws(() => createStripeAdapter({ secretKey: 'sk_live_fixture' }), /Live Stripe keys/);
});

test('Stripe PaymentIntent receives only whitelisted shipping/metadata and stable idempotency', async () => {
  let captured;
  const adapter = createStripeAdapter({ env: {}, client: { paymentIntents: { create: async (params, options) => { captured = { params, options }; return { id: 'pi_fixture12345', livemode: false }; } } } });
  await adapter.createPaymentIntent({ orderId: 'ord_fixture', amountCents: 100, shipTo: bag().shipTo, receiptEmail: 'synthetic@example.com', health: 'PRIVATE_HEALTH', metadata: { cycle: 'PRIVATE_HEALTH' } });
  assert.equal(captured.params.shipping.address.line1, '123 Test Street');
  assert.equal(captured.params.transfer_group, 'ORD_ord_fixture');
  assert.equal(captured.options.idempotencyKey, 'payment:ord_fixture:v1');
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_|health|cycle|phone/);
  assert.equal(captured.params.confirm, undefined);
  assert.deepEqual(captured.params.allowed_payment_method_types, ['card']);
  assert.equal(Object.hasOwn(captured.params, 'payment_method_types'), false);
  assert.equal(Object.hasOwn(captured.params, 'automatic_payment_methods'), false, 'Endive forbids combining the allow-list with automatic_payment_methods.');
});

test('Stripe current SDK API pin and official Visa fixture use Endive card-only create parameters', async () => {
  assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
  assert.equal(STRIPE_API_VERSION, Stripe.API_VERSION, 'Review the explicit API pin when upgrading the Stripe SDK.');
  let captured;
  const adapter = createStripeAdapter({ secretKey: 'sk_test_fixture1234567890', env: {}, client: {
    paymentIntents: { create: async (params, options) => { captured = { params, options }; return { id: 'pi_fixture12345', livemode: false }; } },
  } });
  await adapter.createPaymentIntent({ orderId: 'tco_fixture_01', amountCents: 108, shipTo: bag().shipTo, paymentMethodId: 'pm_card_visa', confirm: true });
  assert.equal(captured.params.confirm, true);
  assert.equal(captured.params.payment_method, 'pm_card_visa');
  assert.deepEqual(captured.params.allowed_payment_method_types, ['card']);
  assert.equal(Object.hasOwn(captured.params, 'payment_method_types'), false);
  assert.equal(Object.hasOwn(captured.params, 'automatic_payment_methods'), false, 'Card-only allow-list and automatic methods must be mutually exclusive.');
  assert.equal(Object.hasOwn(captured.params, 'return_url'), false);
  assert.equal(captured.options.idempotencyKey, 'payment:tco_fixture_01:v1');
});

test('Stripe Connect transfer uses source charge and rejects simulated account IDs', async () => {
  let captured;
  const adapter = createStripeAdapter({ env: {}, client: { transfers: { create: async (params, options) => { captured = { params, options }; return { id: 'tr_fixture12345' }; } } } });
  await adapter.createTransfer({ orderId: 'ord_1', bagId: 'bag_1', amountCents: 100, accountId: 'acct_fixture12345', chargeId: 'ch_fixture12345' });
  assert.equal(captured.params.source_transaction, 'ch_fixture12345');
  assert.equal(captured.options.idempotencyKey, 'transfer:bag_1:v1');
  await assert.rejects(adapter.createTransfer({ orderId: 'ord_1', bagId: 'bag_1', amountCents: 100, accountId: 'acct_sandbox_bloom', chargeId: 'ch_fixture12345' }), /simulated/);
});

test('Stripe refund and brand reversal use distinct amounts; recovery failure retains successful refund', async () => {
  const calls = [];
  const adapter = createStripeAdapter({ env: {}, client: {
    refunds: { create: async (params, options) => { calls.push({ params, options }); return { id: 're_fixture12345' }; } },
    transfers: { createReversal: async (_id, params, options) => { calls.push({ params, options }); const error = new Error('Fixture insufficient balance'); error.code = 'balance_insufficient'; throw error; } },
  } });
  const result = await adapter.refundBag({ paymentIntentId: 'pi_fixture12345', amountCents: 3139, transferId: 'tr_fixture12345', transferReversalAmountCents: 2552, bagId: 'bag_1', refundId: 'refund_1' });
  assert.equal(result.refund.id, 're_fixture12345'); assert.equal(result.requiresManualReview, true);
  assert.equal(result.brandReceivableCents, 2552);
  assert.equal(calls[0].params.amount, 3139); assert.equal(calls[1].params.amount, 2552);
  assert.notEqual(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
});

test('Stripe Tax requires explicit tax codes and passes aggregated line amounts once', async () => {
  let captured;
  const adapter = createStripeAdapter({ env: {}, client: { tax: { calculations: { create: async (params, options) => { captured = { params, options }; return { id: 'taxcalc_fixture12345' }; } } } } });
  await adapter.createTaxCalculation({ orderId: 'ord_1', calculationId: 'rev_1', items: [{ reference: 'bag_1_sku_1', qty: 2, unitPriceCents: 100, taxCode: 'txcd_99999999' }], shipTo: bag().shipTo });
  assert.equal(captured.params.line_items[0].amount, 200);
  assert.equal(captured.params.line_items[0].quantity, 2);
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_|phone|health|cycle/);
  await assert.rejects(adapter.createTaxCalculation({ orderId: 'ord_1', calculationId: 'rev_2', items: [{ reference: 'bag_1_sku_1', qty: 1, unitPriceCents: 100 }], shipTo: bag().shipTo }), /tax code/);
});

test('Stripe webhook validation uses official SDK, raw bytes and rejects live events in test mode', () => {
  const webhookSecret = 'whsec_fixture';
  const adapter = createStripeAdapter({ env: {}, webhookSecret });
  const payload = JSON.stringify({ id: 'evt_fixture', type: 'payment_intent.succeeded', livemode: false, data: { object: { id: 'pi_fixture12345' } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  assert.equal(adapter.verifyWebhook(Buffer.from(payload), signature).id, 'evt_fixture');
  assert.throws(() => adapter.verifyWebhook(Buffer.from(payload + ' '), signature), { code: 'INVALID_WEBHOOK_SIGNATURE' });
  const live = JSON.stringify({ id: 'evt_live', livemode: true });
  assert.throws(() => adapter.verifyWebhook(live, Stripe.webhooks.generateTestHeaderString({ payload: live, secret: webhookSecret })), /Live Stripe events/);
});
