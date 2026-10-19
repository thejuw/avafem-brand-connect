import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { IntegrationError, IntegrationUnavailableError, cents, invalid } from './errors.mjs';
import { projectShippingAddress } from './projection.mjs';

// Keep request shapes pinned to the installed SDK's Endive contract. SDK upgrades
// must deliberately review this pin and its payload regression tests.
export const STRIPE_API_VERSION = '2026-09-30.endive';
// Public diagnostics may expose ONLY these static field/check names, never the
// rejected values or provider payloads. Consumers should import this allow-list.
export const STRIPE_TAX_VALIDATION_FIELDS = Object.freeze([
  'test_mode', 'transaction.shape', 'transaction.id', 'transaction.object', 'transaction.livemode', 'transaction.currency',
  'transaction.type', 'transaction.reference', 'transaction.created', 'transaction.posted_at', 'transaction.tax_date',
  'transaction.reversal.original_transaction', 'transaction.shipping_cost.amount', 'transaction.shipping_cost.amount_tax',
  'transaction.shipping_cost.tax_behavior', 'transaction.shipping_cost.tax_code',
  'line_items.shape', 'line_items.object', 'line_items.url', 'line_items.id', 'line_items.has_more', 'line_items.data',
  'line_items.page_size', 'line_items.nonempty_cursor', 'line_items.duplicate_id', 'line_items.pagination_limit',
  'line_item.shape', 'line_item.id', 'line_item.object', 'line_item.livemode', 'line_item.amount', 'line_item.amount_tax',
  'line_item.quantity', 'line_item.reference', 'line_item.tax_behavior', 'line_item.tax_code', 'line_item.type',
  'line_item.reversal.original_line_item',
]);

