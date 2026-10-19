import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.mjs';
import { createUnifiedCheckout } from './unified-checkout.mjs';
import { TEST_STORES } from './test-stores.mjs';

const PLATFORM = 'acct_1U74iQGgawRtH2qe', MAX_TOTAL = 1000;
export const PROVIDER_FAILURE_CHECKOUT_CASES = Object.freeze(['declined_payment', ...['stock', 'price'].flatMap(kind => ['002', '004', '006'].map(number => `${kind}_changed_${number}`))]);
const fixtures = TEST_STORES.map((store, index) => ({ ...store, number: ['002', '004', '006'][index], priceCents: (index + 1) * 100,
  sku: `AVF-CONNECT-TEST-FAIL-${['002', '004', '006'][index]}` }));
const hash = value => createHash('sha256').update(value).digest('hex');
const operation = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const run = value => typeof value === 'string' && /^uco_[a-f0-9]{32}$/.test(value);
const providerId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const gid = (value, kind) => typeof value === 'string' && new RegExp(`^gid://shopify/${kind}/[0-9]{1,40}$`).test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
class FailureCheckoutError extends Error {
  constructor(code, message, statusCode = 409) { super(message); Object.assign(this, { code, statusCode, unifiedSafe: true }); }
}
const fail = (code, message, statusCode = 409) => { throw new FailureCheckoutError(code, message, statusCode); };
const exactInput = (input, allowed) => { if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key))) fail('FAILURE_CHECKOUT_INPUT', 'Only the fixed failure-test fields are accepted.', 422); };
const safeUrl = value => { try { const url = new URL(value); return value.length < 5000 && url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
  && !url.port && !url.username && !url.password && /^\/(?:c\/)?pay\//.test(url.pathname) ? url.href : null; } catch { return null; } };
const fixtureProjection = (value, expected) => {
  if (!gid(value?.productId, 'Product') || !gid(value?.variantId, 'ProductVariant') || !gid(value?.inventoryItemId, 'InventoryItem') || !gid(value?.locationId, 'Location')
    || value.sku !== expected.sku || !Number.isSafeInteger(value.priceCents) || !nonnegative(value.inventoryQty) || value.inventoryQty > 10 || !['ACTIVE', 'ARCHIVED'].includes(value.status))
    fail('FAILURE_FIXTURE_IDENTITY', 'The dedicated disposable fixture does not verify.');
  return { shop: expected.shop, productId: value.productId, variantId: value.variantId, inventoryItemId: value.inventoryItemId, locationId: value.locationId,
    sku: value.sku, priceCents: value.priceCents, inventoryQty: value.inventoryQty, status: value.status };
};
const rememberObservation = (privateData, observation) => {
  privateData.observation = observation;
  if (observation.declined) privateData.declineEvidence ??= structuredClone(observation);
  return observation;
};

/** Seven isolated, manual-authorization failure cases. NO timer exists and the
 * main worker cannot see this database. Capture, order creation and every other
 * financial write are blocked even if a mutation/race guard is wrong. Only
 * native Session creation, authoritative reads and one known-PI cancellation
 * are permitted; no caller amount, card, provider ID, URL or GraphQL is accepted.
 * The default DB is durable; ':memory:' explicitly isolates unit tests.
 */
export async function createProviderFailureCheckouts(auth, {
  stores, getStripe, failureFixtures, dataDir = fileURLToPath(new URL('../.runtime/provider-failure-tests', import.meta.url)), clock = () => new Date(),
} = {}) {
  if (!auth?.encrypt || !auth?.decrypt || !stores?.row || !stores?.preflight || !stores?.forShop || !failureFixtures?.inspect || typeof getStripe !== 'function')
    fail('FAILURE_CHECKOUT_SETUP', 'Encrypted storage and exact bound test adapters are required.', 503);
  let initialization, closed = false;
  const now = () => { const value = new Date(clock()); if (!Number.isFinite(value.getTime())) fail('FAILURE_CHECKOUT_CLOCK', 'A valid wall clock is required.'); return value; };
  async function ready() {
    if (closed) fail('FAILURE_CHECKOUT_CLOSED', 'The isolated failure test service is closed.', 503);
    initialization ??= (async () => {
      if (dataDir !== ':memory:') await mkdir(dirname(dataDir), { recursive: true });
      const db = await createDatabase({ ...(dataDir === ':memory:' ? {} : { dataDir }), connectionString: null });
      try {
        await db.migrate();
        await db.query(`CREATE TABLE IF NOT EXISTS provider_failure_checkout_cases (
          operation_id TEXT PRIMARY KEY,case_id TEXT NOT NULL UNIQUE,run_id TEXT UNIQUE,request_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,private_encrypted TEXT NOT NULL,lock_token TEXT,lease_until TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const brandIds = new Set();
        for (const [index, fixture] of fixtures.entries()) {
          const row = await stores.row(fixture.shop);
          if (!row?.brand_id || brandIds.has(row.brand_id)) fail('FAILURE_STORE_BINDING', 'Three distinct existing brand/store bindings are required.');
          brandIds.add(row.brand_id);
          await db.query(`INSERT INTO brands(id,name,slug,commission_bps,connection_tier,return_window_days,shipping_table)
            VALUES($1,$2,$3,1500,'shopify',30,$4) ON CONFLICT(id) DO NOTHING`, [row.brand_id, `Isolated Failure Test ${fixture.number}`,
            `isolated-failure-${index}`, JSON.stringify([{ country: 'US', priceCents: fixture.shippingCents }])]);
        }
        const readMethods = ['preflight', 'getCheckoutSession', 'listCheckoutLineItems', 'getPaymentIntent', 'getCharge'];
        const stripe = Object.fromEntries(readMethods.map(method => [method, (...args) => getStripe()[method](...args)]));
        stripe.createCheckoutSession = async input => {
          const subtotal = input.items?.reduce((total, item) => total + item.unitPriceCents * item.qty, 0);
          if (input.captureMethod !== 'manual' || input.items?.length !== 3 || subtotal !== 600 || input.shippingCents !== 150
            || input.items.some(item => item.qty !== 1 || !fixtures.some(fixture => fixture.sku === item.sku && fixture.priceCents === item.unitPriceCents)))
            fail('FAILURE_CART_CHANGED', 'Only the fixed three-item manual-authorization failure cart is allowed.');
          return getStripe().createCheckoutSession(input);
        };
        stripe.capturePaymentIntent = async () => fail('FAILURE_CAPTURE_FORBIDDEN', 'Failure-test authorizations can never be captured.');
        stripe.cancelPaymentIntent = input => getStripe().cancelPaymentIntent(input);
        const isolatedStores = { ...stores, forShop: async shop => {
          if (!fixtures.some(fixture => fixture.shop === shop)) fail('FAILURE_STORE_BINDING', 'Only the exact three failure-test stores are allowed.');
          const adapter = await stores.forShop(shop);
          return { ...adapter, createOrder: async () => fail('FAILURE_ORDER_FORBIDDEN', 'Failure-test checkouts can never create a Shopify order.') };
        } };
        const unified = await createUnifiedCheckout(db, auth, { stores: isolatedStores, getStripe: () => stripe, clock });
        return { db, unified };
      } catch (cause) { await db.close(); throw cause; }
    })();
    return initialization;
  }
  const decode = row => auth.decrypt(row.private_encrypted);
  async function rowFor(runId, db) {
    if (!run(runId)) fail('FAILURE_CHECKOUT_NOT_FOUND', 'The isolated failure checkout was not found.', 404);
    const row = (await db.query('SELECT * FROM provider_failure_checkout_cases WHERE run_id=$1', [runId])).rows[0];
    if (!row) fail('FAILURE_CHECKOUT_NOT_FOUND', 'The isolated failure checkout was not found.', 404);
    return row;
  }
  async function save(row, privateData, state, db, token) {
    const result = await db.query(`UPDATE provider_failure_checkout_cases SET state=$3,private_encrypted=$4,updated_at=$5
      WHERE operation_id=$1 AND lock_token=$2 RETURNING *`, [row.operation_id, token, state, auth.encrypt(privateData), now()]);
    if (!result.rows.length) fail('FAILURE_CHECKOUT_LEASE', 'The isolated operation lease was lost.');
    return result.rows[0];
  }
  async function operate(row, action, env) {
    const token = randomUUID();
    const claimed = (await env.db.query(`UPDATE provider_failure_checkout_cases SET lock_token=$2,lease_until=$3 WHERE operation_id=$1
      AND (lock_token IS NULL OR lease_until<$4) RETURNING *`, [row.operation_id, token, new Date(now().getTime() + 300_000), now()])).rows[0];
    if (!claimed) fail('FAILURE_CHECKOUT_BUSY', 'The isolated failure case is already being processed.');
    try { return await action(claimed, decode(claimed), token); }
    finally { await env.db.query('UPDATE provider_failure_checkout_cases SET lock_token=NULL,lease_until=NULL WHERE operation_id=$1 AND lock_token=$2', [row.operation_id, token]); }
  }
  async function summary(row, env) {
    const details = decode(row); let native;
    if (row.run_id) native = env.unified.runtime.decode(await env.unified.runtime.read(row.run_id));
    const counts = {};
    for (const table of ['orders', 'bags', 'ledger_journals', 'transfers', 'refunds']) counts[table] = (await env.db.query(`SELECT COUNT(*)::integer AS count FROM ${table}`)).rows[0].count;
    const urlVerified = !details.lastError && details.observation?.sessionStatus === 'open' && details.observation?.sessionId === native?.details.sessionId
      && nonnegative(details.observation?.sessionTotalCents) && details.observation.sessionTotalCents <= MAX_TOTAL
      && !(details.observation.capturedCents > 0) && details.observation.chargeCaptured !== true;
    return { runId: row.run_id, caseId: row.case_id, operationId: row.operation_id, state: row.state, test: true,
      isolation: 'separate_failure_database_no_worker', currency: 'USD', maxTotalCents: MAX_TOTAL, expectedCapturedCents: 0,
      checkoutUrl: urlVerified ? safeUrl(native?.details.sessionUrl) : null, sessionId: native?.details.sessionId ?? null,
      paymentIntentId: details.observation?.paymentIntentId ?? native?.details.paymentIntentId ?? null,
      observation: details.observation ?? null, baseline: details.baseline ?? [], mutationObserved: details.mutationObserved ?? null,
      declineEvidence: details.declineEvidence ?? null, raceCancellationEvidence: details.raceCancellationEvidence ?? null,
      casePassed: !details.lastError && !(details.observation?.capturedCents > 0) && details.observation?.chargeCaptured !== true
        && (row.case_id === 'declined_payment' ? Boolean(details.declineEvidence) : Boolean(details.raceCancellationEvidence)),
      lastError: details.lastError ? { code: details.lastError.code } : null, cleanup: details.cleanup ?? null,
      localRecords: counts, createdAt: row.created_at, updatedAt: row.updated_at, fullAcceptancePassed: false };
  }
  async function stripeReady() {
    const stripe = getStripe(); let checked;
    try { checked = await stripe.preflight(); } catch { fail('FAILURE_TEST_PLATFORM_REQUIRED', 'Fresh approved Stripe test-platform verification is required.'); }
    if (checked?.verified !== true || checked.mode !== 'test' || checked.accountId !== PLATFORM) fail('FAILURE_TEST_PLATFORM_REQUIRED', 'Only the explicitly approved test platform is allowed.');
    return stripe;
  }
  async function inspectFixtures({ clean = false } = {}) {
    const result = [];
    for (const fixture of fixtures) {
      const report = await failureFixtures.inspect({ shop: fixture.shop, phase: 'checkout' });
      if (report?.shop !== fixture.shop || report.test !== true || !report.fixture) fail('FAILURE_FIXTURES_REQUIRED', 'Prepare all three dedicated disposable fixtures first.');
      const value = fixtureProjection(report.fixture, fixture);
      if (report.baselineCaptured !== true || !report.baseline) fail('FAILURE_FIXTURE_BASELINE_REQUIRED', 'The server-created disposable fixture needs its immutable native baseline; same-handle products cannot be adopted.');
      const baseline = fixtureProjection(report.baseline, fixture);
      if (['productId', 'variantId', 'inventoryItemId', 'locationId', 'sku'].some(key => baseline[key] !== value[key])) fail('FAILURE_FIXTURE_IDENTITY', 'The current fixture does not match the server-owned baseline.');
      if (clean && (report.state !== 'prepared' || report.cleanupRequired || JSON.stringify(value) !== JSON.stringify(baseline)
        || value.status !== 'ACTIVE' || value.priceCents !== fixture.priceCents || value.inventoryQty < 1))
        fail('FAILURE_FIXTURE_RESTORE_REQUIRED', 'Restore every disposable fixture to its captured baseline before opening a new Session.');
      result.push(value);
    }
    return result;
  }
  async function create(input = {}) {
    exactInput(input, ['caseId', 'operationId', 'confirmTest']); const { caseId, operationId, confirmTest } = input;
    if (confirmTest !== true || !PROVIDER_FAILURE_CHECKOUT_CASES.includes(caseId) || !operation(operationId)) fail('FAILURE_CHECKOUT_CONFIRMATION', 'Confirm one of the seven fixed test cases with a stable operation ID.', 422);
    const env = await ready(), key = `failure-checkout:${caseId}:${operationId}`;
    await env.db.transaction(async tx => {
      const same = (await tx.query('SELECT * FROM provider_failure_checkout_cases WHERE operation_id=$1 OR case_id=$2', [operationId, caseId])).rows[0];
      if (same && (same.operation_id !== operationId || same.case_id !== caseId)) fail('FAILURE_CHECKOUT_OPERATION_CONFLICT', 'A fixed case or operation ID cannot create a replacement checkout.');
      if (!same) await tx.query(`INSERT INTO provider_failure_checkout_cases(operation_id,case_id,request_key,state,private_encrypted)
        VALUES($1,$2,$3,'reserved',$4)`, [operationId, caseId, key, auth.encrypt({})]);
    });
    const row = (await env.db.query('SELECT * FROM provider_failure_checkout_cases WHERE operation_id=$1', [operationId])).rows[0];
    return operate(row, async (current, privateData, token) => {
      if (current.run_id) return summary(await verifySessionBeforeExpose(current, privateData, env, token), env);
      const recovered = (await env.db.query('SELECT id FROM unified_checkout_runs WHERE request_hash=$1', [hash(key)])).rows[0];
      if (recovered) {
        current = (await env.db.query('UPDATE provider_failure_checkout_cases SET run_id=$2 WHERE operation_id=$1 RETURNING *', [operationId, recovered.id])).rows[0];
        return summary(await verifySessionBeforeExpose(current, privateData, env, token), env);
      }
      await stripeReady(); privateData.baseline ??= await inspectFixtures({ clean: true });
      await save(current, privateData, 'creating_session', env.db, token);
      const checkout = await env.unified.create({ items: privateData.baseline.map(item => ({ shop: item.shop, variantId: item.variantId, quantity: 1 })) }, key);
      if (!run(checkout?.id)) fail('FAILURE_CHECKOUT_UNVERIFIED', 'Preserve this isolated operation for inspection; no replacement was authorized.');
      current = (await env.db.query('UPDATE provider_failure_checkout_cases SET run_id=$2 WHERE operation_id=$1 RETURNING *', [operationId, checkout.id])).rows[0];
      privateData.lastError = checkout.lastError ? { code: 'FAILURE_SESSION_REVIEW_REQUIRED' } : null;
      current = await verifySessionBeforeExpose(current, privateData, env, token);
      return summary(current, env);
    }, env);
  }
  async function verifySessionBeforeExpose(current, privateData, env, token) {
    let state = current.state;
    try {
      const observation = rememberObservation(privateData, await observeProvider(current, privateData, env));
      if (!observation.sessionId) fail('FAILURE_SESSION_IDENTITY', 'The existing Session has not been observed.');
      privateData.lastError = null;
      if (observation.capturedCents > 0 || observation.chargeCaptured === true) {
        state = 'unexpected_capture_review'; privateData.lastError = { code: 'FAILURE_UNEXPECTED_CAPTURE' };
      } else if (observation.sessionStatus === 'expired') state = 'checkout_expired';
      else if (observation.paymentStatus === 'canceled') state = 'authorization_cancelled';
      else if (['reserved', 'creating_session', 'needs_review'].includes(state)) state = observation.declined ? 'decline_observed' : 'checkout_open';
    } catch { privateData.lastError = { code: 'FAILURE_SESSION_REVIEW_REQUIRED' }; state = 'needs_review'; }
    // Both crash-recovery paths preserve their original run/Session, then
    // persist this fresh read result BEFORE any URL can be returned.
    return save(current, privateData, state, env.db, token);
  }
  async function get(input = {}) { exactInput(input, ['runId']); const env = await ready(); return summary(await rowFor(input.runId, env.db), env); }
  async function list() { const env = await ready(); return Promise.all((await env.db.query('SELECT * FROM provider_failure_checkout_cases ORDER BY created_at')).rows.map(row => summary(row, env))); }

  async function observeProvider(row, privateData, env) {
    const stripe = await stripeReady(), frozen = env.unified.runtime.decode(await env.unified.runtime.read(row.run_id));
    const id = frozen.details.sessionId;
    if (!providerId(id, 'cs_test')) return { status: 'session_not_observed', sessionId: null, paymentIntentId: null, capturedCents: null, observedAt: now().toISOString() };
    const session = await stripe.getCheckoutSession(id);
    if (session?.id !== id || session.livemode !== false || session.mode !== 'payment' || session.client_reference_id !== row.run_id
      || session.metadata?.order_id !== row.run_id || session.currency !== 'usd' || !nonnegative(session.amount_total) || session.amount_total > MAX_TOTAL
      || !['open', 'complete', 'expired'].includes(session.status)) fail('FAILURE_SESSION_IDENTITY', 'The existing native test Session, identity and capped total must verify.');
    const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (privateData.observation?.paymentIntentId && paymentId !== privateData.observation.paymentIntentId) fail('FAILURE_PAYMENT_IDENTITY', 'The Session cannot change its previously observed PaymentIntent.');
    const result = { status: session.status === 'expired' ? 'session_expired' : 'checkout_open', sessionId: id, sessionStatus: session.status,
      sessionTotalCents: session.amount_total, paymentIntentId: paymentId ?? null, paymentStatus: null, capturedCents: null, chargeId: null,
      chargeCaptured: null, declined: false, observedAt: now().toISOString() };
    if (!paymentId) return result;
    if (!providerId(paymentId, 'pi')) fail('FAILURE_PAYMENT_IDENTITY', 'One exact existing test PaymentIntent is required.');
    const payment = await stripe.getPaymentIntent(paymentId);
    if (payment?.id !== paymentId || payment.livemode !== false || payment.currency !== 'usd' || payment.amount !== session.amount_total
      || payment.metadata?.order_id !== row.run_id || payment.metadata?.integration !== 'avafem' || payment.transfer_group !== `ORD_${row.run_id}`
      || !nonnegative(payment.amount_received)) fail('FAILURE_PAYMENT_IDENTITY', 'The exact Session-linked test authorization must verify.');
    const allowed = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded'];
    if (!allowed.includes(payment.status)) fail('FAILURE_PAYMENT_IDENTITY', 'A documented native payment status is required.');
    result.paymentStatus = payment.status; result.status = payment.status; result.capturedCents = payment.amount_received;
    const errorCode = ['card_declined', 'expired_card', 'incorrect_cvc', 'processing_error'].includes(payment.last_payment_error?.code) ? payment.last_payment_error.code : null;
    const declineCode = ['generic_decline', 'insufficient_funds', 'lost_card', 'stolen_card'].includes(payment.last_payment_error?.decline_code) ? payment.last_payment_error.decline_code : null;
    if (errorCode) result.paymentErrorCode = errorCode; if (declineCode) result.declineCode = declineCode;
    result.declined = payment.status === 'requires_payment_method' && errorCode === 'card_declined' && payment.amount_received === 0;
    const chargeId = typeof payment.latest_charge === 'string' ? payment.latest_charge : payment.latest_charge?.id;
    if (chargeId) {
      if (!providerId(chargeId, 'ch')) fail('FAILURE_CHARGE_IDENTITY', 'The existing authorization Charge identity must verify.');
      const charge = await stripe.getCharge(chargeId);
      if (charge?.id !== chargeId || charge.livemode !== false || charge.currency !== 'usd' || charge.payment_intent !== paymentId || charge.amount !== payment.amount
        || typeof charge.captured !== 'boolean') fail('FAILURE_CHARGE_IDENTITY', 'The native authorization Charge must match the exact payment.');
      result.chargeId = chargeId; result.chargeCaptured = charge.captured;
    }
    return result;
  }
  async function observe(input = {}) {
    exactInput(input, ['runId']); const env = await ready(), row = await rowFor(input.runId, env.db);
    return operate(row, async (current, privateData, token) => {
      try {
        rememberObservation(privateData, await observeProvider(current, privateData, env)); privateData.lastError = null;
        const observation = privateData.observation;
        current = await save(current, privateData, observation.capturedCents > 0 || observation.chargeCaptured === true ? 'unexpected_capture_review'
          : observation.declined ? 'decline_observed' : observation.status === 'canceled' ? 'authorization_cancelled' : observation.status, env.db, token);
      } catch { privateData.lastError = { code: 'FAILURE_PROVIDER_OBSERVATION_UNVERIFIED' }; current = await save(current, privateData, 'needs_review', env.db, token); }
      return summary(current, env);
    }, env);
  }
  function verifyMutation(caseId, baseline, current) {
    const match = /^(stock|price)_changed_(002|004|006)$/.exec(caseId);
    if (!match) fail('FAILURE_MUTATION_NOT_APPLICABLE', 'This case is a declined payment, not a stock/price race.');
    const target = fixtures.find(fixture => fixture.number === match[2]);
    for (const before of baseline) {
      const after = current.find(value => value.shop === before.shop);
      if (!after || ['productId', 'variantId', 'inventoryItemId', 'locationId', 'sku', 'status'].some(key => before[key] !== after[key])) fail('FAILURE_FIXTURE_CHANGED', 'The frozen fixture identity cannot change.');
      const stock = before.shop === target.shop && match[1] === 'stock' ? 0 : before.inventoryQty;
      const price = before.shop === target.shop && match[1] === 'price' ? before.priceCents + 1 : before.priceCents;
      if (after.inventoryQty !== stock || after.priceCents !== price) fail('FAILURE_MUTATION_REQUIRED', 'Apply only the exact targeted stock-zero or one-cent price mutation before reconciliation; restored or unrelated changes cannot authorize processing.');
    }
    return { shop: target.shop, kind: match[1] === 'stock' ? 'out_of_stock' : 'price_changed', providerReadVerified: true };
  }
  async function reconcile(input = {}) {
    exactInput(input, ['runId', 'confirmTest']); if (input.confirmTest !== true) fail('FAILURE_CHECKOUT_CONFIRMATION', 'Explicit test confirmation is required.', 422);
    const env = await ready(), row = await rowFor(input.runId, env.db);
    return operate(row, async (current, privateData, token) => {
      let frozen = env.unified.runtime.decode(await env.unified.runtime.read(current.run_id));
      if (!frozen.details.sessionId) await env.unified.reconcile(current.run_id); // same stable Session key only; captures are still blocked
      const observation = rememberObservation(privateData, await observeProvider(current, privateData, env));
      if (observation.capturedCents > 0 || observation.chargeCaptured === true || observation.paymentStatus === 'succeeded') {
        privateData.lastError = { code: 'FAILURE_UNEXPECTED_CAPTURE' }; current = await save(current, privateData, 'unexpected_capture_review', env.db, token); return summary(current, env);
      }
      if (current.case_id === 'declined_payment') {
        current = await save(current, privateData, observation.declined ? 'decline_observed' : observation.paymentStatus === 'canceled' ? 'authorization_cancelled' : 'awaiting_decline', env.db, token);
        return summary(current, env);
      }
      if (observation.paymentStatus === 'canceled') { current = await save(current, privateData, 'authorization_cancelled', env.db, token); return summary(current, env); }
      if (observation.paymentStatus !== 'requires_capture') { current = await save(current, privateData, 'awaiting_authorization', env.db, token); return summary(current, env); }
      privateData.mutationObserved = { ...verifyMutation(current.case_id, privateData.baseline, await inspectFixtures()), observedAt: now().toISOString() };
      await save(current, privateData, 'reconciling_race', env.db, token);
      await env.unified.reconcile(current.run_id);
      rememberObservation(privateData, await observeProvider(current, privateData, env));
      frozen = env.unified.runtime.decode(await env.unified.runtime.read(current.run_id));
      const cancelled = privateData.observation.paymentStatus === 'canceled' && privateData.observation.capturedCents === 0 && frozen.details.authorizationCancelled === true;
      if (cancelled) privateData.raceCancellationEvidence ??= { paymentIntentId: privateData.observation.paymentIntentId, paymentStatus: 'canceled',
        capturedCents: 0, mutation: privateData.mutationObserved, observedAt: privateData.observation.observedAt, verification: 'unified_pre_capture_revalidation_cancelled' };
      privateData.lastError = cancelled ? null : { code: 'FAILURE_CANCELLATION_UNVERIFIED' };
      current = await save(current, privateData, cancelled ? 'authorization_cancelled' : 'needs_review', env.db, token);
      return summary(current, env);
    }, env);
  }
  async function cancel(input = {}) {
    exactInput(input, ['runId', 'confirmTest']); if (input.confirmTest !== true) fail('FAILURE_CHECKOUT_CONFIRMATION', 'Explicit cleanup confirmation is required.', 422);
    const env = await ready(), row = await rowFor(input.runId, env.db);
    return operate(row, async (current, privateData, token) => {
      let observed = rememberObservation(privateData, await observeProvider(current, privateData, env));
      if (observed.capturedCents > 0 || observed.chargeCaptured === true) fail('FAILURE_UNEXPECTED_CAPTURE', 'Unexpected captured money requires review; cleanup cannot refund or replace it.');
      if (observed.sessionStatus === 'open') {
        if (privateData.expireStartedAt) fail('FAILURE_EXPIRY_UNCERTAIN', 'The original Session expiry was attempted; inspect that same Session before any further cleanup.');
        const stripe = await stripeReady();
        if (typeof stripe.expireTestCheckoutSession !== 'function') fail('FAILURE_SESSION_EXPIRY_REQUIRED', 'The bounded TEST Session expiry adapter is required before cleanup.');
        privateData.expireStartedAt = now().toISOString(); await save(current, privateData, 'expiry_pending', env.db, token);
        try { await stripe.expireTestCheckoutSession({ sessionId: observed.sessionId, orderId: current.run_id }); }
        catch { privateData.lastError = { code: 'FAILURE_EXPIRY_UNCERTAIN' }; current = await save(current, privateData, 'expiry_uncertain', env.db, token); return summary(current, env); }
        observed = rememberObservation(privateData, await observeProvider(current, privateData, env));
        if (observed.sessionStatus !== 'expired') { privateData.lastError = { code: 'FAILURE_EXPIRY_UNVERIFIED' }; current = await save(current, privateData, 'expiry_uncertain', env.db, token); return summary(current, env); }
      }
      if (!observed.paymentIntentId) { privateData.cleanup = observed.sessionStatus === 'expired' ? 'checkout_session_expired_no_payment_intent' : 'no_payment_intent_observed_session_preserved';
        current = await save(current, privateData, observed.sessionStatus === 'expired' ? 'checkout_expired' : current.state, env.db, token); return summary(current, env); }
      if (observed.paymentStatus === 'canceled') { privateData.cleanup = 'authorization_cancel_verified'; current = await save(current, privateData, 'authorization_cancelled', env.db, token); return summary(current, env); }
      if (observed.sessionStatus === 'expired' && observed.declined && observed.capturedCents === 0) {
        privateData.cleanup = 'expired_declined_payment_no_authorization'; current = await save(current, privateData, 'checkout_expired', env.db, token); return summary(current, env);
      }
      if (observed.paymentStatus !== 'requires_capture') fail('FAILURE_CANCEL_STATUS', 'Only the known uncaptured authorization can be cancelled directly; Checkout-owned declined payments require Session expiry.');
      if (privateData.cancelStartedAt) fail('FAILURE_CANCEL_UNCERTAIN', 'An original cancellation was already attempted; read its outcome instead of sending another mutation.');
      privateData.cancelStartedAt = now().toISOString(); await save(current, privateData, 'cancel_pending', env.db, token);
      try { await (await stripeReady()).cancelPaymentIntent({ paymentIntentId: observed.paymentIntentId, orderId: current.run_id }); }
      catch { privateData.lastError = { code: 'FAILURE_CANCEL_UNCERTAIN' }; current = await save(current, privateData, 'cancel_uncertain', env.db, token); return summary(current, env); }
      rememberObservation(privateData, await observeProvider(current, privateData, env));
      const verified = privateData.observation.paymentStatus === 'canceled' && privateData.observation.capturedCents === 0;
      privateData.cleanup = verified ? 'authorization_cancel_verified' : 'original_cancellation_unverified';
      current = await save(current, privateData, verified ? 'authorization_cancelled' : 'cancel_uncertain', env.db, token); return summary(current, env);
    }, env);
  }
  // Server-only deletion gate, not a browser attestation or a destructive action.
  // Require all seven durable cases and fresh native closure observations.
  async function safeToDeleteFixtures() {
    try {
      const env = await ready(), rows = (await env.db.query('SELECT * FROM provider_failure_checkout_cases')).rows;
      if (rows.length !== PROVIDER_FAILURE_CHECKOUT_CASES.length || !PROVIDER_FAILURE_CHECKOUT_CASES.every(caseId => rows.some(row => row.case_id === caseId && run(row.run_id)))) return false;
      for (const row of rows) {
        const report = await observe({ runId: row.run_id }), observed = report.observation;
        if (report.lastError || !observed || Object.values(report.localRecords).some(value => value !== 0)
          || observed.chargeCaptured === true || (observed.capturedCents !== null && observed.capturedCents !== 0)) return false;
        if (observed.sessionStatus === 'expired') {
          if (observed.paymentIntentId && !(observed.paymentStatus === 'canceled' || (observed.declined && observed.capturedCents === 0))) return false;
        } else if (observed.sessionStatus !== 'complete' || observed.paymentStatus !== 'canceled' || observed.capturedCents !== 0) return false;
      }
      return true;
    } catch { return false; }
  }
  async function close() { if (closed) return; closed = true; if (initialization) { try { await (await initialization).db.close(); } catch { /* initialization already failed closed */ } } }
  const protect = action => async (...args) => {
    try { return await action(...args); }
    catch (cause) { if (cause instanceof FailureCheckoutError) throw cause; fail('FAILURE_OPERATION_UNVERIFIED', 'Preserve the isolated case and inspect its existing provider IDs; no replacement operation was authorized.'); }
  };
  return { create: protect(create), get: protect(get), list: protect(list), observe: protect(observe), reconcile: protect(reconcile), cancel: protect(cancel), safeToDeleteFixtures, close };
}
