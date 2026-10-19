import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderMoney } from '../server/provider-money.mjs';
import { stripeTestRecipientContactEmail } from '../server/integrations/stripe.mjs';

const RUN = `uco_${'a'.repeat(32)}`;
const DAY = 86400_000;
const START = new Date('2026-10-19T12:00:00.000Z');
const PLATFORM = 'acct_fixturePlatform123';
const PI = 'pi_fixturePayment123';
const CHARGE = 'ch_fixtureCharge123';
const TXN = 'txn_fixtureCharge123';
const shops = ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'];
const decimal = cents => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: 'USD' } });

async function fixture(t, { bound = true, commercial = {} } = {}) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const calls = []; const accounts = new Map(), transfers = new Map(), refunds = new Map(), reversals = new Map(), payouts = new Map();
  const records = new Map(), orders = new Map(), cancelJobs = new Map(); let stripeMode = 'test'; let platformId = PLATFORM;
  const snapshot = { id: RUN, currency: 'USD', bags: shops.map((shop, index) => ({ id: `bag_provider_${index}`, shop,
    brandId: `brand_provider_${index}`, name: `Test Brand ${index}`, shippingCents: 25 * (index + 1), commissionBps: 1500, returnWindowDays: 30,
    items: [{ reference: `bag${index}_sku`, variantId: `gid://shopify/ProductVariant/${100 + index}`, sku: `SKU-${index}`,
      qty: commercial[index]?.qty ?? 2, unitPriceCents: commercial[index]?.unitPriceCents ?? 100, title: 'TEST item' }] })) };
  const details = { accountId: PLATFORM, paymentVerified: true, paymentIntentId: PI, chargeId: CHARGE,
    sessionId: 'cs_test_fixtureSession123', chargeBalanceTransactionId: TXN, amounts: { totalCents: 810 },
    shipTo: { name: 'PRIVATE_SHOPPER', line1: 'PRIVATE_STREET' }, testClock: { now: START.toISOString() }, bags: {} };
  for (const [index, bag] of snapshot.bags.entries()) {
    const shipping = bag.shippingCents, lineTax = commercial[index]?.lineTaxCents ?? 16, shippingTax = commercial[index]?.shippingTaxCents ?? 2 * (index + 1);
    const tax = lineTax + shippingTax, subtotal = bag.items[0].qty * bag.items[0].unitPriceCents, commission = Math.round(subtotal * .15);
    details.bags[bag.id] = { verified: true, orderId: `gid://shopify/Order/${100 + index}`,
      subtotalCents: subtotal, shippingCents: shipping, taxCents: tax, totalCents: subtotal + shipping + tax,
      commissionCents: commission, transferCents: subtotal - commission + shipping, lineTaxCents: { [`SKU-${index}`]: lineTax }, shippingTaxCents: shippingTax,
      fullyDelivered: true, deliveredAt: START.toISOString(), payoutDueAt: new Date(+START + 30 * DAY).toISOString(), refundOps: {} };
    const accountId = `acct_fixtureRecipient${index}`;
    const record = { shop: bag.shop, brand_id: bag.brandId, return_window_days: 30,
      connected_account_id: bound ? accountId : null, connected_account_created_in_test: bound, connected_account_verified: bound };
    records.set(bag.shop, record);
    accounts.set(accountId, { id: accountId, type: 'express', country: 'US', capabilities: { transfers: 'active' }, payouts_enabled: true,
      requirements: { currently_due: [], disabled_reason: null }, metadata: { brand_id: bag.brandId, integration: 'avafem' } });
    orders.set(details.bags[bag.id].orderId, { id: details.bags[bag.id].orderId, test: true, currencyCode: 'USD', operationsComplete: true,
      lineItems: { nodes: [{ id: `gid://shopify/LineItem/${100 + index}`, sku: `SKU-${index}`, quantity: bag.items[0].qty, refundableQuantity: bag.items[0].qty, variant: { id: bag.items[0].variantId } }] },
      transactions: [{ id: `gid://shopify/OrderTransaction/${100 + index}`, kind: 'SALE', status: 'SUCCESS', test: true,
        gateway: 'manual', manualPaymentGateway: true, amountSet: decimal(details.bags[bag.id].totalCents) }], refunds: [], fulfillments: [] });
    await db.query('INSERT INTO brands(id,name,slug,commission_bps,return_window_days) VALUES($1,$2,$1,1500,30)', [bag.brandId, bag.name]);
  }
  details.amounts = { subtotalCents: Object.values(details.bags).reduce((sum, value) => sum + value.subtotalCents, 0),
    shippingCents: Object.values(details.bags).reduce((sum, value) => sum + value.shippingCents, 0),
    taxCents: Object.values(details.bags).reduce((sum, value) => sum + value.taxCents, 0),
    totalCents: Object.values(details.bags).reduce((sum, value) => sum + value.totalCents, 0) };
  const stripe = {
    preflight: async () => ({ verified: true, mode: stripeMode, accountId: platformId }),
    getBalanceTransaction: async id => ({ id, source: CHARGE, amount: details.amounts.totalCents, fee: 54, net: details.amounts.totalCents - 54, currency: 'usd' }),
    getCharge: async id => ({ id, livemode: false, captured: true, paid: true, currency: 'usd', payment_intent: PI, amount: details.amounts.totalCents,
      amount_refunded: [...refunds.values()].filter(value => value.status === 'succeeded').reduce((sum, value) => sum + value.amount, 0) }),
    createExpressAccount: async ({ brandId, manualPayouts }) => { calls.push({ type: 'account', brandId, manualPayouts });
      const account = [...accounts.values()].find(item => item.metadata.brand_id === brandId); return structuredClone(account); },
    createExpressRecipientV2: async ({ brandId, manualPayouts }) => { calls.push({ type: 'account', brandId, manualPayouts });
      const account = [...accounts.values()].find(item => item.metadata.brand_id === brandId); return { id: account.id, metadata: structuredClone(account.metadata), livemode: false }; },
    getTestConnectedAccountV2: async id => ({ id, object: 'v2.core.account', livemode: false, dashboard: 'express', identity: { country: 'US' },
      defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      applied_configurations: ['recipient'], configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: 'active' } } } } },
      metadata: structuredClone(accounts.get(id)?.metadata) }),
    getTestBalanceSettings: async id => { calls.push({ type: 'scheduleRead', id }); return { payments: { payouts: { schedule: { interval: 'manual' } } } }; },
    configureTestRecipientManualPayouts: async input => { calls.push({ type: 'schedule', input }); return { payments: { payouts: { schedule: { interval: 'manual' } } } }; },
    getTestConnectedAccount: async id => structuredClone(accounts.get(id)),
    createOnboardingLink: async input => { calls.push({ type: 'link', input }); return { url: 'https://connect.stripe.com/setup/fixture', expires_at: 9999999999 }; },
    createRecipientOnboardingLinkV2: async input => { calls.push({ type: 'link', input }); return { url: 'https://connect.stripe.com/setup/fixture', expires_at: '2026-10-20T00:00:00.000Z' }; },
    createTransfer: async input => { calls.push({ type: 'transfer', input }); const id = `tr_fixture${transfers.size}provider`;
      const actual = { id, livemode: false, amount: input.amountCents, currency: 'usd', destination: input.accountId,
        source_transaction: input.chargeId, transfer_group: `ORD_${input.orderId}` }; transfers.set(id, actual); return structuredClone(actual); },
    getTransfer: async id => structuredClone(transfers.get(id)),
    createRefund: async input => { calls.push({ type: 'refund', input }); const id = `re_fixture${refunds.size}provider`;
      const actual = { id, object: 'refund', amount: input.amountCents, currency: 'usd', payment_intent: PI, charge: CHARGE, status: 'succeeded',
        metadata: { bag_id: input.bagId, refund_id: input.refundId } };
      refunds.set(id, actual); return structuredClone(actual); },
    getRefund: async id => structuredClone(refunds.get(id)),
    createReversal: async input => { calls.push({ type: 'reversal', input }); const id = `trr_fixture${reversals.size}provider`;
      const actual = { id, object: 'transfer_reversal', transfer: input.transferId, amount: input.amountCents, currency: 'usd',
        metadata: { bag_id: input.bagId, refund_id: input.refundId } }; reversals.set(id, actual); return structuredClone(actual); },
    getReversal: async (_transferId, id) => structuredClone(reversals.get(id)),
    createTestPayout: async input => { calls.push({ type: 'payout', input }); const id = `po_fixture${payouts.size}provider`;
      const actual = { id, livemode: false, amount: input.amountCents, currency: 'usd', status: 'pending' }; payouts.set(id, actual); return structuredClone(actual); },
    getPayout: async (id, input) => { calls.push({ type: 'payoutRead', id, input }); return structuredClone(payouts.get(id)); },
    recordTaxTransaction: async () => { throw new Error('Native Checkout tax must not be duplicated.'); },
    reverseTaxTransaction: async () => { throw new Error('Native Checkout refunds must not create a second tax reversal.'); },
  };
  const shopify = {
    getOrderOperations: async id => structuredClone(orders.get(id)),
    getSuggestedRefund: async input => {
      calls.push({ type: 'refundPreview', input });
      const bag = snapshot.bags.find(bag => details.bags[bag.id].orderId === input.orderId);
      const index = snapshot.bags.indexOf(bag), unit = bag.items[0].unitPriceCents;
      const lineTax = qty => commercial[index]?.nativeTax ? commercial[index].nativeTax(qty, orders.get(input.orderId)) : qty * 8;
      const lines = input.lineItems.map(line => ({ quantity: line.quantity, restockType: 'NO_RESTOCK', lineItem: { id: line.lineItemId },
        subtotalSet: decimal(line.quantity * unit), totalTaxSet: decimal(lineTax(line.quantity)) }));
      const subtotal = input.lineItems.reduce((sum, line) => sum + line.quantity * unit, 0);
      const shipping = input.shippingAmountCents, tax = input.lineItems.reduce((sum, line) => sum + lineTax(line.quantity), 0) + shipping * .08;
      return { orderId: input.orderId, shop: bag.shop, operationsComplete: true, refundLineItems: lines,
        amountSet: decimal(subtotal + shipping + tax), subtotalSet: decimal(subtotal), discountedSubtotalSet: decimal(subtotal), totalTaxSet: decimal(tax),
        maximumRefundableSet: decimal(10000), totalDutiesSet: decimal(0), totalCartDiscountAmountSet: decimal(0),
        shipping: { amountSet: decimal(shipping), taxSet: decimal(shipping * .08), maximumRefundableSet: decimal(10000) } };
    },
    cancelOrder: async input => {
      const row = (await db.query('SELECT details_encrypted FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0];
      const persisted = auth.decrypt(row.details_encrypted);
      assert.ok(Object.values(persisted.bags).some(value => value.cancelOp?.startedAt && value.cancelOp.operationId === input.operationId));
      calls.push({ type: 'cancel', input }); const id = `gid://shopify/Job/${100 + cancelJobs.size}`;
      cancelJobs.set(id, { id, done: false, orderId: input.orderId }); return { job: { id, done: false } };
    },
    getJob: async id => {
      calls.push({ type: 'cancelJobRead', id }); const job = cancelJobs.get(id);
      if (job?.done) orders.get(job.orderId).cancelledAt = START.toISOString();
      return job ? { id: job.id, done: job.done } : null;
    },
    createManualRefund: async input => {
      calls.push({ type: 'shopifyRefund', input }); const order = orders.get(input.orderId);
      const index = snapshot.bags.findIndex(bag => details.bags[bag.id].orderId === input.orderId), unit = snapshot.bags[index].items[0].unitPriceCents;
      const lineTax = qty => commercial[index]?.nativeTax ? commercial[index].nativeTax(qty, order) : qty * 8;
      const actual = { id: `gid://shopify/Refund/${100 + order.refunds.length}`, note: `AVAFEM TEST MANUAL REFUND / ${input.operationId}`,
        totalRefundedSet: decimal(input.amountCents), transactions: { nodes: [{ kind: 'REFUND', status: 'SUCCESS', test: true,
          gateway: 'manual', parentTransaction: { id: input.parentTransactionId }, amountSet: decimal(input.amountCents) }] },
        refundLineItems: { pageInfo: { hasNextPage: false }, nodes: input.lineItems.map(item => ({ quantity: item.qty, lineItem: { id: item.lineItemId },
          subtotalSet: decimal(item.qty * unit), totalTaxSet: decimal(lineTax(item.qty)) })) },
        refundShippingLines: { pageInfo: { hasNextPage: false }, nodes: input.shippingCents > 0
          ? [{ subtotalAmountSet: decimal(input.shippingCents), taxAmountSet: decimal(input.shippingCents * .08), shippingLine: { id: 'gid://shopify/ShippingLine/100' } }] : [] } };
      order.refunds.push(actual);
      for (const item of input.lineItems) order.lineItems.nodes.find(line => line.id === item.lineItemId).refundableQuantity -= item.qty;
      return { refund: structuredClone(actual) };
    },
  };
  const stores = {
    row: async shop => records.get(shop), list: async () => [...records.values()].map(row => ({ shop: row.shop, brandId: row.brand_id })),
    forShop: async shop => { if (!records.has(shop)) throw new Error('Unknown test store'); return shopify; },
    bindConnectedAccount: async (shop, raw, options) => { const row = records.get(shop); assert.equal(options.createdInTest, true);
      assert.equal(raw.metadata.brand_id, row.brand_id); row.connected_account_id = raw.id; row.connected_account_created_in_test = true; },
    verifyConnectedAccount: async (shop, raw) => { const row = records.get(shop);
      assert.equal(raw.id, row.connected_account_id); assert.equal(raw.metadata.brand_id, row.brand_id);
      row.connected_account_verified = raw.capabilities.transfers === 'active' && raw.payouts_enabled;
      return { shop, ready: row.connected_account_verified }; },
  };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => stripe, clock: () => START });
  await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted)
    VALUES($1,'fixture-request','fixture-cart','orders_created',$2,$3)`, [RUN, auth.encrypt(snapshot), auth.encrypt(details)]);
  await db.query(`INSERT INTO orders(id,order_ref,status,subtotal_cents,shipping_cents,tax_cents,total_cents)
    VALUES($1,'PROVIDER-TEST','paid',$2,$3,$4,$5)`, [RUN, details.amounts.subtotalCents, details.amounts.shippingCents, details.amounts.taxCents, details.amounts.totalCents]);
  for (const bag of snapshot.bags) {
    const value = details.bags[bag.id];
    await db.query(`INSERT INTO bags(id,order_id,brand_id,status,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,
      transfer_cents,total_cents,ship_by,return_window_days) VALUES($1,$2,$3,'delivered',$4,$5,$11,$6,$7,$12,$8,$9,$10,30)`,
    [bag.id, RUN, bag.brandId, JSON.stringify(bag.items), JSON.stringify({ encryptedShipping: auth.encrypt(details.shipTo) }),
      value.shippingCents, value.taxCents, value.transferCents, value.totalCents, START, value.subtotalCents, value.commissionCents]);
    await db.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status) VALUES($1,$2,$3,$4,'scheduled')", [`tr_local_${bag.id}`, bag.id, bag.brandId, value.transferCents]);
    await db.query("INSERT INTO credits(id,bag_id,brand_id,amount_cents,status) VALUES($1,$2,$3,0,'pending')", [`cr_${bag.id}`, bag.id, bag.brandId]);
    await db.transaction(tx => unified.runtime.journal(tx, `payment:${bag.id}`, 'provider_payment_fixture', bag, [
      { account: 'stripe_platform_clearing', debitCents: value.totalCents }, { account: 'brand_payable', creditCents: value.transferCents },
      { account: 'commission_revenue', creditCents: value.commissionCents }, { account: 'tax_payable', creditCents: value.taxCents },
    ]));
  }
  const money = await createProviderMoney(db, auth, { runtime: unified.runtime, stores, getStripe: () => stripe });
  const inspect = async () => unified.runtime.decode(await unified.runtime.read(RUN));
  const change = async callback => { const current = await inspect(); callback(current);
    await db.query('UPDATE unified_checkout_runs SET snapshot_encrypted=$2,details_encrypted=$3 WHERE id=$1', [RUN, auth.encrypt(current.snapshot), auth.encrypt(current.details)]); };
  const advance = days => change(({ details }) => { details.testClock.now = new Date(+START + days * DAY).toISOString(); });
  const bag = snapshot.bags[0];
  const refundInput = (overrides = {}) => ({ runId: RUN, bagId: bag.id, operationId: 'return1', items: [{ sku: bag.items[0].sku, qty: 1 }], refundShipping: false, ...overrides });
  return { db, auth, money, unified, stores, stripe, shopify, calls, accounts, transfers, refunds, reversals, payouts, records, orders, cancelJobs, snapshot, bag,
    inspect, change, advance, refundInput, setMode: value => { stripeMode = value; }, setPlatform: value => { platformId = value; } };
}
async function balanced(db) {
  const result = await db.query(`SELECT journal_id,SUM(debit_cents)-SUM(credit_cents) AS difference FROM ledger_entries GROUP BY journal_id`);
  assert.ok(result.rows.every(row => Number(row.difference) === 0));
}
const count = (fx, type) => fx.calls.filter(call => call.type === type).length;

test('one checkout supplies three exact 15%-merchandise transfers only after the full isolated 30-day window', async t => {
  const fx = await fixture(t); await fx.advance(29);
  await fx.money.settle({ runId: RUN }); assert.equal(count(fx, 'transfer'), 0);
  const held = await fx.inspect(); assert.equal(held.details.bags[fx.bag.id].settlementError.code, 'RETURN_WINDOW_OPEN');
  await fx.advance(30); await fx.money.settle({ runId: RUN });
  assert.equal(count(fx, 'transfer'), 3);
  assert.deepEqual(fx.calls.filter(call => call.type === 'transfer').map(call => call.input.amountCents), [195, 220, 245]);
  assert.ok(fx.calls.filter(call => call.type === 'transfer').every(call => call.input.chargeId === CHARGE && call.input.orderId === RUN));
  await fx.money.settle({ runId: RUN }); assert.equal(count(fx, 'transfer'), 3);
  assert.equal((await fx.inspect()).details.processingFeeCents, 54);
  assert.equal((await fx.db.query("SELECT id FROM ledger_journals WHERE kind='provider_processing_fee'")).rows.length, 1);
  await balanced(fx.db);
});

test('reconcile clears a stale aggregate review state only after all three actual refunds/native bookkeeping and cancellation outcomes are complete, without new provider writes', async t => {
  const fx = await fixture(t);
  for (const bag of fx.snapshot.bags) await fx.money.refund({ runId: RUN, bagId: bag.id, operationId: `full_${bag.id}`,
    items: [{ sku: bag.items[0].sku, qty: 2 }], refundShipping: true });
  await fx.db.query("UPDATE unified_checkout_runs SET state='needs_review',last_error=$2 WHERE id=$1", [RUN, JSON.stringify({ code: 'HISTORICAL_REFUND_VERIFIER_HOLD' })]);
  let result = await fx.money.reconcile({ runId: RUN });
  assert.equal(result.state, 'refunded'); assert.equal(result.lastError, null); assert.equal(count(fx, 'refund'), 3); assert.equal(count(fx, 'shopifyRefund'), 3);
  for (const bag of fx.snapshot.bags) {
    fx.orders.get((await fx.inspect()).details.bags[bag.id].orderId).cancelledAt = START.toISOString();
    await fx.money.ingestShopifyCancellation({ runId: RUN, bagId: bag.id });
  }
  result = await fx.money.reconcile({ runId: RUN });
  assert.equal(result.state, 'cancelled'); assert.equal(result.lastError, null); assert.equal(count(fx, 'refund'), 3); assert.equal(count(fx, 'shopifyRefund'), 3);
  assert.equal(count(fx, 'transfer'), 0); assert.equal(count(fx, 'payout'), 0);
});

test('aggregate cash lifecycle stays incomplete for pending bank payouts and becomes completed only on actual paid readbacks for every remaining brand net', async t => {
  const fx = await fixture(t); await fx.advance(30); await fx.money.settle({ runId: RUN });
  for (const bag of fx.snapshot.bags) await fx.money.payout({ runId: RUN, bagId: bag.id, operationId: `payout_${bag.id}` });
  await fx.db.query("UPDATE unified_checkout_runs SET state='needs_review',last_error=NULL WHERE id=$1", [RUN]);
  assert.equal((await fx.money.reconcile({ runId: RUN })).state, 'needs_review');
  for (const payout of fx.payouts.values()) payout.status = 'paid';
  assert.equal((await fx.money.reconcile({ runId: RUN })).state, 'completed');
  await fx.db.query("UPDATE unified_checkout_runs SET state='needs_review',last_error=NULL WHERE id=$1", [RUN]);
  const getPayout = fx.stripe.getPayout;
  fx.stripe.getPayout = async () => { throw new Error('Actual bank-payout readback unavailable'); };
  assert.equal((await fx.money.reconcile({ runId: RUN })).state, 'needs_review', 'A stale paid flag cannot bypass a failed current readback.');
  fx.stripe.getPayout = getPayout;
  assert.equal((await fx.money.reconcile({ runId: RUN })).state, 'completed');
  assert.equal(count(fx, 'transfer'), 3); assert.equal(count(fx, 'payout'), 3); assert.equal(count(fx, 'refund'), 0);
});

test('optional automation policy is validated inside the durable run lease before any provider read or money dispatch', async t => {
  const fx = await fixture(t); await fx.advance(30);
  const original = fx.stripe.preflight; let providerReads = 0;
  fx.stripe.preflight = async () => { providerReads++; return original(); };
  let result = await fx.money.settle({ runId: RUN, automationPolicyId: 'policy_fixture' });
  assert.equal(result.lastError.code, 'AUTOMATION_GUARD_REQUIRED'); assert.equal(providerReads, 0); assert.equal(count(fx, 'transfer'), 0);
  const validations = [];
  fx.money.setAutomationGuard(async (ctx, input) => {
    const row = (await fx.db.query('SELECT lock_token FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0];
    assert.ok(row.lock_token, 'The policy check must occur while the run lease is held.');
    assert.equal(ctx.snapshot.id, RUN); assert.equal(providerReads, validations.length);
    validations.push(input);
    assert.equal(input.automationPolicyId, 'policy_fixture');
  });
  for (const automationPolicyId of [null, '', 'policy with spaces', 'sk_test_fixture']) {
    result = await fx.money.settle({ runId: RUN, automationPolicyId });
    assert.equal(result.lastError.code, 'AUTOMATION_POLICY_INVALID'); assert.equal(validations.length, 0); assert.equal(providerReads, 0);
  }
  await fx.money.settle({ runId: RUN, automationPolicyId: 'policy_fixture' });
  assert.equal(count(fx, 'transfer'), 3); assert.equal(validations.length, 1);
  await fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'payout_automation', automationPolicyId: 'policy_fixture' });
  assert.deepEqual(validations, [{ action: 'settle', automationPolicyId: 'policy_fixture' },
    { action: 'payout', bagId: fx.bag.id, operationId: 'payout_automation', automationPolicyId: 'policy_fixture' }]);
  assert.equal(providerReads, 2); assert.equal(count(fx, 'payout'), 1);
});

test('automation validator denial is fail-closed and cannot expose arbitrary safe-marked provider or policy diagnostics', async t => {
  const fx = await fixture(t); await fx.advance(30);
  fx.stripe.preflight = async () => assert.fail('Denied automation must not read the provider.');
  fx.money.setAutomationGuard(async () => { throw Object.assign(new Error('PRIVATE_SHOPPER private@example.com sk_test_fixture'), {
    unifiedSafe: true, providerMoney: true, code: 'PRIVATE_POLICY', details: { requestId: 'req_private', secret: 'sk_test_fixture' },
  }); });
  for (const invoke of [() => fx.money.settle({ runId: RUN, automationPolicyId: 'policy_fixture' }),
    () => fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'payout_automation', automationPolicyId: 'policy_fixture' })]) {
    const result = await invoke();
    assert.equal(result.lastError.code, 'AUTOMATION_POLICY_REJECTED');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SHOPPER|private@example|sk_test|req_private|PRIVATE_POLICY/);
  }
  assert.equal(count(fx, 'transfer'), 0); assert.equal(count(fx, 'payout'), 0);
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].payoutOp, undefined);
});

test('no full-delivery evidence, current-window extension or refunded uncertainty can bypass the hold', async t => {
  const fx = await fixture(t); await fx.advance(31);
  await fx.change(({ details }) => { details.bags[fx.bag.id].fullyDelivered = false; });
  fx.records.get(fx.snapshot.bags[1].shop).return_window_days = 45;
  await fx.money.settle({ runId: RUN }); assert.equal(count(fx, 'transfer'), 1);
  let state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].settlementError.code, 'DELIVERY_EVIDENCE_REQUIRED');
  const second = fx.snapshot.bags[1]; assert.equal(state.details.bags[second.id].payoutDueAt, new Date(+START + 45 * DAY).toISOString());
  fx.records.get(second.shop).return_window_days = 3;
  await fx.money.settle({ runId: RUN }); assert.equal(count(fx, 'transfer'), 1);
  state = await fx.inspect(); assert.equal(state.details.bags[second.id].payoutDueAt, new Date(+START + 45 * DAY).toISOString());
});

test('actual partial-quantity refund before transfer reduces only its own brand payable, with native tax unduplicated', async t => {
  const fx = await fixture(t);
  const result = await fx.money.refund(fx.refundInput());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|client_secret|encryptedShipping/);
  assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1); assert.equal(count(fx, 'reversal'), 0);
  let state = await fx.inspect(); const op = state.details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.status, 'complete'); assert.equal(op.amountCents, 108); assert.equal(op.commissionCents, 15); assert.equal(op.recoveryCents, 85);
  assert.equal(state.details.bags[fx.bag.id].refundCents, 108);
  assert.ok(fx.calls.findIndex(call => call.type === 'refundPreview') < fx.calls.findIndex(call => call.type === 'refund'));
  assert.equal(op.nativePreview.amountCents, 108);
  assert.equal((await fx.db.query('SELECT refunded_cents FROM bags WHERE id=$1', [fx.bag.id])).rows[0].refunded_cents, 108);
  assert.deepEqual((await fx.db.query('SELECT subtotal_cents,shipping_cents,tax_cents,commission_cents FROM refunds WHERE id=$1',[op.id])).rows[0],
    {subtotal_cents:100,shipping_cents:0,tax_cents:8,commission_cents:15});
  assert.equal((await fx.db.query('SELECT amount_cents FROM transfers WHERE bag_id=$1', [fx.bag.id])).rows[0].amount_cents, 110);
  await fx.advance(30); await fx.money.settle({ runId: RUN });
  assert.equal(fx.calls.find(call => call.type === 'transfer' && call.input.bagId === fx.bag.id).input.amountCents, 110);
  await fx.money.refund(fx.refundInput()); assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1);
  await balanced(fx.db);
});

test('documented Refund without livemode resumes its existing ID only after fresh linked test Charge and exact refund metadata verification', async t => {
  const fx = await fixture(t), getRefund = fx.stripe.getRefund, getCharge = fx.stripe.getCharge;
  const invalidRefunds = [{ livemode: true }, { charge: 'ch_wrongOriginal123' }, { payment_intent: 'pi_wrongOriginal123' },
    { amount: 109 }, { currency: 'eur' }, { metadata: {} }, { metadata: { bag_id: 'bag_wrong', refund_id: 'prf_wrong' } }];
  for (const patch of invalidRefunds) {
    fx.stripe.getRefund = async id => ({ ...await getRefund(id), ...patch });
    assert.equal((await fx.money.refund(fx.refundInput())).lastError.code, 'STRIPE_REFUND_MISMATCH');
    assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 0);
  }
  fx.stripe.getRefund = getRefund;
  for (const patch of [{ livemode: true }, { captured: false }, { paid: false }, { amount: 811 },
    { payment_intent: 'pi_wrongOriginal123' }, { currency: 'eur' }, { amount_refunded: 0 }]) {
    fx.stripe.getCharge = async id => ({ ...await getCharge(id), ...patch });
    assert.equal((await fx.money.refund(fx.refundInput())).lastError.code, 'STRIPE_REFUND_MISMATCH');
    assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 0);
  }
  fx.stripe.getCharge = getCharge;
  const before = (await fx.inspect()).details.bags[fx.bag.id].refundOps.return1.stripeRefundId;
  assert.equal((await getRefund(before)).livemode, undefined);
  await fx.money.refund(fx.refundInput());
  const op = (await fx.inspect()).details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.stripeRefundId, before); assert.equal(op.status, 'complete'); assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1);
  await balanced(fx.db);
});

test('native refund preview rejects missing evidence and every cent/quantity/shipping mismatch before Stripe, then only an explicit same-operation match may proceed', async t => {
  const fx = await fixture(t), original = fx.shopify.getSuggestedRefund;
  const patches = [
    value => { value.amountSet = decimal(109); },
    value => { value.totalTaxSet = decimal(9); },
    value => { value.refundLineItems[0].totalTaxSet = decimal(9); },
    value => { value.refundLineItems[0].quantity = 2; },
    value => { value.refundLineItems[0].lineItem.id = 'gid://shopify/LineItem/999'; },
    value => { value.refundLineItems[0].restockType = 'RETURN'; },
    value => { value.shipping.taxSet = decimal(1); },
    value => { value.shipping.amountSet = decimal(1); },
    value => { value.discountedSubtotalSet = decimal(99); },
    value => { value.totalDutiesSet = decimal(1); },
    value => { value.totalCartDiscountAmountSet = decimal(1); },
    value => { value.maximumRefundableSet = decimal(107); },
    value => { value.refundLineItems = { nodes: value.refundLineItems }; },
    value => { delete value.totalTaxSet; },
    value => { value.shop = fx.snapshot.bags[1].shop; },
  ];
  for (const patch of patches) {
    fx.shopify.getSuggestedRefund = async input => { const value = await original(input); patch(value); return value; };
    const result = await fx.money.refund(fx.refundInput());
    assert.ok(['SHOPIFY_REFUND_PREVIEW_MISMATCH', 'SHOPIFY_REFUND_MISMATCH', 'REFUND_AMOUNT_EXCEEDED', 'REFUND_TAX_REMAINDER_EXCEEDED'].includes(result.lastError.code));
    const op = (await fx.inspect()).details.bags[fx.bag.id].refundOps.return1;
    assert.equal(op.status, 'native_preview_review'); assert.equal(op.stripeStartedAt, undefined);
    assert.equal(op.amountCents, null); assert.equal(op.taxCents, null); assert.equal(op.taxAllocationFrozen, false);
    assert.equal(count(fx, 'refund'), 0); assert.equal(count(fx, 'shopifyRefund'), 0);
  }
  fx.shopify.getSuggestedRefund = undefined;
  assert.equal((await fx.money.refund(fx.refundInput())).lastError.code, 'SHOPIFY_REFUND_PREVIEW_REQUIRED');
  await fx.money.reconcile({ runId: RUN }); assert.equal(count(fx, 'refund'), 0);
  fx.shopify.getSuggestedRefund = original;
  await fx.money.refund(fx.refundInput());
  assert.equal(count(fx, 'refund'), 1); assert.equal((await fx.inspect()).details.bags[fx.bag.id].refundOps.return1.status, 'complete');
});

test('native partial tax is frozen from actual evidence while the immutable odd-cent Checkout tax and exact final residual remain protected', async t => {
  const fx = await fixture(t, { commercial: { 0: { lineTaxCents: 17 } } });
  await fx.money.refund(fx.refundInput());
  const op = (await fx.inspect()).details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.taxCents, 8); assert.equal(op.amountCents, 108); assert.equal(op.taxPolicy, 'shopify_native_refund_v2');
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].lineTaxCents['SKU-0'], 17);
  const result = await fx.money.refund(fx.refundInput({ operationId: 'finalOddCent', refundShipping: true }));
  assert.equal(result.lastError.code, 'REFUND_TAX_RESIDUAL');
  assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'reversal'), 0); assert.equal(count(fx, 'shopifyRefund'), 1);
});

async function legacyUnsentRefund(fx) {
  const bag = fx.snapshot.bags[1], operationId = 'main_store4_pre_transfer_refund_v1';
  const input = { runId: RUN, bagId: bag.id, operationId, items: [{ sku: bag.items[0].sku, qty: 1 }], refundShipping: false };
  await fx.change(({ details }) => { details.bags[bag.id].refundOps[operationId] = {
    id: 'prf_fixtureLegacyUnsent123', input: { items: input.items, refundShipping: false }, items: input.items,
    lineItems: [{ sku: bag.items[0].sku, lineItemId: 'gid://shopify/LineItem/101', qty: 1, subtotalCents: 200, taxCents: 17 }],
    refundShipping: false, amountCents: 217, subtotalCents: 200, shippingCents: 0, shippingTaxCents: 0, taxCents: 17,
    commissionCents: 30, recoveryCents: 170, parentTransactionId: 'gid://shopify/OrderTransaction/101', afterTransfer: false,
    status: 'native_preview_review', createdAt: START.toISOString(), lastError: { code: 'SHOPIFY_REFUND_PREVIEW_MISMATCH' },
  }; });
  return { bag, input, revise: { runId: RUN, bagId: bag.id, operationId, confirmNoProviderWrites: true } };
}
const store4Commercial = () => ({ 1: { qty: 4, unitPriceCents: 200, lineTaxCents: 66, nativeTax: qty => Math.floor(66 * qty / 4) } });

test('explicit never-dispatched legacy proposal revision archives217/17 and freezes native216/16 under the same operation before any provider write', async t => {
  const fx = await fixture(t, { commercial: store4Commercial() }), legacy = await legacyUnsentRefund(fx);
  const revised = await fx.money.reviseRefundProposal(legacy.revise);
  assert.equal(revised.lastError, null); assert.equal(count(fx, 'refund'), 0); assert.equal(count(fx, 'shopifyRefund'), 0);
  let value = (await fx.inspect()).details.bags[legacy.bag.id], op = value.refundOps[legacy.input.operationId];
  assert.equal(op.id, 'prf_fixtureLegacyUnsent123'); assert.equal(op.amountCents, 216); assert.equal(op.taxCents, 16); assert.equal(op.status, 'native_quote_frozen');
  assert.equal(op.proposalRevisions[0].previous.amountCents, 217); assert.equal(op.proposalRevisions[0].previous.taxCents, 17);
  assert.equal(op.proposalRevisions[0].proof.chargeRefundedCents, 0); assert.equal(value.lineTaxCents['SKU-1'], 66); assert.equal(value.totalCents, 920);
  assert.equal((await fx.db.query('SELECT * FROM provider_money_bookings WHERE business_key=$1', [`provider-refund:${op.id}`])).rows.length, 0);
  const raw = (await fx.db.query('SELECT details_encrypted FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0].details_encrypted;
  assert.doesNotMatch(raw, /proposalRevisions|PRIVATE_STREET/);
  await fx.money.refund(legacy.input); await fx.money.refund(legacy.input);
  value = (await fx.inspect()).details.bags[legacy.bag.id]; op = value.refundOps[legacy.input.operationId];
  assert.equal(op.status, 'complete'); assert.equal(op.amountCents, 216); assert.equal(op.commissionCents, 30); assert.equal(op.recoveryCents, 170);
  assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1); await balanced(fx.db);
});

test('new Store6-shaped intent uses actual24/324 rather than Math.round25/325 and final native residual must preserve all99 original tax cents', async t => {
  const commercial = { 2: { qty: 4, unitPriceCents: 300, lineTaxCents: 99, nativeTax: qty => Math.floor(99 * qty / 4) } };
  const fx = await fixture(t, { commercial }), bag = fx.snapshot.bags[2];
  const input = { runId: RUN, bagId: bag.id, operationId: 'store6partial', items: [{ sku: 'SKU-2', qty: 1 }], refundShipping: false };
  await fx.money.refund(input);
  let value = (await fx.inspect()).details.bags[bag.id], op = value.refundOps.store6partial;
  assert.equal(op.taxCents, 24); assert.equal(op.amountCents, 324); assert.equal(op.commissionCents, 45); assert.equal(value.lineTaxCents['SKU-2'], 99);
  const final = { ...input, operationId: 'store6final', items: [{ sku: 'SKU-2', qty: 3 }], refundShipping: true };
  assert.equal((await fx.money.refund(final)).lastError.code, 'REFUND_TAX_RESIDUAL'); assert.equal(count(fx, 'refund'), 1);
  commercial[2].nativeTax = (qty, order) => qty === order.lineItems.nodes[0].refundableQuantity
    ? 99 - order.refunds.reduce((sum, refund) => sum + refund.refundLineItems.nodes.reduce((n, line) => n + Math.round(Number(line.totalTaxSet.shopMoney.amount) * 100), 0), 0)
    : Math.floor(99 * qty / 4);
  await fx.money.refund(final);
  value = (await fx.inspect()).details.bags[bag.id];
  assert.equal(value.refundOps.store6final.lineItems[0].taxCents, 75); assert.equal(value.refundCents, 1380);
  assert.equal(Object.values(value.refundOps).reduce((sum, refund) => sum + refund.lineItems[0].taxCents, 0), 99);
  assert.equal((await fx.db.query('SELECT status FROM bags WHERE id=$1', [bag.id])).rows[0].status, 'refunded'); await balanced(fx.db);
});

test('proposal revision rejects every dispatch marker, existing booking and missing operator confirmation without changing historical monetary intent', async t => {
  const fx = await fixture(t, { commercial: store4Commercial() }), legacy = await legacyUnsentRefund(fx);
  await assert.rejects(fx.money.reviseRefundProposal({ ...legacy.revise, confirmNoProviderWrites: false }), { code: 'REFUND_REVISION_CONFIRMATION_REQUIRED' });
  for (const key of ['stripeStartedAt', 'stripeRefundId', 'stripeStatus', 'shopifyStartedAt', 'shopifyRefundId', 'sourceShopifyRefundId', 'reversalStartedAt', 'reversalId']) {
    await fx.change(({ details }) => { details.bags[legacy.bag.id].refundOps[legacy.input.operationId][key] = 'EXISTING_EVIDENCE'; });
    const result = await fx.money.reviseRefundProposal(legacy.revise); assert.equal(result.lastError.code, 'REFUND_REVISION_UNSENT_REQUIRED');
    await fx.change(({ details }) => { delete details.bags[legacy.bag.id].refundOps[legacy.input.operationId][key]; });
  }
  await fx.db.query(`INSERT INTO provider_money_bookings(business_key,run_id,bag_id,kind,provider_id,created_at) VALUES($1,$2,$3,'provider_refund','re_fixtureExisting123',now())`,
    ['provider-refund:prf_fixtureLegacyUnsent123', RUN, legacy.bag.id]);
  assert.equal((await fx.money.reviseRefundProposal(legacy.revise)).lastError.code, 'REFUND_REVISION_UNSENT_REQUIRED');
  const op = (await fx.inspect()).details.bags[legacy.bag.id].refundOps[legacy.input.operationId];
  assert.equal(op.amountCents, 217); assert.equal(op.taxCents, 17); assert.equal(op.proposalRevisions, undefined); assert.equal(count(fx, 'refund'), 0);
});

test('proposal revision requires actual charge totals, no unknown run refund, matching native quantities and no original operation refund marker', async t => {
  const fx = await fixture(t, { commercial: store4Commercial() }), legacy = await legacyUnsentRefund(fx), original = fx.stripe.getCharge;
  fx.stripe.getCharge = async id => ({ ...await original(id), amount_refunded: 1 });
  assert.equal((await fx.money.reviseRefundProposal(legacy.revise)).lastError.code, 'REFUND_REVISION_PROVIDER_PROOF_REQUIRED'); fx.stripe.getCharge = original;
  const order = fx.orders.get('gid://shopify/Order/101'); order.refunds.push({ id: 'gid://shopify/Refund/999', note: 'AVAFEM TEST MANUAL REFUND / prf_fixtureLegacyUnsent123' });
  assert.equal((await fx.money.reviseRefundProposal(legacy.revise)).lastError.code, 'REFUND_REVISION_UNSENT_REQUIRED'); order.refunds = [];
  order.lineItems.nodes[0].refundableQuantity = 3;
  assert.equal((await fx.money.reviseRefundProposal(legacy.revise)).lastError.code, 'REFUND_REVISION_PROVIDER_PROOF_REQUIRED'); order.lineItems.nodes[0].refundableQuantity = 4;
  await fx.change(({ details }) => { details.bags[fx.bag.id].refundOps.unknown = { stripeStartedAt: START.toISOString() }; });
  assert.equal((await fx.money.reviseRefundProposal(legacy.revise)).lastError.code, 'REFUND_REVISION_PROVIDER_PROOF_REQUIRED');
  assert.equal(count(fx, 'refund'), 0); assert.equal(count(fx, 'shopifyRefund'), 0);
});

test('concurrent duplicate refund operation issues one re_ and mismatched reuse or over-refund is rejected', async t => {
  const fx = await fixture(t);
  await Promise.all([fx.money.refund(fx.refundInput()), fx.money.refund(fx.refundInput())]);
  await fx.money.refund(fx.refundInput()); assert.equal(count(fx, 'refund'), 1);
  let result = await fx.money.refund(fx.refundInput({ items: [{ sku: fx.bag.items[0].sku, qty: 2 }] }));
  assert.equal(result.lastError.code, 'OPERATION_REUSED');
  result = await fx.money.refund(fx.refundInput({ operationId: 'return2', items: [{ sku: fx.bag.items[0].sku, qty: 2 }] }));
  assert.equal(result.lastError.code, 'REFUND_QUANTITY_EXCEEDED'); assert.equal(count(fx, 'refund'), 1);
});

test('after-transfer partial refund records distinct shopper re_ and brand trr_ shares, then only the remainder is paid externally', async t => {
  const fx = await fixture(t); await fx.advance(30); await fx.money.settle({ runId: RUN });
  await fx.money.refund(fx.refundInput());
  assert.equal(fx.calls.find(call => call.type === 'refund').input.amountCents, 108);
  assert.equal(fx.calls.find(call => call.type === 'reversal').input.amountCents, 85);
  let state = await fx.inspect(); const op = state.details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.status, 'complete'); assert.equal(op.reversalVerified, true);
  await fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'payout1' });
  assert.equal(fx.calls.find(call => call.type === 'payout').input.amountCents, 110);
  state = await fx.inspect(); const payoutId = state.details.bags[fx.bag.id].payoutId;
  assert.equal(state.details.bags[fx.bag.id].payoutOp.status, 'pending');
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='payout.paid'")).rows.length, 0);
  fx.payouts.get(payoutId).status = 'paid'; await fx.money.reconcile({ runId: RUN });
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='payout.paid'")).rows.length, 1);
  await fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'differentOperation' });
  assert.equal(count(fx, 'payout'), 1, 'A second operation ID cannot issue a second bank payout.');
  await balanced(fx.db);
});

test('failed brand recovery preserves the successful shopper refund and receivable without fabricating reversal/payout', async t => {
  const fx = await fixture(t); await fx.advance(30); await fx.money.settle({ runId: RUN });
  fx.stripe.createReversal = async () => { fx.calls.push({ type: 'reversalFailed' }); throw new Error('sk_test_DO_NOT_EXPOSE'); };
  await fx.money.refund(fx.refundInput());
  let state = await fx.inspect(); const op = state.details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.stripeStatus, 'succeeded'); assert.equal(op.status, 'recovery_uncertain'); assert.equal(op.unrecoveredCents, 85);
  assert.equal((await fx.db.query("SELECT id FROM ledger_journals WHERE kind='provider_transfer_reversal'")).rows.length, 0);
  const result = await fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'payout1' });
  assert.equal(result.lastError.code, 'REFUND_PENDING'); assert.equal(count(fx, 'payout'), 0);
  await fx.money.reconcile({ runId: RUN }); assert.equal(count(fx, 'reversalFailed'), 1);
  assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1); await balanced(fx.db);
});

test('unknown refund write cannot repeat after restart or 24 hours, and holds money safely', async t => {
  const fx = await fixture(t);
  fx.stripe.createRefund = async () => { fx.calls.push({ type: 'unknownRefund' }); throw new Error('connection lost'); };
  await fx.money.refund(fx.refundInput());
  await fx.advance(35);
  const restarted = await createProviderMoney(fx.db, fx.auth, { runtime: fx.unified.runtime, stores: fx.stores, getStripe: () => fx.stripe });
  await restarted.refund(fx.refundInput()); await restarted.reconcile({ runId: RUN }); await restarted.settle({ runId: RUN });
  assert.equal(count(fx, 'unknownRefund'), 1);
  assert.equal(count(fx, 'shopifyRefund'), 0);
  assert.equal(fx.calls.filter(call => call.type === 'transfer' && call.input.bagId === fx.bag.id).length, 0);
  assert.equal((await fx.db.query('SELECT refunded_cents FROM bags WHERE id=$1', [fx.bag.id])).rows[0].refunded_cents, 0);
});

test('Shopify timeout after its native-idempotent refund is reconciled by recorded operation without a second create', async t => {
  const fx = await fixture(t); const original = fx.shopify.createManualRefund;
  fx.shopify.createManualRefund = async input => { await original(input); throw new Error('response lost'); };
  await fx.money.refund(fx.refundInput());
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].refundOps.return1.status, 'shopify_uncertain');
  await fx.money.reconcile({ runId: RUN });
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].refundOps.return1.status, 'complete');
  assert.equal(count(fx, 'shopifyRefund'), 1); assert.equal(count(fx, 'refund'), 1);
});

test('shipping is refunded only with final quantity and tax/commission cents reconcile exactly', async t => {
  const fx = await fixture(t);
  let result = await fx.money.refund(fx.refundInput({ refundShipping: true }));
  assert.equal(result.lastError.code, 'REFUND_SHIPPING_INVALID'); assert.equal(count(fx, 'refund'), 0);
  await fx.money.refund(fx.refundInput());
  await fx.money.refund(fx.refundInput({ operationId: 'finalReturn', refundShipping: true }));
  const state = await fx.inspect(); const value = state.details.bags[fx.bag.id];
  assert.equal(value.refundCents, 243); assert.equal(value.refundOps.finalReturn.amountCents, 135);
  assert.equal(Object.values(value.refundOps).reduce((sum, op) => sum + op.commissionCents, 0), 30);
  assert.equal((await fx.db.query('SELECT status,amount_cents FROM transfers WHERE bag_id=$1', [fx.bag.id])).rows[0].status, 'cancelled');
  assert.equal((await fx.db.query('SELECT status FROM bags WHERE id=$1', [fx.bag.id])).rows[0].status, 'refunded'); await balanced(fx.db);
});

async function merchantRefund(fx, { qty = 1, shippingCents = 0 } = {}) {
  const order = fx.orders.get(`gid://shopify/Order/100`);
  const result = await fx.shopify.createManualRefund({ orderId: order.id, operationId: `merchant_${order.refunds.length}`,
    lineItems: qty ? [{ lineItemId: order.lineItems.nodes[0].id, qty }] : [],
    shippingCents, amountCents: qty * 108 + shippingCents + shippingCents * .08,
    parentTransactionId: order.transactions[0].id });
  return result.refund.id;
}

