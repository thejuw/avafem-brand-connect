import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout, allocateCheckout, allocateCents, checkoutAddress } from '../server/unified-checkout.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';
import { shopifyBagTag } from '../server/integrations/projection.mjs';
import { UncertainOperationError } from '../server/integrations/errors.mjs';

const money = cents => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: 'USD' } });
const PRIVATE_NAME = 'Synthetic Private Checkout Shopper';
const PRIVATE_LINE = '456 Synthetic Private Checkout Street';
const PRIVATE_EMAIL = 'synthetic-private-checkout@example.com';
const CLIENT_SECRET = 'fixture_client_secret_never_return';
const rate = () => ({ id: 'txr_fixture', percentage: 7.25, inclusive: false, country: 'US', state: 'TX' });
const variantId = index => `gid://shopify/ProductVariant/${1001 + index}`;
const cart = () => ({ items: TEST_STORES.map((store, index) => ({ shop: store.shop, variantId: variantId(index), quantity: 2 })) });
const snapshotFixture = () => ({ id: 'uco_fixture', bags: TEST_STORES.map((store, index) => ({ id: `bag_fixture_${index}`, shippingCents: store.shippingCents, commissionBps: 1500, items: [{ reference: `bag_fixture_${index}:0`, variantId: variantId(index), sku: `SKU_${index}`, qty: 2, unitPriceCents: 100 + index * 50 }] })) });
function completed(snapshot) {
  const taxes = [15, 22, 29];
  const lines = snapshot.bags.flatMap((bag, index) => bag.items.map((item, lineIndex) => ({ id: `li_fixture${index}${lineIndex}`, quantity: item.qty, currency: 'usd', price: { currency: 'usd', unit_amount: item.unitPriceCents, product: { metadata: { reference: item.reference } } }, amount_subtotal: item.qty * item.unitPriceCents, amount_tax: taxes[index], amount_total: item.qty * item.unitPriceCents + taxes[index], amount_discount: 0, taxes: [{ amount: taxes[index], rate: rate() }] })));
  const subtotal = lines.reduce((sum, line) => sum + line.amount_subtotal, 0);
  const shipping = snapshot.bags.reduce((sum, bag) => sum + bag.shippingCents, 0);
  const tax = lines.reduce((sum, line) => sum + line.amount_tax, 0) + 11;
  return { lines, session: { id: 'cs_test_fixture1', livemode: false, status: 'complete', mode: 'payment', client_reference_id: snapshot.id, metadata: { order_id: snapshot.id }, currency: 'usd', automatic_tax: { status: 'complete' }, amount_subtotal: subtotal, amount_total: subtotal + shipping + tax, total_details: { amount_tax: tax, amount_discount: 0 }, shipping_cost: { amount_subtotal: shipping, amount_tax: 11, taxes: [{ amount: 11, rate: rate() }] }, payment_intent: 'pi_fixture1', collected_information: { shipping_details: { name: PRIVATE_NAME, address: { line1: PRIVATE_LINE, line2: 'Suite TEST', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } }, customer_details: { email: PRIVATE_EMAIL }, client_secret: CLIENT_SECRET } };
}
function safe(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [PRIVATE_NAME, PRIVATE_LINE, PRIVATE_EMAIL, CLIENT_SECRET, 'fixture_access_token', 'fixture_secret_key']) assert.ok(!text.includes(privateValue), `Safe view must not expose ${privateValue}`);
  assert.doesNotMatch(text, /"(?:shipTo|ship_to|shopperEmail|client_secret|snapshot_encrypted|details_encrypted)"/);
}

