import { createHash, randomUUID } from 'node:crypto';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const number = value => { const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value; return Number.isSafeInteger(parsed) ? parsed : null; };
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{8,}$`).test(value);
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const money = value => {
  const raw = value?.shopMoney;
  if (raw?.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(raw.amount))) return null;
  const [whole, fraction = ''] = String(raw.amount).split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return integer(result) ? result : null;
};
const accountNames = ['stripe_platform_clearing', 'brand_payable', 'commission_revenue', 'tax_payable', 'brand_receivable', 'payment_processing_expense'];
const statusValue = value => ['succeeded', 'pending', 'failed', 'canceled', 'requires_action', 'paid', 'in_transit'].includes(value) ? value : 'unknown';

/**
 * Read-only TEST-provider audit. It never creates/captures/refunds/transfers or
 * pays money and never repairs a ledger. A balanced journal alone is insufficient:
 * each account net and each provider/canonical gross amount is compared in cents.
 * Reports are encrypted and one row is reused per UTC date/run. Provider account
 * balances are observations, not falsely attributed to this run's opening balance.
 */
export async function createProviderReconciliation(db, auth, { unifiedCheckout, stores, getStripe, clock = () => new Date() } = {}) {
  const runtime = unifiedCheckout?.runtime;
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !runtime?.withRun || !runtime?.read || !stores?.forShop || typeof getStripe !== 'function')
    fail('RECONCILIATION_SETUP_REQUIRED', 'Encrypted provider runtime, bound stores and read adapters are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_reconciliation_reports (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,report_date DATE NOT NULL,status TEXT NOT NULL,
    report_encrypted TEXT,lease_token TEXT,lease_until TIMESTAMPTZ,alert_hash TEXT,
    checked_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(run_id,report_date)
  )`);
  const now = () => new Date(clock());

  async function inspect(ctx, report) {
    const { snapshot, details } = ctx;
    const checks = report.checks, expectedLedger = Object.fromEntries(accountNames.map(account => [account, 0]));
    const add = (name, status, values = {}) => checks.push({ name, status, ...values });
    const same = (name, expected, actual) => add(name, actual === expected ? 'matched' : 'mismatch', { expected, actual });
    const cents = (name, expected, actual) => {
      if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(actual)) { add(name, 'pending', { code: 'EXACT_CENT_EVIDENCE_REQUIRED' }); return; }
      add(name, expected === actual ? 'matched' : 'mismatch', { expectedCents: expected, actualCents: actual, differenceCents: actual - expected });
    };
    const read = async (name, action) => {
      try { return await action(); }
      catch { add(name, 'pending', { code: 'PROVIDER_READ_UNAVAILABLE' }); return null; }
    };
    if (details.paymentVerified !== true || !id(details.chargeId, 'ch') || !id(details.paymentIntentId, 'pi')) {
      add('captured_payment', 'pending', { code: 'CAPTURED_PROVIDER_PAYMENT_REQUIRED' }); return;
    }
    const stripe = getStripe();
    const preflight = await read('stripe_test_account', () => stripe.preflight());
    if (!preflight) return;
    const platformVerified = preflight.verified === true && preflight.mode === 'test' && id(preflight.accountId, 'acct') && preflight.accountId === details.accountId;
    same('stripe_test_account', true, platformVerified); if (!platformVerified) return;
    report.stripeAccountId = preflight.accountId; report.chargeId = details.chargeId;
    const charge = await read('stripe_charge_read', () => stripe.getCharge(details.chargeId));
    if (!charge) return;
    const chargeVerified = charge.id === details.chargeId && charge.livemode === false && charge.currency === 'usd'
      && charge.payment_intent === details.paymentIntentId && charge.captured === true && charge.paid === true;
    same('stripe_charge_identity', true, chargeVerified);
    cents('stripe_charge_total', details.amounts?.totalCents, charge.amount);
    const balanceId = typeof charge.balance_transaction === 'string' ? charge.balance_transaction : charge.balance_transaction?.id;
    same('stripe_charge_balance_transaction_id', true, id(balanceId, 'txn') && (!details.chargeBalanceTransactionId || details.chargeBalanceTransactionId === balanceId));
    let fee = null;
    if (id(balanceId, 'txn')) {
      const balance = await read('stripe_charge_balance_transaction_read', () => stripe.getBalanceTransaction(balanceId));
      if (balance) {
        same('stripe_charge_balance_transaction_identity', true, balance.id === balanceId && balance.livemode !== true && balance.currency === 'usd' && balance.source === details.chargeId);
        cents('stripe_charge_balance_gross', charge.amount, balance.amount);
        if (integer(balance.fee)) fee = balance.fee; else add('stripe_processing_fee', 'pending', { code: 'EXACT_FEE_REQUIRED' });
        cents('stripe_charge_balance_net', integer(balance.amount) && fee !== null ? balance.amount - fee : null, balance.net);
      }
    }
    if (typeof stripe.getBalance === 'function') {
      const balance = await read('stripe_platform_balance_read', () => stripe.getBalance());
      if (balance) { same('stripe_platform_balance_test_mode', true, balance.livemode === false); report.balanceObservations.push({ accountId: preflight.accountId,
        availableUsdCents: (balance.available ?? []).filter(value => value.currency === 'usd' && Number.isSafeInteger(value.amount)).reduce((sum, value) => sum + value.amount, 0),
        pendingUsdCents: (balance.pending ?? []).filter(value => value.currency === 'usd' && Number.isSafeInteger(value.amount)).reduce((sum, value) => sum + value.amount, 0),
        runAttribution: 'not_asserted_shared_account' }); }
    } else add('stripe_platform_balance_read', 'pending', { code: 'BALANCE_READER_REQUIRED' });

    const totals = { original: 0, refund: 0, transfer: 0, reversal: 0, commissionRefund: 0, taxRefund: 0, preRecovery: 0, postRecovery: 0 };
    const gross = { stripe_test_payment: { count: snapshot.bags.length, cents: 0 }, provider_processing_fee: { count: fee > 0 ? 1 : 0, cents: fee ?? 0 },
      provider_refund: { count: 0, cents: 0 }, provider_transfer: { count: 0, cents: 0 }, provider_transfer_reversal: { count: 0, cents: 0 } };
    const usedIds = new Set(); let lifecycleComplete = true, unknownMoney = false, unknownRefundTotal = false;
    for (const bag of snapshot.bags) {
      const value = details.bags?.[bag.id], label = bag.id;
      if (!value) { add(`${label}:bag_allocation`, 'pending', { code: 'BAG_ALLOCATION_REQUIRED' }); lifecycleComplete = false; continue; }
      const row = await stores.row(bag.shop);
      same(`${label}:immutable_store_binding`, true, row?.brand_id === bag.brandId);
      const subtotal = bag.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
      cents(`${label}:merchandise`, subtotal, value.subtotalCents);
      cents(`${label}:commission_15_percent`, Math.round(subtotal * .15), value.commissionCents);
      cents(`${label}:shipping`, bag.shippingCents, value.shippingCents);
      cents(`${label}:allocation_total`, value.subtotalCents + value.shippingCents + value.taxCents, value.totalCents);
      cents(`${label}:brand_original_share`, subtotal - value.commissionCents + value.shippingCents, value.transferCents);
      if (![value.totalCents, value.transferCents, value.commissionCents, value.taxCents].every(integer)) {
        add(`${label}:allocation`, 'pending', { code: 'EXACT_ALLOCATION_REQUIRED' }); lifecycleComplete = false; continue;
      }
      totals.original += value.totalCents; gross.stripe_test_payment.cents += value.totalCents;
      expectedLedger.brand_payable -= value.transferCents; expectedLedger.commission_revenue -= value.commissionCents; expectedLedger.tax_payable -= value.taxCents;
      let actualRefund = 0, preRecovery = 0, actualReversal = 0, unknownRefund = false, unknownTransfer = false, unknownReversal = false;
      for (const op of Object.values(value.refundOps ?? {})) {
        if (!op.stripeRefundId) { if (op.stripeStartedAt) { unknownRefund = true; add(`${label}:unknown_refund`, 'pending', { code: 'REFUND_OUTCOME_UNKNOWN' }); } continue; }
        same(`${label}:refund_unique_${op.id}`, false, usedIds.has(op.stripeRefundId)); usedIds.add(op.stripeRefundId);
        const refund = await read(`${label}:stripe_refund_read`, () => stripe.getRefund(op.stripeRefundId));
        if (!refund) { unknownRefund = true; continue; }
        same(`${label}:stripe_refund_identity_${op.id}`, true, chargeVerified && refund.id === op.stripeRefundId && refund.livemode !== true && refund.currency === 'usd'
          && refund.payment_intent === details.paymentIntentId && refund.charge === details.chargeId
          && refund.metadata?.bag_id === bag.id && refund.metadata?.refund_id === op.id);
        cents(`${label}:stripe_refund_amount_${op.id}`, op.amountCents, refund.amount);
        same(`${label}:stripe_refund_saved_status_${op.id}`, statusValue(refund.status), statusValue(op.stripeStatus));
        if (refund.status !== 'succeeded') { unknownRefund = true; add(`${label}:stripe_refund_status_${op.id}`, 'pending', { code: 'REFUND_NOT_SUCCEEDED' }); continue; }
        actualRefund += refund.amount;
        totals.refund += refund.amount; totals.commissionRefund += op.commissionCents; totals.taxRefund += op.taxCents;
        gross.provider_refund.count++; gross.provider_refund.cents += refund.amount;
        if (op.afterTransfer) totals.postRecovery += op.recoveryCents; else { totals.preRecovery += op.recoveryCents; preRecovery += op.recoveryCents; }
        cents(`${label}:refund_components_${op.id}`, op.amountCents, op.recoveryCents + op.commissionCents + op.taxCents);
        if (op.status !== 'complete') add(`${label}:refund_workflow_${op.id}`, 'pending', { code: 'REFUND_OR_RECOVERY_INCOMPLETE' });
        if (op.reversalId) {
          const reversal = await read(`${label}:stripe_reversal_read`, () => stripe.getReversal(value.transferId, op.reversalId));
          if (reversal) {
            same(`${label}:stripe_reversal_identity_${op.id}`, true, reversal.id === op.reversalId && reversal.transfer === value.transferId && reversal.currency === 'usd' && reversal.livemode !== true
              && reversal.metadata?.bag_id === bag.id && reversal.metadata?.refund_id === op.id);
            cents(`${label}:stripe_reversal_amount_${op.id}`, op.recoveryCents, reversal.amount);
            if (integer(reversal.amount)) { actualReversal += reversal.amount; totals.reversal += reversal.amount;
              gross.provider_transfer_reversal.count++; gross.provider_transfer_reversal.cents += reversal.amount; }
          } else unknownReversal = true;
        } else if (op.afterTransfer && op.recoveryCents > 0) { unknownReversal = true; add(`${label}:unrecovered_brand_refund`, 'pending', { code: 'ACTUAL_REVERSAL_REQUIRED' }); }
      }
      cents(`${label}:saved_refund_total`, unknownRefund ? null : actualRefund, value.refundCents ?? 0);
      const transferId = value.transferId ?? value.transferOp?.id; let actualTransfer = null;
      if (transferId) {
        const transfer = await read(`${label}:stripe_transfer_read`, () => stripe.getTransfer(transferId));
        if (transfer) {
          same(`${label}:stripe_transfer_identity`, true, transfer.id === transferId && transfer.livemode === false && transfer.currency === 'usd'
            && transfer.destination === row.connected_account_id && row.connected_account_created_in_test === true
            && transfer.source_transaction === details.chargeId && transfer.transfer_group === `ORD_${snapshot.id}`);
          cents(`${label}:stripe_transfer_amount`, value.transferOp?.amountCents, transfer.amount);
          cents(`${label}:stripe_transfer_reversed`, actualReversal, transfer.amount_reversed);
          if (integer(transfer.amount)) { actualTransfer = transfer.amount; totals.transfer += transfer.amount; gross.provider_transfer.count++; gross.provider_transfer.cents += transfer.amount; }
        } else unknownTransfer = true;
      } else if (value.transferOp?.startedAt) { unknownTransfer = true; add(`${label}:unknown_transfer`, 'pending', { code: 'TRANSFER_OUTCOME_UNKNOWN' }); }
      unknownMoney ||= unknownRefund || unknownTransfer || unknownReversal; unknownRefundTotal ||= unknownRefund;
      const payoutId = value.payoutId ?? value.payoutOp?.id;
      if (payoutId) {
        const payout = await read(`${label}:stripe_payout_read`, () => stripe.getPayout(payoutId, { accountId: row.connected_account_id }));
        if (payout) {
          same(`${label}:stripe_payout_identity`, true, payout.id === payoutId && payout.livemode === false && payout.currency === 'usd'
            && row.connected_account_created_in_test === true && value.payoutOp?.accountId === row.connected_account_id);
          cents(`${label}:stripe_payout_amount`, actualTransfer === null ? null : actualTransfer - actualReversal, payout.amount);
          same(`${label}:stripe_payout_saved_status`, statusValue(payout.status), statusValue(value.payoutOp?.status));
          if (payout.status !== 'paid') { add(`${label}:stripe_payout_status`, 'pending', { code: 'PAYOUT_NOT_PAID' }); lifecycleComplete = false; }
        } else lifecycleComplete = false;
      } else {
        if (actualRefund !== value.totalCents) lifecycleComplete = false;
        if (value.payoutOp?.startedAt) add(`${label}:unknown_payout`, 'pending', { code: 'PAYOUT_OUTCOME_UNKNOWN' });
      }
      if (row?.connected_account_created_in_test === true && id(row.connected_account_id, 'acct') && typeof stripe.getBalance === 'function') {
        const balance = await read(`${label}:connected_balance_read`, () => stripe.getBalance({ accountId: row.connected_account_id }));
        if (balance) { same(`${label}:connected_balance_test_mode`, true, balance.livemode === false); report.balanceObservations.push({ accountId: row.connected_account_id,
          availableUsdCents: (balance.available ?? []).filter(item => item.currency === 'usd' && Number.isSafeInteger(item.amount)).reduce((sum, item) => sum + item.amount, 0),
          pendingUsdCents: (balance.pending ?? []).filter(item => item.currency === 'usd' && Number.isSafeInteger(item.amount)).reduce((sum, item) => sum + item.amount, 0),
          runAttribution: 'not_asserted_shared_recipient' }); }
      }
      if (!value.verified || !value.orderId) add(`${label}:shopify_mapping`, 'pending', { code: 'VERIFIED_ORDER_REQUIRED' });
      else {
        const adapter = await stores.forShop(bag.shop);
        const original = await read(`${label}:shopify_original_read`, () => adapter.getOrderDetails(value.orderId));
        if (original) {
          same(`${label}:shopify_original_identity`, true, original.id === value.orderId && original.test === true && original.sourceIdentifier === bag.id);
          cents(`${label}:shopify_original_total`, value.totalCents, money(original.totalPriceSet));
          cents(`${label}:shopify_original_subtotal`, value.subtotalCents, money(original.subtotalPriceSet));
          cents(`${label}:shopify_original_tax`, value.taxCents, money(original.totalTaxSet));
          cents(`${label}:shopify_original_shipping`, value.shippingCents, money(original.totalShippingPriceSet));
        }
        const order = await read(`${label}:shopify_refunds_read`, () => adapter.getOrderOperations(value.orderId));
        if (order) {
          same(`${label}:shopify_refund_order_identity`, true, order.id === value.orderId && order.test === true && order.currencyCode === 'USD' && order.operationsComplete === true);
          cents(`${label}:shopify_refund_total`, unknownRefund ? null : actualRefund, money(order.totalRefundedSet));
          let summed = 0;
          for (const native of order.refunds ?? []) {
            const op = Object.values(value.refundOps ?? {}).find(item => item.shopifyRefundId === native.id || item.sourceShopifyRefundId === native.id);
            if (!op) add(`${label}:unmapped_native_refund`, 'pending', { code: 'SHOPIFY_REFUND_INGESTION_REQUIRED' });
            else cents(`${label}:shopify_refund_${op.id}`, op.amountCents, money(native.totalRefundedSet));
            const transactions = native.transactions?.nodes;
            if (native.transactions?.pageInfo?.hasNextPage !== false || !Array.isArray(transactions)) add(`${label}:shopify_refund_transactions`, 'pending', { code: 'COMPLETE_REFUND_TRANSACTIONS_REQUIRED' });
            else {
              const successful = transactions.filter(tx => tx.kind === 'REFUND' && tx.status === 'SUCCESS' && tx.test === true && tx.gateway === 'manual');
              const values = successful.map(tx => money(tx.amountSet));
              if (values.some(amount => amount === null)) add(`${label}:shopify_refund_money`, 'pending', { code: 'EXACT_SHOPIFY_USD_REQUIRED' });
              else summed += values.reduce((sum, amount) => sum + amount, 0);
            }
          }
          cents(`${label}:shopify_successful_refund_transactions`, unknownRefund ? null : actualRefund, summed);
        }
      }
      const canonical = (await db.query('SELECT * FROM bags WHERE id=$1 AND order_id=$2 AND brand_id=$3', [bag.id, snapshot.id, bag.brandId])).rows[0];
      if (!canonical) add(`${label}:canonical_bag`, 'mismatch', { code: 'CANONICAL_BAG_MISSING' });
      else for (const [field, expected] of [['subtotal_cents', value.subtotalCents], ['shipping_cents', value.shippingCents], ['tax_cents', value.taxCents],
        ['total_cents', value.totalCents], ['commission_cents', value.commissionCents], ['refunded_cents', unknownRefund ? null : actualRefund]]) cents(`${label}:canonical_${field}`, expected, canonical[field]);
      const canonicalTransfer = (await db.query('SELECT * FROM transfers WHERE bag_id=$1 AND brand_id=$2', [bag.id, bag.brandId])).rows[0];
      if (!canonicalTransfer) add(`${label}:canonical_transfer`, 'mismatch', { code: 'CANONICAL_TRANSFER_MISSING' });
      else {
        cents(`${label}:canonical_transfer_amount`, unknownTransfer || unknownRefund ? null : actualTransfer ?? value.transferCents - preRecovery, canonicalTransfer.amount_cents);
        cents(`${label}:canonical_reversal_amount`, unknownReversal ? null : actualReversal, canonicalTransfer.reversed_cents);
      }
    }
    report.lifecycleComplete = lifecycleComplete;
    cents('bag_total_to_charge', charge.amount, totals.original);
    cents('stripe_charge_refunded', unknownRefundTotal ? null : totals.refund, charge.amount_refunded);
    const canonicalOrder = (await db.query('SELECT * FROM orders WHERE id=$1', [snapshot.id])).rows[0];
    if (!canonicalOrder) add('canonical_order', 'mismatch', { code: 'CANONICAL_ORDER_MISSING' });
    else { cents('canonical_order_total', totals.original, canonicalOrder.total_cents); cents('canonical_order_refunded', unknownRefundTotal ? null : totals.refund, canonicalOrder.refunded_cents); }
    expectedLedger.stripe_platform_clearing = charge.amount - (fee ?? 0) - totals.refund - totals.transfer + totals.reversal;
    expectedLedger.brand_payable += totals.preRecovery + totals.transfer;
    expectedLedger.commission_revenue += totals.commissionRefund; expectedLedger.tax_payable += totals.taxRefund;
    expectedLedger.brand_receivable = totals.postRecovery - totals.reversal; expectedLedger.payment_processing_expense = fee ?? 0;
    const bagIds = snapshot.bags.map(bag => bag.id);
    const journals = (await db.query(`SELECT j.id,j.kind,j.total_debit_cents,j.total_credit_cents,
      COALESCE(SUM(e.debit_cents),0)::bigint AS actual_debit,COALESCE(SUM(e.credit_cents),0)::bigint AS actual_credit
      FROM ledger_journals j LEFT JOIN ledger_entries e ON e.journal_id=j.id WHERE j.bag_id=ANY($1)
      GROUP BY j.id,j.kind,j.total_debit_cents,j.total_credit_cents`, [bagIds])).rows;
    let invalid = 0;
    for (const journal of journals) if (number(journal.actual_debit) !== number(journal.actual_credit)
      || number(journal.actual_debit) !== journal.total_debit_cents || number(journal.actual_credit) !== journal.total_credit_cents) invalid++;
    same('balanced_journals_and_declared_totals', 0, invalid);
    for (const [kind, expected] of Object.entries(gross)) {
      if ((unknownMoney && ['provider_refund', 'provider_transfer', 'provider_transfer_reversal'].includes(kind)) || (kind === 'provider_processing_fee' && fee === null)) {
        add(`journal_gross:${kind}`, 'pending', { code: 'COMPLETE_PROVIDER_MONEY_READBACK_REQUIRED' }); continue;
      }
      const selected = journals.filter(row => row.kind === kind);
      same(`journal_count:${kind}`, expected.count, selected.length);
      cents(`journal_gross:${kind}`, expected.cents, selected.reduce((sum, row) => sum + number(row.actual_debit), 0));
    }
    same('unexpected_journal_kinds', 0, journals.filter(journal => !Object.hasOwn(gross, journal.kind)).length);
    const accounts = (await db.query(`SELECT e.account,SUM(e.debit_cents-e.credit_cents)::bigint AS net
      FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=ANY($1) GROUP BY e.account`, [bagIds])).rows;
    for (const account of accountNames) {
      if (unknownMoney) add(`ledger_net:${account}`, 'pending', { code: 'COMPLETE_PROVIDER_MONEY_READBACK_REQUIRED' });
      else if (fee === null && ['stripe_platform_clearing', 'payment_processing_expense'].includes(account)) add(`ledger_net:${account}`, 'pending', { code: 'ACTUAL_PROCESSING_FEE_REQUIRED' });
      else cents(`ledger_net:${account}`, expectedLedger[account], number(accounts.find(row => row.account === account)?.net ?? 0));
    }
    cents('ledger_unexpected_accounts_absolute_net', 0, accounts.filter(row => !accountNames.includes(row.account)).reduce((sum, row) => sum + Math.abs(number(row.net)), 0));
  }

  async function reconcile({ runId } = {}) {
    await runtime.read(runId);
    const date = now().toISOString().slice(0, 10), token = randomUUID(), reportId = `recon_${createHash('sha256').update(`${date}:${runId}`).digest('hex').slice(0, 32)}`;
    await db.query(`INSERT INTO provider_reconciliation_reports(id,run_id,report_date,status) VALUES($1,$2,$3,'pending') ON CONFLICT DO NOTHING`, [reportId, runId, date]);
    const claimed = (await db.query(`UPDATE provider_reconciliation_reports SET lease_token=$2,lease_until=$3
      WHERE id=$1 AND (lease_token IS NULL OR lease_until<$4) RETURNING *`, [reportId, token, new Date(now().getTime() + 300_000), now()])).rows[0];
    if (!claimed) {
      const prior = (await db.query('SELECT * FROM provider_reconciliation_reports WHERE id=$1', [reportId])).rows[0];
      return prior.report_encrypted ? { ...auth.decrypt(prior.report_encrypted), processing: true } : { id: reportId, runId, date, status: 'pending', processing: true, test: true };
    }
    const report = { id: reportId, runId, date, checkedAt: now().toISOString(), status: 'pending', test: true, checks: [],
      lifecycleComplete: false, balanceObservations: [],
      warnings: ['Read-only provider audit; no repair or replacement money operation was performed.',
        'Shared platform/recipient balances are observations, not proof of this run’s opening balance.',
        'Matched cents describe the observed records; mock-adapter tests are not real-provider acceptance.'] };
    try {
      let executed = false;
      await runtime.withRun(runId, async ctx => {
        executed = true;
        try { await inspect(ctx, report); }
        catch { report.checks.push({ name: 'reconciliation_read', status: 'pending', code: 'RECONCILIATION_READ_REQUIRED' }); }
      });
      if (!executed) report.checks.push({ name: 'run_lease', status: 'pending', code: 'RUN_BUSY' });
      if (!report.checks.length) report.checks.push({ name: 'provider_evidence', status: 'pending', code: 'PROVIDER_READBACK_REQUIRED' });
      report.status = report.checks.some(check => check.status === 'mismatch') ? 'mismatch' : report.checks.some(check => check.status === 'pending') ? 'pending' : 'matched';
    } catch {
      report.checks.push({ name: 'reconciliation', status: 'pending', code: 'RECONCILIATION_REVIEW_REQUIRED' }); report.status = 'pending';
    }
    report.mismatchCount = report.checks.filter(check => check.status === 'mismatch').length;
    report.pendingCount = report.checks.filter(check => check.status === 'pending').length;
    const alertHash = createHash('sha256').update(JSON.stringify({ status: report.status, checks: report.checks.filter(check => check.status !== 'matched') })).digest('hex');
    await db.transaction(async tx => {
      const prior = (await tx.query('SELECT * FROM provider_reconciliation_reports WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
      if (prior.lease_token !== token) return;
      await tx.query(`UPDATE provider_reconciliation_reports SET status=$3,report_encrypted=$4,checked_at=$5,
        alert_hash=$6,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [reportId, token, report.status, auth.encrypt(report), now(), alertHash]);
      if (report.status !== 'matched' && prior.alert_hash !== alertHash) await runtime.emit(tx, 'provider.reconciliation_review', runId, null,
        { reportId, date, status: report.status, mismatchCount: report.mismatchCount, pendingCount: report.pendingCount, sandbox: true });
    });
    return report;
  }
  async function runNightly() {
    const date = now().toISOString().slice(0, 10);
    const rows = (await db.query(`SELECT r.id FROM unified_checkout_runs r LEFT JOIN provider_reconciliation_reports p
      ON p.run_id=r.id AND p.report_date=$1 WHERE r.charge_id IS NOT NULL AND p.checked_at IS NULL ORDER BY r.created_at LIMIT 50`, [date])).rows;
    const reports = [];
    for (const row of rows) reports.push(await reconcile({ runId: row.id }));
    return { date, test: true, checked: reports.length, reports, boundedBatch: 50 };
  }
  return { reconcile, runNightly };
}