test('native Shopify partial refund creates one Stripe refund, no second Shopify refund, and self-generated echoes cannot double-charge', async t => {
  const fx = await fixture(t); const nativeId = await merchantRefund(fx);
  await Promise.all([fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId }),
    fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId })]);
  assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1);
  assert.equal(count(fx, 'refundPreview'), 0, 'Already-consumed native refund quantities use original authoritative evidence, not a second preview.');
  let state = await fx.inspect(); const native = Object.values(state.details.bags[fx.bag.id].refundOps)[0];
  assert.equal(native.status, 'complete'); assert.equal(native.sourceShopifyRefundId, nativeId); assert.equal(native.amountCents, 108);
  await fx.money.refund(fx.refundInput({ operationId: 'ownerFinal', refundShipping: true }));
  state = await fx.inspect(); const ownId = state.details.bags[fx.bag.id].refundOps.ownerFinal.shopifyRefundId;
  await fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: ownId });
  assert.equal(count(fx, 'refund'), 2); assert.equal(count(fx, 'shopifyRefund'), 2);
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].refundCents, 243); await balanced(fx.db);
});

test('native refund after transfer reverses only its brand share and refuses mismatched tax before shopper money writes', async t => {
  const fx = await fixture(t); await fx.advance(30); await fx.money.settle({ runId: RUN });
  const nativeId = await merchantRefund(fx);
  const order = fx.orders.get('gid://shopify/Order/100'); order.refunds[0].refundLineItems.nodes[0].totalTaxSet = decimal(9);
  let result = await fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId });
  assert.equal(result.lastError.code, 'SHOPIFY_REFUND_PREVIEW_MISMATCH'); assert.equal(count(fx, 'refund'), 0);
  order.refunds[0].refundLineItems.nodes[0].totalTaxSet = decimal(8);
  await fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId });
  assert.equal(fx.calls.find(call => call.type === 'refund').input.amountCents, 108);
  assert.equal(fx.calls.find(call => call.type === 'reversal').input.amountCents, 85);
  assert.equal(count(fx, 'shopifyRefund'), 1); await balanced(fx.db);
});

