import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderReconciliation } from '../server/provider-reconciliation.mjs';

const RUN = `uco_${'b'.repeat(32)}`, PLATFORM = 'acct_fixturePlatform123', CHARGE = 'ch_fixtureCharge123', PI = 'pi_fixturePayment123', TXN = 'txn_fixtureBalance123';
const decimal = value => ({ shopMoney: { amount: (value / 100).toFixed(2), currencyCode: 'USD' } });
const shops = ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'];
async function setup(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  const calls = [], snapshot = { id: RUN, currency: 'USD', bags: [] };
  const details = { accountId: PLATFORM, paymentVerified: true, canonicalCommitted: true, paymentIntentId: PI, chargeId: CHARGE,
    chargeBalanceTransactionId: TXN, amounts: { subtotalCents: 600, shippingCents: 150, taxCents: 60, totalCents: 810 },
    shipTo: { name: 'PRIVATE_SHOPPER', line1: 'PRIVATE_STREET' }, bags: {} };
  const charge = { id: CHARGE, livemode: false, currency: 'usd', payment_intent: PI, captured: true, paid: true, amount: 810, amount_refunded: 0, balance_transaction: TXN };
  const balanceTransaction = { id: TXN, currency: 'usd', source: CHARGE, amount: 810, fee: 54, net: 756 };
  const rows = new Map(), originals = new Map(), orders = new Map(), refunds = new Map(), transfers = new Map(), reversals = new Map(), payouts = new Map();
  const stripe = { preflight: async () => ({ verified: true, mode: 'test', accountId: PLATFORM }),
    getCharge: async value => { calls.push(['getCharge', value]); return structuredClone(charge); },
    getBalanceTransaction: async value => { calls.push(['getBalanceTransaction', value]); return structuredClone(balanceTransaction); },
    getBalance: async options => { calls.push(['getBalance', options]); return { livemode: false, available: [{ currency: 'usd', amount: 100000 }], pending: [{ currency: 'usd', amount: 123 }] }; },
    getRefund: async value => { calls.push(['getRefund', value]); return structuredClone(refunds.get(value)); },
    getTransfer: async value => { calls.push(['getTransfer', value]); return structuredClone(transfers.get(value)); },
    getReversal: async (_transfer, value) => { calls.push(['getReversal', value]); return structuredClone(reversals.get(value)); },
    getPayout: async (value, options) => { calls.push(['getPayout', value, options]); return structuredClone(payouts.get(value)); },
  };
  for (const method of ['createRefund', 'createTransfer', 'createReversal', 'createTestPayout', 'createCheckoutSession', 'capturePaymentIntent', 'recordTaxTransaction'])
    stripe[method] = async () => { calls.push(['FORBIDDEN_WRITE', method]); throw new Error('Reconciliation must never mutate providers.'); };
  const stores = { row: async shop => rows.get(shop), forShop: async shop => ({ shop,
    getOrderDetails: async value => { calls.push(['getOrderDetails', shop, value]); return structuredClone(originals.get(value)); },
    getOrderOperations: async value => { calls.push(['getOrderOperations', shop, value]); return structuredClone(orders.get(value)); },
  }) };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => stripe, clock: () => new Date('2026-10-19T12:00:00Z') });
  for (let index = 0; index < 3; index++) {
    const bag = { id: `bag_recon_${index}`, shop: shops[index], brandId: `brand_recon_${index}`, commissionBps: 1500,
      shippingCents: 25 * (index + 1), returnWindowDays: 30, items: [{ sku: `SKU-${index}`, qty: 2, unitPriceCents: 100 }] };
    snapshot.bags.push(bag);
    const value = { orderId: `gid://shopify/Order/${100 + index}`, verified: true, subtotalCents: 200, shippingCents: bag.shippingCents,
      taxCents: 18 + index * 2, commissionCents: 30, transferCents: 170 + bag.shippingCents,
      totalCents: 218 + bag.shippingCents + index * 2, refundOps: {}, refundCents: 0 };
    details.bags[bag.id] = value;
    rows.set(bag.shop, { brand_id: bag.brandId, connected_account_created_in_test: true, connected_account_id: `acct_fixtureRecipient${index}` });
    originals.set(value.orderId, { id: value.orderId, test: true, sourceIdentifier: bag.id,
      totalPriceSet: decimal(value.totalCents), subtotalPriceSet: decimal(200), totalTaxSet: decimal(value.taxCents), totalShippingPriceSet: decimal(bag.shippingCents),
      shippingAddress: { address1: 'PRIVATE_STREET' }, email: 'PRIVATE_EMAIL' });
    orders.set(value.orderId, { id: value.orderId, test: true, currencyCode: 'USD', operationsComplete: true, totalRefundedSet: decimal(0), refunds: [] });
    await db.query('INSERT INTO brands(id,name,slug,commission_bps) VALUES($1,$1,$1,1500)', [bag.brandId]);
  }
  const save = async () => db.query(`UPDATE unified_checkout_runs SET details_encrypted=$2 WHERE id=$1`, [RUN, auth.encrypt(details)]);
  await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted,charge_id)
    VALUES($1,'recon-request','recon-cart','orders_created',$2,$3,$4)`, [RUN, auth.encrypt(snapshot), auth.encrypt(details), CHARGE]);
  await db.query("INSERT INTO orders(id,order_ref,status,subtotal_cents,shipping_cents,tax_cents,total_cents) VALUES($1,'RECON-TEST','paid',600,150,60,810)", [RUN]);
  for (const bag of snapshot.bags) {
    const value = details.bags[bag.id];
    await db.query(`INSERT INTO bags(id,order_id,brand_id,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,transfer_cents,total_cents,ship_by)
      VALUES($1,$2,$3,$8,$9,200,$4,$5,30,$6,$7,now())`, [bag.id, RUN, bag.brandId, value.shippingCents, value.taxCents, value.transferCents, value.totalCents,
      JSON.stringify(bag.items), JSON.stringify({ encryptedShipping: auth.encrypt(details.shipTo) })]);
    await db.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status) VALUES($1,$2,$3,$4,'scheduled')", [`transfer_${bag.id}`, bag.id, bag.brandId, value.transferCents]);
    await db.transaction(tx => unified.runtime.journal(tx, `payment:${bag.id}`, 'stripe_test_payment', bag,
      [{ account: 'stripe_platform_clearing', debitCents: value.totalCents }, { account: 'brand_payable', creditCents: value.transferCents },
        { account: 'commission_revenue', creditCents: 30 }, { account: 'tax_payable', creditCents: value.taxCents }]));
  }
  await db.transaction(tx => unified.runtime.journal(tx, `fee:${RUN}`, 'provider_processing_fee', snapshot.bags[0],
    [{ account: 'payment_processing_expense', debitCents: 54 }, { account: 'stripe_platform_clearing', creditCents: 54 }]));
  let time = new Date('2026-10-19T12:00:00Z');
  const service = await createProviderReconciliation(db, auth, { unifiedCheckout: unified, stores, getStripe: () => stripe, clock: () => time });
  return { db, auth, calls, snapshot, details, charge, balanceTransaction, rows, originals, orders, refunds, transfers, reversals, payouts, stripe, stores, unified, service, save,
    setTime: value => { time = new Date(value); } };
}
function check(report, name) { const result = report.checks.find(value => value.name === name); assert.ok(result, name); return result; }

test('three-brand captured charge, original Shopify orders and exact account nets match without falsely attributing shared balances or completion', async t => {
  const fx = await setup(t); const result = await fx.service.reconcile({ runId: RUN });
  assert.equal(result.status, 'matched'); assert.equal(result.mismatchCount, 0); assert.equal(result.pendingCount, 0);
  assert.equal(result.lifecycleComplete, false); assert.equal(result.balanceObservations.length, 4);
  assert.ok(result.balanceObservations.every(value => value.runAttribution.startsWith('not_asserted')));
  assert.equal(check(result, 'ledger_net:stripe_platform_clearing').actualCents, 756);
  assert.equal(check(result, 'ledger_net:brand_payable').actualCents, -660);
  assert.equal(fx.calls.filter(value => value[0] === 'FORBIDDEN_WRITE').length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|address|email|secret/i);
  const stored = (await fx.db.query('SELECT * FROM provider_reconciliation_reports')).rows[0];
  assert.doesNotMatch(stored.report_encrypted, /stripe_platform_clearing|PRIVATE_|ch_fixture/);
  assert.equal(fx.auth.decrypt(stored.report_encrypted).status, 'matched');
});

test('balanced but misclassified commission/tax cents are actual mismatches, not a false balanced-ledger PASS', async t => {
  const fx = await setup(t), first = fx.snapshot.bags[0];
  await fx.db.query(`UPDATE ledger_entries SET credit_cents=credit_cents+CASE WHEN account='commission_revenue' THEN 1 ELSE -1 END
    WHERE journal_id=(SELECT id FROM ledger_journals WHERE business_key=$1) AND account IN ('commission_revenue','tax_payable')`, [`payment:${first.id}`]);
  const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'mismatch'); assert.equal(check(report, 'balanced_journals_and_declared_totals').status, 'matched');
  assert.equal(check(report, 'ledger_net:commission_revenue').differenceCents, -1);
  assert.equal(check(report, 'ledger_net:tax_payable').differenceCents, 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.reconciliation_review'")).rows.length, 1);
  await fx.service.reconcile({ runId: RUN });
  assert.equal((await fx.db.query('SELECT id FROM provider_reconciliation_reports')).rows.length, 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.reconciliation_review'")).rows.length, 1);
});

test('declared journal imbalance, canonical Bag cents and unseen charge refunds independently trigger discrepancies', async t => {
  const fx = await setup(t), bag = fx.snapshot.bags[0];
  await fx.db.query(`UPDATE ledger_entries SET debit_cents=debit_cents+1 WHERE journal_id=(SELECT id FROM ledger_journals WHERE business_key=$1) AND account='stripe_platform_clearing'`, [`payment:${bag.id}`]);
  await fx.db.query('UPDATE bags SET subtotal_cents=subtotal_cents+1,tax_cents=tax_cents-1,commission_cents=commission_cents+1 WHERE id=$1', [bag.id]); fx.charge.amount_refunded = 1;
  const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'mismatch'); assert.equal(check(report, 'balanced_journals_and_declared_totals').status, 'mismatch');
  assert.equal(check(report, `${bag.id}:canonical_subtotal_cents`).differenceCents, 1);
  assert.equal(check(report, 'stripe_charge_refunded').differenceCents, 1);
});

async function fullLifecycle(fx) {
  for (const [index, bag] of fx.snapshot.bags.entries()) {
    const value = fx.details.bags[bag.id], accountId = fx.rows.get(bag.shop).connected_account_id, transferId = `tr_fixtureTransfer${index}`;
    value.transferId = transferId; value.transferOp = { id: transferId, status: 'verified', amountCents: value.transferCents, accountId };
    fx.transfers.set(transferId, { id: transferId, livemode: false, amount: value.transferCents, currency: 'usd', amount_reversed: 0,
      destination: accountId, source_transaction: CHARGE, transfer_group: `ORD_${RUN}` });
    await fx.db.query("UPDATE transfers SET status='paid' WHERE bag_id=$1", [bag.id]);
    await fx.db.transaction(tx => fx.unified.runtime.journal(tx, `transfer:${bag.id}`, 'provider_transfer', bag,
      [{ account: 'brand_payable', debitCents: value.transferCents }, { account: 'stripe_platform_clearing', creditCents: value.transferCents }]));
    const refundAmount = index ? 0 : 108, recovery = index ? 0 : 85;
    if (!index) {
      const refundId = 're_fixtureRefund123', reversalId = 'trr_fixtureReverse123', nativeId = 'gid://shopify/Refund/100';
      value.refundCents = refundAmount; value.refundOps.return1 = { id: 'prf_fixtureReturn123', stripeRefundId: refundId, stripeStatus: 'succeeded',
        amountCents: 108, taxCents: 8, commissionCents: 15, recoveryCents: 85, afterTransfer: true, status: 'complete', reversalId,
        reversalVerified: true, shopifyRefundId: nativeId };
      fx.refunds.set(refundId, { id: refundId, object: 'refund', amount: 108, currency: 'usd', payment_intent: PI, charge: CHARGE, status: 'succeeded',
        metadata: { bag_id: bag.id, refund_id: 'prf_fixtureReturn123' } });
      fx.reversals.set(reversalId, { id: reversalId, object: 'transfer_reversal', transfer: transferId, amount: 85, currency: 'usd',
        metadata: { bag_id: bag.id, refund_id: 'prf_fixtureReturn123' } });
      fx.transfers.get(transferId).amount_reversed = 85; fx.charge.amount_refunded = 108;
      fx.orders.get(value.orderId).totalRefundedSet = decimal(108);
      fx.orders.get(value.orderId).refunds = [{ id: nativeId, totalRefundedSet: decimal(108), transactions: { pageInfo: { hasNextPage: false },
        nodes: [{ kind: 'REFUND', status: 'SUCCESS', test: true, gateway: 'manual', amountSet: decimal(108) }] } }];
      await fx.db.query('UPDATE bags SET refunded_cents=108 WHERE id=$1', [bag.id]);
      await fx.db.query('UPDATE orders SET refunded_cents=108 WHERE id=$1', [RUN]);
      await fx.db.query('UPDATE transfers SET reversed_cents=85 WHERE bag_id=$1', [bag.id]);
      await fx.db.transaction(tx => fx.unified.runtime.journal(tx, 'refund:return1', 'provider_refund', bag,
        [{ account: 'brand_receivable', debitCents: 85 }, { account: 'commission_revenue', debitCents: 15 },
          { account: 'tax_payable', debitCents: 8 }, { account: 'stripe_platform_clearing', creditCents: 108 }]));
      await fx.db.transaction(tx => fx.unified.runtime.journal(tx, 'reversal:return1', 'provider_transfer_reversal', bag,
        [{ account: 'stripe_platform_clearing', debitCents: 85 }, { account: 'brand_receivable', creditCents: 85 }]));
    }
    const payoutId = `po_fixturePayout${index}`;
    value.payoutId = payoutId; value.payoutOp = { id: payoutId, amountCents: value.transferCents - recovery, accountId, status: 'paid' };
    fx.payouts.set(payoutId, { id: payoutId, livemode: false, amount: value.transferCents - recovery, currency: 'usd', status: 'paid' });
  }
  await fx.save();
}

test('actual re_, tr_, trr_ and connected po_ readbacks reconcile full lifecycle gross journals and platform clearing cents', async t => {
  const fx = await setup(t); await fullLifecycle(fx);
  const report = await fx.service.reconcile({ runId: RUN });
  assert.equal(report.status, 'matched'); assert.equal(report.lifecycleComplete, true);
  assert.equal(check(report, 'ledger_net:stripe_platform_clearing').actualCents, 73);
  assert.equal(check(report, 'ledger_net:brand_receivable').actualCents, 0);
  assert.equal(check(report, 'journal_gross:provider_refund').actualCents, 108);
  assert.equal(check(report, 'journal_gross:provider_transfer_reversal').actualCents, 85);
  assert.equal(fx.calls.filter(value => value[0] === 'getPayout').length, 3);
  assert.ok(fx.calls.filter(value => value[0] === 'getPayout').every(([, , options]) => options.accountId.startsWith('acct_fixtureRecipient')));
  assert.equal(fx.calls.filter(value => value[0] === 'FORBIDDEN_WRITE').length, 0);
});

test('documented Refund/Reversal/BalanceTransaction mode absence is accepted only with linked test Charge; explicit live or wrong refund metadata remains a mismatch', async t => {
  const fx = await setup(t); await fullLifecycle(fx);
  const refund = fx.refunds.get('re_fixtureRefund123'), reversal = fx.reversals.get('trr_fixtureReverse123');
  assert.equal(refund.livemode, undefined); assert.equal(reversal.livemode, undefined); assert.equal(fx.balanceTransaction.livemode, undefined);
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'matched');
  refund.livemode = true;
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'mismatch'); delete refund.livemode;
  const metadata = refund.metadata; refund.metadata = {};
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'mismatch'); refund.metadata = metadata;
  fx.charge.livemode = true;
  const liveCharge = await fx.service.reconcile({ runId: RUN });
  assert.equal(check(liveCharge, `${fx.snapshot.bags[0].id}:stripe_refund_identity_prf_fixtureReturn123`).status, 'mismatch'); fx.charge.livemode = false;
  reversal.livemode = true;
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'mismatch'); delete reversal.livemode;
  fx.balanceTransaction.livemode = true;
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'mismatch'); delete fx.balanceTransaction.livemode;
  assert.equal((await fx.service.reconcile({ runId: RUN })).status, 'matched');
});

test('wrong recipient/source charge, extra reversal or Shopify refund amount cannot masquerade as reconciled money', async t => {
  const fx = await setup(t); await fullLifecycle(fx);
  const bag = fx.snapshot.bags[0], value = fx.details.bags[bag.id];
  fx.transfers.get(value.transferId).destination = 'acct_otherRecipient123';
  fx.transfers.get(value.transferId).amount_reversed = 86;
  fx.orders.get(value.orderId).totalRefundedSet = decimal(107);
  const report = await fx.service.reconcile({ runId: RUN }); assert.equal(report.status, 'mismatch');
  assert.equal(check(report, `${bag.id}:stripe_transfer_identity`).status, 'mismatch');
  assert.equal(check(report, `${bag.id}:stripe_transfer_reversed`).differenceCents, 1);
  assert.equal(check(report, `${bag.id}:shopify_refund_total`).differenceCents, -1);
});

test('pending payout/read failure and unknown provider operations remain pending, preserve lifecycle, and never expose raw errors', async t => {
  const fx = await setup(t); await fullLifecycle(fx);
  const bag = fx.snapshot.bags[0], value = fx.details.bags[bag.id];
  fx.payouts.get(value.payoutId).status = 'pending'; value.payoutOp.status = 'pending';
  value.refundOps.uncertain = { id: 'prf_unknown', stripeStartedAt: new Date().toISOString(), status: 'refund_uncertain' }; await fx.save();
  fx.stripe.getBalance = async () => { throw new Error('sk_test_SECRET PRIVATE_EMAIL'); };
  const result = await fx.service.reconcile({ runId: RUN });
  assert.equal(result.status, 'pending'); assert.equal(result.lifecycleComplete, false); assert.ok(result.pendingCount >= 3);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_EMAIL|sk_test/);
  assert.equal((await fx.db.query('SELECT state FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0].state, 'orders_created');
});

test('wrong/live platform readbacks halt subsequent provider reads and cannot produce matched evidence', async t => {
  const fx = await setup(t); fx.stripe.preflight = async () => ({ verified: true, mode: 'live', accountId: PLATFORM });
  const result = await fx.service.reconcile({ runId: RUN }); assert.equal(result.status, 'mismatch');
  assert.equal(fx.calls.length, 0); assert.equal(check(result, 'stripe_test_account').actual, false);
});

test('nightly uses one encrypted UTC-date/run report and manual rechecks reuse its identity without duplicate unchanged review notices', async t => {
  const fx = await setup(t);
  let result = await fx.service.runNightly(); assert.equal(result.checked, 1); assert.equal(result.reports[0].status, 'matched');
  result = await fx.service.runNightly(); assert.equal(result.checked, 0);
  const first = await fx.service.reconcile({ runId: RUN }); assert.equal((await fx.db.query('SELECT id FROM provider_reconciliation_reports')).rows.length, 1);
  fx.setTime('2026-10-20T00:01:00Z'); result = await fx.service.runNightly(); assert.equal(result.checked, 1);
  assert.notEqual(result.reports[0].id, first.id); assert.equal((await fx.db.query('SELECT id FROM provider_reconciliation_reports')).rows.length, 2);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.reconciliation_review'")).rows.length, 0);
});
