import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createProviderFailureCheckouts, PROVIDER_FAILURE_CHECKOUT_CASES } from '../server/provider-failure-checkouts.mjs';

const PLATFORM = 'acct_1U74iQGgawRtH2qe';
const shops = ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'];
const code = expected => cause => cause.code === expected;
async function setup(t, { dataDir = ':memory:' } = {}) {
  const main = await createDatabase({ connectionString: null }); await main.migrate(); t.after(() => main.close());
  const auth = await createAuth(main, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const calls = [], variants = new Map(), nativeFixtures = new Map(), sessions = new Map(), payments = new Map(), charges = new Map();
  const rows = new Map(); let counter = 0;
  for (const [index, shop] of shops.entries()) {
    const number = ['002', '004', '006'][index], variantId = `gid://shopify/ProductVariant/${100 + index}`;
    const fixture = { productId: `gid://shopify/Product/${200 + index}`, variantId, inventoryItemId: `gid://shopify/InventoryItem/${300 + index}`,
      locationId: `gid://shopify/Location/${400 + index}`, priceCents: 100 * (index + 1), inventoryQty: 10, status: 'ACTIVE', sku: `AVF-CONNECT-TEST-FAIL-${number}` };
    nativeFixtures.set(shop, fixture); rows.set(shop, { shop, brand_id: `brand_actual_${index}`, state: 'connected', shipping_cents: 25 * (index + 1), commission_bps: 1500, return_window_days: 30 });
    variants.set(variantId, { id: variantId, shop, sku: fixture.sku, productTitle: 'Avafem Failure Test — DO NOT SHIP', productStatus: 'ACTIVE',
      priceCents: fixture.priceCents, inventoryQty: 10, inventoryPolicy: 'DENY', tracked: true, requiresShipping: true, currency: 'USD' });
  }
  const stores = { row: async shop => { calls.push(['row', shop]); return structuredClone(rows.get(shop)); }, preflight: async shop => { calls.push(['preflight', shop]); },
    forShop: async shop => ({ shop, getVariant: async id => { calls.push(['getVariant', shop, id]); return structuredClone(variants.get(id)); },
      createOrder: async () => { calls.push(['REAL_ORDER_WRITE']); throw new Error('FORBIDDEN'); } }) };
  const failureFixtures = { inspect: async ({ shop, phase }) => { calls.push(['inspectFixture', shop, phase]); const fixture = nativeFixtures.get(shop);
    const baseline = { ...fixture, inventoryQty: 10, priceCents: (shops.indexOf(shop) + 1) * 100 };
    return { shop, test: true, state: 'prepared', baselineCaptured: true, baseline, fixture: structuredClone(fixture),
      cleanupRequired: fixture.priceCents !== (shops.indexOf(shop) + 1) * 100 || fixture.inventoryQty !== 10 }; } };
  const stripe = {
    preflight: async () => ({ verified: true, mode: 'test', accountId: PLATFORM }),
    createCheckoutSession: async input => {
      calls.push(['createSession', input.orderId]); const id = `cs_test_FailureFixture${++counter}`;
      const value = { id, url: `https://checkout.stripe.com/c/pay/${id}`, livemode: false, mode: 'payment', status: 'open', currency: 'usd',
        client_reference_id: input.orderId, metadata: { order_id: input.orderId }, payment_intent: null, amount_subtotal: 600, amount_total: 812,
        total_details: { amount_tax: 62, amount_discount: 0 }, automatic_tax: { status: 'complete' },
        shipping_cost: { amount_subtotal: 150, amount_tax: 12, taxes: [{ amount: 12, rate: { id: 'txr_shipping', percentage: 8.25, country: 'US', state: 'TX', inclusive: false } }] },
        collected_information: { shipping_details: { name: 'PRIVATE_SHOPPER', address: { line1: 'PRIVATE_STREET', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } },
        customer_details: { email: 'PRIVATE_EMAIL' }, privateItems: input.items };
      sessions.set(id, value); return structuredClone(value);
    },
    getCheckoutSession: async id => { calls.push(['getSession', id]); return structuredClone(sessions.get(id)); },
    listCheckoutLineItems: async id => { calls.push(['listLines', id]); return { data: sessions.get(id).privateItems.map((item, index) => ({ id: `li_${index}`,
      quantity: 1, currency: 'usd', price: { currency: 'usd', unit_amount: item.unitPriceCents, product: { metadata: { reference: item.reference } } },
      amount_subtotal: item.unitPriceCents, amount_tax: [8, 17, 25][index], amount_total: item.unitPriceCents + [8, 17, 25][index], amount_discount: 0,
      taxes: [{ amount: [8, 17, 25][index], rate: { id: 'txr_fixture', percentage: 8.25, country: 'US', state: 'TX', inclusive: false } }] })), has_more: false }; },
    getPaymentIntent: async id => { calls.push(['getPayment', id]); return structuredClone(payments.get(id)); },
    getCharge: async id => { calls.push(['getCharge', id]); return structuredClone(charges.get(id)); },
    capturePaymentIntent: async () => { calls.push(['REAL_CAPTURE_WRITE']); throw new Error('FORBIDDEN'); },
    cancelPaymentIntent: async input => { calls.push(['cancelPayment', input.paymentIntentId, input.orderId]); const payment = payments.get(input.paymentIntentId); payment.status = 'canceled'; return structuredClone(payment); },
    expireTestCheckoutSession: async ({ sessionId, orderId }) => { calls.push(['expireSession', sessionId, orderId]); const session = sessions.get(sessionId);
      assert.equal(session.client_reference_id, orderId); session.status = 'expired'; if (session.payment_intent) payments.get(session.payment_intent).status = 'canceled'; return structuredClone(session); },
  };
  const service = await createProviderFailureCheckouts(auth, { stores, getStripe: () => stripe, failureFixtures, dataDir, clock: () => new Date('2026-10-19T15:00:00Z') });
  t.after(() => service.close());
  const create = caseId => service.create({ caseId, operationId: `failure_${caseId}_v1`, confirmTest: true });
  const sessionFor = runId => [...sessions.values()].find(value => value.client_reference_id === runId);
  const authorize = runId => {
    const session = sessionFor(runId), number = session.id.match(/\d+$/)[0], paymentId = `pi_FailurePayment${number}`, chargeId = `ch_FailureAuthorization${number}`;
    session.status = 'complete'; session.payment_intent = paymentId;
    const payment = { id: paymentId, livemode: false, currency: 'usd', status: 'requires_capture', amount: 812, amount_received: 0,
      metadata: { order_id: runId, integration: 'avafem' }, transfer_group: `ORD_${runId}`, latest_charge: chargeId };
    payments.set(paymentId, payment); charges.set(chargeId, { id: chargeId, livemode: false, currency: 'usd', amount: 812, amount_captured: 0, captured: false, paid: true, payment_intent: paymentId });
    return payment;
  };
  const mutate = (index, kind) => {
    const fixture = nativeFixtures.get(shops[index]), variant = variants.get(fixture.variantId);
    if (kind === 'stock') { fixture.inventoryQty = 0; variant.inventoryQty = 0; }
    else { fixture.priceCents++; variant.priceCents++; }
  };
  const restore = index => { const fixture = nativeFixtures.get(shops[index]), variant = variants.get(fixture.variantId); fixture.inventoryQty = variant.inventoryQty = 10; fixture.priceCents = variant.priceCents = (index + 1) * 100; };
  return { main, auth, calls, rows, stores, stripe, failureFixtures, variants, nativeFixtures, sessions, payments, charges, service, create, authorize, mutate, restore, sessionFor };
}

test('constructor is lazy, separate storage has no worker, and create/replay persist one hosted Session without touching main accounting', async t => {
  const fx = await setup(t); assert.equal(fx.calls.length, 0);
  const result = await fx.create('stock_changed_002'); assert.equal(result.state, 'checkout_open'); assert.equal(result.test, true);
  assert.equal(result.isolation, 'separate_failure_database_no_worker'); assert.equal(result.expectedCapturedCents, 0); assert.equal(result.maxTotalCents, 1000);
  assert.match(result.checkoutUrl, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  assert.deepEqual((await fx.create('stock_changed_002')).sessionId, result.sessionId);
  assert.equal(fx.calls.filter(call => call[0] === 'createSession').length, 1); assert.equal((await fx.service.list()).length, 1);
  assert.ok(Object.values(result.localRecords).every(value => value === 0));
  assert.equal((await fx.main.query('SELECT COUNT(*)::integer AS count FROM orders')).rows[0].count, 0);
  assert.equal((await fx.main.query('SELECT COUNT(*)::integer AS count FROM ledger_journals')).rows[0].count, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|client_secret|sk_test_|shipping_details/);
});

test('fixed seven cases cannot accept caller amounts/cards/URLs/stores or create replacement Sessions with different operation IDs', async t => {
  const fx = await setup(t);
  await assert.rejects(fx.service.create({ caseId: 'declined_payment', operationId: 'failure_decline_v1', confirmTest: true, amountCents: 1 }), code('FAILURE_CHECKOUT_INPUT'));
  await assert.rejects(fx.service.create({ caseId: 'unapproved_case', operationId: 'failure_other_v1', confirmTest: true }), code('FAILURE_CHECKOUT_CONFIRMATION'));
  for (const caseId of PROVIDER_FAILURE_CHECKOUT_CASES) await fx.create(caseId);
  assert.equal(fx.sessions.size, 7); assert.equal((await fx.service.list()).length, 7);
  await assert.rejects(fx.service.create({ caseId: 'declined_payment', operationId: 'replacement_decline_v2', confirmTest: true }), code('FAILURE_CHECKOUT_OPERATION_CONFLICT'));
  await assert.rejects(fx.service.get({ runId: `uco_${'f'.repeat(32)}` }), code('FAILURE_CHECKOUT_NOT_FOUND'));
  assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE' || call[0] === 'REAL_ORDER_WRITE').length, 0);
});

test('all six isolated stock/price authorization races require the exact mutation then cancel before any capture/order', async t => {
  const fx = await setup(t);
  for (const kind of ['stock', 'price']) for (const [index, number] of ['002', '004', '006'].entries()) {
    const result = await fx.create(`${kind}_changed_${number}`), payment = fx.authorize(result.runId);
    const observed = await fx.service.observe({ runId: result.runId }); assert.equal(observed.observation.paymentStatus, 'requires_capture'); assert.equal(observed.observation.capturedCents, 0);
    const cancels = fx.calls.filter(call => call[0] === 'cancelPayment').length;
    await assert.rejects(fx.service.reconcile({ runId: result.runId, confirmTest: true }), code('FAILURE_MUTATION_REQUIRED'));
    assert.equal(fx.calls.filter(call => call[0] === 'cancelPayment').length, cancels);
    fx.mutate(index, kind);
    const cancelled = await fx.service.reconcile({ runId: result.runId, confirmTest: true });
    assert.equal(cancelled.state, 'authorization_cancelled'); assert.equal(payment.status, 'canceled'); assert.equal(cancelled.observation.capturedCents, 0);
    assert.equal(cancelled.casePassed, true); assert.equal(cancelled.raceCancellationEvidence.verification, 'unified_pre_capture_revalidation_cancelled');
    assert.equal(cancelled.mutationObserved.providerReadVerified, true); assert.ok(Object.values(cancelled.localRecords).every(value => value === 0));
    fx.restore(index); assert.equal((await fx.service.reconcile({ runId: result.runId, confirmTest: true })).state, 'authorization_cancelled');
    assert.equal(fx.calls.filter(call => call[0] === 'cancelPayment').length, cancels + 1);
  }
  assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE' || call[0] === 'REAL_ORDER_WRITE').length, 0);
  assert.ok(fx.calls.filter(call => call[0] === 'inspectFixture').every(call => call[2] === 'checkout'));
});

test('a fixture restored between the mutation guard and underlying revalidation still cannot reach the real capture adapter', async t => {
  const fx = await setup(t), result = await fx.create('price_changed_002'); fx.authorize(result.runId); fx.mutate(0, 'price');
  const original = fx.stores.forShop;
  fx.stores.forShop = async shop => { fx.restore(0); return original(shop); };
  const response = await fx.service.reconcile({ runId: result.runId, confirmTest: true });
  assert.equal(response.state, 'needs_review'); assert.equal(response.observation.paymentStatus, 'requires_capture');
  assert.ok(Object.values(response.localRecords).every(value => value === 0)); assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE').length, 0);
});

test('native declined PI is observed without trusting UI text, and explicit cleanup expires its Session instead of directly cancelling a Checkout-owned declined PI', async t => {
  const fx = await setup(t), result = await fx.create('declined_payment'), payment = fx.authorize(result.runId);
  fx.sessionFor(result.runId).status = 'open'; payment.status = 'requires_payment_method'; payment.latest_charge = null;
  payment.last_payment_error = { code: 'card_declined', decline_code: 'generic_decline', message: 'PRIVATE_ERROR secret https://evil.example/' };
  const observed = await fx.service.observe({ runId: result.runId }); assert.equal(observed.state, 'decline_observed'); assert.equal(observed.observation.declined, true);
  assert.equal(observed.observation.paymentErrorCode, 'card_declined'); assert.equal(observed.observation.declineCode, 'generic_decline');
  assert.equal((await fx.service.reconcile({ runId: result.runId, confirmTest: true })).state, 'decline_observed');
  const cleanup = await fx.service.cancel({ runId: result.runId, confirmTest: true }); assert.equal(cleanup.cleanup, 'authorization_cancel_verified');
  assert.equal(cleanup.casePassed, true); assert.equal(cleanup.declineEvidence.declined, true); assert.equal(cleanup.declineEvidence.paymentStatus, 'requires_payment_method');
  await fx.service.cancel({ runId: result.runId, confirmTest: true }); assert.equal(fx.calls.filter(call => call[0] === 'expireSession').length, 1);
  assert.equal(fx.calls.filter(call => call[0] === 'cancelPayment').length, 0);
  assert.doesNotMatch(JSON.stringify(cleanup), /PRIVATE_|evil\.example|secret/);
});

test('unknown cleanup cannot repeat a mutation; later authoritative canceled readback safely recovers the original PI', async t => {
  const fx = await setup(t), result = await fx.create('stock_changed_002'), payment = fx.authorize(result.runId);
  const cancel = fx.stripe.cancelPaymentIntent; fx.stripe.cancelPaymentIntent = async input => { await cancel(input); throw new Error('PRIVATE response lost'); };
  assert.equal((await fx.service.cancel({ runId: result.runId, confirmTest: true })).state, 'cancel_uncertain');
  assert.equal((await fx.service.cancel({ runId: result.runId, confirmTest: true })).state, 'authorization_cancelled');
  assert.equal(fx.calls.filter(call => call[0] === 'cancelPayment').length, 1); assert.equal(payment.status, 'canceled');
});

test('unmutated/foreign fixture, changed PI, live mode, oversized totals and unexpected capture remain review without bookkeeping', async t => {
  const fx = await setup(t), result = await fx.create('stock_changed_002'), payment = fx.authorize(result.runId);
  payment.status = 'succeeded'; payment.amount_received = 812; fx.charges.get(payment.latest_charge).captured = true;
  const paid = await fx.service.reconcile({ runId: result.runId, confirmTest: true }); assert.equal(paid.state, 'unexpected_capture_review');
  assert.ok(Object.values(paid.localRecords).every(value => value === 0));
  await assert.rejects(fx.service.cancel({ runId: result.runId, confirmTest: true }), code('FAILURE_UNEXPECTED_CAPTURE'));
  fx.sessionFor(result.runId).amount_total = 1001; assert.equal((await fx.service.observe({ runId: result.runId })).state, 'needs_review');
  fx.sessionFor(result.runId).amount_total = 812; fx.sessionFor(result.runId).livemode = true;
  assert.equal((await fx.service.observe({ runId: result.runId })).observation.capturedCents, 812); // retained prior observation, not fabricated zero
  assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE' || call[0] === 'REAL_ORDER_WRITE').length, 0);
});

test('upstream raw errors and unsafe Session URLs never escape safe summaries, and close is idempotent', async t => {
  const fx = await setup(t); fx.failureFixtures.inspect = async () => { throw Object.assign(new Error('PRIVATE https://evil.example/sk_test_secret'), { unifiedSafe: true, code: 'FAILURE_FAKE' }); };
  await assert.rejects(fx.create('declined_payment'), cause => cause.code === 'FAILURE_OPERATION_UNVERIFIED' && !/PRIVATE|https|secret/.test(cause.message));
  await fx.service.close(); await fx.service.close(); await assert.rejects(fx.service.list(), code('FAILURE_CHECKOUT_CLOSED'));
});

test('fixture deletion gate requires all seven closed native Sessions, rejects active authorizations and verifies zero captured/booked money', async t => {
  const fx = await setup(t); assert.equal(await fx.service.safeToDeleteFixtures(), false);
  const reports = [];
  for (const caseId of PROVIDER_FAILURE_CHECKOUT_CASES) reports.push(await fx.create(caseId));
  assert.equal(await fx.service.safeToDeleteFixtures(), false);
  for (const report of reports) await fx.service.cancel({ runId: report.runId, confirmTest: true });
  assert.equal(await fx.service.safeToDeleteFixtures(), true);
  assert.ok((await fx.service.list()).every(report => report.casePassed === false)); // safe cleanup is not an invented successful failure exercise
  const active = reports[1], session = fx.sessionFor(active.runId); session.status = 'complete'; fx.authorize(active.runId);
  assert.equal(await fx.service.safeToDeleteFixtures(), false);
  await fx.service.cancel({ runId: active.runId, confirmTest: true }); assert.equal(await fx.service.safeToDeleteFixtures(), true);
  const payment = fx.payments.get(session.payment_intent); payment.amount_received = 1;
  assert.equal(await fx.service.safeToDeleteFixtures(), false);
});

test('an exact same-handle fixture without server-created immutable baseline is not adopted for a hosted checkout', async t => {
  const fx = await setup(t), original = fx.failureFixtures.inspect;
  fx.failureFixtures.inspect = async input => ({ ...await original(input), baselineCaptured: false, baseline: null, state: 'unprepared' });
  await assert.rejects(fx.create('declined_payment'), code('FAILURE_FIXTURE_BASELINE_REQUIRED'));
  assert.equal(fx.sessions.size, 0);
});

test('a durable isolated restart replays its original operation/run/Session instead of making a replacement authorization', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'avafem-isolated-failure-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = join(temporary, 'provider-failure-tests'), fx = await setup(t, { dataDir });
  const first = await fx.create('declined_payment'); await fx.service.close();
  const reopened = await createProviderFailureCheckouts(fx.auth, { stores: fx.stores, getStripe: () => fx.stripe, failureFixtures: fx.failureFixtures,
    dataDir, clock: () => new Date('2026-10-19T15:00:00Z') });
  try {
    const replay = await reopened.create({ caseId: 'declined_payment', operationId: 'failure_declined_payment_v1', confirmTest: true });
    assert.equal(replay.runId, first.runId); assert.equal(replay.sessionId, first.sessionId); assert.equal(fx.sessions.size, 1);
    assert.equal((await reopened.list()).length, 1); assert.ok(Object.values(replay.localRecords).every(value => value === 0));
  } finally { await reopened.close(); }
});

test('an oversized or unverified native Session preserves its ID but never returns a payment URL', async t => {
  const fx = await setup(t), original = fx.stripe.createCheckoutSession;
  fx.stripe.createCheckoutSession = async input => { const value = await original(input); fx.sessions.get(value.id).amount_total = 1001; return value; };
  const result = await fx.create('declined_payment'); assert.equal(result.state, 'needs_review'); assert.equal(result.checkoutUrl, null);
  assert.match(result.sessionId, /^cs_test_/); assert.equal(fx.sessions.size, 1); assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE').length, 0);
});

test('existing-run create replay freshly checks Session cap and identity before URL exposure without a replacement', async t => {
  const fx = await setup(t), first = await fx.create('declined_payment');
  fx.sessionFor(first.runId).amount_total = 1001;
  const replay = await fx.create('declined_payment'); assert.equal(replay.runId, first.runId); assert.equal(replay.sessionId, first.sessionId);
  assert.equal(replay.checkoutUrl, null); assert.equal(replay.lastError.code, 'FAILURE_SESSION_REVIEW_REQUIRED');
  assert.equal((await fx.service.get({ runId: first.runId })).checkoutUrl, null); assert.equal(fx.sessions.size, 1);
});

test('orphaned run-ID recovery verifies the original Session and keeps its URL hidden when native identity is invalid', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'avafem-recovery-failure-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const dataDir = join(temporary, 'provider-failure-tests'), fx = await setup(t, { dataDir });
  const first = await fx.create('declined_payment'); await fx.service.close();
  const edit = await createDatabase({ dataDir, connectionString: null });
  try {
    const row = (await edit.query('SELECT * FROM provider_failure_checkout_cases')).rows[0], privateData = fx.auth.decrypt(row.private_encrypted);
    delete privateData.observation;
    await edit.query("UPDATE provider_failure_checkout_cases SET run_id=NULL,state='creating_session',private_encrypted=$1", [fx.auth.encrypt(privateData)]);
  } finally { await edit.close(); }
  fx.sessionFor(first.runId).livemode = true;
  const reopened = await createProviderFailureCheckouts(fx.auth, { stores: fx.stores, getStripe: () => fx.stripe, failureFixtures: fx.failureFixtures,
    dataDir, clock: () => new Date('2026-10-19T15:00:00Z') });
  try {
    const recovered = await reopened.create({ caseId: 'declined_payment', operationId: 'failure_declined_payment_v1', confirmTest: true });
    assert.equal(recovered.runId, first.runId); assert.equal(recovered.sessionId, first.sessionId); assert.equal(recovered.checkoutUrl, null);
    assert.equal(recovered.state, 'needs_review'); assert.equal(recovered.lastError.code, 'FAILURE_SESSION_REVIEW_REQUIRED'); assert.equal(fx.sessions.size, 1);
    assert.equal(fx.calls.filter(call => call[0] === 'REAL_CAPTURE_WRITE' || call[0] === 'REAL_ORDER_WRITE').length, 0);
  } finally { await reopened.close(); }
});