test('authoritative Shopify cancellation refunds only remaining quantity and final shipping, idempotently in both directions', async t => {
  const fx = await fixture(t);
  let result = await fx.money.ingestShopifyCancellation({ runId: RUN, bagId: fx.bag.id });
  assert.equal(result.lastError.code, 'SHOPIFY_CANCELLATION_REQUIRED'); assert.equal(count(fx, 'refund'), 0);
  const nativeId = await merchantRefund(fx);
  fx.orders.get('gid://shopify/Order/100').cancelledAt = START.toISOString();
  await fx.money.ingestShopifyCancellation({ runId: RUN, bagId: fx.bag.id });
  assert.deepEqual(fx.calls.filter(call => call.type === 'refund').map(call => call.input.amountCents), [108, 135]);
  assert.equal(count(fx, 'shopifyRefund'), 2);
  await fx.money.ingestShopifyCancellation({ runId: RUN, bagId: fx.bag.id });
  await fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId });
  const state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].cancellationVerified, true);
  assert.equal(state.details.bags[fx.bag.id].refundCents, 243); assert.equal(count(fx, 'refund'), 2); assert.equal(count(fx, 'shopifyRefund'), 2);
  await balanced(fx.db);
});

test('cancellation can refund final remaining shipping only after every merchandise quantity was already natively refunded', async t => {
  const fx = await fixture(t); const nativeId = await merchantRefund(fx, { qty: 2 });
  await fx.money.ingestShopifyRefund({ runId: RUN, bagId: fx.bag.id, shopifyRefundId: nativeId });
  fx.orders.get('gid://shopify/Order/100').cancelledAt = START.toISOString();
  await fx.money.ingestShopifyCancellation({ runId: RUN, bagId: fx.bag.id });
  assert.deepEqual(fx.calls.filter(call => call.type === 'refund').map(call => call.input.amountCents), [216, 27]);
  const shipping = fx.calls.filter(call => call.type === 'shopifyRefund').at(-1).input;
  assert.deepEqual(shipping.lineItems, []); assert.equal(shipping.shippingCents, 25);
  const state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].refundCents, 243);
  assert.equal(state.details.bags[fx.bag.id].cancellationVerified, true); await balanced(fx.db);
});