async function fixture(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  await db.query('CREATE TABLE external_orders(bag_id TEXT PRIMARY KEY,brand_id TEXT NOT NULL,shop TEXT NOT NULL,external_order_id TEXT,state TEXT NOT NULL,last_error TEXT,updated_at TIMESTAMPTZ DEFAULT now())');
  await db.query('CREATE TABLE shopify_order_attempts(id TEXT PRIMARY KEY,shop TEXT NOT NULL,bag_id TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now())');
  const rows = TEST_STORES.map((store, index) => ({ shop: store.shop, brand_id: `brand_provider_${index}`, shipping_cents: store.shippingCents, commission_bps: 1500, return_window_days: 30 }));
  for (const row of rows) await db.query('INSERT INTO brands(id,name,slug,commission_bps) VALUES($1,$2,$3,1500)', [row.brand_id, row.shop, row.brand_id]);
  const calls = { sessions: [], remoteSessions: 0, reads: 0, captures: [], cancellations: [], creates: [], finds: [], transfers: 0, refunds: 0 };
  const state = { complete: false, sessionError: null, sessionPatch: {}, linePatch: null, paymentPatch: {}, capturedPatch: {}, chargePatch: {}, variantPatch: new Map(), disconnected: new Set(), readbackPatch: {}, failShop: null, loseOrderResponse: false, hideOrder: false, onCapture: null, session: null, lines: [], checkoutInput: null };
  const stocks = new Map(TEST_STORES.map((store, index) => [store.shop, 20]));
  const remote = new Map(); const adapters = new Map();
  const variant = index => ({ id: variantId(index), sku: `AVF-CONNECT-TEST-${index}`, productTitle: `Avafem distinct fixture ${index} — DO NOT SHIP`, title: 'Default', productStatus: 'ACTIVE', priceCents: 100 + index * 50, currency: 'USD', inventoryQty: stocks.get(TEST_STORES[index].shop), inventoryPolicy: 'DENY', tracked: true, requiresShipping: true, ...(state.variantPatch.get(TEST_STORES[index].shop) ?? {}) });
  TEST_STORES.forEach((store, index) => {
    const adapter = { shop: store.shop, getVariant: async input => input === variantId(index) ? variant(index) : null,
      listProducts: async () => ({ products: [{ title: variant(index).productTitle, sourceStatus: 'ACTIVE', variantsPageInfo: { hasNextPage: false }, variants: [{ shopifyVariantId: variantId(index), sku: variant(index).sku, title: 'Default', tracked: true, requiresShipping: true, inventory: { policy: 'deny', qty: stocks.get(store.shop) }, price: { amount: variant(index).priceCents, currency: 'USD' } }] }], pageInfo: { hasNextPage: false } }),
      createOrder: async (bag, options) => {
        calls.creates.push({ shop: store.shop, bag: structuredClone(bag), options: structuredClone(options) });
        if (state.failShop === store.shop) throw new Error('fixture_secret_key PRIVATE_PROVIDER_ERROR');
        const orderId = `gid://shopify/Order/${5000 + index}`;
        remote.set(bag.id, { id: orderId, bag: structuredClone(bag), options: structuredClone(options) });
        if (options.inventoryBehaviour === 'DECREMENT_OBEYING_POLICY') stocks.set(store.shop, stocks.get(store.shop) - bag.items.reduce((sum, item) => sum + item.qty, 0));
        if (state.loseOrderResponse && index === 0) { state.loseOrderResponse = false; throw new UncertainOperationError('Shopify', 'orderCreate', bag.id); }
        return { order: { id: orderId } };
      },
      findOrder: async bagId => { calls.finds.push({ shop: store.shop, bagId }); return !state.hideOrder && remote.has(bagId) ? { id: remote.get(bagId).id } : null; },
      getOrderDetails: async orderId => {
        const record = [...remote.values()].find(record => record.id === orderId); if (!record) return null;
        const bag = record.bag; const subtotal = bag.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
        const names = bag.shipTo.name.split(' ');
        return { id: orderId, test: true, taxesIncluded: false, displayFinancialStatus: 'PAID', sourceIdentifier: bag.id, email: `bag-${createHash('sha256').update(bag.id).digest('hex').slice(0, 24)}@relay.avafem.com`, tags: [shopifyBagTag(bag.id), 'TEST_DO_NOT_SHIP'], totalPriceSet: money(subtotal + bag.shippingCents + bag.taxCents), subtotalPriceSet: money(subtotal), totalTaxSet: money(bag.taxCents), totalShippingPriceSet: money(bag.shippingCents),
          lineItems: { pageInfo: { hasNextPage: false }, nodes: bag.items.map(item => ({ sku: item.sku, quantity: item.qty, variant: { id: item.variantId }, originalUnitPriceSet: money(item.unitPriceCents),
            taxLines: record.options.lineTaxLines[item.sku].map(tax => ({ title: tax.title, rate: tax.rate, priceSet: money(tax.amountCents) })) })) },
          shippingLines: { pageInfo: { hasNextPage: false }, nodes: [{ originalPriceSet: money(bag.shippingCents),
            taxLines: record.options.shippingTaxLines.map(tax => ({ title: tax.title, rate: tax.rate, priceSet: money(tax.amountCents) })) }] },
          transactions: [{ test: true, kind: 'SALE', status: 'SUCCESS', gateway: 'manual', amountSet: money(subtotal + bag.shippingCents + bag.taxCents) }],
          shippingAddress: { firstName: names.shift(), lastName: names.join(' '), address1: bag.shipTo.line1, address2: bag.shipTo.line2, city: bag.shipTo.city, provinceCode: bag.shipTo.region, countryCodeV2: bag.shipTo.country, zip: bag.shipTo.postal }, ...(typeof state.readbackPatch === 'function' ? state.readbackPatch(store.shop) : state.readbackPatch) };
      } };
    adapters.set(store.shop, adapter);
  });
  const checkStore = shop => { if (state.disconnected.has(shop)) throw Object.assign(new Error('Disconnected fixture'), { code: 'SHOPIFY_DISCONNECTED' }); if (!adapters.has(shop)) throw new Error('Wrong shop'); };
  const stores = { row: async shop => { checkStore(shop); return rows.find(row => row.shop === shop); }, preflight: async shop => { checkStore(shop); return { verified: true }; }, forShop: async shop => { checkStore(shop); return adapters.get(shop); }, list: async () => rows.map(row => ({ shop: row.shop, brandId: row.brand_id, connected: !state.disconnected.has(row.shop) })) };
  let captured = false;
  const pi = () => ({ id: 'pi_fixture1', livemode: false, currency: 'usd', amount: state.session.amount_total, amount_received: captured ? state.session.amount_total : 0, status: captured ? 'succeeded' : 'requires_capture', metadata: { order_id: state.session.client_reference_id, integration: 'avafem' }, transfer_group: `ORD_${state.session.client_reference_id}`, latest_charge: captured ? 'ch_fixture1' : null, client_secret: CLIENT_SECRET, ...state.paymentPatch, ...(captured ? state.capturedPatch : {}) });
  const stripe = { preflight: async () => ({ verified: true, mode: 'test', accountId: 'acct_fixture1' }),
    createCheckoutSession: async input => {
      calls.sessions.push(structuredClone(input)); state.checkoutInput = input;
      if (!state.session) {
        calls.remoteSessions++;
        const snapshot = { id: input.orderId, bags: TEST_STORES.map(store => ({ shippingCents: store.shippingCents, items: input.items.filter(item => item.reference.startsWith(input.items.find(candidate => candidate.variantId === variantId(TEST_STORES.indexOf(store))).reference.split(':')[0])) })) };
        const full = completed(snapshot); state.session = { ...full.session, url: 'https://checkout.stripe.com/c/pay/cs_test_fixture1', expires_at: 9999999999 }; state.lines = full.lines;
      }
      if (state.sessionError) { const error = state.sessionError; state.sessionError = null; throw error; }
      return structuredClone(state.session);
    },
    getCheckoutSession: async () => { calls.reads++; return structuredClone({ ...state.session, status: state.complete ? 'complete' : 'open', ...(typeof state.sessionPatch === 'function' ? state.sessionPatch(state.session) : state.sessionPatch) }); },
    listCheckoutLineItems: async () => ({ data: structuredClone(state.linePatch ? state.linePatch(state.lines) : state.lines), has_more: false }),
    getPaymentIntent: async () => structuredClone(pi()),
    capturePaymentIntent: async input => { calls.captures.push(input); captured = true; state.onCapture?.(); return structuredClone(pi()); },
    cancelPaymentIntent: async input => { calls.cancellations.push(input); return { id: input.paymentIntentId, livemode: false, status: 'canceled', amount_received: 0 }; },
    getCharge: async () => ({ id: 'ch_fixture1', livemode: false, captured: true, paid: true, amount: state.session.amount_total, payment_intent: 'pi_fixture1', currency: 'usd', balance_transaction: 'txn_fixture1', ...state.chargePatch }),
    createTransfer: async () => { calls.transfers++; assert.fail('Checkout must not pay a brand.'); }, createRefund: async () => { calls.refunds++; assert.fail('Checkout must not refund money.'); } };
  const service = await createUnifiedCheckout(db, auth, { stores, getStripe: () => stripe });
  let sequence = 0;
  const open = () => service.create(cart(), `fixture_cart_request_${++sequence}`);
  const complete = async runId => { state.complete = true; return service.reconcile(runId); };
  return { db, auth, service, state, calls, stores, stripe, rows, open, complete, stocks, adapters };
}

