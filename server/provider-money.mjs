import { createHash, randomUUID } from 'node:crypto';
import { stripeTestRecipientContactEmail } from './integrations/stripe.mjs';
import { isShopifyJobId } from './integrations/shopify.mjs';
import { TEST_STORES } from './test-stores.mjs';

const DAY = 86_400_000;
const REFUND_TAX_POLICY = 'shopify_native_refund_v2';
const problem = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, providerMoney: true, unifiedSafe: true });
const fail = (code, message, statusCode) => { throw problem(code, message, statusCode); };
const integer = (value, label, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail('MONEY_INPUT_INVALID', `${label} must be integer cents or a positive quantity.`, 422);
  return value;
};
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('MONEY_INPUT_INVALID', 'A stable operation identifier is required.', 422);
  return value;
};
const providerId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{8,}$`).test(value);
const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
const amount = money => {
  const value = money?.shopMoney;
  if (value?.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(value.amount))) fail('SHOPIFY_REFUND_MISMATCH', 'Shopify money evidence is not exact USD.');
  const [whole, fraction = ''] = String(value.amount).split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'Shopify amount');
};
const credentialLike = value => /(?:sk|rk|pk)_(?:test|live)_|whsec_|bearer|secret/i.test(value);
const providerDiagnostic = cause => {
  const requestId = cause?.details?.requestId ?? cause?.requestId;
  const stripeCode = cause?.details?.stripeCode ?? cause?.stripeCode ?? cause?.code;
  return {
    ...(typeof requestId === 'string' && /^req_[A-Za-z0-9]{1,100}$/.test(requestId) && !credentialLike(requestId) ? { requestId } : {}),
    ...(typeof stripeCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(stripeCode) && !credentialLike(stripeCode) ? { stripeCode } : {}),
  };
};
const safeError = cause => ({ code: typeof cause?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(cause.code) && !credentialLike(cause.code) ? cause.code : 'PROVIDER_MONEY_UNCERTAIN',
  message: cause?.providerMoney ? cause.message : 'Provider outcome requires reconciliation. No replacement money operation was created.', ...providerDiagnostic(cause) });
const recipientFailure = (code, message, cause) => Object.assign(problem(code, message), { details: providerDiagnostic(cause) });
const successfulRefunds = bag => Object.values(bag.refundOps ?? {}).filter(op => op.stripeStatus === 'succeeded');
const unresolved = bag => Object.values(bag.refundOps ?? {}).some(op => op.status !== 'complete');
const refunded = (bag, field) => successfulRefunds(bag).reduce((sum, op) => sum + op[field], 0);
const sameInput = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isoDate = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('DELIVERY_EVIDENCE_REQUIRED', 'Valid delivery and promised payout timestamps are required.');
  return date;
};

/**
 * Actual-provider TEST money orchestration, never a substitute for the sandbox
 * domain. runtime.withRun supplies the durable run lease and encrypted details.
 * Intent is saved before every provider mutation. Unknown results without an ID
 * are held, not retried after an idempotency retention window. Journal/event
 * booking keys commit atomically with canonical state. The host supplies auth,
 * owner approval, the isolated logical clock and verified fulfillment evidence.
 *
 * Per-line tax MUST come from Checkout: details.bags[id].lineTaxCents[sku].
 * shippingTaxCents is an explicit exact allocation, including zero. Checkout's
 * native refund tax reporting is not duplicated with a custom Tax transaction.
 */
export async function createProviderMoney(db, auth, { runtime, stores, getStripe } = {}) {
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !runtime?.withRun || !stores?.row || typeof getStripe !== 'function') {
    fail('PROVIDER_MONEY_SETUP', 'Encrypted runtime, database and bound provider adapters are required.', 503);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS provider_recipient_attempts (
    shop TEXT PRIMARY KEY,brand_id TEXT NOT NULL,platform_account_id TEXT NOT NULL,
    state TEXT NOT NULL,account_id TEXT,started_at TIMESTAMPTZ NOT NULL,last_error JSONB
  )`);
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS retry_requested_at TIMESTAMPTZ');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS retry_provider_request_id TEXT');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS retry_params JSONB');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS parameter_revision INTEGER');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS request_params JSONB');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS previous_revision_id TEXT');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS schedule_started_at TIMESTAMPTZ');
  await db.query('ALTER TABLE provider_recipient_attempts ADD COLUMN IF NOT EXISTS schedule_verified_at TIMESTAMPTZ');
  await db.query(`CREATE TABLE IF NOT EXISTS provider_recipient_revision_history (
    id TEXT PRIMARY KEY,shop TEXT NOT NULL,brand_id TEXT NOT NULL,platform_account_id TEXT NOT NULL,
    record_encrypted TEXT NOT NULL,proof_encrypted TEXT NOT NULL,archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_money_bookings (
    business_key TEXT PRIMARY KEY,run_id TEXT NOT NULL,bag_id TEXT NOT NULL,
    kind TEXT NOT NULL,provider_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL
  )`);
  let automationGuard;
  /** Server-only policy validator, installed by the host after its policy service
   * is constructed. An automated invocation is checked under the money run lease;
   * explicit/manual invocations without a policy retain the existing guards. */
  function setAutomationGuard(guard) {
    if (typeof guard !== 'function') fail('AUTOMATION_GUARD_INVALID', 'A server-side automation policy validator is required.', 422);
    automationGuard = guard;
  }
  async function checkAutomation(ctx, input) {
    if (input.automationPolicyId === undefined) return;
    if (typeof input.automationPolicyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.automationPolicyId)
      || credentialLike(input.automationPolicyId)) fail('AUTOMATION_POLICY_INVALID', 'A valid immutable automation policy identifier is required.', 422);
    if (!automationGuard) fail('AUTOMATION_GUARD_REQUIRED', 'Automation is disabled until its server-side policy validator is installed.');
    try { await automationGuard(ctx, input); }
    catch {
      // Policy failures can contain encrypted-record diagnostics or arbitrary
      // upstream errors. Never promote their message/details into the public run.
      fail('AUTOMATION_POLICY_REJECTED', 'The enabled immutable automation policy did not authorize this money operation. No provider operation was sent.');
    }
  }

  async function stripeFor(snapshot, expectedAccountId) {
    const stripe = getStripe();
    const checked = await stripe.preflight();
    if (checked?.verified !== true || checked.mode !== 'test' || !providerId(checked.accountId, 'acct')
      || ((expectedAccountId ?? snapshot?.stripeAccountId) && (expectedAccountId ?? snapshot?.stripeAccountId) !== checked.accountId))
      fail('STRIPE_TEST_ACCOUNT_REQUIRED', 'Use the same verified real Stripe test platform account.');
    return { stripe, accountId: checked.accountId };
  }
  async function storeRow(bag) {
    const row = await stores.row(bag.shop);
    if (!row || row.brand_id !== bag.brandId) fail('TEST_ACCOUNT_BINDING_REQUIRED', 'The Bag does not belong to this immutable test-store binding.');
    return row;
  }
  async function recipient(bag, stripe) {
    const row = await storeRow(bag);
    if (row.connected_account_created_in_test !== true || !providerId(row.connected_account_id, 'acct'))
      fail('TEST_ACCOUNT_BINDING_REQUIRED', 'A newly created test recipient must be bound to this store.');
    const attempt = (await db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [bag.shop])).rows[0];
    if (attempt?.parameter_revision === 3) await readV2Recipient(stripe, attempt, bag.brandId);
    const raw = await stripe.getTestConnectedAccount(row.connected_account_id);
    const checked = await stores.verifyConnectedAccount(bag.shop, raw);
    if (checked.ready !== true || raw.id !== row.connected_account_id || raw.metadata?.brand_id !== bag.brandId
      || raw.metadata?.integration !== 'avafem' || raw.capabilities?.transfers !== 'active' || raw.payouts_enabled !== true)
      fail('TEST_RECIPIENT_NOT_READY', 'Complete test Express onboarding before releasing brand money.');
    return raw.id;
  }
  function bagFor(ctx, bagId) {
    const bag = ctx.snapshot.bags?.find(item => item.id === bagId);
    const detail = ctx.details.bags?.[bagId];
    if (!bag || !detail) fail('BAG_NOT_FOUND', 'Bag not found in this checkout.', 404);
    if (ctx.snapshot.currency !== 'USD' || bag.commissionBps !== 1500 || detail.verified !== true || !detail.orderId)
      fail('PROVIDER_ORDER_REQUIRED', 'A verified USD provider Bag at the accepted 15% commission is required.');
    const subtotal = bag.items.reduce((sum, item) => sum + integer(item.qty, 'Original quantity', 1) * integer(item.unitPriceCents, 'Original unit price', 1), 0);
    if (!subtotal || subtotal !== detail.subtotalCents || detail.shippingCents !== bag.shippingCents
      || detail.commissionCents !== Math.round(subtotal * .15)
      || detail.transferCents !== subtotal - detail.commissionCents + detail.shippingCents
      || detail.totalCents !== subtotal + integer(detail.shippingCents, 'Shipping') + integer(detail.taxCents, 'Tax'))
      fail('BAG_MONEY_MISMATCH', 'Immutable Bag amounts and 15% merchandise commission must reconcile before provider money operations.');
    return { bag, detail };
  }
  function requirePayment(ctx) {
    if (ctx.details.paymentVerified !== true || !providerId(ctx.details.paymentIntentId, 'pi') || !providerId(ctx.details.chargeId, 'ch'))
      fail('CAPTURED_PAYMENT_REQUIRED', 'A provider-verified captured test payment is required.');
  }
  async function booking(ctx, bag, key, kind, provider, entries, mutation, eventType, payload = {}) {
    await db.transaction(async tx => {
      const inserted = await tx.query(`INSERT INTO provider_money_bookings(business_key,run_id,bag_id,kind,provider_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING business_key`,
      [key, ctx.snapshot.id, bag.id, kind, provider, ctx.wallNow()]);
      if (!inserted.rows.length) return;
      if (entries?.some(entry => entry.debitCents || entry.creditCents)) await ctx.journal(tx, key, kind, bag, entries);
      if (mutation) await mutation(tx);
      if (eventType) await ctx.emit(tx, eventType, bag.id, bag.brandId, { ...payload, providerId: provider, sandbox: true,
        logicalAt: ctx.now().toISOString(), providerRecordedAt: ctx.wallNow().toISOString() });
    });
  }
  async function bookProcessingFee(ctx, stripe) {
    if (ctx.details.processingFeeRecorded || !ctx.details.chargeBalanceTransactionId) return;
    const transaction = await stripe.getBalanceTransaction(ctx.details.chargeBalanceTransactionId);
    if (transaction.id !== ctx.details.chargeBalanceTransactionId || transaction.livemode === true || transaction.source !== ctx.details.chargeId
      || transaction.currency !== 'usd' || transaction.amount !== ctx.details.amounts?.totalCents
      || !Number.isSafeInteger(transaction.fee) || transaction.fee < 0 || transaction.net !== transaction.amount - transaction.fee)
      fail('STRIPE_FEE_MISMATCH', 'Actual charge fee and balance transaction must reconcile to the captured checkout.');
    const bag = ctx.snapshot.bags[0];
    await booking(ctx, bag, `provider-fee:${ctx.snapshot.id}`, 'provider_processing_fee', transaction.id,
      [debit('payment_processing_expense', transaction.fee), credit('stripe_platform_clearing', transaction.fee)], null,
      'payment.fee_recorded', { feeCents: transaction.fee });
    ctx.details.processingFeeCents = transaction.fee; ctx.details.processingFeeRecorded = true; await ctx.save();
  }
  async function eligible(ctx, bag, detail) {
    if (detail.fullyDelivered !== true || !detail.deliveredAt) fail('DELIVERY_EVIDENCE_REQUIRED', 'Every remaining item must be delivered before the return-window hold starts.');
    const row = await storeRow(bag);
    const days = Math.max(30, integer(bag.returnWindowDays ?? 30, 'Snapshot return window'), integer(row.return_window_days ?? 30, 'Current return window'));
    const due = new Date(Math.max(isoDate(detail.deliveredAt).getTime() + days * DAY,
      detail.payoutDueAt ? isoDate(detail.payoutDueAt).getTime() : 0));
    if (detail.payoutDueAt !== due.toISOString()) { detail.payoutDueAt = due.toISOString(); await ctx.save(); }
    if (ctx.now() < due) fail('RETURN_WINDOW_OPEN', 'The full promised delivery-based return window has not elapsed in this isolated test run.');
    if (unresolved(detail)) fail('REFUND_PENDING', 'An unfinished refund or recovery holds settlement and external payouts.');
    return due;
  }
  async function verifyTransfer(ctx, bag, detail, stripe) {
    const op = detail.transferOp;
    if (!providerId(op?.id ?? detail.transferId, 'tr')) fail('TRANSFER_UNCERTAIN', 'Transfer outcome has no provider ID; reconcile manually before another create.');
    const transfer = await stripe.getTransfer(op?.id ?? detail.transferId);
    if (transfer.livemode !== false || transfer.id !== (op?.id ?? detail.transferId) || transfer.amount !== op?.amountCents
      || transfer.currency !== 'usd' || transfer.destination !== op.accountId || transfer.source_transaction !== ctx.details.chargeId
      || transfer.transfer_group !== `ORD_${ctx.snapshot.id}`)
      fail('STRIPE_TRANSFER_MISMATCH', 'Actual transfer does not match the authorized Bag, source charge and recipient.');
    detail.transferId = transfer.id; op.status = 'verified';
    await ctx.save();
    await booking(ctx, bag, `provider-transfer:${bag.id}`, 'provider_transfer', transfer.id,
      [debit('brand_payable', op.amountCents), credit('stripe_platform_clearing', op.amountCents)],
      tx => tx.query("UPDATE transfers SET amount_cents=$2,status='paid',paid_at=$3 WHERE bag_id=$1", [bag.id, op.amountCents, ctx.wallNow()]),
      'transfer.created', { amountCents: op.amountCents, sourceChargeId: ctx.details.chargeId, accountId: op.accountId });
    return transfer;
  }
  async function bookRefund(ctx, bag, detail, op) {
    await booking(ctx, bag, `provider-refund:${op.id}`, 'provider_refund', op.stripeRefundId,
      [debit(op.afterTransfer ? 'brand_receivable' : 'brand_payable', op.recoveryCents), debit('commission_revenue', op.commissionCents),
        debit('tax_payable', op.taxCents), credit('stripe_platform_clearing', op.amountCents)],
      async tx => {
        await tx.query(`INSERT INTO refunds(id,bag_id,brand_id,amount_cents,reason,status,approved_at,created_at,subtotal_cents,shipping_cents,tax_cents,commission_cents)
          VALUES($1,$2,$3,$4,'Explicit owner-approved actual provider TEST refund','approved',$5,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [op.id, bag.id, bag.brandId, op.amountCents, ctx.wallNow(), op.subtotalCents, op.shippingCents, op.taxCents, op.commissionCents]);
        await tx.query(`UPDATE bags SET refunded_cents=refunded_cents+$2,
          status=CASE WHEN refunded_cents+$2=total_cents THEN 'refunded' ELSE status END,updated_at=$3 WHERE id=$1`, [bag.id, op.amountCents, ctx.wallNow()]);
        await tx.query(`UPDATE orders SET refunded_cents=refunded_cents+$2,
          status=CASE WHEN refunded_cents+$2=total_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=(SELECT order_id FROM bags WHERE id=$1)`, [bag.id, op.amountCents]);
        if (!op.afterTransfer) await tx.query(`UPDATE transfers SET amount_cents=amount_cents-$2,
          status=CASE WHEN amount_cents-$2=0 THEN 'cancelled' ELSE 'held' END WHERE bag_id=$1`, [bag.id, op.recoveryCents]);
      }, 'refund.issued', { refundId: op.id, amountCents: op.amountCents, taxCents: op.taxCents, commissionCents: op.commissionCents,
        recoveryCents: op.recoveryCents, afterTransfer: op.afterTransfer });
  }
  async function verifyStripeRefund(ctx, bag, detail, op, stripe) {
    if (!providerId(op.stripeRefundId, 're')) fail('REFUND_UNCERTAIN', 'Refund outcome has no provider ID; manual reconciliation is required.');
    const refund = await stripe.getRefund(op.stripeRefundId);
    // Refund has no documented livemode attribute. Prove test mode through its
    // freshly retrieved original Charge rather than inventing a Refund field.
    const charge = await stripe.getCharge(ctx.details.chargeId);
    if (refund.id !== op.stripeRefundId || refund.livemode === true || refund.amount !== op.amountCents || refund.currency !== 'usd'
      || refund.payment_intent !== ctx.details.paymentIntentId || refund.charge !== ctx.details.chargeId
      || refund.metadata?.bag_id !== bag.id || refund.metadata?.refund_id !== op.id
      || charge?.id !== ctx.details.chargeId || charge.livemode !== false || charge.payment_intent !== ctx.details.paymentIntentId
      || charge.currency !== 'usd' || charge.amount !== ctx.details.amounts?.totalCents || charge.captured !== true || charge.paid !== true
      || (refund.status === 'succeeded' && (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < refund.amount)))
      fail('STRIPE_REFUND_MISMATCH', 'Actual shopper refund does not match this captured checkout and authorized amount.');
    op.stripeStatus = refund.status;
    if (refund.status !== 'succeeded') {
      op.status = refund.status === 'failed' || refund.status === 'canceled' ? 'refund_failed' : 'refund_pending';
      await ctx.save(); return false;
    }
    op.status = 'shopify_pending'; detail.refundCents = refunded(detail, 'amountCents');
    await ctx.save(); await bookRefund(ctx, bag, detail, op); return true;
  }
  function validShopifyRefund(refund, op, order) {
    if (!refund || amount(refund.totalRefundedSet) !== op.amountCents) return false;
    const transactions = refund.transactions?.nodes ?? refund.transactions ?? [];
    const lines = refund.refundLineItems?.nodes;
    const shipping = refund.refundShippingLines?.nodes;
    if (!Array.isArray(lines) || refund.refundLineItems.pageInfo?.hasNextPage !== false
      || !Array.isArray(shipping) || refund.refundShippingLines.pageInfo?.hasNextPage !== false
      || lines.length !== op.lineItems.length || lines.some(line => !op.lineItems.some(expected =>
        expected.lineItemId === line.lineItem?.id && expected.qty === line.quantity
        && expected.subtotalCents === amount(line.subtotalSet) && expected.taxCents === amount(line.totalTaxSet)))
      || shipping.reduce((sum, line) => sum + amount(line.subtotalAmountSet), 0) !== op.shippingCents
      || shipping.reduce((sum, line) => sum + amount(line.taxAmountSet), 0) !== op.shippingTaxCents) return false;
    return transactions.some(tx => tx.kind === 'REFUND' && tx.status === 'SUCCESS' && tx.test === true && tx.gateway === 'manual'
      && tx.parentTransaction?.id === op.parentTransactionId && amount(tx.amountSet) === op.amountCents)
      && op.lineItems.every(line => order.lineItems.nodes.some(item => item.id === line.lineItemId && item.sku === line.sku));
  }
  async function finishRefund(ctx, bag, detail, op, stripe) {
    if (!await verifyStripeRefund(ctx, bag, detail, op, stripe)) return;
    const shopify = await stores.forShop(bag.shop);
    let order = await shopify.getOrderOperations(detail.orderId);
    if (order?.id !== detail.orderId || order.test !== true || order.currencyCode !== 'USD' || order.operationsComplete !== true) fail('SHOPIFY_REFUND_REVIEW', 'Complete verified test-order refund readback is required.');
    let recorded = (order.refunds ?? []).find(item => item.id === op.shopifyRefundId || item.note === `AVAFEM TEST MANUAL REFUND / ${op.id}`);
    if (!recorded && !op.shopifyStartedAt && !op.sourceShopifyRefundId) {
      op.shopifyStartedAt = ctx.wallNow().toISOString(); await ctx.save();
      try {
        const result = await shopify.createManualRefund({ orderId: detail.orderId, operationId: op.id,
          lineItems: op.lineItems.map(({ lineItemId, qty }) => ({ lineItemId, qty, restockType: 'NO_RESTOCK' })),
          amountCents: op.amountCents, shippingCents: op.shippingCents, parentTransactionId: op.parentTransactionId });
        op.shopifyRefundId = result.refund?.id;
        await ctx.save();
      } catch (cause) { op.status = 'shopify_uncertain'; op.lastError = safeError(cause); await ctx.save(); return; }
      order = await shopify.getOrderOperations(detail.orderId);
      recorded = (order?.refunds ?? []).find(item => item.id === op.shopifyRefundId || item.note === `AVAFEM TEST MANUAL REFUND / ${op.id}`);
    }
    if (!validShopifyRefund(recorded, op, order)) { op.status = 'shopify_uncertain'; await ctx.save(); return; }
    op.shopifyRefundId = recorded.id; op.shopifyVerified = true; await ctx.save();
    if (op.afterTransfer && op.recoveryCents > 0) {
      if (!op.reversalId && !op.reversalStartedAt) {
        op.reversalStartedAt = ctx.wallNow().toISOString(); await ctx.save();
        try {
          const reversal = await stripe.createReversal({ transferId: detail.transferId, amountCents: op.recoveryCents, refundId: op.id, bagId: bag.id });
          op.reversalId = reversal.id; await ctx.save();
        } catch (cause) { op.status = 'recovery_uncertain'; op.unrecoveredCents = op.recoveryCents; op.lastError = safeError(cause); await ctx.save(); return; }
      }
      if (!op.reversalId) { op.status = 'recovery_uncertain'; op.unrecoveredCents = op.recoveryCents; await ctx.save(); return; }
      const reversal = await stripe.getReversal(detail.transferId, op.reversalId);
      if (reversal.id !== op.reversalId || reversal.livemode === true || reversal.transfer !== detail.transferId || reversal.amount !== op.recoveryCents || reversal.currency !== 'usd'
        || reversal.metadata?.bag_id !== bag.id || reversal.metadata?.refund_id !== op.id)
        fail('STRIPE_REVERSAL_MISMATCH', 'Actual reversal does not match this brand transfer and refund share.');
      await booking(ctx, bag, `provider-reversal:${op.id}`, 'provider_transfer_reversal', reversal.id,
        [debit('stripe_platform_clearing', op.recoveryCents), credit('brand_receivable', op.recoveryCents)],
        tx => tx.query(`UPDATE transfers SET reversed_cents=reversed_cents+$2,
          status=CASE WHEN reversed_cents+$2=amount_cents THEN 'reversed' ELSE 'paid' END WHERE bag_id=$1`, [bag.id, op.recoveryCents]),
        'transfer.reversed', { refundId: op.id, amountCents: op.recoveryCents, transferId: detail.transferId });
      op.unrecoveredCents = 0; op.reversalVerified = true;
    }
    op.status = 'complete'; await ctx.save();
  }

  function planRefund(ctx, bag, detail, input, order, { native = false, allowShippingOnly = false } = {}) {
    if (!Array.isArray(input.items) || (!input.items.length && !allowShippingOnly) || input.items.length > 20) fail('REFUND_INPUT_INVALID', 'Explicit refund SKU quantities are required.', 422);
    const requested = input.items.map(line => ({ sku: line.sku, qty: integer(line.qty, 'Refund quantity', 1) })).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    if (new Set(requested.map(line => line.sku)).size !== requested.length) fail('REFUND_INPUT_INVALID', 'Duplicate refund SKUs are not allowed.', 422);
    if (input.refundShipping !== undefined && typeof input.refundShipping !== 'boolean') fail('REFUND_INPUT_INVALID', 'refundShipping must be boolean.', 422);
    const prior = successfulRefunds(detail);
    const used = sku => prior.reduce((sum, op) => sum + (op.items.find(line => line.sku === sku)?.qty ?? 0), 0);
    let subtotal = 0;
    const lineItems = requested.map(line => {
      const original = bag.items.find(item => item.sku === line.sku);
      if (!original || line.qty + used(line.sku) > original.qty) fail('REFUND_QUANTITY_EXCEEDED', 'Refund exceeds this Bag SKU remainder.');
      subtotal += integer(original.unitPriceCents, 'Unit price') * line.qty;
      const lineTax = detail.lineTaxCents?.[line.sku];
      if (!Number.isSafeInteger(lineTax) || lineTax < 0) fail('AUTHORITATIVE_TAX_REQUIRED', 'Exact Checkout line-tax evidence is required for quantity refunds.');
      const providerLine = order.lineItems.nodes.find(item => item.sku === line.sku && item.variant?.id === original.variantId);
      if (!providerLine || (!native && providerLine.refundableQuantity < line.qty)) fail('SHOPIFY_REFUND_MISMATCH', 'Shopify SKU/variant refundable quantities do not match this Bag.');
      return { sku: line.sku, lineItemId: providerLine.id, qty: line.qty, subtotalCents: original.unitPriceCents * line.qty, taxCents: null };
    });
    const allReturned = bag.items.every(item => used(item.sku) + (requested.find(line => line.sku === item.sku)?.qty ?? 0) === item.qty);
    const shipping = input.refundShipping === true ? integer(detail.shippingCents, 'Original shipping') : 0;
    if (input.refundShipping && (!allReturned || prior.some(op => op.refundShipping))) fail('REFUND_SHIPPING_INVALID', 'Shipping can only be refunded once, with the final returned quantity.');
    if (input.refundShipping) integer(detail.shippingTaxCents, 'Authoritative shipping tax');
    const priorSubtotal = prior.reduce((sum, op) => sum + op.subtotalCents, 0);
    const commission = Math.round(detail.commissionCents * (priorSubtotal + subtotal) / detail.subtotalCents)
      - Math.round(detail.commissionCents * priorSubtotal / detail.subtotalCents);
    if (integer(subtotal + shipping, 'Refund subtotal', 1) + refunded(detail, 'amountCents') > detail.totalCents) fail('REFUND_AMOUNT_EXCEEDED', 'Refund exceeds this Bag total remainder.');
    const parent = order.transactions.find(tx => ['SALE', 'CAPTURE'].includes(tx.kind) && tx.status === 'SUCCESS' && tx.test === true
      && tx.gateway === 'manual' && tx.manualPaymentGateway === true && amount(tx.amountSet) === detail.totalCents);
    if (!parent) fail('SHOPIFY_REFUND_MISMATCH', 'Original verified test manual payment is required.');
    return { id: `prf_${createHash('sha256').update(`${ctx.snapshot.id}:${bag.id}:${input.operationId}`).digest('hex').slice(0, 32)}`,
      input: { items: requested, refundShipping: input.refundShipping === true }, items: requested, lineItems,
      refundShipping: input.refundShipping === true, amountCents: null, subtotalCents: subtotal, shippingCents: shipping,
      shippingTaxCents: null, taxCents: null, taxPolicy: REFUND_TAX_POLICY, taxAllocationFrozen: false,
      commissionCents: integer(commission, 'Refund commission'), recoveryCents: integer(subtotal - commission + shipping, 'Brand refund share'),
      parentTransactionId: parent.id, afterTransfer: Boolean(detail.transferId), status: 'awaiting_native_preview', createdAt: ctx.wallNow().toISOString() };
  }
  function validateNativeAllocation(bag, detail, op, quote) {
    const prior = successfulRefunds(detail).filter(value => value.id !== op.id);
    const lines = quote.lineItems;
    if (!Array.isArray(lines) || lines.length !== op.lineItems.length || new Set(lines.map(line => line.lineItemId)).size !== lines.length
      || quote.subtotalCents !== op.subtotalCents || quote.shippingCents !== op.shippingCents)
      fail('SHOPIFY_REFUND_PREVIEW_MISMATCH', 'Native refund quantities, merchandise or shipping do not match the requested frozen Bag.');
    let originalTax = integer(detail.shippingTaxCents, 'Original shipping tax');
    for (const original of bag.items) originalTax += integer(detail.lineTaxCents?.[original.sku], 'Original Checkout line tax');
    if (originalTax !== detail.taxCents) fail('AUTHORITATIVE_TAX_REQUIRED', 'The immutable Checkout line and shipping tax must sum to the original Bag tax.');
    const allocated = lines.map(line => {
      const requested = op.lineItems.find(value => value.lineItemId === line.lineItemId);
      const original = requested && bag.items.find(value => value.sku === requested.sku);
      if (!requested || !original || line.qty !== requested.qty || line.subtotalCents !== requested.subtotalCents)
        fail('SHOPIFY_REFUND_PREVIEW_MISMATCH', 'Native refund line identity, quantity or merchandise does not match.');
      integer(line.taxCents, 'Native line refund tax');
      const usedQty = prior.reduce((sum, value) => sum + (value.items.find(item => item.sku === requested.sku)?.qty ?? 0), 0);
      const usedTax = prior.reduce((sum, value) => sum + value.lineItems.filter(item => item.sku === requested.sku).reduce((n, item) => n + integer(item.taxCents, 'Previously refunded native tax'), 0), 0);
      const remainingQty = original.qty - usedQty, remainingTax = detail.lineTaxCents[requested.sku] - usedTax;
      if (remainingQty < line.qty || remainingTax < 0 || line.taxCents > remainingTax)
        fail('REFUND_TAX_REMAINDER_EXCEEDED', 'Native refund exceeds the original Checkout line quantity or remaining tax.');
      if (line.qty === remainingQty && line.taxCents !== remainingTax)
        fail('REFUND_TAX_RESIDUAL', 'The final native line refund does not return the exact original tax remainder. No Stripe refund was sent.');
      return { ...requested, taxCents: line.taxCents };
    });
    const shippingTax = integer(quote.shippingTaxCents, 'Native shipping refund tax');
    const remainingShippingTax = detail.shippingTaxCents - prior.reduce((sum, value) => sum + integer(value.shippingTaxCents, 'Previously refunded shipping tax'), 0);
    if (remainingShippingTax < 0 || shippingTax > remainingShippingTax || (!op.refundShipping && shippingTax !== 0))
      fail('REFUND_TAX_REMAINDER_EXCEEDED', 'Native shipping refund exceeds its original remaining tax.');
    if (op.refundShipping && shippingTax !== remainingShippingTax)
      fail('REFUND_TAX_RESIDUAL', 'The final native shipping refund does not return the exact original shipping-tax remainder. No Stripe refund was sent.');
    const tax = allocated.reduce((sum, line) => sum + line.taxCents, shippingTax);
    const total = integer(op.subtotalCents + op.shippingCents + tax, 'Native refund total', 1);
    if (quote.taxCents !== tax || quote.amountCents !== total)
      fail('SHOPIFY_REFUND_PREVIEW_MISMATCH', 'Native refund total and line/shipping tax components must agree exactly.');
    if (total + prior.reduce((sum, value) => sum + value.amountCents, 0) > detail.totalCents
      || tax + prior.reduce((sum, value) => sum + value.taxCents, 0) > detail.taxCents)
      fail('REFUND_AMOUNT_EXCEEDED', 'Native refund exceeds this Bag original monetary remainder.');
    return { lineItems: allocated.sort((a, b) => a.sku.localeCompare(b.sku)), taxCents: tax, shippingTaxCents: shippingTax, amountCents: total };
  }
  function previewAllocation(bag, detail, op, preview) {
    const lines = preview?.refundLineItems;
    if (preview?.orderId !== detail.orderId || preview.shop !== bag.shop || preview.operationsComplete !== true
      || !Array.isArray(lines) || lines.some(line => line.restockType !== 'NO_RESTOCK')
      || amount(preview.discountedSubtotalSet) !== op.subtotalCents || amount(preview.totalDutiesSet) !== 0
      || amount(preview.totalCartDiscountAmountSet) !== 0)
      fail('SHOPIFY_REFUND_PREVIEW_MISMATCH', 'Complete native test-order refund evidence with no discounts or duties is required.');
    const allocation = validateNativeAllocation(bag, detail, op, { subtotalCents: amount(preview.subtotalSet),
      shippingCents: amount(preview.shipping?.amountSet), shippingTaxCents: amount(preview.shipping?.taxSet),
      taxCents: amount(preview.totalTaxSet), amountCents: amount(preview.amountSet),
      lineItems: lines.map(line => ({ lineItemId: line.lineItem?.id, qty: line.quantity, subtotalCents: amount(line.subtotalSet), taxCents: amount(line.totalTaxSet) })) });
    if (amount(preview.maximumRefundableSet) < allocation.amountCents || amount(preview.shipping?.maximumRefundableSet) < op.shippingCents)
      fail('REFUND_AMOUNT_EXCEEDED', 'Native refund exceeds the provider remaining refundable amount.');
    return allocation;
  }
  function freezeAllocation(ctx, op, allocation) {
    Object.assign(op, allocation, { taxPolicy: REFUND_TAX_POLICY, taxAllocationFrozen: true, allocationFrozenAt: ctx.wallNow().toISOString(), status: 'native_quote_frozen' });
  }
  async function verifyNativeRefundPreview(ctx, bag, detail, op) {
    // A Shopify-origin refund has already consumed its refundable quantities.
    // Its original, complete native refund is the evidence, not a new preview.
    if (op.sourceShopifyRefundId) {
      const order = await readOrder(bag, detail);
      const native = order.refunds?.find(value => value.id === op.sourceShopifyRefundId);
      if (!validShopifyRefund(native, op, order)) fail('SHOPIFY_REFUND_MISMATCH', 'The original native Shopify refund no longer matches the frozen refund allocation.');
      return;
    }
    const shopify = await stores.forShop(bag.shop);
    if (typeof shopify.getSuggestedRefund !== 'function') fail('SHOPIFY_REFUND_PREVIEW_REQUIRED', 'Authoritative native refund preview is required before any Stripe refund.');
    const preview = await shopify.getSuggestedRefund({ orderId: detail.orderId,
      lineItems: op.lineItems.map(line => ({ lineItemId: line.lineItemId, quantity: line.qty })), shippingAmountCents: op.shippingCents });
    const allocation = previewAllocation(bag, detail, op, preview);
    if (op.taxPolicy === REFUND_TAX_POLICY && op.taxAllocationFrozen === false) freezeAllocation(ctx, op, allocation);
    else if (allocation.amountCents !== op.amountCents || allocation.taxCents !== op.taxCents || allocation.shippingTaxCents !== op.shippingTaxCents
      || !sameInput(allocation.lineItems, op.lineItems))
      fail('SHOPIFY_REFUND_PREVIEW_MISMATCH', 'Native Shopify refund rounding, quantities, tax or shipping differs from the frozen Checkout allocation. No Stripe refund was sent.');
    op.nativePreview = { verifiedAt: ctx.wallNow().toISOString(), amountCents: op.amountCents, taxCents: op.taxCents,
      shippingCents: op.shippingCents, shippingTaxCents: op.shippingTaxCents,
      lines: op.lineItems.map(({ lineItemId, qty, subtotalCents, taxCents }) => ({ lineItemId, qty, subtotalCents, taxCents })) };
    delete op.lastError;
    await ctx.save();
  }
  async function applyRefund(ctx, bag, detail, stripe, op) {
    if (!op.stripeRefundId) {
      if (op.stripeStartedAt) { op.status = 'refund_uncertain'; await ctx.save(); return; }
      try { await verifyNativeRefundPreview(ctx, bag, detail, op); }
      catch (cause) {
        op.status = 'native_preview_review'; op.lastError = safeError(cause); await ctx.save();
        if (cause?.providerMoney) throw cause;
        throw problem('SHOPIFY_REFUND_PREVIEW_REQUIRED', 'Native Shopify refund preview could not be verified. No Stripe refund was sent.');
      }
      op.stripeStartedAt = ctx.wallNow().toISOString(); op.status = 'refund_started'; await ctx.save();
      try {
        const created = await stripe.createRefund({ paymentIntentId: ctx.details.paymentIntentId, amountCents: op.amountCents, bagId: bag.id, refundId: op.id });
        if (!providerId(created.id, 're')) fail('STRIPE_REFUND_MISMATCH', 'Stripe did not return a refund identifier.');
        op.stripeRefundId = created.id; await ctx.save();
      } catch (cause) { op.status = 'refund_uncertain'; op.lastError = safeError(cause); await ctx.save(); return; }
    }
    await finishRefund(ctx, bag, detail, op, stripe);
  }
  function canStartRefund(detail) {
    if (unresolved(detail) || (detail.transferOp && detail.transferOp.status !== 'verified')) fail('REFUND_PENDING', 'Resolve prior refund/transfer uncertainty before a new refund.');
    if (detail.payoutId || detail.payoutOp?.startedAt) fail('PAYOUT_ALREADY_STARTED', 'Refund after an external payout requires separate manual recovery review.');
  }
  async function readOrder(bag, detail) {
    const order = await (await stores.forShop(bag.shop)).getOrderOperations(detail.orderId);
    if (order?.id !== detail.orderId || order.test !== true || order.operationsComplete !== true || order.currencyCode !== 'USD')
      fail('SHOPIFY_REFUND_REVIEW', 'A complete verified Shopify test order is required.');
    return order;
  }
  async function refund(input) {
    identifier(input.operationId);
    return runtime.withRun(input.runId, async ctx => {
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, input.bagId);
      await storeRow(bag); const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId);
      await bookProcessingFee(ctx, stripe);
      detail.refundOps ??= {};
      let op = detail.refundOps[input.operationId];
      if (op) {
        const normalized = { items: [...(input.items ?? [])].map(line => ({ sku: line.sku, qty: line.qty })).sort((a, b) => String(a.sku).localeCompare(String(b.sku))), refundShipping: input.refundShipping === true };
        if (!sameInput(op.input, normalized)) fail('OPERATION_REUSED', 'This refund operation ID is immutable.');
        if (op.status === 'complete') return;
      } else {
        canStartRefund(detail);
        const order = await readOrder(bag, detail);
        op = planRefund(ctx, bag, detail, input, order); detail.refundOps[input.operationId] = op;
        await ctx.save();
      }
      await applyRefund(ctx, bag, detail, stripe, op);
    });
  }

  /** Explicit owner correction of an OLD, never-dispatched proportional-tax
   * proposal. This method only archives/requotes. It never sends a refund. */
  async function reviseRefundProposal({ runId, bagId, operationId, confirmNoProviderWrites } = {}) {
    identifier(operationId);
    if (confirmNoProviderWrites !== true) fail('REFUND_REVISION_CONFIRMATION_REQUIRED', 'Explicit confirmation of the never-dispatched proposal review is required.', 422);
    return runtime.withRun(runId, async ctx => {
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, bagId); await storeRow(bag);
      const op = detail.refundOps?.[operationId];
      const hasWrite = value => ['stripeStartedAt', 'stripeRefundId', 'shopifyStartedAt', 'shopifyRefundId', 'sourceShopifyRefundId', 'reversalStartedAt', 'reversalId']
        .some(key => value[key] !== undefined && value[key] !== null) || value.stripeStatus != null || value.reversalVerified === true;
      if (!op || op.status !== 'native_preview_review' || op.taxPolicy === REFUND_TAX_POLICY || hasWrite(op)
        || op.proposalRevisions?.length) fail('REFUND_REVISION_UNSENT_REQUIRED', 'Only the original held, never-dispatched legacy tax proposal may be revised once.');
      for (const value of Object.values(ctx.details.bags).flatMap(value => Object.values(value.refundOps ?? {}))) {
        if (value.stripeStartedAt && (!value.stripeRefundId || value.stripeStatus !== 'succeeded'))
          fail('REFUND_REVISION_PROVIDER_PROOF_REQUIRED', 'Resolve every unknown run refund before changing a monetary proposal.');
      }
      const keys = [`provider-refund:${op.id}`, `provider-reversal:${op.id}`];
      const bookings = (await db.query('SELECT business_key FROM provider_money_bookings WHERE business_key=ANY($1)', [keys])).rows;
      const journals = (await db.query('SELECT id FROM ledger_journals WHERE business_key=ANY($1)', [keys])).rows;
      const canonical = (await db.query('SELECT id FROM refunds WHERE id=$1', [op.id])).rows;
      if (bookings.length || journals.length || canonical.length) fail('REFUND_REVISION_UNSENT_REQUIRED', 'Existing money booking, journal or canonical refund makes this proposal immutable.');
      const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId);
      const actualCharge = await stripe.getCharge(ctx.details.chargeId);
      const knownRefunds = Object.values(ctx.details.bags).reduce((sum, value) => sum + refunded(value, 'amountCents'), 0);
      if (actualCharge?.id !== ctx.details.chargeId || actualCharge.livemode !== false || actualCharge.payment_intent !== ctx.details.paymentIntentId
        || actualCharge.currency !== 'usd' || actualCharge.amount !== ctx.details.amounts.totalCents
        || !Number.isSafeInteger(actualCharge.amount_refunded) || actualCharge.amount_refunded !== knownRefunds)
        fail('REFUND_REVISION_PROVIDER_PROOF_REQUIRED', 'Actual captured charge/refund totals do not prove the proposal remains unwritten.');
      const order = await readOrder(bag, detail);
      if ((order.refunds ?? []).some(value => value.note === `AVAFEM TEST MANUAL REFUND / ${op.id}`))
        fail('REFUND_REVISION_UNSENT_REQUIRED', 'An actual native refund already carries this operation marker. Preserve its original amounts.');
      const prior = successfulRefunds(detail);
      const knownNativeIds = new Set(prior.flatMap(value => [value.shopifyRefundId, value.sourceShopifyRefundId]).filter(Boolean));
      if ((order.refunds ?? []).some(value => !knownNativeIds.has(value.id)))
        fail('REFUND_REVISION_PROVIDER_PROOF_REQUIRED', 'Reconcile actual unaccounted Shopify refunds before requoting this proposal.');
      for (const original of bag.items) {
        const line = order.lineItems.nodes.find(value => value.sku === original.sku && value.variant?.id === original.variantId);
        const used = prior.reduce((sum, value) => sum + (value.items.find(item => item.sku === original.sku)?.qty ?? 0), 0);
        if (!line || line.refundableQuantity !== original.qty - used)
          fail('REFUND_REVISION_PROVIDER_PROOF_REQUIRED', 'Actual Shopify refundable quantities do not prove this proposal is unwritten.');
      }
      const preview = await (await stores.forShop(bag.shop)).getSuggestedRefund({ orderId: detail.orderId,
        lineItems: op.lineItems.map(value => ({ lineItemId: value.lineItemId, quantity: value.qty })), shippingAmountCents: op.shippingCents });
      const allocation = previewAllocation(bag, detail, op, preview);
      const previous = structuredClone(op);
      op.proposalRevisions = [{ revision: 1, reason: 'legacy_proportional_tax_to_authoritative_native_v2', revisedAt: ctx.wallNow().toISOString(),
        previous, proof: { chargeId: actualCharge.id, chargeRefundedCents: actualCharge.amount_refunded, shopifyOrderId: order.id,
          nativeRefundCount: order.refunds?.length ?? 0, explicitOwnerConfirmation: true } }];
      freezeAllocation(ctx, op, allocation); delete op.lastError;
      op.nativePreview = { verifiedAt: ctx.wallNow().toISOString(), amountCents: op.amountCents, taxCents: op.taxCents,
        shippingCents: op.shippingCents, shippingTaxCents: op.shippingTaxCents,
        lines: op.lineItems.map(({ lineItemId, qty, subtotalCents, taxCents }) => ({ lineItemId, qty, subtotalCents, taxCents })) };
      await ctx.save();
    });
  }

  async function ingestNativeRefund(ctx, bag, detail, stripe, order, refundId) {
    const native = order.refunds?.find(value => value.id === refundId);
    if (!native) fail('SHOPIFY_REFUND_NOT_FOUND', 'The bound test order has no such authoritative refund.', 404);
    detail.refundOps ??= {};
    // Native ID and our durable operation note are both deduplication keys. A
    // webhook echo arriving after the provider response was lost is never a new re_.
    let op = Object.values(detail.refundOps).find(value => value.sourceShopifyRefundId === refundId || value.shopifyRefundId === refundId
      || native.note === `AVAFEM TEST MANUAL REFUND / ${value.id}`);
    if (op) {
      if (op.shopifyRefundId && op.shopifyRefundId !== refundId) fail('SHOPIFY_REFUND_MISMATCH', 'Refund note and native identifier disagree.');
      if (!validShopifyRefund(native, op, order)) fail('SHOPIFY_REFUND_MISMATCH', 'Native refund quantities, tax or successful manual transaction do not match.');
      op.shopifyRefundId = refundId; op.sourceShopifyRefundId = refundId; op.shopifyVerified = true;
      await ctx.save();
      if (op.status !== 'complete') await applyRefund(ctx, bag, detail, stripe, op);
      return;
    }
    canStartRefund(detail);
    const nativeLines = native.refundLineItems?.nodes, nativeShipping = native.refundShippingLines?.nodes;
    if (!Array.isArray(nativeLines) || native.refundLineItems.pageInfo?.hasNextPage !== false
      || !Array.isArray(nativeShipping) || native.refundShippingLines.pageInfo?.hasNextPage !== false)
      fail('SHOPIFY_REFUND_REVIEW', 'Complete native refund line and shipping evidence is required.');
    const items = nativeLines.map(line => {
      const providerLine = order.lineItems.nodes.find(item => item.id === line.lineItem?.id);
      if (!providerLine) fail('SHOPIFY_REFUND_MISMATCH', 'Native refund line is not part of this bound Bag.');
      return { sku: providerLine.sku, qty: line.quantity };
    });
    const shippingCents = nativeShipping.reduce((sum, line) => sum + amount(line.subtotalAmountSet), 0);
    const operationId = `native_${createHash('sha256').update(refundId).digest('hex').slice(0, 32)}`;
    op = planRefund(ctx, bag, detail, { operationId, items, refundShipping: shippingCents > 0 }, order, { native: true, allowShippingOnly: shippingCents > 0 });
    const shippingTaxCents = nativeShipping.reduce((sum, line) => sum + amount(line.taxAmountSet), 0);
    const nativeAllocation = validateNativeAllocation(bag, detail, op, { amountCents: amount(native.totalRefundedSet), subtotalCents: op.subtotalCents,
      shippingCents, shippingTaxCents, taxCents: nativeLines.reduce((sum, line) => sum + amount(line.totalTaxSet), shippingTaxCents),
      lineItems: nativeLines.map(line => ({ lineItemId: line.lineItem?.id, qty: line.quantity, subtotalCents: amount(line.subtotalSet), taxCents: amount(line.totalTaxSet) })) });
    freezeAllocation(ctx, op, nativeAllocation);
    if (!validShopifyRefund(native, op, order)) fail('SHOPIFY_REFUND_MISMATCH', 'Native refund must exactly match Checkout merchandise, tax, shipping and successful manual transaction.');
    op.sourceShopifyRefundId = refundId; op.shopifyRefundId = refundId; op.shopifyVerified = true;
    op.shopifyStartedAt = native.createdAt ?? ctx.wallNow().toISOString();
    detail.refundOps[operationId] = op; await ctx.save();
    await applyRefund(ctx, bag, detail, stripe, op);
  }
  async function ingestShopifyRefund({ runId, bagId, shopifyRefundId }) {
    if (typeof shopifyRefundId !== 'string' || !/^gid:\/\/shopify\/Refund\/\d+$/.test(shopifyRefundId)) fail('SHOPIFY_REFUND_ID_INVALID', 'A Shopify refund identifier is required.', 422);
    return runtime.withRun(runId, async ctx => {
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, bagId); await storeRow(bag);
      const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId); await bookProcessingFee(ctx, stripe);
      await ingestNativeRefund(ctx, bag, detail, stripe, await readOrder(bag, detail), shopifyRefundId);
    });
  }
  async function ingestShopifyCancellation({ runId, bagId }) {
    return runtime.withRun(runId, async ctx => {
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, bagId); await storeRow(bag);
      const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId); await bookProcessingFee(ctx, stripe);
      const order = await readOrder(bag, detail);
      if (!order.cancelledAt || !Number.isFinite(Date.parse(order.cancelledAt))) fail('SHOPIFY_CANCELLATION_REQUIRED', 'Actual cancellation of the bound Shopify test order must be verified.');
      await booking(ctx, bag, `provider-cancel:${bag.id}`, 'provider_cancellation', detail.orderId, [],
        async tx => {
          await tx.query("UPDATE bags SET status=CASE WHEN status='refunded' THEN status ELSE 'cancelled' END,updated_at=$2 WHERE id=$1", [bag.id, ctx.wallNow()]);
          await tx.query("UPDATE transfers SET status='held' WHERE bag_id=$1 AND status='scheduled'", [bag.id]);
          await tx.query("UPDATE credits SET status='voided',voided_at=$2 WHERE bag_id=$1 AND status='pending' AND amount_cents=0", [bag.id, ctx.wallNow()]);
        }, 'bag.cancelled', { shop: bag.shop, externalOrderId: detail.orderId });
      detail.state = 'cancelled'; detail.fullyDelivered = false; detail.shippingStatus = 'cancelled'; await ctx.save();
      for (const native of order.refunds ?? []) await ingestNativeRefund(ctx, bag, detail, stripe, order, native.id);
      detail.refundOps ??= {};
      const cancellationOp = Object.values(detail.refundOps).find(op => op.cancellationSource);
      if (cancellationOp && cancellationOp.status !== 'complete') {
        await applyRefund(ctx, bag, detail, stripe, cancellationOp);
        if (cancellationOp.status !== 'complete') return;
      }
      if (unresolved(detail)) fail('REFUND_PENDING', 'Unfinished native refund holds cancellation completion.');
      const prior = successfulRefunds(detail);
      const items = bag.items.map(item => ({ sku: item.sku, qty: item.qty - prior.reduce((sum, op) => sum + (op.items.find(line => line.sku === item.sku)?.qty ?? 0), 0) })).filter(item => item.qty > 0);
      const refundShipping = !prior.some(op => op.refundShipping) && detail.shippingCents > 0;
      if (!items.length && !refundShipping) { detail.cancellationVerified = true; if (detail.cancelOp) detail.cancelOp.status = 'complete'; await ctx.save(); return; }
      const operationId = `cancel_${createHash('sha256').update(detail.orderId).digest('hex').slice(0, 32)}`;
      let op = detail.refundOps[operationId];
      if (!op) {
        canStartRefund(detail);
        op = planRefund(ctx, bag, detail, { operationId, items, refundShipping }, order, { allowShippingOnly: refundShipping });
        op.cancellationSource = order.cancelledAt; detail.refundOps[operationId] = op; await ctx.save();
      }
      await applyRefund(ctx, bag, detail, stripe, op);
      detail.cancellationVerified = op.status === 'complete';
      if (detail.cancellationVerified && detail.cancelOp) detail.cancelOp.status = 'complete';
      await ctx.save();
    });
  }

  /** Explicit Avafem-side cancellation. The cancel mutation never refunds a
   * Shopify gateway; actual shopper money follows only authoritative cancelledAt
   * readback, in a fresh run lease. A job/unknown outcome is never re-created. */
  async function cancel({ runId, bagId, operationId }) {
    identifier(operationId); let ready = false;
    const result = await runtime.withRun(runId, async ctx => {
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, bagId); await storeRow(bag);
      await stripeFor(ctx.snapshot, ctx.details.accountId);
      const adapter = await stores.forShop(bag.shop);
      let order = await readOrder(bag, detail), op = detail.cancelOp;
      if (op && (op.operationId !== operationId || op.orderId !== detail.orderId)) fail('OPERATION_REUSED', 'The original cancellation operation and bound order are immutable.');
      if (order.cancelledAt && Number.isFinite(Date.parse(order.cancelledAt))) {
        detail.cancelOp ??= { operationId, orderId: detail.orderId, observedAt: ctx.wallNow().toISOString() };
        if (detail.cancelOp.status !== 'complete') detail.cancelOp.status = 'cancelled';
        await ctx.save(); ready = true; return;
      }
      if (!op) {
        canStartRefund(detail);
        if (!Array.isArray(order.fulfillments) || order.fulfillments.some(item => item.status !== 'CANCELLED'))
          fail('SHOPIFY_CANCELLATION_BLOCKED', 'This bounded cancellation requires an unfulfilled verified test order.');
        op = detail.cancelOp = { operationId, orderId: detail.orderId, status: 'started', startedAt: ctx.wallNow().toISOString() };
        await ctx.save();
        try {
          const response = await adapter.cancelOrder({ orderId: detail.orderId, operationId, restock: false, reason: 'OTHER' });
          if (isShopifyJobId(response.job?.id)) { op.jobId = response.job.id; op.status = 'job_pending'; await ctx.save(); }
          else if (!response.alreadyCancelled) { op.status = 'cancel_uncertain'; await ctx.save(); }
        } catch (cause) { op.status = 'cancel_uncertain'; op.lastError = safeError(cause); await ctx.save(); }
      }
      if (op.jobId) {
        try {
          const job = await adapter.getJob(op.jobId);
          if (!job || job.id !== op.jobId || typeof job.done !== 'boolean') fail('SHOPIFY_CANCEL_JOB_MISMATCH', 'Actual Shopify cancellation job readback is required.');
          op.jobDone = job.done; op.status = job.done ? 'job_done' : 'job_pending'; await ctx.save();
        } catch (cause) { op.lastError = safeError(cause); await ctx.save(); }
      } else if (op.startedAt) { op.status = 'cancel_uncertain'; await ctx.save(); }
      order = await readOrder(bag, detail);
      if (order.cancelledAt && Number.isFinite(Date.parse(order.cancelledAt))) { op.status = 'cancelled'; op.cancelledAt = order.cancelledAt; ready = true; await ctx.save(); }
    });
    // withRun has released its lease before money/refund reconciliation begins.
    return ready ? ingestShopifyCancellation({ runId, bagId }) : result;
  }

  async function settle({ runId, automationPolicyId }) {
    return runtime.withRun(runId, async ctx => {
      await checkAutomation(ctx, { action: 'settle', automationPolicyId });
      requirePayment(ctx); const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId);
      await bookProcessingFee(ctx, stripe);
      for (const bag of ctx.snapshot.bags) {
        const { detail } = bagFor(ctx, bag.id);
        try {
          await eligible(ctx, bag, detail);
          const accountId = await recipient(bag, stripe);
          if (detail.transferId || detail.transferOp?.id) { await verifyTransfer(ctx, bag, detail, stripe); continue; }
          if (detail.transferOp?.startedAt) { detail.transferOp.status = 'uncertain'; await ctx.save(); continue; }
          const value = integer(detail.transferCents - refunded(detail, 'recoveryCents'), 'Remaining brand transfer');
          if (!value) { detail.settlementStatus = 'fully_refunded'; await ctx.save(); continue; }
          detail.transferOp = { status: 'started', startedAt: ctx.wallNow().toISOString(), amountCents: value, accountId };
          await ctx.save();
          const transfer = await stripe.createTransfer({ orderId: ctx.snapshot.id, bagId: bag.id, amountCents: value, accountId, chargeId: ctx.details.chargeId });
          detail.transferOp.id = transfer.id; await ctx.save();
          await verifyTransfer(ctx, bag, detail, stripe);
        } catch (cause) {
          detail.settlementError = safeError(cause);
          if (detail.transferOp?.startedAt && detail.transferOp.status !== 'verified') detail.transferOp.status = 'uncertain';
          await ctx.save();
        }
      }
    });
  }
  async function verifyPayout(ctx, bag, detail, stripe) {
    const op = detail.payoutOp;
    if (!providerId(op?.id ?? detail.payoutId, 'po')) fail('PAYOUT_UNCERTAIN', 'Payout outcome has no provider ID; manual reconciliation is required.');
    const actual = await stripe.getPayout(op?.id ?? detail.payoutId, { accountId: op.accountId });
    if (actual.id !== (op?.id ?? detail.payoutId) || actual.livemode !== false || actual.amount !== op.amountCents || actual.currency !== 'usd')
      fail('STRIPE_PAYOUT_MISMATCH', 'Actual external payout does not match its authorized recipient amount.');
    detail.payoutId = actual.id; op.status = actual.status;
    await ctx.save();
    if (actual.status !== 'paid') return;
    // The platform ledger already debited brand_payable for the transfer. Bank
    // arrival is a separate recipient event, never a second platform disbursement.
    await booking(ctx, bag, `provider-payout:${bag.id}`, 'provider_payout', actual.id, [],
      tx => tx.query("UPDATE credits SET status='released',released_at=$2 WHERE bag_id=$1 AND amount_cents=0 AND status='pending'", [bag.id, ctx.wallNow()]),
      'payout.paid', { amountCents: op.amountCents, accountId: op.accountId });
  }
  async function payout({ runId, bagId, operationId, automationPolicyId }) {
    identifier(operationId);
    return runtime.withRun(runId, async ctx => {
      await checkAutomation(ctx, { action: 'payout', bagId, operationId, automationPolicyId });
      requirePayment(ctx); const { bag, detail } = bagFor(ctx, bagId);
      const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId);
      await bookProcessingFee(ctx, stripe);
      await eligible(ctx, bag, detail);
      const accountId = await recipient(bag, stripe);
      await verifyTransfer(ctx, bag, detail, stripe);
      if (detail.payoutId || detail.payoutOp?.id) { await verifyPayout(ctx, bag, detail, stripe); return; }
      if (detail.payoutOp?.startedAt) { detail.payoutOp.status = 'uncertain'; await ctx.save(); return; }
      const recovered = successfulRefunds(detail).filter(op => op.afterTransfer && op.reversalVerified).reduce((sum, op) => sum + op.recoveryCents, 0);
      const value = integer(detail.transferOp.amountCents - recovered, 'Remaining external payout', 1);
      detail.payoutOp = { operationId, status: 'started', amountCents: value, accountId, startedAt: ctx.wallNow().toISOString() };
      await ctx.save();
      try {
        const result = await stripe.createTestPayout({ accountId, amountCents: value, orderId: ctx.snapshot.id, bagId, payoutId: operationId });
        detail.payoutOp.id = result.id; await ctx.save();
        await verifyPayout(ctx, bag, detail, stripe);
      } catch (cause) { detail.payoutOp.status = 'uncertain'; detail.payoutOp.lastError = safeError(cause); await ctx.save(); }
    });
  }
  async function reconcile({ runId }) {
    const cancellations = [];
    let result = await runtime.withRun(runId, async ctx => {
      requirePayment(ctx); const { stripe } = await stripeFor(ctx.snapshot, ctx.details.accountId);
      await bookProcessingFee(ctx, stripe);
      let terminalReadbackFailed = false;
      for (const bag of ctx.snapshot.bags) {
        const { detail } = bagFor(ctx, bag.id);
        if (detail.cancelOp && detail.cancelOp.status !== 'complete') cancellations.push({ runId, bagId: bag.id, operationId: detail.cancelOp.operationId });
        for (const op of Object.values(detail.refundOps ?? {})) if (op.status !== 'complete' && op.stripeRefundId) {
          try { await finishRefund(ctx, bag, detail, op, stripe); }
          catch (cause) { terminalReadbackFailed = true; op.lastError = safeError(cause); await ctx.save(); }
        }
        if (detail.transferOp?.id) {
          try { await verifyTransfer(ctx, bag, detail, stripe); }
          catch (cause) { terminalReadbackFailed = true; detail.settlementError = safeError(cause); await ctx.save(); }
        }
        if (detail.payoutOp?.id) {
          try { await verifyPayout(ctx, bag, detail, stripe); }
          catch (cause) { terminalReadbackFailed = true; detail.payoutOp.lastError = safeError(cause); await ctx.save(); }
        }
      }
      // Aggregate already-verified money outcomes only. This is a cash lifecycle
      // label, not acceptance or Stripe Tax reporting certification.
      const states = ctx.snapshot.bags.map(bag => ctx.details.bags[bag.id]);
      const refundsVerified = value => !unresolved(value) && Object.values(value.refundOps ?? {}).every(op => op.status === 'complete'
        && op.stripeStatus === 'succeeded' && op.shopifyVerified === true && (!op.afterTransfer || op.recoveryCents === 0 || op.reversalVerified === true));
      const fullyRefunded = value => refundsVerified(value) && value.refundCents === value.totalCents && refunded(value, 'amountCents') === value.totalCents
        && (!value.transferOp || value.transferOp.status === 'verified' && value.transferOp.amountCents === successfulRefunds(value).filter(op => op.afterTransfer).reduce((sum, op) => sum + op.recoveryCents, 0));
      const paid = value => refundsVerified(value) && !value.cancellationVerified && !value.cancelOp && value.fullyDelivered === true
        && value.transferOp?.status === 'verified' && value.transferId === value.transferOp.id
        && value.payoutOp?.status === 'paid' && value.payoutId === value.payoutOp.id && value.payoutOp.accountId === value.transferOp.accountId
        && value.payoutOp.amountCents > 0 && value.payoutOp.amountCents === value.transferOp.amountCents
          - successfulRefunds(value).filter(op => op.afterTransfer).reduce((sum, op) => sum + op.recoveryCents, 0);
      if (!terminalReadbackFailed && states.length === 3 && states.every(value => value?.verified === true && (fullyRefunded(value) || paid(value))))
        await ctx.save(states.every(fullyRefunded) ? states.every(value => value.cancellationVerified === true && (!value.cancelOp || value.cancelOp.status === 'complete')) ? 'cancelled' : 'refunded' : 'completed');
    });
    for (const input of cancellations) result = await cancel(input);
    return result;
  }

  async function createRecipients({ confirmTest } = {}) {
    if (confirmTest !== true) fail('TEST_CONFIRMATION_REQUIRED', 'Confirm creation of the three new Stripe TEST recipients.', 422);
    const { stripe, accountId } = await stripeFor();
    for (const store of await stores.list()) {
      const row = await stores.row(store.shop);
      if (row.connected_account_id) continue;
      const params = { brandId: row.brand_id, country: 'US', manualPayouts: true, parameterRevision: 3, email: stripeTestRecipientContactEmail(row.brand_id) };
      const claim = await db.transaction(async tx => {
        const inserted = await tx.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at,parameter_revision,request_params)
          VALUES($1,$2,$3,'creating',$4,3,$5) ON CONFLICT DO NOTHING RETURNING shop`, [store.shop, row.brand_id, accountId, new Date(), JSON.stringify(params)]);
        const prior = (await tx.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [store.shop])).rows[0];
        if (prior.brand_id !== row.brand_id || prior.platform_account_id !== accountId) fail('TEST_ACCOUNT_BINDING_REQUIRED', 'Recipient creation binding changed.');
        return { create: inserted.rows.length === 1, prior };
      });
      let raw;
      if (claim.prior.account_id) raw = claim.prior.parameter_revision === 3
        ? await completeV2Recipient(stripe, claim.prior) : await stripe.getTestConnectedAccount(claim.prior.account_id);
      else if (!claim.create) fail('RECIPIENT_CREATION_UNCERTAIN', 'A recipient creation has an uncertain outcome; do not create a replacement account.');
      else {
        try {
          raw = claim.prior.parameter_revision === 3 ? await stripe.createExpressRecipientV2(claim.prior.request_params)
            : await stripe.createExpressAccount(claim.prior.request_params);
          // A v2 ID must survive any later readback or schedule failure. Never
          // discard a known created account and send a replacement create.
          if (claim.prior.parameter_revision === 3 && providerId(raw?.id, 'acct'))
            await db.query("UPDATE provider_recipient_attempts SET account_id=$2,state='created' WHERE shop=$1", [store.shop, raw.id]);
          if (!providerId(raw?.id, 'acct') || raw.metadata?.brand_id !== row.brand_id || raw.metadata?.integration !== 'avafem')
            fail('TEST_ACCOUNT_BINDING_REQUIRED', 'Stripe recipient identity/metadata did not verify.');
          await db.query("UPDATE provider_recipient_attempts SET account_id=$2,state='created' WHERE shop=$1", [store.shop, raw.id]);
          if (claim.prior.parameter_revision === 3) raw = await completeV2Recipient(stripe, { ...claim.prior, account_id: raw.id });
        } catch (cause) {
          await db.query("UPDATE provider_recipient_attempts SET state='uncertain',last_error=$2 WHERE shop=$1", [store.shop, JSON.stringify(safeError(cause))]);
          throw recipientFailure('RECIPIENT_CREATION_UNCERTAIN', 'Preserve this recipient attempt and reconcile; no automatic replacement will be created.', cause);
        }
      }
      await stores.bindConnectedAccount(store.shop, raw, { createdInTest: true });
    }
    return stores.list();
  }
  async function readV2Recipient(stripe, attempt, brandId = attempt.brand_id) {
    const raw = await stripe.getTestConnectedAccountV2(attempt.account_id);
    if (raw?.id !== attempt.account_id || raw.livemode !== false || raw.dashboard !== 'express'
      || raw.metadata?.integration !== 'avafem' || raw.metadata?.brand_id !== brandId)
      fail('TEST_ACCOUNT_BINDING_REQUIRED', 'The original test v2 Express recipient identity must verify.');
    const settings = await stripe.getTestBalanceSettings(attempt.account_id);
    if (settings?.payments?.payouts?.schedule?.interval !== 'manual')
      fail('RECIPIENT_SCHEDULE_UNVERIFIED', 'Preserve the known recipient account ID; its manual payout schedule has not verified.');
    return raw;
  }
  async function completeV2Recipient(stripe, attempt) {
    if (!providerId(attempt.account_id, 'acct') || attempt.parameter_revision !== 3)
      fail('TEST_ACCOUNT_BINDING_REQUIRED', 'A durably saved new test v2 recipient ID is required before payout setup.');
    const raw = await stripe.getTestConnectedAccountV2(attempt.account_id);
    if (raw?.metadata?.brand_id !== attempt.brand_id || raw.metadata?.integration !== 'avafem' || raw.id !== attempt.account_id)
      fail('TEST_ACCOUNT_BINDING_REQUIRED', 'The saved v2 recipient does not match the original brand.');
    const claimed = (await db.query(`UPDATE provider_recipient_attempts SET schedule_started_at=now(),state='schedule_started'
      WHERE shop=$1 AND account_id=$2 AND parameter_revision=3 AND schedule_started_at IS NULL RETURNING shop`, [attempt.shop, attempt.account_id])).rows.length === 1;
    if (claimed) await stripe.configureTestRecipientManualPayouts({ accountId: attempt.account_id, brandId: attempt.brand_id });
    // An uncertain setup is read back only. No blind second schedule mutation.
    await readV2Recipient(stripe, attempt);
    await db.query("UPDATE provider_recipient_attempts SET schedule_verified_at=now(),state='created',last_error=NULL WHERE shop=$1 AND account_id=$2", [attempt.shop, attempt.account_id]);
    const financial = await stripe.getTestConnectedAccount(attempt.account_id);
    if (financial?.id !== attempt.account_id || financial.metadata?.brand_id !== attempt.brand_id || financial.metadata?.integration !== 'avafem')
      fail('TEST_ACCOUNT_BINDING_REQUIRED', 'The original v1 financial projection does not match the created v2 recipient.');
    return financial;
  }
  /** Owner-only recovery for an explicitly observed HTTP400 that rejected the
   * original create before returning an account. This is not an automatic retry
   * and never rotates the original Stripe idempotency key or its fixed params. */
  async function retryRecipient({ shop, providerRequestId, confirmRejectedBeforeCreation } = {}) {
    if (confirmRejectedBeforeCreation !== true || typeof providerRequestId !== 'string' || !/^req_[A-Za-z0-9]{8,100}$/.test(providerRequestId))
      fail('RECIPIENT_REJECTION_PROOF_REQUIRED', 'Confirm the observed pre-creation HTTP400 rejection and its Stripe request ID.', 422);
    if (!(await stores.list()).some(store => store.shop === shop)) fail('TEST_STORE_REQUIRED', 'Use the original explicitly bound test store.', 422);
    const row = await stores.row(shop);
    const attempt = (await db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [shop])).rows[0];
    if (!attempt || attempt.brand_id !== row.brand_id || !['uncertain', 'retry_started', 'retry_uncertain', 'created'].includes(attempt.state))
      fail('RECIPIENT_HELD_ATTEMPT_REQUIRED', 'An existing held recipient creation attempt for this exact brand is required.');
    if (attempt.parameter_revision === 3) fail('RECIPIENT_V2_RECONCILE_REQUIRED', 'Preserve API-v2 recipient IDs and intents. The historical v1 retry cannot authorize another API-v2 creation.');
    const started = new Date(attempt.started_at), wall = new Date(), age = wall - started;
    if (!Number.isFinite(age) || age < 0 || age >= 23 * 3600_000)
      fail('RECIPIENT_RETRY_WINDOW_CLOSED', 'The original attempt is outside the conservative 23-hour same-key recovery window. Do not create a replacement.');
    const { stripe } = await stripeFor(undefined, attempt.platform_account_id);
    if (typeof stripe.listTestConnectedAccounts !== 'function') fail('RECIPIENT_COMPLETE_LIST_REQUIRED', 'A complete bounded connected-account read is required before recovery.');
    const from = Math.floor(started.getTime() / 1000), to = Math.floor(wall.getTime() / 1000);
    const accounts = await stripe.listTestConnectedAccounts({ createdAfter: from, createdBefore: to });
    if (!Array.isArray(accounts)) fail('RECIPIENT_COMPLETE_LIST_REQUIRED', 'A complete bounded connected-account read is required before recovery.');
    const matches = accounts.filter(account => account.metadata?.brand_id === row.brand_id && account.metadata?.integration === 'avafem'
      && Number.isSafeInteger(account.created) && account.created >= from && account.created <= to);
    if (matches.length > 1) fail('RECIPIENT_MULTIPLE_MATCHES', 'More than one original recipient candidate exists. Preserve all IDs for manual reconciliation; no create was sent.');
    const bind = async (raw, retried) => {
      if (!providerId(raw?.id, 'acct') || raw.type !== 'express' || raw.country !== 'US'
        || raw.metadata?.brand_id !== row.brand_id || raw.metadata?.integration !== 'avafem'
        || raw.settings?.payouts?.schedule?.interval !== 'manual'
        || (attempt.account_id && attempt.account_id !== raw.id) || (row.connected_account_id && row.connected_account_id !== raw.id))
        fail('RECIPIENT_CANDIDATE_MISMATCH', 'Original recipient identity, manual schedule and immutable brand binding must verify.');
      await db.query("UPDATE provider_recipient_attempts SET account_id=$2,state='created' WHERE shop=$1", [shop, raw.id]);
      await stores.bindConnectedAccount(shop, raw, { createdInTest: true });
      return { shop, accountId: raw.id, state: 'bound', reconciledExisting: !retried, retried, sandbox: true };
    };
    if (matches.length === 1) return bind(matches[0], false);
    if (row.connected_account_id || attempt.account_id) fail('RECIPIENT_EXISTING_ID_UNVERIFIED', 'Preserve the original connected-account ID; an empty list cannot authorize replacement.');
    // Preserve the original request revision; never silently change an existing
    // held v1 request into an email-bearing v2 idempotency key.
    const params = attempt.request_params ?? { brandId: row.brand_id, country: 'US', manualPayouts: true, parameterRevision: 1 };
    const claim = (await db.query(`UPDATE provider_recipient_attempts SET state='retry_started',retry_requested_at=$2,
      retry_provider_request_id=$3,retry_params=$4 WHERE shop=$1 AND state='uncertain' AND retry_requested_at IS NULL
      AND account_id IS NULL RETURNING shop`, [shop, wall, providerRequestId, JSON.stringify(params)])).rows[0];
    if (!claim) fail('RECIPIENT_RETRY_ALREADY_USED', 'The one controlled same-key retry is already reserved or uncertain. Reconcile only; no replacement was sent.');
    try { return await bind(await stripe.createExpressAccount(params), true); }
    catch (cause) {
      await db.query("UPDATE provider_recipient_attempts SET state='retry_uncertain',last_error=$2 WHERE shop=$1", [shop, JSON.stringify(safeError(cause))]);
      throw recipientFailure('RECIPIENT_RETRY_UNCERTAIN', 'The one same-key retry has an uncertain outcome. Preserve the intent and reconcile provider accounts; never issue a second retry.', cause);
    }
  }
  /** One bounded new-parameter revision after the exact owner-observed target
   * HTTP400 rejected the original missing-contact-email request. This is neither
   * an automatic reset nor an unknown-outcome replacement. Archive precedes delete.
   */
  async function reviseRejectedRecipient({ shop, providerRequestId, confirmRejectedBeforeCreation } = {}) {
    const target = 'acct_1U74iQGgawRtH2qe';
    if (shop !== TEST_STORES[0].shop || providerRequestId !== 'req_98gvn77VCy6nK8' || confirmRejectedBeforeCreation !== true)
      fail('RECIPIENT_REVISION_APPROVAL_REQUIRED', 'Only the explicitly observed target-sandbox Store2 pre-creation HTTP400 may authorize this contact-email revision.', 422);
    const { stripe } = await stripeFor(undefined, target), wall = new Date();
    const old = (await db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [shop])).rows[0];
    if (!old || old.platform_account_id !== target || old.state !== 'uncertain' || old.account_id !== null
      || old.retry_requested_at != null || ![null, 1].includes(old.parameter_revision ?? null) || old.request_params?.email)
      fail('RECIPIENT_REVISION_HELD_REQUIRED', 'Preserve existing/retried/revised recipient records; only the original held missing-email attempt is eligible.');
    const age = wall - new Date(old.started_at);
    if (!Number.isFinite(age) || age < 0 || age >= 23 * 3600_000) fail('RECIPIENT_RETRY_WINDOW_CLOSED', 'The original rejection is outside the conservative23-hour revision window.');
    if (typeof stripe.listTestConnectedAccounts !== 'function') fail('RECIPIENT_COMPLETE_LIST_REQUIRED', 'Complete bounded recipient account evidence is required before any new parameter revision.');
    const accounts = await stripe.listTestConnectedAccounts({ createdAfter: Math.floor(new Date(old.started_at).getTime() / 1000), createdBefore: Math.floor(wall.getTime() / 1000) });
    if (!Array.isArray(accounts) || accounts.some(account => account.metadata?.brand_id === old.brand_id && account.metadata?.integration === 'avafem'))
      fail('RECIPIENT_REVISION_EXISTING_CANDIDATE', 'A recipient candidate exists or complete absence is unverified. Reconcile its original ID; no new parameter revision was created.');
    const params = { brandId: old.brand_id, country: 'US', manualPayouts: true, parameterRevision: 2, email: stripeTestRecipientContactEmail(old.brand_id) };
    const historyId = `recipient_revision_${createHash('sha256').update(`${target}:${shop}:${providerRequestId}`).digest('hex').slice(0, 32)}`;
    await db.transaction(async tx => {
      const registry = (await tx.query('SELECT * FROM provider_test_stores WHERE shop=ANY($1) ORDER BY shop FOR UPDATE', [TEST_STORES.map(store => store.shop)])).rows;
      if (registry.length !== TEST_STORES.length || registry.some(row => row.connected_account_id !== null
        || row.connected_account_created_in_test === true || row.connected_account_verified === true))
        fail('RECIPIENT_REVISION_UNBOUND_REQUIRED', 'All three test recipients must remain unbound before this explicitly approved revision.');
      const row = registry.find(value => value.shop === shop);
      const current = (await tx.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1 FOR UPDATE', [shop])).rows[0];
      if (!row || row.brand_id !== old.brand_id || !current || current.brand_id !== old.brand_id || current.platform_account_id !== target
        || current.account_id !== null || current.state !== 'uncertain' || current.retry_requested_at != null
        || ![null, 1].includes(current.parameter_revision ?? null) || new Date(current.started_at).getTime() !== new Date(old.started_at).getTime())
        fail('RECIPIENT_REVISION_HELD_REQUIRED', 'The original held attempt changed; no archive, clear or new create was authorized.');
      await tx.query(`INSERT INTO provider_recipient_revision_history(id,shop,brand_id,platform_account_id,record_encrypted,proof_encrypted)
        VALUES($1,$2,$3,$4,$5,$6)`, [historyId, shop, old.brand_id, target, auth.encrypt(current), auth.encrypt({
        providerRequestId, confirmRejectedBeforeCreation: true, observedHttpStatus: 400,
        verification: 'explicit_operator_rejected_before_creation', parameterRevision: 2, recordedAt: wall.toISOString() })]);
      const removed = await tx.query('DELETE FROM provider_recipient_attempts WHERE shop=$1 AND platform_account_id=$2 AND account_id IS NULL RETURNING shop', [shop, target]);
      if (removed.rows.length !== 1) fail('RECIPIENT_REVISION_ATOMIC_GUARD', 'The original held attempt could not be archived atomically.');
      await tx.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at,parameter_revision,request_params,previous_revision_id)
        VALUES($1,$2,$3,'creating',$4,2,$5,$6)`, [shop, old.brand_id, target, wall, JSON.stringify(params), historyId]);
    });
    try {
      const raw = await stripe.createExpressAccount(params);
      if (!providerId(raw?.id, 'acct') || raw.metadata?.brand_id !== old.brand_id || raw.metadata?.integration !== 'avafem')
        fail('TEST_ACCOUNT_BINDING_REQUIRED', 'New revision recipient identity/metadata did not verify.');
      await db.query("UPDATE provider_recipient_attempts SET account_id=$2,state='created' WHERE shop=$1 AND previous_revision_id=$3", [shop, raw.id, historyId]);
      await stores.bindConnectedAccount(shop, raw, { createdInTest: true });
      return { shop, accountId: raw.id, state: 'bound', parameterRevision: 2, archivedAttemptId: historyId, sandbox: true };
    } catch (cause) {
      await db.query("UPDATE provider_recipient_attempts SET state='uncertain',last_error=$2 WHERE shop=$1 AND previous_revision_id=$3", [shop, JSON.stringify(safeError(cause)), historyId]);
      throw recipientFailure('RECIPIENT_REVISION_UNCERTAIN', 'The approved new-parameter revision has an uncertain outcome. Preserve the new intent and original encrypted history; never repeat revision creation.', cause);
    }
  }
  /** Explicit API-v2 revision only after the second exact operator-observed
   * HTTP400 rejected the email-bearing v1 create. Neither unknown outcome nor
   * an arbitrary request ID authorizes a changed-parameter create. */
  async function reviseRejectedRecipientV2({ shop, providerRequestId, confirmRejectedBeforeCreation } = {}) {
    const target = 'acct_1U74iQGgawRtH2qe';
    if (shop !== TEST_STORES[0].shop || providerRequestId !== 'req_kxW4JTIW5nYP4G' || confirmRejectedBeforeCreation !== true)
      fail('RECIPIENT_V2_REVISION_APPROVAL_REQUIRED', 'Only the explicitly observed Store2 target-sandbox second pre-creation HTTP400 authorizes the API-v2 revision.', 422);
    const { stripe } = await stripeFor(undefined, target), wall = new Date();
    const old = (await db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [shop])).rows[0];
    const eligibleAttempt = row => row && row.platform_account_id === target && row.state === 'uncertain' && row.account_id === null
      && row.parameter_revision === 2 && row.request_params?.parameterRevision === 2 && row.previous_revision_id
      && row.retry_requested_at == null && row.last_error?.requestId === providerRequestId
      && row.request_params.email === stripeTestRecipientContactEmail(row.brand_id);
    if (!eligibleAttempt(old)) fail('RECIPIENT_V2_REVISION_HELD_REQUIRED', 'Preserve the original known/unknown account state; only the exact rejected email-bearing revision may be archived.');
    const priorHistory = (await db.query('SELECT id,shop,brand_id,platform_account_id FROM provider_recipient_revision_history WHERE id=$1', [old.previous_revision_id])).rows[0];
    if (!priorHistory || priorHistory.shop !== shop || priorHistory.brand_id !== old.brand_id || priorHistory.platform_account_id !== target)
      fail('RECIPIENT_V2_REVISION_HELD_REQUIRED', 'The original encrypted recipient revision history must remain recoverable before a further explicit revision.');
    const age = wall - new Date(old.started_at);
    if (!Number.isFinite(age) || age < 0 || age >= 23 * 3600_000) fail('RECIPIENT_RETRY_WINDOW_CLOSED', 'The rejected revision is outside the conservative23-hour revision window.');
    if (typeof stripe.listTestConnectedAccounts !== 'function' || typeof stripe.listTestConnectedAccountsV2 !== 'function')
      fail('RECIPIENT_COMPLETE_LIST_REQUIRED', 'Complete bounded v1 and v2 connected-account evidence is required before revision.');
    const v1 = await stripe.listTestConnectedAccounts(), v2 = await stripe.listTestConnectedAccountsV2();
    if (![v1, v2].every(Array.isArray) || [...v1, ...v2].some(raw => !raw.metadata || raw.metadata.integration === 'avafem' && raw.metadata.brand_id === old.brand_id))
      fail('RECIPIENT_V2_REVISION_EXISTING_CANDIDATE', 'An original recipient candidate exists or complete v1/v2 absence is unverified. No changed-parameter creation was sent.');
    const params = { brandId: old.brand_id, country: 'US', manualPayouts: true, parameterRevision: 3, email: stripeTestRecipientContactEmail(old.brand_id) };
    const historyId = `recipient_revision_${createHash('sha256').update(`${target}:${shop}:${providerRequestId}:v3`).digest('hex').slice(0, 32)}`;
    await db.transaction(async tx => {
      const registry = (await tx.query('SELECT * FROM provider_test_stores WHERE shop=ANY($1) ORDER BY shop FOR UPDATE', [TEST_STORES.map(store => store.shop)])).rows;
      if (registry.length !== TEST_STORES.length || registry.some(row => row.connected_account_id !== null
        || row.connected_account_created_in_test === true || row.connected_account_verified === true))
        fail('RECIPIENT_REVISION_UNBOUND_REQUIRED', 'All three new test recipients must remain unbound before the approved API-v2 revision.');
      const row = registry.find(value => value.shop === shop);
      const current = (await tx.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1 FOR UPDATE', [shop])).rows[0];
      if (!eligibleAttempt(current) || row?.brand_id !== old.brand_id || current.brand_id !== old.brand_id
        || new Date(current.started_at).getTime() !== new Date(old.started_at).getTime() || !sameInput(current.request_params, old.request_params))
        fail('RECIPIENT_V2_REVISION_HELD_REQUIRED', 'The exact rejected revision changed; no archive or provider creation was authorized.');
      await tx.query(`INSERT INTO provider_recipient_revision_history(id,shop,brand_id,platform_account_id,record_encrypted,proof_encrypted)
        VALUES($1,$2,$3,$4,$5,$6)`, [historyId, shop, old.brand_id, target, auth.encrypt(current), auth.encrypt({ providerRequestId,
        confirmRejectedBeforeCreation: true, observedHttpStatus: 400, verification: 'explicit_operator_rejected_before_creation',
        parameterRevision: 3, providerApi: 'v2', recordedAt: wall.toISOString() })]);
      const removed = await tx.query('DELETE FROM provider_recipient_attempts WHERE shop=$1 AND platform_account_id=$2 AND account_id IS NULL RETURNING shop', [shop, target]);
      if (removed.rows.length !== 1) fail('RECIPIENT_REVISION_ATOMIC_GUARD', 'The exact rejected revision could not be archived atomically.');
      await tx.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at,parameter_revision,request_params,previous_revision_id)
        VALUES($1,$2,$3,'creating',$4,3,$5,$6)`, [shop, old.brand_id, target, wall, JSON.stringify(params), historyId]);
    });
    try {
      const raw = await stripe.createExpressRecipientV2(params);
      if (!providerId(raw?.id, 'acct')) fail('TEST_ACCOUNT_BINDING_REQUIRED', 'No v2 recipient ID was returned; preserve the new intent for reconciliation.');
      await db.query("UPDATE provider_recipient_attempts SET account_id=$2,state='created' WHERE shop=$1 AND previous_revision_id=$3", [shop, raw.id, historyId]);
      const financial = await completeV2Recipient(stripe, { shop, brand_id: old.brand_id, account_id: raw.id, parameter_revision: 3 });
      await stores.bindConnectedAccount(shop, financial, { createdInTest: true });
      return { shop, accountId: raw.id, state: 'bound', parameterRevision: 3, providerApi: 'v2', archivedAttemptId: historyId, sandbox: true };
    } catch (cause) {
      await db.query("UPDATE provider_recipient_attempts SET state='uncertain',last_error=$2 WHERE shop=$1 AND previous_revision_id=$3", [shop, JSON.stringify(safeError(cause)), historyId]);
      throw recipientFailure('RECIPIENT_REVISION_UNCERTAIN', 'The approved API-v2 revision or its separate manual schedule is unverified. Preserve the original known account ID and encrypted history; no replacement creation is permitted.', cause);
    }
  }
  async function refreshRecipients() {
    const { stripe } = await stripeFor(); const results = [];
    for (const store of await stores.list()) {
      const row = await stores.row(store.shop);
      if (!row.connected_account_id || row.connected_account_created_in_test !== true) { results.push({ shop: store.shop, ready: false }); continue; }
      const attempt = (await db.query('SELECT * FROM provider_recipient_attempts WHERE shop=$1', [store.shop])).rows[0];
      if (attempt?.parameter_revision === 3) await readV2Recipient(stripe, attempt, row.brand_id);
      results.push(await stores.verifyConnectedAccount(store.shop, await stripe.getTestConnectedAccount(row.connected_account_id)));
    }
    return results;
  }
  async function recipientLinks({ baseUrl }) {
    const base = new URL(baseUrl);
    if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
      fail('ONBOARDING_URL_INVALID', 'Use an HTTPS or local test callback origin.', 422);
    const { stripe } = await stripeFor(); const links = [];
    for (const store of await stores.list()) {
      const row = await stores.row(store.shop);
      if (!row.connected_account_id || row.connected_account_created_in_test !== true) continue;
      const callback = kind => { const url = new URL(`/api/provider-test/recipients/${kind}`, base); url.searchParams.set('shop', store.shop); return url.href; };
      const attempt = (await db.query('SELECT parameter_revision FROM provider_recipient_attempts WHERE shop=$1', [store.shop])).rows[0];
      const createLink = attempt?.parameter_revision === 3 ? stripe.createRecipientOnboardingLinkV2 : stripe.createOnboardingLink;
      const result = await createLink({ accountId: row.connected_account_id,
        refreshUrl: callback('refresh'), returnUrl: callback('return'), requestId: `link_${randomUUID().replaceAll('-', '')}` });
      links.push({ shop: store.shop, accountId: row.connected_account_id, url: result.url, expiresAt: result.expires_at,
        sandbox: true, requiresHumanOnboarding: true });
    }
    return links;
  }
  return { createRecipients, retryRecipient, reviseRejectedRecipient, reviseRejectedRecipientV2, recipientLinks, refreshRecipients, refund, reviseRefundProposal, cancel, ingestShopifyRefund, ingestShopifyCancellation, settle, payout, reconcile, setAutomationGuard };
}