test('missing Shopify shipping proof preserves actual shopper refund but never marks its bookkeeping complete', async t => {
  const fx = await fixture(t); const original = fx.shopify.createManualRefund;
  fx.shopify.createManualRefund = async input => { const result = await original(input);
    delete fx.orders.get(input.orderId).refunds.at(-1).refundShippingLines; return result; };
  await fx.money.refund(fx.refundInput({ items: [{ sku: fx.bag.items[0].sku, qty: 2 }], refundShipping: true }));
  const state = await fx.inspect(), op = state.details.bags[fx.bag.id].refundOps.return1;
  assert.equal(op.stripeStatus, 'succeeded'); assert.equal(op.status, 'shopify_uncertain'); assert.equal(op.shopifyVerified, undefined);
  await fx.advance(30); await fx.money.settle({ runId: RUN });
  assert.equal(fx.calls.filter(call => call.type === 'transfer' && call.input.bagId === fx.bag.id).length, 0);
  await fx.money.reconcile({ runId: RUN }); assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1);
});

test('Avafem cancellation persists its async job before polling and refunds only after actual cancelledAt, with no nested lease or repeat mutation', async t => {
  const fx = await fixture(t), input = { runId: RUN, bagId: fx.bag.id, operationId: 'cancel1' };
  await Promise.all([fx.money.cancel(input), fx.money.cancel(input)]);
  assert.equal(count(fx, 'cancel'), 1); assert.equal(count(fx, 'refund'), 0);
  let state = await fx.inspect(); const op = state.details.bags[fx.bag.id].cancelOp;
  assert.equal(op.status, 'job_pending'); assert.ok(op.jobId); assert.equal(op.jobDone, false);
  assert.deepEqual(fx.calls.find(call => call.type === 'cancel').input, { orderId: 'gid://shopify/Order/100', operationId: 'cancel1', restock: false, reason: 'OTHER' });
  fx.cancelJobs.get(op.jobId).done = true;
  const restarted = await createProviderMoney(fx.db, fx.auth, { runtime: fx.unified.runtime, stores: fx.stores, getStripe: () => fx.stripe });
  await restarted.reconcile({ runId: RUN });
  state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].cancelOp.status, 'complete');
  assert.equal(state.details.bags[fx.bag.id].cancellationVerified, true); assert.equal(state.details.bags[fx.bag.id].fullyDelivered, false);
  assert.equal(state.details.bags[fx.bag.id].refundCents, 243); assert.equal(count(fx, 'refund'), 1); assert.equal(count(fx, 'shopifyRefund'), 1);
  await restarted.cancel(input); await restarted.reconcile({ runId: RUN });
  assert.equal(count(fx, 'cancel'), 1); assert.equal(count(fx, 'refund'), 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='bag.cancelled'")).rows.length, 1);
  assert.equal((await fx.db.query('SELECT status FROM credits WHERE bag_id=$1', [fx.bag.id])).rows[0].status, 'voided');
  await balanced(fx.db);
});