test('native Stripe product metadata references allocate each line once and shipping tax by largest remainder', () => {
  const snapshot = snapshotFixture(); const { session, lines } = completed(snapshot);
  const allocated = allocateCheckout(session, [lines[2], lines[0], lines[1]], snapshot);
  assert.deepEqual(allocateCents(11, [25, 50, 75]), [2, 4, 5]); assert.deepEqual(allocateCents(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(allocated.map(bag => bag.shippingTaxCents), [2, 4, 5]);
  assert.deepEqual(allocated.map((bag, index) => bag.lineTaxLines[`SKU_${index}`].map(tax => tax.amountCents)), [[15], [22], [29]]);
  assert.deepEqual(allocated.map(bag => bag.shippingTaxLines.map(tax => tax.amountCents)), [[2], [4], [5]]);
  assert.ok(allocated.every(bag => bag.shippingTaxLines[0].rate === .0725));
  assert.deepEqual(allocated.map(bag => bag.taxCents), [17, 26, 34]);
  assert.deepEqual(allocated.map(bag => bag.totalCents), [242, 376, 509]);
  assert.deepEqual(allocated.map(bag => bag.commissionCents), [30, 45, 60]);
  assert.equal(allocated.reduce((sum, bag) => sum + bag.totalCents, 0), session.amount_total);
  assert.equal(allocated[0].lineAllocations[0].stripeLineId, lines[0].id);
  assert.throws(() => allocateCents(1, [0, 0]));
  const wrong = structuredClone(lines); wrong[0].reference = wrong[0].price.product.metadata.reference; delete wrong[0].price.product.metadata.reference;
  assert.throws(() => allocateCheckout(session, wrong, snapshot), { code: 'CHECKOUT_LINE_MISMATCH' });
});

test('authoritative allocations reject incorrect price/quantity/currency/reference/tax/discount/shipping/rate totals', () => {
  const snapshot = snapshotFixture();
  for (const alter of [
    value => { value.lines[0].price.unit_amount++; }, value => { value.lines[0].quantity = 1; }, value => { value.lines[0].currency = 'cad'; },
    value => { value.lines[0].price.product.metadata.reference = value.lines[1].price.product.metadata.reference; },
    value => { value.lines[0].amount_tax++; }, value => { value.lines[0].amount_discount = 1; },
    value => { value.lines[0].taxes[0].rate = 'txr_unexpanded'; }, value => { value.lines[0].taxes[0].rate.inclusive = true; },
    value => { value.lines[0].taxes[0].rate.percentage = 0; }, value => { value.session.amount_total++; },
    value => { value.session.shipping_cost.amount_subtotal++; }, value => { value.session.shipping_cost.amount_tax++; },
    value => { value.session.automatic_tax.status = 'failed'; }, value => { value.session.livemode = true; },
  ]) {
    const data = structuredClone(completed(snapshot)); alter(data);
    assert.throws(() => allocateCheckout(data.session, data.lines, snapshot));
  }
  for (const alter of [value => { delete value.collected_information.shipping_details; }, value => { value.collected_information.shipping_details.address.country = 'CA'; }, value => { value.collected_information.shipping_details.address.state = 'Texas'; }, value => { value.collected_information.shipping_details.address.postal_code = ''; }]) {
    const { session } = completed(snapshot); alter(session); assert.throws(() => checkoutAddress(session), { code: 'CHECKOUT_ADDRESS_REQUIRED' });
  }
});

test('multiple native lines within a Bag retain separate tax amounts and legitimate provider zero tax stays zero', () => {
  const snapshot = snapshotFixture();
  snapshot.bags[0].items.push({ reference: 'bag_fixture_0:1', sku: 'SKU_EXTRA', variantId: 'gid://shopify/ProductVariant/1010', qty: 1, unitPriceCents: 50 });
  const data = completed(snapshot);
  const extra = data.lines.find(line => line.price.product.metadata.reference === 'bag_fixture_0:1');
  extra.amount_tax = 4; extra.amount_total = 54; extra.taxes[0].amount = 4;
  data.session.total_details.amount_tax -= 11; data.session.amount_total -= 11;
  const allocations = allocateCheckout(data.session, data.lines.toReversed(), snapshot);
  assert.equal(allocations[0].lineAllocations.length, 2);
  assert.deepEqual(allocations[0].lineTaxCents, { SKU_0: 15, SKU_EXTRA: 4 });
  assert.equal(allocations[0].taxCents, 21);
  for (const line of data.lines) { line.amount_tax = 0; line.amount_total = line.amount_subtotal; line.taxes = []; }
  data.session.shipping_cost.amount_tax = 0; data.session.shipping_cost.taxes = [];
  data.session.total_details.amount_tax = 0; data.session.amount_total = data.session.amount_subtotal + data.session.shipping_cost.amount_subtotal;
  const zero = allocateCheckout(data.session, data.lines, snapshot);
  assert.ok(zero.every(bag => bag.taxCents === 0 && bag.taxLines.length === 0));
});

test('one hosted Session and one captured PaymentIntent produce three provider-bound canonical Bags and three stock-decrement orders', async t => {
  const f = await fixture(t); const run = await f.open(); assert.equal(run.state, 'checkout_open');
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.creates.length, 0);
  assert.equal(f.calls.sessions[0].captureMethod, 'manual'); assert.equal(f.calls.sessions[0].shippingCents, 150);
  assert.equal(new Set(f.calls.sessions[0].items.map(item => item.reference)).size, 3);
  const result = await f.complete(run.id);
  assert.equal(result.state, 'orders_created', JSON.stringify(result)); safe(result);
  assert.equal(f.calls.remoteSessions, 1); assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3);
  assert.deepEqual(result.bags.map(bag => bag.totalCents), [242, 376, 509]);
  assert.ok(result.bags.every(bag => bag.orderVerified && bag.stockDecrementVerified));
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM orders WHERE provider_bound=true')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM bags WHERE provider_bound=true')).rows[0].n, 3);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM external_orders WHERE state=\'created\'')).rows[0].n, 3);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM ledger_journals WHERE kind=\'stripe_test_payment\'')).rows[0].n, 3);
  for (const call of f.calls.creates) {
    assert.equal(call.options.test, true); assert.equal(call.options.inventoryBehaviour, 'DECREMENT_OBEYING_POLICY');
    assert.equal(call.bag.items[0].qty, 2); assert.equal(call.options.taxLines, undefined);
    assert.equal(Object.values(call.options.lineTaxLines).flat().concat(call.options.shippingTaxLines)
      .reduce((sum, line) => sum + line.amountCents, 0), call.bag.taxCents);
    assert.equal(call.options.shippingTaxLines.reduce((sum, line) => sum + line.amountCents, 0),
      [2, 4, 5][f.calls.creates.indexOf(call)]);
  }
  assert.equal(f.calls.transfers, 0); assert.equal(f.calls.refunds, 0);
  const entries = (await f.db.query('SELECT SUM(debit_cents)::integer AS debit,SUM(credit_cents)::integer AS credit FROM ledger_entries')).rows[0];
  assert.equal(entries.debit, 1127); assert.equal(entries.credit, 1127);
});

