import { randomUUID, createHash } from 'node:crypto';
import { SHOPIFY_ALLOWED_SCOPES, missingShopifyScopes } from './integrations/shopify-policy.mjs';
import { shopifyBagTag } from './integrations/projection.mjs';

const SHOP = 'i4vd1u-s8.myshopify.com';
const TAX_CODE = 'txcd_99999999';
const MAX_TOTAL = 10_000;
const SHIP_TO = Object.freeze({ name: 'Alex Test', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' });
const WARNING = 'TEST_DO_NOT_SHIP. One-store transport smoke only; no brand transfer, refund, shopper checkout, or three-store acceptance. General - Tangible Goods is an explicit TEST FIXTURE classification, not a product tax determination.';
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, testCheckout: true });
const money = value => {
  const item = value?.shopMoney;
  if (!item || item.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(item.amount))) throw error('SHOPIFY_READBACK_MISMATCH', 'Shopify returned an unexpected money value.');
  const [whole, fraction = ''] = String(item.amount).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validVariant = value => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value ?? '');
const validRun = value => /^tco_[a-f0-9]{32}$/.test(value ?? '');
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const sanitise = (cause, fallback) => {
  const safe = cause?.testCheckout ? { code: cause.code, message: cause.message }
    : { code: cause?.code === 'OUTCOME_UNCERTAIN' ? 'OUTCOME_UNCERTAIN' : fallback,
      message: 'Provider operation could not be verified. Preserve this run and reconcile; do not create a replacement payment or order.' };
  if (typeof cause?.details?.stripeCode === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(cause.details.stripeCode)
    && !/^(?:(?:sk|rk|pk)_(?:test|live)_|whsec_)/i.test(cause.details.stripeCode)) safe.providerCode = cause.details.stripeCode;
  if (typeof cause?.details?.requestId === 'string' && /^req_[A-Za-z0-9]{1,100}$/.test(cause.details.requestId)) safe.providerRequestId = cause.details.requestId;
  return safe;
};

/**
 * Explicit one-store provider smoke. It never calls the sandbox domain or its ledger.
 * Shipping and all immutable input snapshots are encrypted. Public methods return only
 * allow-listed summaries, never provider objects, addresses, credentials or client secrets.
 */