test('canonical UUID Shopify cancellation job IDs remain durable and reconcile without a second cancellation', async t => {
  const fx = await fixture(t), original = fx.shopify.cancelOrder;
  const uuid = 'gid://shopify/Job/4c6e25b8-d41c-45e3-8e83-123456789abc';
  fx.shopify.cancelOrder = async input => {
    const result = await original(input), job = fx.cancelJobs.get(result.job.id);
    fx.cancelJobs.delete(result.job.id); fx.cancelJobs.set(uuid, { ...job, id: uuid });
    return { job: { id: uuid, done: false } };
  };
  const input = { runId: RUN, bagId: fx.bag.id, operationId: 'cancel_uuid' };
  await fx.money.cancel(input);
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].cancelOp.jobId, uuid);
  assert.equal(count(fx, 'cancel'), 1); assert.equal(count(fx, 'refund'), 0);
  fx.cancelJobs.get(uuid).done = true; await fx.money.cancel(input);
  assert.equal(count(fx, 'cancel'), 1); assert.equal(count(fx, 'refund'), 1);
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].cancelOp.status, 'complete');
});

test('unknown cancellation cannot repeat without an ID, but later authoritative native cancellation safely resumes the one refund', async t => {
  const fx = await fixture(t), input = { runId: RUN, bagId: fx.bag.id, operationId: 'cancel1' };
  fx.shopify.cancelOrder = async args => { fx.calls.push({ type: 'unknownCancel', input: args }); throw new Error('shpat_SECRET'); };
  await fx.money.cancel(input); await fx.advance(35); await fx.money.cancel(input); await fx.money.reconcile({ runId: RUN });
  assert.equal(count(fx, 'unknownCancel'), 1); assert.equal(count(fx, 'refund'), 0);
  let state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].cancelOp.status, 'cancel_uncertain');
  assert.doesNotMatch(JSON.stringify(state.details.bags[fx.bag.id].cancelOp.lastError), /shpat_|SECRET/);
  fx.orders.get('gid://shopify/Order/100').cancelledAt = START.toISOString();
  await fx.money.reconcile({ runId: RUN });
  assert.equal(count(fx, 'unknownCancel'), 1); assert.equal(count(fx, 'refund'), 1);
  state = await fx.inspect(); assert.equal(state.details.bags[fx.bag.id].cancelOp.status, 'complete');
});