test('idempotent cart creation, concurrency and persisted reconciliation never duplicate Sessions, captures, Bags or orders', async t => {
  const f = await fixture(t); const key = 'fixture_same_cart_request';
  const results = await Promise.all([f.service.create(cart(), key), f.service.create(cart(), key)]);
  assert.equal(results[0].id, results[1].id); const runId = results[0].id;
  await assert.rejects(f.service.create({ items: cart().items.map((item, index) => ({ ...item, quantity: index ? 2 : 1 })) }, key), { code: 'IDEMPOTENCY_BODY_CHANGED' });
  f.state.complete = true; await Promise.all([f.service.reconcile(runId), f.service.reconcile(runId)]);
  await f.service.reconcile(runId);
  assert.equal(f.calls.remoteSessions, 1); assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM bags')).rows[0].n, 3);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM shopify_order_attempts')).rows[0].n, 3);
  safe(await f.service.list());
});

test('stock changed after authorization cancels before capture and never creates a charge-backed order', async t => {
  const f = await fixture(t); const run = await f.open();
  f.state.variantPatch.set(TEST_STORES[1].shop, { inventoryQty: 0 });
  const result = await f.complete(run.id);
  assert.equal(result.state, 'authorization_cancelled', JSON.stringify(result));
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.cancellations.length, 1); assert.equal(f.calls.creates.length, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM orders')).rows[0].n, 0);
  assert.equal(result.stripe.chargeId, null); safe(result);
});