const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw invalid(`${label} must be a stable identifier.`);
  return value;
};
export const stripeTestRecipientContactEmail = brandId => `avafem-test-${createHash('sha256').update(identifier(brandId, 'Brand ID')).digest('hex').slice(0, 24)}@example.com`;
const checkoutLineReference = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(value)) throw invalid('Checkout line reference must be a bounded stable reference.');
  return value;
};
const currencyCode = value => {
  const currency = String(value ?? 'usd').toLowerCase();
  if (currency !== 'usd') throw invalid('This initial payment adapter supports USD only.');
  return currency;
};
const stripeId = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9]{8,}$`).test(value)) throw invalid(`A real Stripe ${prefix} identifier is required; simulated domain IDs are not accepted.`);
  return value;
};
const emailAddress = value => {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid('A valid email address is required.');
  return value;
};
const httpUrl = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid('An HTTPS return URL is required (localhost is allowed for local test mode).');
  if (url.username || url.password) throw invalid('Return URL cannot contain credentials.');
  return url.href;
};
function stripeAddress(address) {
  const safe = projectShippingAddress(address);
  if (!safe.country || !safe.postal || !safe.line1 || !safe.city) throw invalid('A complete shipping address is required.');
  return {
    ...(safe.name ? { name: safe.name } : {}),
    address: { line1: safe.line1, ...(safe.line2 ? { line2: safe.line2 } : {}), city: safe.city, state: safe.region, postal_code: safe.postal, country: safe.country },
  };
}

/**
 * Official Stripe SDK wrapper for platform charges + separate Connect transfers.
 * Default is test-only. No key -> unavailable; no fabricated account/link/payment is returned.
 * Live keys require allowLive:true. All money calls use explicit, stable business IDs for
 * idempotency, no automatic adapter retries, and a strict metadata/address allow-list.
 * config.client is for controlled tests; production callers should provide secretKey/env.
 */
export function createStripeAdapter(config = {}) {
  const env = config.env ?? process.env;
  const secretKey = config.secretKey ?? env.STRIPE_SECRET_KEY;
  const webhookSecret = config.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET;
  const live = /^(sk|rk)_live_/.test(secretKey ?? '');
  if (live && config.allowLive !== true) throw invalid('Live Stripe keys are disabled. Explicit deployment configuration is required.');
  if (secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(secretKey)) throw invalid('Stripe secret key format is invalid.');
  const client = config.client ?? (secretKey ? new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: config.timeoutMs ?? 20_000 }) : null);
  const requireClient = () => {
    if (!client) throw new IntegrationUnavailableError('Stripe', 'Set a real Stripe test secret key to enable Connect.');
    return client;
  };
  const status = () => ({ provider: 'stripe', available: Boolean(client), configured: Boolean(client), connected: false, verified: false, mode: live ? 'live' : 'test', testOnly: !live, webhookConfigured: Boolean(webhookSecret), message: client ? 'Credentials available; Stripe account capability checks have not been run.' : 'Stripe test credentials are not configured. Sandbox ledger examples are simulated.' });

  async function call(operation) {
    try {
      const result = await operation(requireClient());
      if (result?.livemode === true && config.allowLive !== true) throw new IntegrationError('Stripe returned a live object while the adapter is test-only.', { code: 'STRIPE_MODE_MISMATCH', statusCode: 409 });
      return result;
    } catch (cause) {
      if (cause instanceof IntegrationError) throw cause;
      throw new IntegrationError('Stripe rejected or could not complete the request.', {
        code: 'STRIPE_REQUEST_FAILED', statusCode: cause.statusCode === 429 ? 429 : 502,
        retryable: ['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'].includes(cause.type),
        details: { stripeCode: cause.code, type: cause.type, requestId: cause.requestId }, cause,
      });
    }
  }

  // These acceptance helpers are deliberately stricter than the legacy adapter:
  // even allowLive:true cannot opt them into live provider operations. A controlled
  // config.client may stand in for a test key only in offline unit tests.
  function requireTestMode() {
    if (live || config.allowLive === true) throw invalid('Unified checkout and payout helpers are test-only.');
    requireClient();
  }
  function checkTestObjects(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.livemode === true) throw new IntegrationError('Stripe returned a live object to a test-only helper.', { code: 'STRIPE_MODE_MISMATCH', statusCode: 409 });
    for (const child of Object.values(value)) checkTestObjects(child, seen);
  }
  async function testCall(operation) {
    requireTestMode();
    const result = await call(operation);
    checkTestObjects(result);
    return result;
  }
  const checkoutId = value => {
    if (typeof value !== 'string' || !/^cs_test_[A-Za-z0-9]{8,}$/.test(value)) throw invalid('A real test Checkout Session ID is required.');
    return value;
  };
  const boundedText = (value, label, max = 200) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${label} is invalid.`);
    return value.trim();
  };
  const taxCode = value => {
    if (typeof value !== 'string' || !/^txcd_[0-9]+$/.test(value)) throw invalid('An explicit Stripe Tax code is required for every line and shipping rate.');
    return value;
  };
  const connectedOptions = accountId => ({ stripeAccount: stripeId(accountId, 'acct') });
  const readbackId = (result, expected) => {
    if (result?.id !== expected) throw new IntegrationError('Stripe readback did not match the requested object.', { code: 'STRIPE_READBACK_MISMATCH', statusCode: 409 });
    return result;
  };

  /** One hosted, card-only TEST checkout for a whole basket. No bank, account-wide
   * Managed Payments, or terms changes occur here. Callers own stock reservation,
   * immutable per-brand allocation, durable attempt storage and paid verification.
   * Unknown input properties (including arbitrary metadata/health data) are ignored.
   */
  async function createCheckoutSession({ orderId, items, shippingCents = 0, shippingTaxCode, successUrl, cancelUrl, customerEmail, currency = 'usd', captureMethod = 'manual' }) {
    requireTestMode(); identifier(orderId, 'Order ID'); currencyCode(currency);
    if (!['manual', 'automatic'].includes(captureMethod)) throw invalid('Checkout capture method must be manual or automatic.');
    if (!Array.isArray(items) || !items.length || items.length > 100) throw invalid('Checkout requires 1–100 fixed line items.');
    const references = new Set();
    let subtotal = 0;
    const lineItems = items.map(item => {
      const reference = checkoutLineReference(item.reference);
      if (references.has(reference)) throw invalid('Checkout line references must be unique.');
      references.add(reference);
      const qty = item.qty ?? item.quantity;
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1000) throw invalid('Checkout line quantity must be an integer from 1 to 1000.');
      const unit = cents(item.unitPriceCents, 'checkout unit price', { allowZero: false });
      subtotal = cents(subtotal + cents(unit * qty, 'checkout line total'), 'checkout subtotal');
      const metadata = { reference, ...(item.sku ? { sku: boundedText(item.sku, 'SKU', 128) } : {}) };
      // Both metadata paths are documented by the current Endive create API:
      // https://docs.stripe.com/api/checkout/sessions/create?query=line_items
      return { quantity: qty, metadata, price_data: { currency: 'usd', unit_amount: unit, tax_behavior: 'exclusive',
        product_data: { name: boundedText(item.title, 'Product title'), tax_code: taxCode(item.taxCode), metadata } } };
    });
    cents(shippingCents, 'shipping'); cents(subtotal + shippingCents, 'checkout total');
    const shippingCode = taxCode(shippingTaxCode);
    const params = {
      mode: 'payment', ui_mode: 'hosted_page', allowed_payment_method_types: ['card'],
      managed_payments: { enabled: false }, automatic_tax: { enabled: true },
      client_reference_id: orderId, metadata: { order_id: orderId, integration: 'avafem' },
      payment_intent_data: { capture_method: captureMethod, transfer_group: `ORD_${orderId}`, metadata: { order_id: orderId, integration: 'avafem' } },
      line_items: lineItems, shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: shippingCents, currency: 'usd' },
        display_name: 'Combined brand shipping (TEST)', tax_behavior: 'exclusive', tax_code: shippingCode } }],
      success_url: httpUrl(successUrl), cancel_url: httpUrl(cancelUrl),
      ...(customerEmail ? { customer_email: emailAddress(customerEmail) } : {}),
    };
    const session = await testCall(stripe => stripe.checkout.sessions.create(params, { idempotencyKey: `checkout:${orderId}:v1` }));
    checkoutId(session?.id);
    return session;
  }

  async function getCheckoutSession(sessionId) {
    checkoutId(sessionId);
    return readbackId(await testCall(stripe => stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge.balance_transaction', 'total_details.breakdown', 'shipping_cost.taxes'],
    })), sessionId);
  }

  /** Returns one provider page, including has_more. Callers must finish pagination
   * before accepting line totals; never assume the Session's inline list is full.
   */
  async function listCheckoutLineItems(sessionId, { startingAfter, limit = 100 } = {}) {
    checkoutId(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('Checkout line page size must be 1–100.');
    if (startingAfter !== undefined) stripeId(startingAfter, 'li');
    return testCall(stripe => stripe.checkout.sessions.listLineItems(sessionId, {
      limit, ...(startingAfter ? { starting_after: startingAfter } : {}), expand: ['data.price.product', 'data.taxes'],
    }));
  }

  async function getCharge(chargeId) {
    stripeId(chargeId, 'ch');
    return readbackId(await testCall(stripe => stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] })), chargeId);
  }
  async function getRefund(refundId) {
    stripeId(refundId, 're');
    return readbackId(await testCall(stripe => stripe.refunds.retrieve(refundId, { expand: ['balance_transaction'] })), refundId);
  }
  async function getTransfer(transferId) {
    stripeId(transferId, 'tr');
    return readbackId(await testCall(stripe => stripe.transfers.retrieve(transferId, { expand: ['balance_transaction'] })), transferId);
  }
  async function getReversal(transferId, reversalId) {
    stripeId(transferId, 'tr'); stripeId(reversalId, 'trr');
    const reversal = readbackId(await testCall(stripe => stripe.transfers.retrieveReversal(transferId, reversalId, { expand: ['balance_transaction'] })), reversalId);
    if (reversal.transfer !== transferId) throw new IntegrationError('Stripe reversal belongs to another transfer.', { code: 'STRIPE_READBACK_MISMATCH', statusCode: 409 });
    return reversal;
  }
  async function getBalance({ accountId } = {}) {
    // Omitted means platform. An explicitly supplied empty/unknown context never
    // silently falls back to the platform balance.
    const options = accountId === undefined ? {} : connectedOptions(accountId);
    return testCall(stripe => stripe.balance.retrieve({}, options));
  }
  async function getBalanceTransaction(transactionId, { accountId } = {}) {
    stripeId(transactionId, 'txn');
    const options = accountId === undefined ? {} : connectedOptions(accountId);
    return readbackId(await testCall(stripe => stripe.balanceTransactions.retrieve(transactionId, {}, options)), transactionId);
  }

  const taxRecordId = value => {
    if (typeof value !== 'string' || !/^tax_[A-Za-z0-9]{8,128}$/.test(value)) throw invalid('A bounded Stripe Tax Transaction ID is required.');
    return value;
  };
  const taxLineId = value => typeof value === 'string' && /^tax_li_[A-Za-z0-9]{8,128}$/.test(value);
  const taxReadMismatch = fields => new IntegrationError('The complete Stripe TEST tax record could not be verified.', {
    code: 'STRIPE_TAX_READBACK_MISMATCH', statusCode: 409,
    details: { validationFields: [...new Set(fields)].filter(field => STRIPE_TAX_VALIDATION_FIELDS.includes(field)).slice(0, 24) },
  });
  const validateTaxFields = checks => {
    const failed = checks.filter(([, valid]) => !valid).map(([field]) => field);
    if (failed.length) throw taxReadMismatch(failed);
  };
  function checkTaxLine(line) {
    if (!line) throw taxReadMismatch(['line_item.shape']);
    validateTaxFields([
      ['line_item.object', line.object === 'tax.transaction_line_item'], ['line_item.id', taxLineId(line.id)],
      ['line_item.livemode', line.livemode === false], ['line_item.amount', Number.isSafeInteger(line.amount)],
      ['line_item.amount_tax', Number.isSafeInteger(line.amount_tax)],
      ['line_item.quantity', Number.isFinite(line.quantity) && line.quantity > 0 && line.quantity <= Number.MAX_SAFE_INTEGER],
      ['line_item.reference', typeof line.reference === 'string' && line.reference.length <= 500],
      ['line_item.tax_behavior', ['exclusive', 'inclusive'].includes(line.tax_behavior)], ['line_item.tax_code', /^txcd_[0-9]{1,32}$/.test(line.tax_code ?? '')],
      ['line_item.type', ['transaction', 'reversal'].includes(line.type)],
      ['line_item.reversal.original_line_item', line.type === 'reversal' ? taxLineId(line.reversal?.original_line_item) : line.reversal === null],
    ]);
  }
  function checkTaxPage(page, transactionId) {
    if (!page) throw taxReadMismatch(['line_items.shape']);
    validateTaxFields([
      ['line_items.object', page.object === 'list'], ['line_items.url', page.url === `/v1/tax/transactions/${transactionId}/line_items`],
      ['line_items.id', page.id === undefined || page.id === transactionId], ['line_items.has_more', typeof page.has_more === 'boolean'],
      ['line_items.data', Array.isArray(page.data)], ['line_items.page_size', Array.isArray(page.data) && page.data.length <= 100],
      ['line_items.nonempty_cursor', !page.has_more || (Array.isArray(page.data) && page.data.length > 0)],
    ]);
    const ids = new Set();
    for (const line of page.data) {
      checkTaxLine(line);
      if (ids.has(line.id)) throw taxReadMismatch(['line_items.duplicate_id']);
      ids.add(line.id);
    }
  }
  // Tax reads have a stricter error boundary: no upstream message, response,
  // parameters, customer address, metadata, or raw Error/cause is retained.
  async function taxReadCall(operation, expectedTaxId) {
    try { return await testCall(operation); }
    catch (cause) {
      const safeIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value)
        && !/(?:sk_|rk_|whsec_|secret|password|token)/i.test(value) ? value : undefined;
      const details = {};
      const stripeCode = safeIdentifier(cause?.details?.stripeCode);
      const type = cause?.details?.type;
      const requestId = cause?.details?.requestId;
      if (stripeCode) details.stripeCode = stripeCode;
      if (typeof type === 'string' && /^Stripe(?:API|Authentication|Card|Connection|Idempotency|InvalidRequest|Permission|RateLimit|SignatureVerification)Error$/.test(type)) details.type = type;
      if (typeof requestId === 'string' && /^req_[A-Za-z0-9]{1,80}$/.test(requestId)) details.requestId = requestId;
      if (cause?.code === 'STRIPE_MODE_MISMATCH') details.validationFields = ['test_mode'];
      // Native Checkout Tax records are not standalone API-created records. Only
      // the exact SDK 404 for THIS requested ID earns this classification. Do not
      // expose/retain the raw provider message or mistake another 404, bad object,
      // mode mismatch, or generic permission failure for this specific boundary.
      const upstream = cause?.cause;
      const managedRecord = cause?.code === 'STRIPE_REQUEST_FAILED' && /^tax_[A-Za-z0-9]{8,128}$/.test(expectedTaxId ?? '')
        && upstream?.statusCode === 404 && upstream.type === 'StripeInvalidRequestError'
        && upstream.message === `The transaction you are trying to fetch is managed by Stripe: '${expectedTaxId}'. Provide the ID of a transaction you created.`;
      const code = managedRecord ? 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE'
        : ['STRIPE_MODE_MISMATCH', 'INTEGRATION_UNAVAILABLE', 'INVALID_INTEGRATION_INPUT'].includes(cause?.code) ? cause.code : 'STRIPE_REQUEST_FAILED';
      throw new IntegrationError(managedRecord ? 'Stripe-managed TEST tax records are unavailable through the standalone Tax Transaction API.'
        : 'Stripe TEST tax records are unavailable or could not be verified.', {
        code, statusCode: managedRecord || code === 'STRIPE_MODE_MISMATCH' ? 409 : code === 'INTEGRATION_UNAVAILABLE' ? 503
          : code === 'INVALID_INTEGRATION_INPUT' ? 422 : cause?.statusCode === 429 ? 429 : 502,
        retryable: cause?.retryable === true, ...(Object.keys(details).length ? { details } : {}),
      });
    }
  }
  /** Read-only, strictly TEST, internal provider evidence (contains customer PII).
   * Endive/stripe-node23: tax.transactions.retrieve(id,{expand:['line_items']}).
   * https://docs.stripe.com/api/tax/transactions/retrieve
   * reference is not guaranteed to be a Checkout/PI/refund ID. Only
   * reversal.original_transaction links tax transactions; caller must separately
   * prove payment/refund provenance and redact/encrypt this raw object.
   * An expanded inline line_items page can remain incomplete; use the complete
   * list helper before accepting amounts. Never creates/reverses a tax record.
   */
  async function getTaxTransaction(transactionId) {
    taxRecordId(transactionId);
    const result = await taxReadCall(stripe => stripe.tax.transactions.retrieve(transactionId, { expand: ['line_items'] }), transactionId);
    if (!result) throw taxReadMismatch(['transaction.shape']);
    validateTaxFields([
      ['transaction.id', result.id === transactionId], ['transaction.object', result.object === 'tax.transaction'],
      ['transaction.livemode', result.livemode === false], ['transaction.currency', result.currency === 'usd'],
      ['transaction.type', ['transaction', 'reversal'].includes(result.type)],
      ['transaction.reference', typeof result.reference === 'string' && result.reference.length <= 500],
      ...['created', 'posted_at', 'tax_date'].map(key => [`transaction.${key}`, Number.isSafeInteger(result[key]) && result[key] >= 0]),
      ['transaction.reversal.original_transaction', result.type === 'reversal' ? typeof result.reversal?.original_transaction === 'string'
        && /^tax_[A-Za-z0-9]{8,128}$/.test(result.reversal.original_transaction) && result.reversal.original_transaction !== transactionId : result.reversal === null],
      ...(result.shipping_cost == null ? [] : [
        ['transaction.shipping_cost.amount', Number.isSafeInteger(result.shipping_cost.amount)],
        ['transaction.shipping_cost.amount_tax', Number.isSafeInteger(result.shipping_cost.amount_tax)],
        ['transaction.shipping_cost.tax_behavior', ['exclusive', 'inclusive'].includes(result.shipping_cost.tax_behavior)],
        ['transaction.shipping_cost.tax_code', /^txcd_[0-9]{1,32}$/.test(result.shipping_cost.tax_code ?? '')],
      ]),
    ]);
    if (result.line_items != null) checkTaxPage(result.line_items, transactionId);
    return result;
  }
  /** Complete bounded TEST tax line collection, raw/internal only. Validates the
   * parent first; fixed 100/page, at most10 pages/1000 unique lines. Any truncated,
   * duplicate, cross-parent or live result fails closed; no partial list returns.
   * https://docs.stripe.com/api/tax/transactions/line_items
   */
  async function listTaxTransactionLineItems(transactionId) {
    taxRecordId(transactionId);
    await getTaxTransaction(transactionId);
    const data = []; const ids = new Set(); let startingAfter;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await taxReadCall(stripe => stripe.tax.transactions.listLineItems(transactionId, {
        limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}),
      }), transactionId);
      checkTaxPage(page, transactionId);
      for (const line of page.data) {
        if (ids.has(line.id)) throw taxReadMismatch(['line_items.duplicate_id']);
        ids.add(line.id); data.push(line);
      }
      if (!page.has_more) return { object: 'list', url: page.url, data, has_more: false };
      startingAfter = page.data.at(-1).id;
    }
    throw new IntegrationError('Stripe TEST tax line pagination exceeded the bounded complete-read limit.', {
      code: 'STRIPE_TAX_PAGINATION_REQUIRED', statusCode: 409, details: { validationFields: ['line_items.pagination_limit'] },
    });
  }

  /** Only for newly authorized test recipients in a caller-maintained registry.
   * A successful transfer is not bank-payout evidence. This method returns the
   * actual pending Payout; getPayout/webhooks must establish its final status.
   * It never changes payout schedules, external accounts, KYC or agreements.
   */
  async function createTestPayout({ accountId, amountCents, orderId, bagId, payoutId, destination, currency = 'usd' }) {
    requireTestMode(); const options = connectedOptions(accountId);
    identifier(orderId, 'Order ID'); identifier(bagId, 'Bag ID'); identifier(payoutId, 'Payout business ID');
    cents(amountCents, 'test payout', { allowZero: false }); currencyCode(currency);
    if (destination !== undefined) stripeId(destination, 'ba');
    const registry = config.testConnectedAccountIds;
    const authorized = typeof registry === 'function' ? await registry(accountId) : registry instanceof Set ? registry.has(accountId) : Array.isArray(registry) && registry.includes(accountId);
    if (authorized !== true) throw invalid('Payout requires an explicitly authorized newly created test connected account.');
    const account = readbackId(await testCall(stripe => stripe.accounts.retrieve(accountId)), accountId);
    if (account.type !== 'express') await getTestConnectedAccountV2(accountId);
    if (account.country !== 'US' || account.payouts_enabled !== true
      || account.capabilities?.transfers !== 'active' || account.requirements?.disabled_reason
      || (account.requirements?.currently_due?.length ?? 0) > 0 || (account.requirements?.past_due?.length ?? 0) > 0) {
      throw invalid('The authorized test Express account is not ready for payouts.');
    }
    const external = account.external_accounts;
    if (!Array.isArray(external?.data) || external.has_more === true) throw invalid('Verify the complete test external bank account list before payout.');
    const bank = external.data.find(entry => entry.object === 'bank_account' && entry.currency === 'usd'
      && entry.country === 'US' && (destination ? entry.id === destination : entry.default_for_currency === true));
    if (!bank || ['errored', 'verification_failed'].includes(bank.status)) throw invalid('A usable US test bank payout destination is required.');
    stripeId(bank.id, 'ba');
    const balance = await getBalance({ accountId });
    const available = balance.available?.find(entry => entry.currency === 'usd');
    if (!Number.isSafeInteger(available?.amount) || available.amount < amountCents
      || !Number.isSafeInteger(available.source_types?.card) || available.source_types.card < amountCents) {
      throw invalid('The connected account has insufficient available USD card balance for this test payout.');
    }
    const payout = await testCall(stripe => stripe.payouts.create({ amount: amountCents, currency: 'usd', method: 'standard',
      destination: bank.id, source_type: 'card', metadata: { order_id: orderId, bag_id: bagId, payout_id: payoutId, integration: 'avafem' } },
    { ...options, idempotencyKey: `payout:${bagId}:${payoutId}:v1` }));
    stripeId(payout?.id, 'po');
    return payout;
  }
  async function getPayout(payoutId, { accountId } = {}) {
    stripeId(payoutId, 'po'); const options = connectedOptions(accountId);
    return readbackId(await testCall(stripe => stripe.payouts.retrieve(payoutId, { expand: ['balance_transaction'] }, options)), payoutId);
  }
  /** Internal provider evidence only; callers must project/redact before output. */
  async function getTestConnectedAccount(accountId) {
    stripeId(accountId, 'acct');
    return readbackId(await testCall(stripe => stripe.accounts.retrieve(accountId)), accountId);
  }
  const recipientInclude = ['configuration.recipient', 'identity', 'defaults', 'requirements'];
  function verifiedV2Recipient(raw, accountId, brandId) {
    readbackId(raw, accountId);
    if (raw.object !== 'v2.core.account' || raw.livemode !== false || raw.dashboard !== 'express'
      || raw.identity?.country?.toUpperCase() !== 'US'
      || raw.defaults?.responsibilities?.fees_collector !== 'application' || raw.defaults?.responsibilities?.losses_collector !== 'application'
      || !Array.isArray(raw.applied_configurations) || raw.applied_configurations.length !== 1 || raw.applied_configurations[0] !== 'recipient'
      || !raw.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers
      || raw.metadata?.integration !== 'avafem' || typeof raw.metadata?.brand_id !== 'string'
      || (brandId && raw.metadata.brand_id !== brandId)) throw invalid('A test US Express recipient with the exact Avafem metadata and platform responsibilities is required.');
    return raw;
  }
  /** Internal v2 identity/control evidence. The unmodified v1 account projection
   * remains authoritative for existing transfers/balance/payout operations. */
  async function getTestConnectedAccountV2(accountId) {
    stripeId(accountId, 'acct');
    return verifiedV2Recipient(await testCall(stripe => stripe.v2.core.accounts.retrieve(accountId, { include: recipientInclude })), accountId);
  }
  async function createExpressRecipientV2({ brandId, country = 'US', email, manualPayouts = true, parameterRevision = 3 }) {
    requireTestMode(); identifier(brandId, 'Brand ID');
    const synthetic = stripeTestRecipientContactEmail(brandId);
    if (country !== 'US' || manualPayouts !== true || parameterRevision !== 3 || (email !== undefined && email !== synthetic))
      throw invalid('Recipient API revision3 requires the fixed test US synthetic contact and separate manual payout setup.');
    const raw = await testCall(stripe => stripe.v2.core.accounts.create({ contact_email: synthetic, dashboard: 'express', identity: { country: 'US' },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      defaults: { currency: 'usd', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
      metadata: { integration: 'avafem', brand_id: brandId }, include: recipientInclude }, { idempotencyKey: `brand-account:${brandId}:v3` }));
    stripeId(raw?.id, 'acct');
    // Return the actual ID immediately. The durable orchestrator must persist it
    // before further identity readback/setup; malformed response is never replaced.
    return raw;
  }
  async function getTestBalanceSettings(accountId) {
    const options = connectedOptions(accountId);
    return testCall(stripe => stripe.balanceSettings.retrieve({}, options));
  }
  async function configureTestRecipientManualPayouts({ accountId, brandId }) {
    identifier(brandId, 'Brand ID');
    const raw = await getTestConnectedAccountV2(accountId); verifiedV2Recipient(raw, accountId, brandId);
    await testCall(stripe => stripe.balanceSettings.update({ payments: { payouts: { schedule: { interval: 'manual' } } } },
      { ...connectedOptions(accountId), idempotencyKey: `recipient-manual:${accountId}:v1` }));
    const settings = await getTestBalanceSettings(accountId);
    if (settings?.payments?.payouts?.schedule?.interval !== 'manual') throw invalid('The new test recipient manual payout schedule did not verify. Preserve its original account ID.');
    return settings;
  }
  async function createRecipientOnboardingLinkV2({ accountId, refreshUrl, returnUrl, requestId }) {
    stripeId(accountId, 'acct'); identifier(requestId, 'Onboarding request ID');
    await getTestConnectedAccountV2(accountId);
    const raw = await testCall(stripe => stripe.v2.core.accountLinks.create({ account: accountId, use_case: { type: 'account_onboarding',
      account_onboarding: { refresh_url: httpUrl(refreshUrl), return_url: httpUrl(returnUrl) } } }, { idempotencyKey: `onboarding-v2:${accountId}:${requestId}` }));
    if (raw?.account !== accountId || raw.livemode !== false || typeof raw.url !== 'string' || !Number.isFinite(Date.parse(raw.expires_at)))
      throw invalid('The actual test recipient onboarding link did not verify.');
    return raw;
  }
  /** V2 uses next_page_url/page, not v1 has_more/starting_after. Complete bounded
   * active AND closed reads are required; callers must not infer absence from a page. */
  async function listTestConnectedAccountsV2() {
    requireTestMode(); const accounts = [], seen = new Set(); let pages = 0;
    for (const closed of [false, true]) {
      let page;
      do {
        if (++pages > 100) throw new IntegrationError('Complete v2 account list exceeded its bounded page limit.', { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED', statusCode: 409 });
        const result = await testCall(stripe => stripe.v2.core.accounts.list({ limit: 20, closed, ...(page ? { page } : {}) }));
        if (!Array.isArray(result?.data) || result.data.length > 20 || !(result.next_page_url === null || typeof result.next_page_url === 'string'))
          throw invalid('Complete v2 connected-account pagination is required.');
        for (const raw of result.data) {
          stripeId(raw?.id, 'acct');
          if (raw.livemode !== false || seen.has(raw.id) || !Number.isFinite(Date.parse(raw.created))
            || !raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) throw invalid('V2 connected-account identity, metadata and timestamps must verify.');
          seen.add(raw.id); accounts.push(raw);
        }
        if (result.next_page_url === null) break;
        const next = new URL(result.next_page_url, 'https://api.stripe.com');
        const token = next.searchParams.get('page');
        if (next.origin !== 'https://api.stripe.com' || next.pathname !== '/v2/core/accounts'
          || !/^[A-Za-z0-9_-]{1,500}$/.test(token ?? '') || token === page || !result.data.length)
          throw invalid('V2 connected-account cursor is not a safe continuation.');
        page = token;
      } while (true);
    }
    return accounts;
  }
  /** Authorization is not payment. Callers revalidate the whole basket before
   * invoking capture, then verify succeeded/amount_received from provider evidence.
   */
  async function capturePaymentIntent({ paymentIntentId, orderId, amountCents }) {
    stripeId(paymentIntentId, 'pi'); identifier(orderId, 'Order ID');
    cents(amountCents, 'capture amount', { allowZero: false });
    return readbackId(await testCall(stripe => stripe.paymentIntents.capture(paymentIntentId, { amount_to_capture: amountCents },
      { idempotencyKey: `capture:${orderId}:v1` })), paymentIntentId);
  }
  /** Checkout-owned PaymentIntents may be canceled directly only while
   * requires_capture. The caller must expire the Session for other open states.
   */
  async function cancelPaymentIntent({ paymentIntentId, orderId }) {
    stripeId(paymentIntentId, 'pi'); identifier(orderId, 'Order ID');
    return readbackId(await testCall(stripe => stripe.paymentIntents.cancel(paymentIntentId, {},
      { idempotencyKey: `cancel:${orderId}:v1` })), paymentIntentId);
  }
  /** Close only a saved, exact-bound TEST failure checkout. Expiration prevents
   * a declined/open hosted Session from being paid later. It never captures or
   * refunds money; expired replay is a read, not a replacement mutation.
   * https://docs.stripe.com/api/checkout/sessions/expire
   */
  async function expireTestCheckoutSession({ sessionId, orderId }) {
    requireTestMode(); checkoutId(sessionId); identifier(orderId, 'Order ID');
    const current = await getCheckoutSession(sessionId);
    if (current.livemode !== false || current.mode !== 'payment' || current.currency !== 'usd'
      || current.client_reference_id !== orderId || current.metadata?.order_id !== orderId || current.metadata?.integration !== 'avafem'
      || !['open','expired'].includes(current.status) || !Number.isSafeInteger(current.amount_total)
      || current.amount_total < 0 || current.amount_total > 1000)
      throw invalid('Expire only this exact saved, bounded TEST failure Session.');
    if (current.status === 'expired') return current;
    const result = readbackId(await testCall(stripe => stripe.checkout.sessions.expire(sessionId, {},
      { idempotencyKey: `failure-expire:${orderId}:v1` })), sessionId);
    if (result.livemode !== false || result.status !== 'expired' || result.client_reference_id !== orderId)
      throw new IntegrationError('The TEST Session expiration could not be verified.', { code: 'STRIPE_READBACK_MISMATCH', statusCode: 409 });
    return result;
  }

  async function preflight() {
    const account = await call(stripe => stripe.accounts.retrieve());
    return { provider: 'stripe', available: true, connected: true, verified: true, mode: live ? 'live' : 'test', accountId: account.id, country: account.country, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled };
  }

  /** INTERNAL raw account readback for one explicitly controlled recipient
   * recovery. Full bounded pagination is mandatory; no partial-list empty claim.
   * https://docs.stripe.com/api/accounts/list */
  async function listTestConnectedAccounts({ createdAfter, createdBefore } = {}) {
    requireTestMode();
    if ((createdAfter !== undefined && (!Number.isSafeInteger(createdAfter) || createdAfter < 0))
      || (createdBefore !== undefined && (!Number.isSafeInteger(createdBefore) || createdBefore < 0))
      || (createdAfter !== undefined && createdBefore !== undefined && createdAfter > createdBefore)) throw invalid('A valid bounded connected-account creation interval is required.');
    const created = { ...(createdAfter !== undefined ? { gte: createdAfter } : {}), ...(createdBefore !== undefined ? { lte: createdBefore } : {}) };
    const accounts = [], seen = new Set(); let after;
    for (let page = 0; page < 100; page++) {
      const result = await testCall(stripe => stripe.accounts.list({ limit: 100,
        ...(Object.keys(created).length ? { created } : {}), ...(after ? { starting_after: after } : {}) }));
      if (!Array.isArray(result?.data) || typeof result.has_more !== 'boolean' || result.data.length > 100)
        throw new IntegrationError('Complete connected-account list evidence is required.', { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED', statusCode: 409 });
      for (const account of result.data) {
        stripeId(account?.id, 'acct');
        if (seen.has(account.id) || !Number.isSafeInteger(account.created) || !account.metadata || typeof account.metadata !== 'object' || Array.isArray(account.metadata))
          throw new IntegrationError('Connected-account identities, metadata and pagination must verify.', { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED', statusCode: 409 });
        seen.add(account.id); accounts.push(account);
      }
      if (result.has_more === false) return accounts;
      after = result.data.at(-1)?.id;
      if (!after) throw new IntegrationError('Connected-account pagination cannot continue safely.', { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED', statusCode: 409 });
    }
    throw new IntegrationError('Connected-account list exceeded its bounded complete-read limit.', { code: 'STRIPE_ACCOUNT_PAGINATION_REQUIRED', statusCode: 409 });
  }

  async function createExpressAccount({ brandId, email, country = 'US', manualPayouts = false,
    parameterRevision = !live && config.allowLive !== true ? 2 : 1 }) {
    identifier(brandId, 'Brand ID');
    if (!/^[A-Z]{2}$/.test(country)) throw invalid('Connected account country must be an ISO country code.');
    if (typeof manualPayouts !== 'boolean') throw invalid('Manual payout preference must be boolean.');
    if (manualPayouts) requireTestMode();
    if (![1, 2].includes(parameterRevision)) throw invalid('Recipient parameter revision must be1 or2.');
    if (parameterRevision === 2) {
      requireTestMode();
      const synthetic = stripeTestRecipientContactEmail(brandId);
      if (email !== undefined && email !== synthetic) throw invalid('The new TEST recipient revision requires its fixed synthetic example.com contact email.');
      email = synthetic;
    }
    return call(stripe => stripe.accounts.create({ type: 'express', country, ...(email ? { email: emailAddress(email) } : {}), capabilities: { transfers: { requested: true } },
      ...(manualPayouts ? { settings: { payouts: { schedule: { interval: 'manual' } } } } : {}),
      metadata: { brand_id: brandId, integration: 'avafem' } }, { idempotencyKey: `brand-account:${brandId}:v${parameterRevision}` }));
  }

  async function createOnboardingLink({ accountId, refreshUrl, returnUrl, requestId }) {
    stripeId(accountId, 'acct');
    identifier(requestId, 'Onboarding request ID');
    return call(stripe => stripe.accountLinks.create({ account: accountId, type: 'account_onboarding', refresh_url: httpUrl(refreshUrl), return_url: httpUrl(returnUrl) }, { idempotencyKey: `onboarding:${accountId}:${requestId}` }));
  }

  async function getConnectedAccount(accountId) {
    stripeId(accountId, 'acct');
    const account = await call(stripe => stripe.accounts.retrieve(accountId));
    return { id: account.id, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, transfersCapability: account.capabilities?.transfers, currentlyDue: account.requirements?.currently_due ?? [], disabledReason: account.requirements?.disabled_reason ?? null };
  }

  async function createTaxCalculation({ orderId, calculationId, items, shippingCents = 0, shipTo, currency = 'usd', shippingTaxCode }) {
    identifier(orderId, 'Order ID');
    identifier(calculationId, 'Tax calculation revision ID');
    if (!Array.isArray(items) || !items.length) throw invalid('Tax calculation requires line items.');
    const shipping = stripeAddress(shipTo);
    const lineItems = items.map(item => {
      const qty = item.qty ?? item.quantity;
      if (!Number.isSafeInteger(qty) || qty < 1) throw invalid('Tax line quantity must be positive.');
      const reference = identifier(item.reference ?? (item.bagId && item.sku ? `${item.bagId}_${item.sku}` : undefined), 'Tax line reference');
      if (typeof item.taxCode !== 'string' || !/^txcd_[0-9]+$/.test(item.taxCode)) throw invalid('Each tax line needs an explicitly configured tax code.');
      const unit = cents(item.unitPriceCents ?? item.unit_price, 'tax line unit price');
      return { amount: cents(unit * qty, 'tax line total'), quantity: qty, reference, tax_code: item.taxCode, tax_behavior: 'exclusive' };
    });
    if (new Set(lineItems.map(item => item.reference)).size !== lineItems.length) throw invalid('Tax line references must be unique within the calculation.');
    const params = { currency: currencyCode(currency), customer_details: { address: shipping.address, address_source: 'shipping' }, line_items: lineItems, expand: ['line_items'] };
    cents(shippingCents, 'shipping');
    if (shippingCents) {
      if (!/^txcd_[0-9]+$/.test(shippingTaxCode ?? '')) throw invalid('Shipping needs an explicitly configured tax code.');
      params.shipping_cost = { amount: shippingCents, tax_behavior: 'exclusive', tax_code: shippingTaxCode };
    }
    return call(stripe => stripe.tax.calculations.create(params, { idempotencyKey: `tax:${orderId}:${calculationId}` }));
  }

  async function recordTaxTransaction({ calculationId, orderId }) {
    stripeId(calculationId, 'taxcalc'); identifier(orderId, 'Order ID');
    return call(stripe => stripe.tax.transactions.createFromCalculation({ calculation: calculationId, reference: orderId }, { idempotencyKey: `tax-transaction:${orderId}:v1` }));
  }

  async function reverseTaxTransaction({ transactionId, refundId, mode = 'full', lineItems, shipping }) {
    stripeId(transactionId, 'tax'); identifier(refundId, 'Refund ID');
    if (!['full', 'partial'].includes(mode)) throw invalid('Tax reversal mode must be full or partial.');
    const params = { original_transaction: transactionId, reference: refundId, mode };
    if (mode === 'partial') {
      if (!Array.isArray(lineItems) || !lineItems.length) throw invalid('Partial tax reversal requires authoritative original line IDs and amounts.');
      params.line_items = lineItems.map(line => ({ original_line_item: stripeId(line.originalLineItemId, 'tax_li'), amount: -cents(line.amountCents, 'tax reversal amount', { allowZero: false }), amount_tax: -cents(line.taxCents, 'tax reversal tax') }));
      if (shipping) params.shipping_cost = { amount: -cents(shipping.amountCents, 'shipping reversal'), amount_tax: -cents(shipping.taxCents, 'shipping tax reversal') };
    }
    return call(stripe => stripe.tax.transactions.createReversal(params, { idempotencyKey: `tax-reversal:${refundId}:v1` }));
  }

  async function createPaymentIntent({ orderId, amountCents, currency = 'usd', shipTo, receiptEmail, paymentMethodId, confirm = false }) {
    identifier(orderId, 'Order ID');
    const shipping = stripeAddress(shipTo);
    const params = {
      amount: cents(amountCents, 'payment amount', { allowZero: false }), currency: currencyCode(currency),
      shipping, transfer_group: `ORD_${orderId}`, metadata: { order_id: orderId, integration: 'avafem' },
      // Endive removed payment_method_types as an input. The allow-list keeps
      // this flow card-only while Dashboard settings control availability.
      allowed_payment_method_types: ['card'],
      ...(receiptEmail ? { receipt_email: emailAddress(receiptEmail) } : {}),
    };
    // Only this official success fixture is accepted, and never with a live key/config.
    if (paymentMethodId) params.payment_method = paymentMethodId === 'pm_card_visa' && !live && config.allowLive !== true
      ? paymentMethodId : stripeId(paymentMethodId, 'pm');
    if (confirm) {
      if (!paymentMethodId) throw invalid('Confirming a PaymentIntent requires a payment method ID.');
      params.confirm = true;
    }
    return call(stripe => stripe.paymentIntents.create(params, { idempotencyKey: `payment:${orderId}:v1` }));
  }

  async function getPaymentIntent(paymentIntentId) {
    stripeId(paymentIntentId, 'pi');
    return call(stripe => stripe.paymentIntents.retrieve(paymentIntentId));
  }

  async function createTransfer({ orderId, bagId, amountCents, accountId, chargeId, currency = 'usd' }) {
    identifier(orderId, 'Order ID'); identifier(bagId, 'Bag ID');
    stripeId(accountId, 'acct'); stripeId(chargeId, 'ch');
    return call(stripe => stripe.transfers.create({ amount: cents(amountCents, 'brand transfer', { allowZero: false }), currency: currencyCode(currency), destination: accountId, source_transaction: chargeId, transfer_group: `ORD_${orderId}`, metadata: { order_id: orderId, bag_id: bagId } }, { idempotencyKey: `transfer:${bagId}:v1` }));
  }

  async function createRefund({ paymentIntentId, chargeId, amountCents, bagId, refundId }) {
    identifier(bagId, 'Bag ID'); identifier(refundId, 'Refund ID');
    if (Boolean(paymentIntentId) === Boolean(chargeId)) throw invalid('Provide exactly one original PaymentIntent or charge for a refund.');
    const source = paymentIntentId ? { payment_intent: stripeId(paymentIntentId, 'pi') } : { charge: stripeId(chargeId, 'ch') };
    return call(stripe => stripe.refunds.create({ ...source, amount: cents(amountCents, 'shopper refund', { allowZero: false }), metadata: { bag_id: bagId, refund_id: refundId } }, { idempotencyKey: `refund:${refundId}:v1` }));
  }

  async function createReversal({ transferId, amountCents, refundId, bagId }) {
    stripeId(transferId, 'tr'); identifier(refundId, 'Refund ID'); identifier(bagId, 'Bag ID');
    return call(stripe => stripe.transfers.createReversal(transferId, { amount: cents(amountCents, 'brand transfer reversal', { allowZero: false }), metadata: { bag_id: bagId, refund_id: refundId } }, { idempotencyKey: `reversal:${transferId}:${refundId}:v1` }));
  }

  /**
   * Explicit two-step workflow. Shopper refund and brand recovery are separate money amounts.
   * If recovery fails, the completed refund is returned with a receivable/manual-review result.
   * Caller MUST persist that partial result and cancel any unpaid transfer in its own transaction.
   */
  async function refundBag(input) {
    if (input.transferId) cents(input.transferReversalAmountCents, 'brand share to reverse', { allowZero: false });
    const refund = await createRefund(input);
    if (!input.transferId) return { refund, reversal: null, cancelScheduledTransfer: true, requiresManualReview: false };
    try {
      const reversal = await createReversal({ transferId: input.transferId, amountCents: input.transferReversalAmountCents, refundId: input.refundId, bagId: input.bagId });
      return { refund, reversal, cancelScheduledTransfer: false, requiresManualReview: false };
    } catch (error) {
      return { refund, reversal: null, cancelScheduledTransfer: false, requiresManualReview: true, brandReceivableCents: input.transferReversalAmountCents, recoveryError: { code: error.code, details: error.details } };
    }
  }

  function verifyWebhook(rawBody, signature) {
    if (!webhookSecret) throw new IntegrationUnavailableError('Stripe webhooks', 'A signing secret has not been configured.');
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') throw invalid('Stripe signature verification requires the original raw request bytes.');
    try {
      // Signature verification is local and can run even when the Stripe API key is absent.
      const event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret, 300);
      if (event.livemode && config.allowLive !== true) throw invalid('Live Stripe events are disabled.');
      return event;
    } catch (cause) {
      if (cause instanceof IntegrationError) throw cause;
      throw new IntegrationError('Stripe webhook signature is invalid.', { code: 'INVALID_WEBHOOK_SIGNATURE', statusCode: 400 });
    }
  }

  return { provider: 'stripe', status, preflight, createExpressAccount, createExpressRecipientV2, listTestConnectedAccounts, listTestConnectedAccountsV2,
    createOnboardingLink, createRecipientOnboardingLinkV2, getConnectedAccount, getTestConnectedAccountV2, getTestBalanceSettings, configureTestRecipientManualPayouts,
    createCheckoutSession, getCheckoutSession, listCheckoutLineItems, getCharge, getRefund, getTransfer, getReversal,
    getBalance, getBalanceTransaction, getTaxTransaction, listTaxTransactionLineItems, createTestPayout, getPayout, getTestConnectedAccount, capturePaymentIntent, cancelPaymentIntent, expireTestCheckoutSession,
    createTaxCalculation, recordTaxTransaction, reverseTaxTransaction, createPaymentIntent, getPaymentIntent, createTransfer, createRefund, createReversal, refundBag, verifyWebhook };
}