test('completed job alone does not prove cancellation and changed operation/bound order or non-test/fulfilled order cannot cause a cancel/refund', async t => {
  const fx = await fixture(t), input = { runId: RUN, bagId: fx.bag.id, operationId: 'cancel1' };
  const order = fx.orders.get('gid://shopify/Order/100'); order.test = false;
  let result = await fx.money.cancel(input); assert.equal(result.lastError.code, 'SHOPIFY_REFUND_REVIEW'); assert.equal(count(fx, 'cancel'), 0);
  order.test = true; order.fulfillments = [{ status: 'SUCCESS' }];
  result = await fx.money.cancel(input); assert.equal(result.lastError.code, 'SHOPIFY_CANCELLATION_BLOCKED'); assert.equal(count(fx, 'cancel'), 0);
  order.fulfillments = []; await fx.money.cancel(input);
  fx.shopify.getJob = async id => ({ id, done: true });
  await fx.money.cancel(input); assert.equal(count(fx, 'refund'), 0);
  assert.equal((await fx.inspect()).details.bags[fx.bag.id].cancelOp.status, 'job_done');
  result = await fx.money.cancel({ ...input, operationId: 'different' }); assert.equal(result.lastError.code, 'OPERATION_REUSED');
  assert.equal(count(fx, 'cancel'), 1); assert.equal(count(fx, 'refund'), 0);
});

test('wrong brand binding, unverified payment, platform account change and missing authoritative tax fail before writes', async t => {
  const fx = await fixture(t);
  let result = await fx.money.refund(fx.refundInput({ bagId: 'other_brand_bag' })); assert.equal(result.lastError.code, 'BAG_NOT_FOUND');
  await fx.change(({ details }) => { details.paymentVerified = false; });
  result = await fx.money.refund(fx.refundInput()); assert.equal(result.lastError.code, 'CAPTURED_PAYMENT_REQUIRED');
  await fx.change(({ details }) => { details.paymentVerified = true; });
  fx.setPlatform('acct_otherPlatform123'); result = await fx.money.refund(fx.refundInput()); assert.equal(result.lastError.code, 'STRIPE_TEST_ACCOUNT_REQUIRED');
  fx.setPlatform(PLATFORM); await fx.change(({ details }) => { delete details.bags[fx.bag.id].lineTaxCents; });
  result = await fx.money.refund(fx.refundInput()); assert.equal(result.lastError.code, 'AUTHORITATIVE_TAX_REQUIRED');
  assert.equal(count(fx, 'refund'), 0);
  await fx.advance(31); fx.records.get(fx.bag.shop).brand_id = 'wrong_brand';
  await fx.money.settle({ runId: RUN });
  assert.equal(fx.calls.filter(call => call.type === 'transfer' && call.input.bagId === fx.bag.id).length, 0);
});

test('recipient creation is separate, explicit, once per store and never accepts terms or adds external banks', async t => {
  const fx = await fixture(t, { bound: false });
  await assert.rejects(fx.money.createRecipients({}), { code: 'TEST_CONFIRMATION_REQUIRED' });
  await Promise.all([fx.money.createRecipients({ confirmTest: true }), fx.money.createRecipients({ confirmTest: true }).catch(error => error)]);
  await fx.money.createRecipients({ confirmTest: true }); assert.equal(count(fx, 'account'), 3);
  assert.ok(fx.calls.filter(call => call.type === 'account').every(call => call.manualPayouts === true));
  await fx.money.refreshRecipients();
  const links = await fx.money.recipientLinks({ baseUrl: 'http://127.0.0.1:4317' }); assert.equal(links.length, 3);
  assert.ok(links.every(link => link.requiresHumanOnboarding === true));
  assert.ok(fx.calls.filter(call => call.type === 'link').every(call => new URL(call.input.returnUrl).pathname === '/api/provider-test/recipients/return'));
  assert.equal(count(fx, 'transfer'), 0); assert.equal(count(fx, 'payout'), 0);
});

test('unknown recipient creation is durably stopped instead of creating replacement Connect accounts', async t => {
  const fx = await fixture(t, { bound: false });
  fx.stripe.createExpressRecipientV2 = async () => { fx.calls.push({ type: 'unknownAccount' }); throw new Error('timeout'); };
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_CREATION_UNCERTAIN' });
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_CREATION_UNCERTAIN' });
  assert.equal(count(fx, 'unknownAccount'), 1);
});