test('untracked, nonphysical, overselling, wrong currency and disconnected test fixtures stop Session creation', async t => {
  const f = await fixture(t);
  for (const patch of [{ tracked: false }, { requiresShipping: false }, { inventoryPolicy: 'CONTINUE' }, { currency: 'CAD' }, { inventoryQty: 1 }, { priceCents: 0 }, { priceCents: 100.5 }, { sku: 'REAL_PRODUCT' }, { productTitle: 'Real product' }]) {
    f.state.variantPatch.set(TEST_STORES[1].shop, patch);
    await assert.rejects(f.open()); assert.equal(f.calls.sessions.length, 0);
  }
  f.state.variantPatch.clear(); f.state.disconnected.add(TEST_STORES[2].shop);
  await assert.rejects(f.open()); assert.equal(f.calls.sessions.length, 0);
  const options = await f.service.options(); assert.ok(options.blockers.some(blocker => blocker.shop === TEST_STORES[2].shop));
});

test('a price changed after authorization cancels before capture and malformed caller carts cannot override frozen amounts', async t => {
  const f = await fixture(t);
  for (const items of [cart().items.slice(0, 2), [...cart().items, cart().items[0]], cart().items.map((item, index) => ({ ...item, shop: index ? item.shop : 'foreign-store.myshopify.com' })), cart().items.map(item => ({ ...item, quantity: 6 }))]) await assert.rejects(f.service.create({ items }, 'fixture_invalid_cart_key'));
  assert.equal(f.calls.sessions.length, 0);
  const run = await f.open(); f.state.variantPatch.set(TEST_STORES[0].shop, { priceCents: 101 });
  const result = await f.complete(run.id); assert.equal(result.state, 'authorization_cancelled');
  assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.creates.length, 0);
});