export async function createTestCheckout(db, auth, { getStripe, shopify, clock = () => new Date() } = {}) {
  if (!db || !auth?.encrypt || !auth?.decrypt || typeof getStripe !== 'function' || !shopify) throw error('TEST_CHECKOUT_SETUP', 'Test checkout adapters and encrypted storage are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS test_checkout_runs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot_encrypted TEXT NOT NULL, private_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, quote_expires_at TIMESTAMPTZ,
    lock_token TEXT, lease_until TIMESTAMPTZ, last_error JSONB
  )`);
  // Shared with the legacy own-store push path: one store-wide five/minute budget.
  await db.query(`CREATE TABLE IF NOT EXISTS shopify_order_attempts (
    id TEXT PRIMARY KEY, shop TEXT NOT NULL, bag_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const now = () => clock().getTime();
  const date = () => new Date(now());
  const decode = row => ({ snapshot: auth.decrypt(row.snapshot_encrypted), private: auth.decrypt(row.private_encrypted) });

  async function rowFor(id, source = db) {
    if (!validRun(id)) throw error('TEST_CHECKOUT_NOT_FOUND', 'Test checkout run not found.', 404);
    const row = (await source.query('SELECT * FROM test_checkout_runs WHERE id=$1', [id])).rows[0];
    if (!row) throw error('TEST_CHECKOUT_NOT_FOUND', 'Test checkout run not found.', 404);
    return row;
  }
  function view(row) {
    const { snapshot, private: details } = decode(row);
    return {
      id: row.id, state: row.state, test: true, shop: SHOP, currency: 'USD',
      variant: { id: snapshot.variant.id, sku: snapshot.variant.sku, title: snapshot.variant.title,
        productTitle: snapshot.variant.productTitle, priceCents: snapshot.variant.priceCents, quantity: 1 },
      amounts: { subtotalCents: snapshot.variant.priceCents, shippingCents: 0,
        taxCents: details.quote?.taxCents ?? null, totalCents: details.quote?.totalCents ?? null },
      stripe: { accountId: snapshot.stripeAccountId, paymentIntentId: details.paymentIntentId ?? null,
        chargeId: details.chargeId ?? null, taxCalculationId: details.quote?.calculationId ?? null,
        taxTransactionId: details.taxTransactionId ?? null },
      shopify: { orderId: details.shopifyOrderId ?? null, verified: details.shopifyVerified === true },
      createdAt: row.created_at, updatedAt: row.updated_at, quoteExpiresAt: row.quote_expires_at,
      lastError: row.last_error ?? null,
      canPay: row.state === 'quoted' && new Date(row.quote_expires_at).getTime() > now(),
      canReconcile: Boolean(details.paymentStartedAt),
      warnings: [WARNING, ...(details.quote?.warnings ?? [])],
    };
  }
  const get = async id => view(await rowFor(id));
  const list = async () => (await db.query('SELECT * FROM test_checkout_runs ORDER BY created_at DESC LIMIT 100')).rows.map(view);

  async function shopCheck() {
    if (shopify.shop !== SHOP) throw error('TEST_STORE_REQUIRED', 'This smoke test is restricted to My Store 2.');
    const checked = await shopify.preflight();
    if (checked?.shop?.myshopifyDomain !== SHOP || checked.shop.currencyCode !== 'USD') throw error('TEST_STORE_REQUIRED', 'The verified store must be My Store 2 in USD.');
    const granted = checked.grantedScopes;
    if (!Array.isArray(granted) || missingShopifyScopes(granted).length || granted.some(scope => !SHOPIFY_ALLOWED_SCOPES.includes(scope))) {
      throw error('SHOPIFY_SCOPE_POLICY', 'Reauthorize My Store 2 with the exact approved Shopify scope policy before payment.');
    }
    return checked;
  }
  async function stripeCheck(stripe, accountId) {
    const checked = await stripe.preflight();
    if (checked?.mode !== 'test' || checked.verified !== true || !/^acct_[A-Za-z0-9]+$/.test(checked.accountId ?? '') || checked.accountId.startsWith('acct_sandbox_')) {
      throw error('STRIPE_TEST_REQUIRED', 'A verified real Stripe test account is required.');
    }
    if (accountId && checked.accountId !== accountId) throw error('STRIPE_ACCOUNT_CHANGED', 'Restore the Stripe test account used for this quote.');
    return checked;
  }
  async function variantCheck(variantId, expected) {
    if (!validVariant(variantId)) throw error('INVALID_TEST_VARIANT', 'Choose a Shopify variant.', 422);
    const variant = await shopify.getVariant(variantId);
    if (!variant || variant.id !== variantId || variant.currency !== 'USD' || variant.productStatus !== 'ACTIVE'
      || !integer(variant.priceCents) || variant.priceCents < 50 || variant.priceCents > MAX_TOTAL
      || !Number.isSafeInteger(variant.inventoryQty) || variant.inventoryQty < 1 || !variant.sku || variant.requiresShipping !== true) {
      throw error('TEST_VARIANT_UNAVAILABLE', 'Choose an active, in-stock USD variant priced between $0.50 and $100.');
    }
    if (expected && (variant.priceCents !== expected.priceCents || variant.sku !== expected.sku)) throw error('TEST_VARIANT_CHANGED', 'Variant price or SKU changed. Create a fresh quote before any payment.');
    return { id: variant.id, sku: String(variant.sku).slice(0, 128), title: String(variant.title ?? '').slice(0, 200),
      productTitle: String(variant.productTitle ?? '').slice(0, 200), priceCents: variant.priceCents, inventoryQty: variant.inventoryQty };
  }
  async function options() {
    await shopCheck();
    const variants = [];
    let after = null;
    for (let page = 0; page < 4; page++) {
      const result = await shopify.listProducts({ first: 25, after });
      for (const product of result.products ?? []) {
        if (product.currency !== 'USD' || product.sourceStatus !== 'ACTIVE' || product.variantsPageInfo?.hasNextPage) continue;
        for (const variant of product.variants ?? []) {
          const price = variant.price?.amount; const inventory = variant.inventory?.qty;
          if (validVariant(variant.shopifyVariantId ?? variant.id) && integer(price) && price >= 50 && price <= MAX_TOTAL && Number.isSafeInteger(inventory) && inventory > 0 && variant.sku && variant.requiresShipping !== false) {
            variants.push({ id: variant.shopifyVariantId ?? variant.id, sku: String(variant.sku).slice(0, 128),
              title: String(variant.title ?? '').slice(0, 200), productTitle: String(product.title ?? '').slice(0, 200), priceCents: price, inventoryQty: inventory });
          }
        }
      }
      if (!result.pageInfo?.hasNextPage) break;
      after = result.pageInfo.endCursor;
    }
    return { shop: SHOP, currency: 'USD', test: true, variants, warnings: [WARNING] };
  }
  function taxQuote(calculation, snapshot, id) {
    const subtotal = snapshot.variant.priceCents;
    const tax = calculation?.tax_amount_exclusive;
    if (!/^taxcalc_[A-Za-z0-9]+$/.test(calculation?.id ?? '') || calculation.livemode !== false || calculation.currency !== 'usd'
      || !integer(tax) || calculation.tax_amount_inclusive !== 0 || calculation.amount_total !== subtotal + tax || calculation.amount_total > MAX_TOTAL
      || !Number.isSafeInteger(calculation.expires_at) || calculation.expires_at * 1000 <= now()) throw error('STRIPE_TAX_INVALID', 'Stripe Tax did not return a valid bounded test quote. No fallback tax is permitted.');
    const lines = calculation.line_items?.data;
    if (!Array.isArray(lines) || lines.length !== 1 || calculation.line_items.has_more !== false || lines[0].reference !== id || lines[0].amount !== subtotal || lines[0].quantity !== 1 || lines[0].tax_code !== TAX_CODE
      || lines[0].tax_behavior !== 'exclusive' || lines[0].amount_tax !== tax || (lines[0].livemode !== undefined && lines[0].livemode !== false)
      || (calculation.shipping_cost && calculation.shipping_cost.amount !== 0)) {
      throw error('STRIPE_TAX_INVALID', 'Stripe Tax line items do not match the frozen test quote.');
    }
    if (!Array.isArray(calculation.tax_breakdown) || calculation.tax_breakdown.some(line => !integer(line.amount) || line.inclusive !== false)) throw error('STRIPE_TAX_INVALID', 'A nonnegative exclusive Stripe Tax breakdown is required.');
    const taxLines = calculation.tax_breakdown.filter(line => line.amount > 0).map((line, index) => {
      const rateString = line.tax_rate_details?.percentage_decimal;
      const rate = Number(rateString) / 100;
      if (typeof rateString !== 'string' || !/^\d+(?:\.\d+)?$/.test(rateString) || !Number.isFinite(rate) || rate <= 0 || rate > 1
        || line.tax_rate_details?.rate_type === 'flat_amount') throw error('STRIPE_TAX_INVALID', 'Stripe Tax breakdown cannot be represented exactly for this smoke test.');
      const detail = line.tax_rate_details;
      return { amountCents: line.amount, rate, title: `Stripe test ${detail.country ?? ''} ${detail.state ?? ''} ${detail.tax_type ?? 'tax'} ${index + 1}`.trim().slice(0, 100) };
    });
    if (taxLines.reduce((sum, line) => sum + line.amountCents, 0) !== tax) throw error('STRIPE_TAX_INVALID', 'Stripe tax breakdown does not equal the quoted tax total.');
    return { calculationId: calculation.id, taxCents: tax, totalCents: subtotal + tax, taxLines,
      expiresAt: new Date(Math.min(now() + 15 * 60_000, calculation.expires_at * 1000)).toISOString(),
      providerExpiresAt: new Date(calculation.expires_at * 1000).toISOString(),
      warnings: [...new Set(calculation.tax_breakdown.map(line => line.taxability_reason).filter(reason => typeof reason === 'string'))].map(reason => `Stripe Tax test reason: ${reason.slice(0, 80)}. This does not certify tax registration/setup.`) };
  }
  async function quote({ variantId } = {}) {
    const stripe = getStripe();
    await shopCheck();
    const checked = await stripeCheck(stripe);
    const variant = await variantCheck(variantId);
    const id = `tco_${randomUUID().replaceAll('-', '')}`;
    const snapshot = { shop: SHOP, variant, qty: 1, shippingCents: 0, shipTo: SHIP_TO, taxCode: TAX_CODE,
      taxFixtureLabel: 'General - Tangible Goods TEST FIXTURE', stripeAccountId: checked.accountId };
    await db.query(`INSERT INTO test_checkout_runs(id,state,snapshot_encrypted,private_encrypted,created_at,updated_at)
      VALUES($1,'quoting',$2,$3,$4,$4)`, [id, auth.encrypt(snapshot), auth.encrypt({}), date()]);
    try {
      const calculation = await stripe.createTaxCalculation({ orderId: id, calculationId: 'quote1', items: [{ reference: id, sku: variant.sku, qty: 1, unitPriceCents: variant.priceCents, taxCode: TAX_CODE }], shippingCents: 0, shipTo: SHIP_TO, currency: 'usd' });
      const quoted = taxQuote(calculation, snapshot, id);
      await db.query("UPDATE test_checkout_runs SET state='quoted',private_encrypted=$1,quote_expires_at=$2,updated_at=$3 WHERE id=$4 AND state='quoting'", [auth.encrypt({ quote: quoted }), quoted.expiresAt, date(), id]);
    } catch (cause) {
      await db.query("UPDATE test_checkout_runs SET state='quote_failed',last_error=$1,updated_at=$2 WHERE id=$3 AND state='quoting'", [JSON.stringify(sanitise(cause, 'STRIPE_TAX_FAILED')), date(), id]);
    }
    return get(id);
  }

  async function claim(id) {
    return db.transaction(async tx => {
      const row = await rowFor(id, tx);
      if (row.lock_token && new Date(row.lease_until).getTime() > now()) return null;
      const token = randomUUID();
      return (await tx.query('UPDATE test_checkout_runs SET lock_token=$1,lease_until=$2 WHERE id=$3 RETURNING *', [token, new Date(now() + 5 * 60_000), id])).rows[0];
    });
  }
  async function persist(row, details, state, lastError = null) {
    const updated = (await db.query('UPDATE test_checkout_runs SET state=$1,private_encrypted=$2,last_error=$3,updated_at=$4 WHERE id=$5 AND lock_token=$6 RETURNING *',
      [state, auth.encrypt(details), lastError ? JSON.stringify(lastError) : null, date(), row.id, row.lock_token])).rows[0];
    if (!updated) throw error('TEST_CHECKOUT_LEASE_LOST', 'Another reconciler owns this run. Read its current status.');
    Object.assign(row, updated);
  }
  function verifyPayment(payment, snapshot, details, id) {
    const shipping = payment?.shipping; const address = shipping?.address;
    if (payment?.livemode !== false || payment.status !== 'succeeded' || payment.currency !== 'usd'
      || payment.amount !== details.quote.totalCents || payment.amount_received !== details.quote.totalCents
      || payment.transfer_group !== `ORD_${id}` || payment.metadata?.order_id !== id || payment.metadata?.integration !== 'avafem'
      || !/^pi_[A-Za-z0-9]+$/.test(payment.id ?? '') || payment.id !== details.paymentIntentId
      || !same(shipping?.name, snapshot.shipTo.name) || !same(address?.line1, snapshot.shipTo.line1) || !same(address?.line2, snapshot.shipTo.line2)
      || !same(address?.city, snapshot.shipTo.city) || !same(address?.state, snapshot.shipTo.region) || !same(address?.postal_code, snapshot.shipTo.postal) || !same(address?.country, snapshot.shipTo.country)) {
      throw error('STRIPE_PAYMENT_MISMATCH', 'Stripe payment does not match this frozen test run. Do not create a Shopify order.');
    }
    const charge = typeof payment.latest_charge === 'string' ? payment.latest_charge : payment.latest_charge?.id;
    if (!/^ch_[A-Za-z0-9]+$/.test(charge ?? '') || (typeof payment.latest_charge === 'object' && payment.latest_charge?.livemode !== false)) throw error('STRIPE_PAYMENT_MISMATCH', 'A successful Stripe test charge reference is required.');
    return charge;
  }
  function bag(snapshot, details, id) {
    return { id, orderId: id, orderRef: `TEST_DO_NOT_SHIP_${id}`, paid: true, sandbox: true, currency: 'USD', shipTo: snapshot.shipTo,
      items: [{ sku: snapshot.variant.sku, title: snapshot.variant.productTitle, qty: 1, unitPriceCents: snapshot.variant.priceCents, shopifyVariantId: snapshot.variant.id }],
      shippingCents: 0, taxCents: details.quote.taxCents, totalCents: details.quote.totalCents };
  }
  function verifyOrder(order, snapshot, details, id) {
    const items = order?.lineItems?.nodes;
    const transactions = order?.transactions;
    const ship = order?.shippingAddress;
    const relay = `bag-${createHash('sha256').update(id).digest('hex').slice(0, 24)}@relay.avafem.com`;
    if (!order || order.id !== details.shopifyOrderId || order.test !== true || order.displayFinancialStatus !== 'PAID'
      || order.sourceIdentifier !== id || !order.tags?.includes(shopifyBagTag(id)) || !order.tags.includes('TEST_DO_NOT_SHIP') || order.email !== relay
      || money(order.totalPriceSet) !== details.quote.totalCents || money(order.subtotalPriceSet) !== snapshot.variant.priceCents
      || money(order.totalTaxSet) !== details.quote.taxCents || money(order.totalShippingPriceSet) !== 0
      || !Array.isArray(items) || items.length !== 1 || items[0].quantity !== 1 || items[0].variant?.id !== snapshot.variant.id
      || items[0].sku !== snapshot.variant.sku || money(items[0].originalUnitPriceSet) !== snapshot.variant.priceCents
      || !same(ship?.firstName, 'Alex') || !same(ship?.lastName, 'Test') || !same(ship?.address1, snapshot.shipTo.line1) || !same(ship?.address2, snapshot.shipTo.line2)
      || !same(ship?.city, snapshot.shipTo.city) || !same(ship?.provinceCode, snapshot.shipTo.region) || !same(ship?.zip, snapshot.shipTo.postal) || !same(ship?.countryCodeV2, snapshot.shipTo.country)
      || !Array.isArray(transactions) || transactions.length !== 1 || transactions[0].test !== true || transactions[0].kind !== 'SALE'
      || transactions[0].status !== 'SUCCESS' || transactions[0].gateway !== 'manual' || money(transactions[0].amountSet) !== details.quote.totalCents) {
      throw error('SHOPIFY_READBACK_MISMATCH', 'Shopify readback did not match the test snapshot. Preserve the created order for review; do not create another.');
    }
  }
  async function reserveShopify(row, details) {
    await db.transaction(async tx => {
      const current = await rowFor(row.id, tx);
      if (current.lock_token !== row.lock_token) throw error('TEST_CHECKOUT_LEASE_LOST', 'Another reconciler owns this run.');
      if ((await tx.query('SELECT id FROM shopify_order_attempts WHERE bag_id=$1', [row.id])).rows.length) throw error('SHOPIFY_ALREADY_ATTEMPTED', 'Only marker-based reconciliation is permitted after a Shopify attempt.');
      const count = (await tx.query('SELECT COUNT(*)::integer AS n FROM shopify_order_attempts WHERE shop=$1 AND created_at>$2', [SHOP, new Date(now() - 60_000)])).rows[0].n;
      if (count >= 5) throw error('SHOPIFY_DEV_ORDER_LIMIT', 'Five Shopify creation attempts per minute have been reached. Reconcile this paid run after waiting.', 429);
      await tx.query('INSERT INTO shopify_order_attempts(id,shop,bag_id,created_at) VALUES($1,$2,$3,$4)', [`test_${row.id}`, SHOP, row.id, date()]);
      details.shopifyAttemptedAt = date().toISOString();
      await tx.query("UPDATE test_checkout_runs SET state='shopify_pending',private_encrypted=$1,updated_at=$2 WHERE id=$3 AND lock_token=$4", [auth.encrypt(details), date(), row.id, row.lock_token]);
      row.state = 'shopify_pending';
    });
  }
  async function finish(row, snapshot, details, stripe) {
    let taxFailure = null;
    if (!details.taxTransactionId) {
      if (details.taxRecordStartedAt && now() - new Date(details.taxRecordStartedAt).getTime() >= 23 * 3600_000) {
        taxFailure = { code: 'TAX_RECONCILIATION_REQUIRED', message: 'Tax recording idempotency window elapsed. Review Stripe records before further tax writes.' };
      } else {
        details.taxRecordStartedAt ??= date().toISOString();
        await persist(row, details, 'paid');
        try {
          const record = await stripe.recordTaxTransaction({ calculationId: details.quote.calculationId, orderId: row.id });
          if (!/^tax_[A-Za-z0-9]+$/.test(record?.id ?? '') || record.livemode !== false || record.currency !== 'usd' || record.reference !== row.id) throw error('STRIPE_TAX_TRANSACTION_MISMATCH', 'Stripe Tax transaction did not match this test run.');
          details.taxTransactionId = record.id;
          await persist(row, details, 'paid');
        } catch (cause) { taxFailure = sanitise(cause, 'STRIPE_TAX_RECORD_FAILED'); }
      }
    }
    if (!details.shopifyOrderId) {
      if (details.shopifyAttemptedAt) {
        const found = await shopify.findOrder(row.id);
        if (found?.id) { details.shopifyOrderId = found.id; await persist(row, details, 'shopify_created'); }
        else { await persist(row, details, 'shopify_uncertain', { code: 'SHOPIFY_OUTCOME_UNCERTAIN', message: 'No matching order is visible yet. Never repeat orderCreate; reconcile this same run or review the store.' }); return; }
      } else {
        // A paid but paused run must not dispatch against a changed/revoked store/catalog.
        await shopCheck();
        await variantCheck(snapshot.variant.id, snapshot.variant);
        await reserveShopify(row, details);
        try {
          const result = await shopify.createOrder(bag(snapshot, details, row.id), { paid: true, test: true, inventoryBehaviour: 'BYPASS', taxLines: details.quote.taxLines });
          if (!result?.order?.id) throw error('SHOPIFY_OUTCOME_UNCERTAIN', 'Shopify did not return a verifiable order ID.');
          details.shopifyOrderId = result.order.id;
          await persist(row, details, 'shopify_created');
        } catch (cause) { await persist(row, details, 'shopify_uncertain', sanitise(cause, 'SHOPIFY_OUTCOME_UNCERTAIN')); return; }
      }
    }
    try {
      const order = await shopify.getOrderDetails(details.shopifyOrderId);
      verifyOrder(order, snapshot, details, row.id);
      details.shopifyVerified = true;
      await persist(row, details, taxFailure ? 'needs_review' : 'complete', taxFailure);
    } catch (cause) {
      details.shopifyVerified = false;
      await persist(row, details, cause?.code === 'SHOPIFY_READBACK_MISMATCH' ? 'readback_mismatch' : 'shopify_created', sanitise(cause, 'SHOPIFY_READBACK_FAILED'));
    }
  }
  async function execute(id, reconciliation) {
    const row = await claim(id);
    if (!row) return get(id);
    const { snapshot, private: details } = decode(row);
    try {
      if (row.state === 'complete' || (!reconciliation && row.state !== 'quoted') || (reconciliation && !details.paymentStartedAt)) return view(row);
      const stripe = getStripe();
      if (!details.paymentVerified) {
        if (!details.paymentStartedAt) {
          if (new Date(row.quote_expires_at).getTime() <= now()) { await persist(row, details, 'expired', { code: 'QUOTE_EXPIRED', message: 'Create a fresh quote before payment.' }); return view(row); }
          try { await shopCheck(); await stripeCheck(stripe, snapshot.stripeAccountId); await variantCheck(snapshot.variant.id, snapshot.variant); }
          catch (cause) { await persist(row, details, 'blocked', sanitise(cause, 'PAYMENT_PREFLIGHT_FAILED')); return view(row); }
          details.paymentStartedAt = date().toISOString();
          await persist(row, details, 'payment_pending');
        } else if (!details.paymentIntentId) {
          if (!['payment_pending', 'payment_uncertain'].includes(row.state) || now() - new Date(details.paymentStartedAt).getTime() >= 23 * 3600_000
            || new Date(details.quote.providerExpiresAt).getTime() <= now()) {
            await persist(row, details, 'needs_review', { code: 'PAYMENT_RECONCILIATION_REQUIRED', message: 'Review Stripe for the original payment; no new payment will be attempted.' }); return view(row);
          }
          try { await shopCheck(); await stripeCheck(stripe, snapshot.stripeAccountId); await variantCheck(snapshot.variant.id, snapshot.variant); }
          catch (cause) { await persist(row, details, 'needs_review', sanitise(cause, 'PAYMENT_RECONCILIATION_REQUIRED')); return view(row); }
        }
        let payment;
        try {
          if (details.paymentIntentId) { await stripeCheck(stripe, snapshot.stripeAccountId); payment = await stripe.getPaymentIntent(details.paymentIntentId); }
          else {
            payment = await stripe.createPaymentIntent({ orderId: row.id, amountCents: details.quote.totalCents, currency: 'usd', shipTo: snapshot.shipTo, paymentMethodId: 'pm_card_visa', confirm: true });
            if (typeof payment?.id === 'string' && /^pi_[A-Za-z0-9]+$/.test(payment.id)) { details.paymentIntentId = payment.id; await persist(row, details, 'payment_pending'); }
            payment = await stripe.getPaymentIntent(details.paymentIntentId);
          }
          details.chargeId = verifyPayment(payment, snapshot, details, row.id);
          details.paymentVerified = true;
          await persist(row, details, 'paid');
        } catch (cause) {
          const state = cause?.code === 'STRIPE_PAYMENT_MISMATCH' ? 'needs_review' : cause?.details?.type === 'StripeCardError' ? 'payment_failed' : 'payment_uncertain';
          await persist(row, details, state, sanitise(cause, 'STRIPE_PAYMENT_UNCERTAIN')); return view(row);
        }
      } else {
        try { await stripeCheck(stripe, snapshot.stripeAccountId); }
        catch (cause) { await persist(row, details, 'needs_review', sanitise(cause, 'STRIPE_ACCOUNT_UNAVAILABLE')); return view(row); }
      }
      await finish(row, snapshot, details, stripe);
    } catch (cause) {
      await persist(row, details, details.paymentVerified ? 'needs_review' : 'payment_uncertain', sanitise(cause, 'TEST_CHECKOUT_RECONCILIATION_REQUIRED'));
    } finally {
      await db.query('UPDATE test_checkout_runs SET lock_token=NULL,lease_until=NULL WHERE id=$1 AND lock_token=$2', [id, row.lock_token]);
    }
    return get(id);
  }
  return { options, quote, pay: id => execute(id, false), get, list, reconcile: id => execute(id, true) };
}