async function heldRecipient(fx, { ageHours = 0, shop = fx.bag.shop } = {}) {
  const row = fx.records.get(shop);
  await fx.db.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at)
    VALUES($1,$2,$3,'uncertain',$4)`, [shop, row.brand_id, PLATFORM, new Date(Date.now() - ageHours * 3600_000)]);
  return { shop, providerRequestId: 'req_fixtureRejected123', confirmRejectedBeforeCreation: true };
}
const recipientCandidate = (fx, shop = fx.bag.shop) => {
  const account = structuredClone([...fx.accounts.values()].find(value => value.metadata.brand_id === fx.records.get(shop).brand_id));
  account.created = Math.floor(Date.now() / 1000); account.settings = { payouts: { schedule: { interval: 'manual' } } };
  return account;
};

test('explicit observed400 recovery lists accounts first and performs one identical same-key recipient request with durable proof', async t => {
  const fx = await fixture(t, { bound: false }), input = await heldRecipient(fx), raw = recipientCandidate(fx);
  fx.stripe.listTestConnectedAccounts = async filter => { fx.calls.push({ type: 'recipientList', filter }); return []; };
  fx.stripe.createExpressAccount = async params => {
    const attempt = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
    assert.equal(attempt.state, 'retry_started'); assert.equal(attempt.retry_provider_request_id, input.providerRequestId);
    assert.deepEqual(attempt.retry_params, { brandId: fx.bag.brandId, country: 'US', manualPayouts: true, parameterRevision: 1 });
    fx.calls.push({ type: 'accountRetry', params }); return raw;
  };
  const result = await fx.money.retryRecipient(input);
  assert.equal(result.retried, true); assert.equal(result.accountId, raw.id);
  assert.deepEqual(fx.calls.find(call => call.type === 'accountRetry').params, { brandId: fx.bag.brandId, country: 'US', manualPayouts: true, parameterRevision: 1 });
  assert.equal(fx.records.get(input.shop).connected_account_id, raw.id);
  assert.ok(fx.calls.findIndex(call => call.type === 'recipientList') < fx.calls.findIndex(call => call.type === 'accountRetry'));
  fx.stripe.listTestConnectedAccounts = async () => [raw];
  const replay = await fx.money.retryRecipient(input); assert.equal(replay.reconciledExisting, true); assert.equal(count(fx, 'accountRetry'), 1);
});

test('one original metadata-bound account is recovered without creation; multiple candidates or missing proof never authorize a create', async t => {
  const fx = await fixture(t, { bound: false }), input = await heldRecipient(fx), raw = recipientCandidate(fx);
  fx.stripe.listTestConnectedAccounts = async () => [raw];
  await assert.rejects(fx.money.retryRecipient({ ...input, confirmRejectedBeforeCreation: false }), { code: 'RECIPIENT_REJECTION_PROOF_REQUIRED' });
  await assert.rejects(fx.money.retryRecipient({ ...input, providerRequestId: 'sk_test_SECRET' }), { code: 'RECIPIENT_REJECTION_PROOF_REQUIRED' });
  fx.stripe.listTestConnectedAccounts = async () => [raw, { ...raw, id: 'acct_duplicateFixture123' }];
  await assert.rejects(fx.money.retryRecipient(input), { code: 'RECIPIENT_MULTIPLE_MATCHES' }); assert.equal(count(fx, 'account'), 0);
  fx.stripe.listTestConnectedAccounts = async () => [raw];
  const result = await fx.money.retryRecipient(input); assert.equal(result.reconciledExisting, true); assert.equal(count(fx, 'account'), 0);
});

test('recipient retry requires the original held brand/platform binding and closes after23h before listing or creating', async t => {
  const fx = await fixture(t, { bound: false }), input = await heldRecipient(fx, { ageHours: 24 });
  fx.stripe.listTestConnectedAccounts = async () => { fx.calls.push({ type: 'recipientList' }); return []; };
  await assert.rejects(fx.money.retryRecipient(input), { code: 'RECIPIENT_RETRY_WINDOW_CLOSED' });
  await fx.db.query('UPDATE provider_recipient_attempts SET started_at=$2 WHERE shop=$1', [input.shop, new Date()]);
  fx.setPlatform('acct_otherPlatform123');
  await assert.rejects(fx.money.retryRecipient(input), { code: 'STRIPE_TEST_ACCOUNT_REQUIRED' });
  fx.setPlatform(PLATFORM); fx.records.get(input.shop).brand_id = 'brand_other';
  await assert.rejects(fx.money.retryRecipient(input), { code: 'RECIPIENT_HELD_ATTEMPT_REQUIRED' });
  assert.equal(count(fx, 'recipientList'), 0); assert.equal(count(fx, 'account'), 0);
});

test('concurrent controlled retry is reserved once; unknown outcome remains held and cannot be automatically retried', async t => {
  const fx = await fixture(t, { bound: false }), input = await heldRecipient(fx);
  fx.stripe.listTestConnectedAccounts = async () => [];
  fx.stripe.createExpressAccount = async params => { fx.calls.push({ type: 'accountRetryUnknown', params }); throw new Error('sk_test_SECRET'); };
  await Promise.all([fx.money.retryRecipient(input).catch(error => error), fx.money.retryRecipient(input).catch(error => error)]);
  await assert.rejects(fx.money.retryRecipient(input), { code: 'RECIPIENT_RETRY_ALREADY_USED' });
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_CREATION_UNCERTAIN' });
  assert.equal(count(fx, 'accountRetryUnknown'), 1);
  const attempt = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.equal(attempt.state, 'retry_uncertain'); assert.doesNotMatch(JSON.stringify(attempt.last_error), /sk_test|SECRET/);
});

const REVISION_TARGET = 'acct_1U74iQGgawRtH2qe';
async function rejectedEmailFixture(fx) {
  const prior = await heldRecipient(fx); fx.setPlatform(REVISION_TARGET);
  await fx.db.query('UPDATE provider_recipient_attempts SET platform_account_id=$2 WHERE shop=$1', [prior.shop, REVISION_TARGET]);
  await fx.db.query(`CREATE TABLE provider_test_stores(shop TEXT PRIMARY KEY,brand_id TEXT NOT NULL,connected_account_id TEXT,
    connected_account_created_in_test BOOLEAN DEFAULT false,connected_account_verified BOOLEAN DEFAULT false)`);
  for (const row of fx.records.values()) await fx.db.query('INSERT INTO provider_test_stores(shop,brand_id) VALUES($1,$2)', [row.shop, row.brand_id]);
  fx.stripe.listTestConnectedAccounts = async filter => { fx.calls.push({ type: 'revisionList', filter }); return []; };
  return { shop: fx.bag.shop, providerRequestId: 'req_98gvn77VCy6nK8', confirmRejectedBeforeCreation: true };
}

test('explicit missing-email400 revision archives original ciphertext before one durable new email-bearing request, preserving unrelated held attempts', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedEmailFixture(fx);
  const other = fx.snapshot.bags[1];
  await fx.db.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at)
    VALUES($1,$2,$3,'uncertain',now())`, [other.shop, other.brandId, REVISION_TARGET]);
  const unchanged = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [other.shop])).rows[0];
  fx.stripe.createExpressAccount = async params => {
    fx.calls.push({ type: 'emailRevisionCreate', params });
    const current = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
    assert.equal(current.state, 'creating'); assert.equal(current.parameter_revision, 2); assert.ok(current.previous_revision_id);
    assert.deepEqual(current.request_params, params); assert.equal(params.email, stripeTestRecipientContactEmail(fx.bag.brandId));
    const history = (await fx.db.query('SELECT * FROM provider_recipient_revision_history')).rows[0];
    assert.equal(fx.auth.decrypt(history.record_encrypted).parameter_revision, null);
    assert.equal(fx.auth.decrypt(history.proof_encrypted).providerRequestId, input.providerRequestId);
    return recipientCandidate(fx);
  };
  const result = await fx.money.reviseRejectedRecipient(input);
  assert.equal(result.parameterRevision, 2); assert.equal(result.state, 'bound'); assert.equal(count(fx, 'emailRevisionCreate'), 1);
  assert.equal(fx.calls.find(call => call.type === 'emailRevisionCreate').params.parameterRevision, 2);
  assert.deepEqual((await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [other.shop])).rows[0], unchanged);
  const history = (await fx.db.query('SELECT * FROM provider_recipient_revision_history')).rows[0];
  assert.doesNotMatch(history.record_encrypted, /brand_id|account_id|uncertain/);
  await assert.rejects(fx.money.reviseRejectedRecipient(input), { code: 'RECIPIENT_REVISION_HELD_REQUIRED' });
});

test('new normal recipient attempts freeze synthetic-contact API-v2 revision3, but no existing held attempt is automatically upgraded', async t => {
  const fx = await fixture(t, { bound: false }); await fx.money.createRecipients({ confirmTest: true });
  const rows = (await fx.db.query('SELECT * FROM provider_recipient_attempts')).rows;
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.parameter_revision === 3 && row.request_params.parameterRevision === 3
    && row.request_params.email === stripeTestRecipientContactEmail(row.brand_id)));
});

test('recipient parameter revision demands exact target/request/store/operator proof and no existing candidate or linked recipient', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedEmailFixture(fx);
  for (const patch of [{ confirmRejectedBeforeCreation: false }, { providerRequestId: 'req_otherRequest123' }, { shop: fx.snapshot.bags[1].shop }])
    await assert.rejects(fx.money.reviseRejectedRecipient({ ...input, ...patch }), { code: 'RECIPIENT_REVISION_APPROVAL_REQUIRED' });
  fx.setPlatform(PLATFORM); await assert.rejects(fx.money.reviseRejectedRecipient(input), { code: 'STRIPE_TEST_ACCOUNT_REQUIRED' }); fx.setPlatform(REVISION_TARGET);
  fx.stripe.listTestConnectedAccounts = async () => [recipientCandidate(fx)];
  await assert.rejects(fx.money.reviseRejectedRecipient(input), { code: 'RECIPIENT_REVISION_EXISTING_CANDIDATE' });
  fx.stripe.listTestConnectedAccounts = async () => [];
  await fx.db.query('UPDATE provider_test_stores SET connected_account_id=$2 WHERE shop=$1', [fx.snapshot.bags[2].shop, 'acct_someRecipient123']);
  await assert.rejects(fx.money.reviseRejectedRecipient(input), { code: 'RECIPIENT_REVISION_UNBOUND_REQUIRED' });
  assert.equal((await fx.db.query('SELECT id FROM provider_recipient_revision_history')).rows.length, 0); assert.equal(count(fx, 'account'), 0);
});

test('unknown approved email revision is reserved once under concurrency and preserves both original history and held new intent', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedEmailFixture(fx);
  fx.stripe.createExpressAccount = async params => { fx.calls.push({ type: 'emailRevisionUnknown', params });
    throw Object.assign(new Error('sk_test_SECRET and private@example.com'), { code: 'STRIPE_REQUEST_FAILED',
      details: { requestId: 'req_fixtureSafe123', stripeCode: 'parameter_missing', raw: 'sk_test_SECRET' } }); };
  const outcomes = await Promise.all([fx.money.reviseRejectedRecipient(input).catch(error => error), fx.money.reviseRejectedRecipient(input).catch(error => error)]);
  assert.deepEqual(outcomes.find(value => value.code === 'RECIPIENT_REVISION_UNCERTAIN').details, { requestId: 'req_fixtureSafe123', stripeCode: 'parameter_missing' });
  assert.equal(count(fx, 'emailRevisionUnknown'), 1);
  await assert.rejects(fx.money.reviseRejectedRecipient(input), { code: 'RECIPIENT_REVISION_HELD_REQUIRED' });
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_CREATION_UNCERTAIN' });
  const current = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.equal(current.parameter_revision, 2); assert.equal(current.state, 'uncertain'); assert.ok(current.previous_revision_id);
  assert.equal(current.last_error.requestId, 'req_fixtureSafe123'); assert.equal(current.last_error.stripeCode, 'parameter_missing');
  assert.equal((await fx.db.query('SELECT id FROM provider_recipient_revision_history')).rows.length, 1);
  assert.doesNotMatch(JSON.stringify(current.last_error), /SECRET|sk_test/);
});