test('unknown Shopify outcome is recovered by exact Bag marker without a second charge or order create', async t => {
  const f = await fixture(t); const run = await f.open(); f.state.loseOrderResponse = true;
  const partial = await f.complete(run.id); assert.notEqual(partial.state, 'orders_created');
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 1);
  const result = await f.service.reconcile(run.id); assert.equal(result.state, 'orders_created', JSON.stringify(result));
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3); assert.equal(f.calls.finds.length, 1);
  await f.service.reconcile(run.id); assert.equal(f.calls.creates.length, 3);
});

test('a dispatch with no exact mapping remains uncertain instead of creating replacement orders', async t => {
  const f = await fixture(t); const run = await f.open(); f.state.loseOrderResponse = true;
  await f.complete(run.id); f.state.hideOrder = true;
  const result = await f.service.reconcile(run.id);
  assert.notEqual(result.state, 'orders_created'); assert.equal(f.calls.creates.filter(call => call.shop === TEST_STORES[0].shop).length, 1);
  assert.equal(f.calls.captures.length, 1); assert.equal(result.bags[0].state, 'order_uncertain');
});

test('encrypted run/canonical shipping storage and all summary/error views omit shopper data, credentials and client secrets', async t => {
  const f = await fixture(t); const run = await f.open(); await f.complete(run.id);
  safe(await f.service.get(run.id)); safe(await f.service.list());
  const rows = (await f.db.query('SELECT * FROM unified_checkout_runs')).rows;
  for (const row of rows) {
    for (const privateValue of [PRIVATE_NAME, PRIVATE_LINE, PRIVATE_EMAIL, CLIENT_SECRET]) assert.ok(!JSON.stringify(row).includes(privateValue));
    assert.equal(f.auth.decrypt(row.details_encrypted).shipTo.line1, PRIVATE_LINE);
    assert.equal(f.auth.decrypt(row.snapshot_encrypted).bags.length, 3);
  }
  for (const bag of (await f.db.query('SELECT ship_to FROM bags')).rows) {
    assert.ok(!JSON.stringify(bag).includes(PRIVATE_LINE)); assert.equal(f.auth.decrypt(bag.ship_to.encryptedShipping).name, PRIVATE_NAME);
  }
  assert.doesNotMatch(JSON.stringify((await f.db.query('SELECT payload FROM outbox_events')).rows), /Synthetic Private|synthetic-private-checkout|fixture_client_secret/);
});

test('payment and charge identities and immutable metadata are checked both before and after capture', async t => {
  const f = await fixture(t); const run = await f.open();
  for (const patch of [{ id: 'pi_wrong1' }, { livemode: true }, { currency: 'cad' }, { amount: 999 }, { metadata: { order_id: 'other_run', integration: 'avafem' } }, { metadata: { order_id: run.id, integration: 'other' } }, { transfer_group: 'ORD_wrong' }]) {
    f.state.paymentPatch = patch; const result = await f.complete(run.id);
    assert.notEqual(result.state, 'orders_created', JSON.stringify(patch)); assert.equal(f.calls.captures.length, 0); assert.equal(f.calls.creates.length, 0);
  }
  f.state.paymentPatch = {}; f.state.capturedPatch = { id: 'pi_wrong_after_capture' };
  const result = await f.service.reconcile(run.id); assert.notEqual(result.state, 'orders_created'); assert.equal(f.calls.creates.length, 0);
});

test('mismatched post-capture charge and Shopify address readbacks preserve paid partial success without duplicate writes', async t => {
  const f = await fixture(t); const run = await f.open(); f.state.chargePatch = { id: 'ch_wrong1' };
  const blocked = await f.complete(run.id); assert.notEqual(blocked.state, 'orders_created'); assert.equal(f.calls.creates.length, 0);
  f.state.chargePatch = {}; f.state.readbackPatch = { shippingAddress: { address1: PRIVATE_LINE, zip: '78701', city: 'Wrong city', provinceCode: 'CA', countryCodeV2: 'CA', firstName: 'Wrong', lastName: 'Person' } };
  const result = await f.service.reconcile(run.id); assert.notEqual(result.state, 'orders_created', 'All minimal shipping fields must match, not only street and zip.');
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 1); safe(result);
});