test('held recipient diagnostics retain bounded request IDs and Stripe codes but discard credential-like or raw provider values', async t => {
  for (const details of [
    { requestId: 'req_sk_test_superprivate', stripeCode: 'sk_test_superprivate' },
    { requestId: 'req_bad value private@example.com', stripeCode: 'parameter_missing private@example.com' },
  ]) {
    const fx = await fixture(t, { bound: false });
    fx.stripe.createExpressRecipientV2 = async () => { throw Object.assign(new Error('raw upstream body private@example.com sk_test_fixture'),
      { code: 'STRIPE_REQUEST_FAILED', details }); };
    await assert.rejects(fx.money.createRecipients({ confirmTest: true }), error => {
      assert.equal(error.code, 'RECIPIENT_CREATION_UNCERTAIN'); assert.deepEqual(error.details, {});
      assert.doesNotMatch(error.message, /private@example|sk_test|raw upstream/); return true;
    });
    const row = (await fx.db.query('SELECT last_error FROM provider_recipient_attempts')).rows[0];
    assert.deepEqual(Object.keys(row.last_error).sort(), ['code', 'message']);
    assert.doesNotMatch(JSON.stringify(row.last_error), /private@example|sk_test|raw upstream/);
  }
});

async function rejectedV1EmailFixture(fx) {
  await rejectedEmailFixture(fx);
  const historyId = 'recipient_revision_originalFixture';
  await fx.db.query(`INSERT INTO provider_recipient_revision_history(id,shop,brand_id,platform_account_id,record_encrypted,proof_encrypted)
    VALUES($1,$2,$3,$4,$5,$6)`, [historyId, fx.bag.shop, fx.bag.brandId, REVISION_TARGET, fx.auth.encrypt({ original: true }), fx.auth.encrypt({ observedHttpStatus: 400 })]);
  await fx.db.query(`UPDATE provider_recipient_attempts SET parameter_revision=2,request_params=$2,previous_revision_id=$3,last_error=$4 WHERE shop=$1`,
    [fx.bag.shop, JSON.stringify({ brandId: fx.bag.brandId, country: 'US', manualPayouts: true, parameterRevision: 2, email: stripeTestRecipientContactEmail(fx.bag.brandId) }),
      historyId, JSON.stringify({ code: 'STRIPE_REQUEST_FAILED', requestId: 'req_kxW4JTIW5nYP4G' })]);
  fx.stripe.listTestConnectedAccountsV2 = async () => { fx.calls.push({ type: 'v2List' }); return []; };
  return { shop: fx.bag.shop, providerRequestId: 'req_kxW4JTIW5nYP4G', confirmRejectedBeforeCreation: true };
}

test('explicit second HTTP400 revision uses API-v2 once, preserving both encrypted histories and the known ID before separate manual setup and v1 projection binding', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedV1EmailFixture(fx);
  const originalCreate = fx.stripe.createExpressRecipientV2;
  fx.stripe.createExpressRecipientV2 = async params => {
    const row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
    assert.equal(row.parameter_revision, 3); assert.deepEqual(row.request_params, params); assert.equal(row.account_id, null);
    assert.equal((await fx.db.query('SELECT id FROM provider_recipient_revision_history')).rows.length, 2);
    assert.equal(count(fx, 'v2List'), 1); assert.equal(count(fx, 'revisionList'), 1);
    return originalCreate(params);
  };
  fx.stripe.configureTestRecipientManualPayouts = async params => {
    const row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
    assert.equal(row.account_id, params.accountId); assert.ok(row.schedule_started_at); assert.equal(row.schedule_verified_at, null);
    assert.equal(fx.records.get(input.shop).connected_account_id, null);
    fx.calls.push({ type: 'schedule', input: params });
  };
  fx.accounts.get('acct_fixtureRecipient0').type = 'none';
  const result = await fx.money.reviseRejectedRecipientV2(input);
  assert.equal(result.parameterRevision, 3); assert.equal(result.providerApi, 'v2'); assert.equal(result.accountId, 'acct_fixtureRecipient0');
  assert.equal(fx.accounts.get(result.accountId).type, 'none', 'Do not fabricate an Express v1 type from a verified v2 dashboard.');
  const row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.ok(row.schedule_verified_at); assert.equal(row.state, 'created'); assert.equal(count(fx, 'account'), 1); assert.equal(count(fx, 'schedule'), 1);
  assert.doesNotMatch(JSON.stringify(result), /@example|request_params|encrypted/);
  await assert.rejects(fx.money.reviseRejectedRecipientV2(input), { code: 'RECIPIENT_V2_REVISION_HELD_REQUIRED' });
});

test('API-v2 revision requires both complete metadata-absence reads, exact rejected proof, preserved history and all three unbound recipients', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedV1EmailFixture(fx);
  for (const patch of [{ providerRequestId: 'req_otherFixture' }, { confirmRejectedBeforeCreation: false }, { shop: shops[1] }])
    await assert.rejects(fx.money.reviseRejectedRecipientV2({ ...input, ...patch }), { code: 'RECIPIENT_V2_REVISION_APPROVAL_REQUIRED' });
  fx.stripe.listTestConnectedAccountsV2 = async () => [recipientCandidate(fx)];
  await assert.rejects(fx.money.reviseRejectedRecipientV2(input), { code: 'RECIPIENT_V2_REVISION_EXISTING_CANDIDATE' });
  fx.stripe.listTestConnectedAccountsV2 = async () => [];
  fx.stripe.listTestConnectedAccounts = async () => [recipientCandidate(fx)];
  await assert.rejects(fx.money.reviseRejectedRecipientV2(input), { code: 'RECIPIENT_V2_REVISION_EXISTING_CANDIDATE' });
  fx.stripe.listTestConnectedAccounts = async () => [];
  await fx.db.query('UPDATE provider_recipient_attempts SET last_error=$2 WHERE shop=$1', [input.shop, JSON.stringify({ requestId: 'req_otherFixture' })]);
  await assert.rejects(fx.money.reviseRejectedRecipientV2(input), { code: 'RECIPIENT_V2_REVISION_HELD_REQUIRED' });
  assert.equal(count(fx, 'account'), 0); assert.equal((await fx.db.query('SELECT id FROM provider_recipient_revision_history')).rows.length, 1);
});

test('uncertain API-v2 manual setup retains the original ID and never repeats account creation or setup mutation; authoritative manual readback can safely finish', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedV1EmailFixture(fx);
  const originalConfigure = fx.stripe.configureTestRecipientManualPayouts;
  let schedule = 'daily';
  fx.stripe.getTestBalanceSettings = async () => ({ payments: { payouts: { schedule: { interval: schedule } } } });
  fx.stripe.configureTestRecipientManualPayouts = async params => { fx.calls.push({ type: 'scheduleUnknown', params }); throw new Error('private provider timeout sk_test_fixture'); };
  await assert.rejects(fx.money.reviseRejectedRecipientV2(input), { code: 'RECIPIENT_REVISION_UNCERTAIN' });
  let row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.equal(row.account_id, 'acct_fixtureRecipient0'); assert.equal(row.parameter_revision, 3); assert.ok(row.schedule_started_at); assert.equal(row.schedule_verified_at, null);
  assert.equal(fx.records.get(input.shop).connected_account_id, null);
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_SCHEDULE_UNVERIFIED' });
  await assert.rejects(fx.money.retryRecipient(input), { code: 'RECIPIENT_V2_RECONCILE_REQUIRED' });
  assert.equal(count(fx, 'account'), 1); assert.equal(count(fx, 'scheduleUnknown'), 1);
  schedule = 'manual'; fx.stripe.configureTestRecipientManualPayouts = originalConfigure; await fx.money.createRecipients({ confirmTest: true });
  row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.ok(row.schedule_verified_at); assert.equal(fx.records.get(input.shop).connected_account_id, row.account_id);
  assert.equal(fx.calls.filter(call => call.type === 'account' && call.brandId === fx.bag.brandId).length, 1); assert.equal(count(fx, 'scheduleUnknown'), 1);
});

test('concurrent unknown API-v2 create consumes its approved revision once and keeps both histories without automatic reset', async t => {
  const fx = await fixture(t, { bound: false }), input = await rejectedV1EmailFixture(fx);
  fx.stripe.createExpressRecipientV2 = async () => { fx.calls.push({ type: 'v2Unknown' }); throw Object.assign(new Error('private'), { details: { requestId: 'req_fixtureV2Unknown', stripeCode: 'account_creation_invalid' } }); };
  await Promise.all([fx.money.reviseRejectedRecipientV2(input).catch(error => error), fx.money.reviseRejectedRecipientV2(input).catch(error => error)]);
  assert.equal(count(fx, 'v2Unknown'), 1);
  await assert.rejects(fx.money.createRecipients({ confirmTest: true }), { code: 'RECIPIENT_CREATION_UNCERTAIN' });
  const row = (await fx.db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [input.shop])).rows[0];
  assert.equal(row.parameter_revision, 3); assert.equal(row.account_id, null); assert.equal(row.last_error.requestId, 'req_fixtureV2Unknown');
  assert.equal((await fx.db.query('SELECT id FROM provider_recipient_revision_history')).rows.length, 2);
});

test('unknown actual transfer cannot be recreated after lease release, restart or an idempotency retention window', async t => {
  const fx = await fixture(t); await fx.advance(30); const original = fx.stripe.createTransfer;
  fx.stripe.createTransfer = async input => { if (input.bagId !== fx.bag.id) return original(input);
    fx.calls.push({ type: 'unknownTransfer', input }); throw new Error('timeout after provider write'); };
  await fx.money.settle({ runId: RUN }); await fx.advance(35);
  const restarted = await createProviderMoney(fx.db, fx.auth, { runtime: fx.unified.runtime, stores: fx.stores, getStripe: () => fx.stripe });
  await restarted.settle({ runId: RUN }); await restarted.reconcile({ runId: RUN });
  assert.equal(count(fx, 'unknownTransfer'), 1); assert.equal(count(fx, 'transfer'), 2);
  assert.equal((await fx.db.query('SELECT status FROM transfers WHERE bag_id=$1', [fx.bag.id])).rows[0].status, 'scheduled');
  const result = await restarted.refund(fx.refundInput()); assert.equal(result.lastError.code, 'REFUND_PENDING');
});

test('unknown external payout cannot be replaced by a different operation ID, restart or later isolated clock', async t => {
  const fx = await fixture(t); await fx.advance(30); await fx.money.settle({ runId: RUN });
  fx.stripe.createTestPayout = async input => { fx.calls.push({ type: 'unknownPayout', input }); throw new Error('timeout'); };
  await fx.money.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'payout1' }); await fx.advance(35);
  const restarted = await createProviderMoney(fx.db, fx.auth, { runtime: fx.unified.runtime, stores: fx.stores, getStripe: () => fx.stripe });
  await restarted.payout({ runId: RUN, bagId: fx.bag.id, operationId: 'replacement' }); await restarted.reconcile({ runId: RUN });
  assert.equal(count(fx, 'unknownPayout'), 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='payout.paid'")).rows.length, 0);
  const result = await restarted.refund(fx.refundInput()); assert.equal(result.lastError.code, 'PAYOUT_ALREADY_STARTED');
});