test('unknown hosted Session creation reuses the immutable order identity rather than creating a replacement checkout', async t => {
  const f = await fixture(t); f.state.sessionError = new Error('fixture_secret_key PRIVATE_PROVIDER_ERROR');
  const run = await f.open(); assert.equal(run.state, 'checkout_needs_review'); safe(run);
  assert.equal(f.calls.remoteSessions, 1); assert.equal(f.calls.sessions.length, 1);
  const restored = await f.service.reconcile(run.id); assert.equal(restored.state, 'checkout_open');
  assert.equal(f.calls.remoteSessions, 1); assert.equal(f.calls.sessions.length, 2);
  assert.deepEqual(f.calls.sessions[0], f.calls.sessions[1]);
  const complete = await f.complete(run.id); assert.equal(complete.state, 'orders_created');
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3);
});

test('post-capture stock race preserves the single charge and provider-bound Bags for review instead of faking inventory reservation', async t => {
  const f = await fixture(t); const run = await f.open();
  f.state.onCapture = () => f.state.variantPatch.set(TEST_STORES[0].shop, { inventoryQty: 0 });
  const result = await f.complete(run.id);
  assert.equal(result.state, 'needs_review'); assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM bags WHERE provider_bound=true')).rows[0].n, 3);
  assert.equal(result.stripe.chargeId, 'ch_fixture1'); assert.equal(f.calls.transfers, 0); safe(result);
});

test('unified dispatch shares the legacy five-per-store-minute budget and resumes without another capture', async t => {
  const f = await fixture(t); const run = await f.open();
  for (let index = 0; index < 5; index++) await f.db.query('INSERT INTO shopify_order_attempts(id,shop,bag_id) VALUES($1,$2,$3)', [`legacy_${index}`, TEST_STORES[0].shop, `legacy_bag_${index}`]);
  const held = await f.complete(run.id); assert.equal(held.state, 'needs_review');
  assert.equal(f.calls.creates.length, 0); assert.equal(f.calls.captures.length, 1);
  await f.db.query("UPDATE shopify_order_attempts SET created_at=now()-interval '2 minutes'");
  const resumed = await f.service.reconcile(run.id); assert.equal(resumed.state, 'orders_created', JSON.stringify(resumed));
  assert.equal(f.calls.creates.length, 3); assert.equal(f.calls.captures.length, 1);
});

test('late payment events preserve delivered or settled lifecycle states instead of downgrading a verified run', async t => {
  const f = await fixture(t); const run = await f.open(); await f.complete(run.id);
  for (const state of ['delivered', 'settled']) {
    await f.db.query('UPDATE unified_checkout_runs SET state=$2 WHERE id=$1', [run.id, state]);
    const result = await f.service.reconcile(run.id);
    assert.equal(result.state, state); assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3);
  }
});

test('native shipping-tax readback mismatches hold paid dispatch without creating replacement orders', async t => {
  const f = await fixture(t); const run = await f.open();
  f.state.readbackPatch = { shippingLines: { pageInfo: { hasNextPage: false }, nodes: [
    { originalPriceSet: money(25), taxLines: [{ priceSet: money(17) }] },
  ] } };
  const held = await f.complete(run.id);
  assert.equal(held.state, 'needs_review'); assert.equal(held.lastError.code, 'SHOPIFY_READBACK_MISMATCH');
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 1);
  await f.service.reconcile(run.id); assert.equal(f.calls.creates.length, 1);
  f.state.readbackPatch = {};
  const fixed = await f.service.reconcile(run.id); assert.equal(fixed.state, 'orders_created');
  assert.equal(f.calls.captures.length, 1); assert.equal(f.calls.creates.length, 3);
});
