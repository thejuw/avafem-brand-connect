import { randomUUID, createHash } from 'node:crypto';
import { TEST_STORES } from './test-stores.mjs';
import { shopifyBagTag } from './integrations/projection.mjs';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, unifiedSafe: true });
const int = value => Number.isSafeInteger(value) && value >= 0;
const RUN = /^uco_[a-f0-9]{32}$/;
const gid = value => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value ?? '');
const diagnostic = cause => ({ code: cause?.unifiedSafe ? cause.code : 'PROVIDER_OPERATION_UNVERIFIED',
  message: cause?.unifiedSafe ? cause.message : 'Preserve this run and reconcile its existing provider records; do not create replacement payments or orders.',
  ...(/^req_[A-Za-z0-9]+$/.test(cause?.details?.requestId ?? '') ? { providerRequestId: cause.details.requestId } : {}) });
const toMoney = value => {
  const money = value?.shopMoney;
  if (money?.currencyCode !== 'USD' || !/^\d+(?:\.\d{1,2})?$/.test(String(money.amount))) throw fail('SHOPIFY_READBACK_MISMATCH', 'Unexpected Shopify money.');
  const [whole, fraction = ''] = String(money.amount).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/** Stable largest-remainder allocation. It never invents a tax amount: only a
 * provider's exact shipping-tax cents are apportioned across frozen flat rates. */
export function allocateCents(total, weights) {
  if (!int(total) || !Array.isArray(weights) || weights.some(weight => !int(weight))) throw fail('ALLOCATION_INVALID', 'Integer cents and weights are required.');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) { if (total) throw fail('ALLOCATION_INVALID', 'Cannot allocate nonzero cents to zero weights.'); return weights.map(() => 0); }
  const result = weights.map(weight => Math.floor(total * weight / sum));
  const order = weights.map((weight, index) => ({ index, remainder: total * weight % sum })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let left = total - result.reduce((a, b) => a + b, 0), cursor = 0; left; left--, cursor++) result[order[cursor].index]++;
  return result;
}

export function checkoutAddress(session) {
  const shipping = session?.collected_information?.shipping_details;
  const source = shipping?.address;
  const shipTo = { name: shipping?.name, line1: source?.line1, ...(source?.line2 ? { line2: source.line2 } : {}),
    city: source?.city, region: source?.state, postal: source?.postal_code, country: source?.country };
  if (shipTo.country !== 'US' || ['name', 'line1', 'city', 'region', 'postal'].some(key => typeof shipTo[key] !== 'string' || !shipTo[key].trim() || shipTo[key].length > 250)
    || !/^[A-Z]{2}$/.test(shipTo.region) || !/^\d{5}(?:-\d{4})?$/.test(shipTo.postal))
    throw fail('CHECKOUT_ADDRESS_REQUIRED', 'Stripe must return one complete, valid US shipping address.');
  return shipTo;
}
const reference = line => line?.price?.product?.metadata?.reference;
const taxRate = tax => {
  const rate = tax?.rate;
  if (!int(tax?.amount) || !rate || typeof rate !== 'object' || typeof rate.percentage !== 'number'
    || !Number.isFinite(rate.percentage) || rate.percentage <= 0 || rate.percentage > 100
    || rate.inclusive === true) throw fail('AUTHORITATIVE_TAX_REQUIRED', 'Expanded exclusive Stripe tax rates are required.');
  return { key: `${rate.id ?? ''}:${rate.country ?? ''}:${rate.state ?? ''}:${rate.percentage}`,
    amountCents: tax.amount, rate: rate.percentage / 100,
    title: `Stripe TEST ${rate.country ?? 'US'} ${rate.state ?? ''} tax`.trim().slice(0, 100) };
};

export function allocateCheckout(session, lines, snapshot) {
  if (session?.livemode !== false || session.mode !== 'payment' || session.client_reference_id !== snapshot.id
    || session.metadata?.order_id !== snapshot.id || session.currency !== 'usd' || session.automatic_tax?.status !== 'complete'
    || !int(session.amount_subtotal) || !int(session.amount_total) || session.amount_total > 10_000
    || !int(session.total_details?.amount_tax) || (session.total_details?.amount_discount ?? 0) !== 0)
    throw fail('CHECKOUT_TOTAL_MISMATCH', 'The completed test Session must match the frozen cart and authoritative tax.');
  const all = snapshot.bags.flatMap(bag => bag.items);
  if (!Array.isArray(lines) || lines.length !== all.length || new Set(lines.map(reference)).size !== all.length)
    throw fail('CHECKOUT_LINE_MISMATCH', 'Stripe line references are missing, duplicated or unexpected.');
  const result = snapshot.bags.map(bag => ({ id: bag.id, subtotalCents: 0, shippingCents: bag.shippingCents, taxCents: 0,
    taxLines: [], lineTaxLines: {}, shippingTaxLines: [], lineAllocations: [], lineTaxCents: {}, shippingTaxCents: 0,
    commissionCents: 0, transferCents: 0, totalCents: 0 }));
  const rates = result.map(() => new Map());
  const addTax = (index, tax) => {
    if (!tax.amount) return;
    const checked = taxRate(tax);
    const prior = rates[index].get(checked.key);
    rates[index].set(checked.key, { ...checked, amountCents: (prior?.amountCents ?? 0) + checked.amountCents });
    result[index].taxCents += checked.amountCents;
  };
  snapshot.bags.forEach((bag, index) => {
    for (const item of bag.items) {
      const line = lines.find(candidate => reference(candidate) === item.reference);
      if (!line || line.quantity !== item.qty || line.currency !== 'usd' || line.price?.currency !== 'usd'
        || line.price?.unit_amount !== item.unitPriceCents || line.amount_subtotal !== item.qty * item.unitPriceCents
        || !int(line.amount_tax) || line.amount_total !== line.amount_subtotal + line.amount_tax
        || (line.amount_discount ?? 0) !== 0 || !Array.isArray(line.taxes)
        || line.taxes.reduce((sum, tax) => sum + tax.amount, 0) !== line.amount_tax)
        throw fail('CHECKOUT_LINE_MISMATCH', 'Stripe quantities, prices, currency or line tax do not match the frozen cart.');
      result[index].subtotalCents += line.amount_subtotal;
      result[index].lineTaxCents[item.sku] = (result[index].lineTaxCents[item.sku] ?? 0) + line.amount_tax;
      result[index].lineTaxLines[item.sku] = line.taxes.filter(tax => tax.amount > 0).map(tax => {
        const { key, ...checked } = taxRate(tax); return checked;
      });
      for (const tax of line.taxes) addTax(index, tax);
      result[index].lineAllocations.push({ reference: item.reference, sku: item.sku, variantId: item.variantId,
        qty: item.qty, unitPriceCents: item.unitPriceCents, subtotalCents: line.amount_subtotal, taxCents: line.amount_tax,
        stripeLineId: line.id, refundedQty: 0 });
    }
  });
  const shipping = snapshot.bags.reduce((sum, bag) => sum + bag.shippingCents, 0);
  if (session.shipping_cost?.amount_subtotal !== shipping || !int(session.shipping_cost?.amount_tax)
    || !Array.isArray(session.shipping_cost?.taxes)
    || session.shipping_cost.taxes.reduce((sum, tax) => sum + tax.amount, 0) !== session.shipping_cost.amount_tax)
    throw fail('CHECKOUT_SHIPPING_MISMATCH', 'Stripe shipping must equal the sum of the three frozen brand flat rates.');
  for (const tax of session.shipping_cost.taxes) {
    taxRate(tax);
    const allocation = allocateCents(tax.amount, snapshot.bags.map(bag => bag.shippingCents));
    allocation.forEach((amount, index) => {
      result[index].shippingTaxCents += amount;
      if (amount) { const { key, ...checked } = taxRate({ ...tax, amount }); result[index].shippingTaxLines.push(checked); }
      addTax(index, { ...tax, amount });
    });
  }
  result.forEach((bag, index) => {
    bag.taxLines = [...rates[index].values()].map(({ key, ...line }) => line);
    bag.commissionCents = Math.round(bag.subtotalCents * snapshot.bags[index].commissionBps / 10_000);
    bag.transferCents = bag.subtotalCents - bag.commissionCents + bag.shippingCents;
    bag.totalCents = bag.subtotalCents + bag.shippingCents + bag.taxCents;
  });
  const sum = field => result.reduce((value, bag) => value + bag[field], 0);
  if (sum('subtotalCents') !== session.amount_subtotal || sum('taxCents') !== session.total_details.amount_tax
    || sum('totalCents') !== session.amount_total) throw fail('CHECKOUT_TOTAL_MISMATCH', 'Shopper and brand allocations must agree to the cent.');
  return result;
}

export async function createUnifiedCheckout(db, auth, { stores, getStripe, baseUrl = 'http://127.0.0.1:4317', clock = () => new Date() } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS unified_checkout_runs (
    id TEXT PRIMARY KEY, request_hash TEXT UNIQUE NOT NULL, cart_hash TEXT NOT NULL, state TEXT NOT NULL,
    snapshot_encrypted TEXT NOT NULL, details_encrypted TEXT NOT NULL, checkout_session_id TEXT UNIQUE,
    payment_intent_id TEXT UNIQUE, charge_id TEXT UNIQUE, lock_token TEXT, lease_until TIMESTAMPTZ,
    last_error JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS unified_provider_events (
    provider TEXT NOT NULL, delivery_id TEXT NOT NULL, topic TEXT NOT NULL, shop TEXT,
    payload_encrypted TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ, last_error JSONB, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(provider,delivery_id)
  )`);
  await db.query('ALTER TABLE unified_checkout_runs ADD COLUMN IF NOT EXISTS checkout_dispatch_complete BOOLEAN NOT NULL DEFAULT false');
  await db.query(`CREATE TABLE IF NOT EXISTS provider_notifications (
    id TEXT PRIMARY KEY, business_key TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL, bag_id TEXT NOT NULL,
    body_encrypted TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'simulated_delivered',
    receipt_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const wallNow = () => new Date(clock());
  const read = async runId => {
    if (!RUN.test(runId ?? '')) throw fail('UNIFIED_CHECKOUT_NOT_FOUND', 'Unified checkout not found.', 404);
    const row = (await db.query('SELECT * FROM unified_checkout_runs WHERE id=$1', [runId])).rows[0];
    if (!row) throw fail('UNIFIED_CHECKOUT_NOT_FOUND', 'Unified checkout not found.', 404);
    return row;
  };
  const decode = row => ({ snapshot: auth.decrypt(row.snapshot_encrypted), details: auth.decrypt(row.details_encrypted) });
  const summary = row => {
    const { snapshot, details } = decode(row);
    return { id: row.id, state: row.state, test: true, currency: 'USD', createdAt: row.created_at, updatedAt: row.updated_at,
      checkoutUrl: details.sessionUrl ?? null, amounts: details.amounts ?? { subtotalCents: snapshot.bags.reduce((sum, bag) => sum + bag.items.reduce((n, item) => n + item.qty * item.unitPriceCents, 0), 0),
        shippingCents: snapshot.bags.reduce((sum, bag) => sum + bag.shippingCents, 0), taxCents: null, totalCents: null },
      stripe: { accountId: details.accountId ?? null, checkoutSessionId: details.sessionId ?? null,
        paymentIntentId: details.paymentIntentId ?? null, chargeId: details.chargeId ?? null },
      bags: snapshot.bags.map(bag => {
        const state = details.bags?.[bag.id] ?? {};
        return { id: bag.id, shop: bag.shop, brandId: bag.brandId, name: bag.name, state: state.state ?? 'awaiting_checkout',
          items: bag.items.map(({ reference, ...item }) => item), shippingCents: bag.shippingCents,
          commissionBps: bag.commissionBps, returnWindowDays: bag.returnWindowDays,
          orderId: state.orderId ?? null, orderVerified: state.verified === true, shippingStatus: state.shippingStatus ?? 'unfulfilled',
          subtotalCents: state.subtotalCents ?? null, taxCents: state.taxCents ?? null, totalCents: state.totalCents ?? null,
          commissionCents: state.commissionCents ?? null, transferCents: state.transferCents ?? null,
          refundCents: state.refundCents ?? 0, transferId: state.transferId ?? null, payoutId: state.payoutId ?? null,
          transferStatus: state.transferOp?.status ?? null, payoutStatus: state.payoutOp?.status ?? null,
          cancelStatus: state.cancelOp?.status ?? null, cancellationVerified: state.cancellationVerified === true,
          refunds: Object.values(state.refundOps ?? {}).map(op => ({ id: op.id, status: op.status,
            stripeRefundId: op.stripeRefundId ?? null, stripeStatus: op.stripeStatus ?? null,
            shopifyRefundId: op.shopifyRefundId ?? null, reversalId: op.reversalId ?? null,
            reversalVerified: op.reversalVerified === true, amountCents: op.amountCents,
            recoveryCents: op.recoveryCents, taxCents: op.taxCents, shippingCents: op.shippingCents, afterTransfer: op.afterTransfer === true })),
          fulfillments: (state.fulfillments ?? []).map(fulfillment => ({ id: fulfillment.id, status: fulfillment.status,
            items: fulfillment.items, providerDeliveredAt: fulfillment.providerDeliveredAt, carrierVerified: false })),
          deliveredAt: state.deliveredAt ?? null, payoutDueAt: state.payoutDueAt ?? null,
          stockDecrementVerified: state.stockDecrementVerified === true };
      }), lastError: row.last_error ?? null,
      clock: { mode: details.testClock ? 'isolated_test_clock' : 'wall_clock', logicalNow: details.testClock?.now ?? null },
      warnings: ['TEST ONLY / DO NOT SHIP. One shopper checkout and one charge, split into three provider-linked Bags.',
        'General tangible-goods tax codes and per-brand flat shipping are explicit test fixtures, not production classifications or rates.',
        'Shipping notices use the user-authorized simulated inbox; no external email delivery is claimed.',
        'An isolated app test clock may simulate the return window; provider timestamps are never rewritten.'],
    };
  };
  const get = async runId => summary(await read(runId));
  const list = async () => (await db.query('SELECT * FROM unified_checkout_runs ORDER BY created_at DESC LIMIT 50')).rows.map(summary);
  async function journal(tx, businessKey, kind, bag, entries) {
    const filtered = entries.filter(entry => (entry.debitCents ?? 0) || (entry.creditCents ?? 0));
    const debit = filtered.reduce((sum, entry) => sum + (entry.debitCents ?? 0), 0);
    const credit = filtered.reduce((sum, entry) => sum + (entry.creditCents ?? 0), 0);
    if (!int(debit) || !debit || debit !== credit || filtered.some(entry => !int(entry.debitCents ?? 0) || !int(entry.creditCents ?? 0)
      || Boolean(entry.debitCents) === Boolean(entry.creditCents))) throw fail('UNBALANCED_LEDGER', 'Provider journals must balance to integer cents.', 500);
    const journalId = id('jrnl');
    const inserted = await tx.query(`INSERT INTO ledger_journals(id,business_key,kind,bag_id,brand_id,total_debit_cents,total_credit_cents)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(business_key) DO NOTHING RETURNING id`, [journalId, businessKey, kind, bag.id, bag.brandId, debit]);
    if (!inserted.rows.length) return;
    for (const entry of filtered) await tx.query('INSERT INTO ledger_entries(id,journal_id,account,debit_cents,credit_cents) VALUES($1,$2,$3,$4,$5)',
      [id('entry'), journalId, entry.account, entry.debitCents ?? 0, entry.creditCents ?? 0]);
  }
  const emit = (tx, type, bagId, brandId, payload) => tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload)
    VALUES($1,$2,$3,$4,$5)`, [id('evt'), type, bagId, brandId, JSON.stringify({ ...payload, test: true, providerBacked: true, sandbox: true })]);
  async function withRun(runId, action) {
    await read(runId);
    const token = randomUUID();
    const row = (await db.query(`UPDATE unified_checkout_runs SET lock_token=$2,lease_until=$3
      WHERE id=$1 AND (lock_token IS NULL OR lease_until<$4) RETURNING *`, [runId, token, new Date(wallNow().getTime() + 300_000), wallNow()])).rows[0];
    if (!row) return { ...await get(runId), processing: true };
    const { snapshot, details } = decode(row);
    let state = row.state;
    const save = async (next = state, lastError = null) => {
      state = next;
      const result = await db.query(`UPDATE unified_checkout_runs SET state=$3,details_encrypted=$4,last_error=$5,
        checkout_session_id=$6,payment_intent_id=$7,charge_id=$8,updated_at=$9,checkout_dispatch_complete=$10
        WHERE id=$1 AND lock_token=$2 RETURNING id`, [runId, token, state, auth.encrypt(details), lastError ? JSON.stringify(lastError) : null,
        details.sessionId ?? null, details.paymentIntentId ?? null, details.chargeId ?? null, wallNow(),
        details.canonicalCommitted === true && snapshot.bags.every(bag => details.bags[bag.id]?.verified === true)]);
      if (!result.rows.length) throw fail('UNIFIED_LEASE_LOST', 'Another worker owns this run.');
    };
    try { await action({ snapshot, details, save, now: () => details.testClock ? new Date(details.testClock.now) : wallNow(), wallNow, emit, journal, get state() { return state; } }); }
    catch (cause) { await save(details.paymentVerified ? 'needs_review' : 'checkout_needs_review', diagnostic(cause)); }
    finally { await db.query('UPDATE unified_checkout_runs SET lock_token=NULL,lease_until=NULL WHERE id=$1 AND lock_token=$2', [runId, token]); }
    return get(runId);
  }
  async function stripeReady(expected) {
    const stripe = getStripe();
    const result = await stripe.preflight();
    if (result.mode !== 'test' || result.verified !== true || !/^acct_[A-Za-z0-9]+$/.test(result.accountId ?? '')
      || (expected && result.accountId !== expected)) throw fail('STRIPE_TEST_REQUIRED', 'Restore the verified Stripe test account used by this cart.');
    return { stripe, checked: result };
  }
  async function eligibleVariant(shop, variantId, qty, expected) {
    await stores.preflight(shop);
    const adapter = await stores.forShop(shop);
    const variant = await adapter.getVariant(variantId);
    if (!variant || variant.currency !== 'USD' || variant.productStatus !== 'ACTIVE' || variant.tracked !== true
      || variant.requiresShipping !== true || variant.inventoryPolicy !== 'DENY' || !int(variant.inventoryQty) || variant.inventoryQty < qty
      || !int(variant.priceCents) || variant.priceCents < 50 || !variant.sku
      || !/^AVF-CONNECT-TEST-/.test(variant.sku) || !variant.productTitle?.includes('DO NOT SHIP'))
      throw fail('TEST_VARIANT_UNAVAILABLE', 'Use an active, tracked, physical, in-stock DO NOT SHIP test fixture with deny-overselling policy.');
    if (expected && (expected.sku !== variant.sku || expected.unitPriceCents !== variant.priceCents))
      throw fail('TEST_VARIANT_CHANGED', 'The frozen variant price or SKU changed before capture.');
    return variant;
  }
  async function options() {
    const result = { test: true, stores: [], blockers: [], stripe: { verified: false, mode: 'test' }, warnings: ['Only explicit DO NOT SHIP fixtures are eligible. One flat shipping fee per participating brand.'] };
    try { const { checked } = await stripeReady(); result.stripe = { verified: true, mode: 'test', accountId: checked.accountId }; }
    catch { result.blockers.push({ code: 'STRIPE_TEST_REQUIRED', message: 'Verify the Stripe test key through the masked local form.' }); }
    for (const info of TEST_STORES) {
      const safe = (await stores.list()).find(store => store.shop === info.shop);
      const variants = [];
      try {
        await stores.preflight(info.shop);
        const adapter = await stores.forShop(info.shop);
        let after = null;
        for (let page = 0; page < 100; page++) {
          const products = await adapter.listProducts({ first: 25, after });
          for (const product of products.products) {
            if (product.sourceStatus !== 'ACTIVE' || product.variantsPageInfo?.hasNextPage || !product.title.includes('DO NOT SHIP')) continue;
            for (const variant of product.variants) if (/^AVF-CONNECT-TEST-/.test(variant.sku) && variant.tracked && variant.requiresShipping
              && variant.inventory?.policy === 'deny' && variant.inventory.qty > 0 && int(variant.price?.amount)) variants.push({ id: variant.shopifyVariantId,
              sku: variant.sku, title: variant.title, productTitle: product.title, priceCents: variant.price.amount, inventoryQty: variant.inventory.qty });
          }
          if (!products.pageInfo.hasNextPage) break;
          after = products.pageInfo.endCursor;
          if (page === 99) throw fail('CATALOG_LIMIT', 'Catalog pagination is incomplete.');
        }
        result.stores.push({ ...safe, connected: true, variants });
        if (!variants.length) result.blockers.push({ code: 'TEST_FIXTURE_REQUIRED', shop: info.shop, message: 'Create this store’s unpublished, distinct test fixture before checkout.' });
      } catch (cause) { result.stores.push({ ...safe, connected: false, variants: [] }); result.blockers.push({ code: cause.code ?? 'STORE_UNAVAILABLE', shop: info.shop, message: 'This exact store needs its own verified test installation and credentials.' }); }
    }
    return result;
  }
  async function create({ items }, requestKey) {
    if (!Array.isArray(items) || items.length < 3 || items.length > 15 || typeof requestKey !== 'string' || !/^[A-Za-z0-9:_-]{16,160}$/.test(requestKey))
      throw fail('UNIFIED_CART_INVALID', 'Provide a stable idempotency key and a bounded three-brand cart.', 422);
    const normalized = items.map(item => ({ shop: item.shop, variantId: item.variantId, quantity: item.quantity }))
      .sort((a, b) => `${a.shop}:${a.variantId}`.localeCompare(`${b.shop}:${b.variantId}`));
    if (new Set(normalized.map(item => `${item.shop}:${item.variantId}`)).size !== normalized.length
      || normalized.some(item => !TEST_STORES.some(store => store.shop === item.shop) || !gid(item.variantId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 5)
      || new Set(normalized.map(item => item.shop)).size !== 3) throw fail('UNIFIED_CART_INVALID', 'The acceptance cart must contain all three exact stores with unique variants and quantities 1–5.', 422);
    const cartHash = hash(JSON.stringify(normalized)); const requestHash = hash(requestKey);
    const existing = (await db.query('SELECT * FROM unified_checkout_runs WHERE request_hash=$1', [requestHash])).rows[0];
    if (existing) { if (existing.cart_hash !== cartHash) throw fail('IDEMPOTENCY_BODY_CHANGED', 'This idempotency key belongs to a different cart.', 422); return summary(existing); }
    const { checked } = await stripeReady();
    const runId = id('uco'); const bags = [];
    for (const store of TEST_STORES) {
      const config = await stores.row(store.shop);
      const bag = { id: id('bag'), shop: store.shop, brandId: config.brand_id, name: store.name,
        shippingCents: config.shipping_cents, commissionBps: config.commission_bps, returnWindowDays: config.return_window_days, items: [] };
      for (const input of normalized.filter(item => item.shop === store.shop)) {
        const variant = await eligibleVariant(store.shop, input.variantId, input.quantity);
        bag.items.push({ reference: `${bag.id}:${bag.items.length}`, variantId: input.variantId, sku: variant.sku, qty: input.quantity,
          unitPriceCents: variant.priceCents, title: variant.productTitle, stockAtQuote: variant.inventoryQty, taxCode: 'txcd_99999999' });
      }
      if (new Set(bag.items.map(item => item.sku)).size !== bag.items.length)
        throw fail('UNIFIED_CART_INVALID', 'Each participating store needs unique SKU identities for precise shipping and refund allocation.', 422);
      bags.push(bag);
    }
    const subtotal = bags.reduce((sum, bag) => sum + bag.items.reduce((n, item) => n + item.qty * item.unitPriceCents, 0) + bag.shippingCents, 0);
    if (subtotal < 50 || subtotal > 5000) throw fail('TEST_CART_LIMIT', 'Test merchandise plus shipping is capped at $50 before Stripe tax.', 422);
    const snapshot = { id: runId, currency: 'USD', bags, captureMethod: 'manual', createdAt: wallNow().toISOString(),
      successUrl: `${baseUrl}/unified-checkout/success?run=${runId}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${baseUrl}/?checkout_cancelled=${runId}` };
    const inserted = await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted)
      VALUES($1,$2,$3,'checkout_creating',$4,$5) ON CONFLICT(request_hash) DO NOTHING RETURNING *`, [runId, requestHash, cartHash, auth.encrypt(snapshot), auth.encrypt({ accountId: checked.accountId, bags: {} })]);
    if (!inserted.rows.length) {
      const raced = (await db.query('SELECT * FROM unified_checkout_runs WHERE request_hash=$1', [requestHash])).rows[0];
      if (raced.cart_hash !== cartHash) throw fail('IDEMPOTENCY_BODY_CHANGED', 'This key belongs to a different cart.', 422);
      return summary(raced);
    }
    return reconcile(runId);
  }
  async function reserveOrder(ctx, bag) {
    const state = ctx.details.bags[bag.id];
    if (state.dispatchStartedAt) return false;
    await db.transaction(async tx => {
      const count = (await tx.query("SELECT COUNT(*)::integer AS count FROM shopify_order_attempts WHERE shop=$1 AND created_at>now()-interval '60 seconds'", [bag.shop])).rows[0].count;
      if (count >= 5) throw fail('SHOPIFY_ORDER_THROTTLED', 'Wait before this store’s next conservative order attempt.', 429);
      await tx.query('INSERT INTO shopify_order_attempts(id,shop,bag_id) VALUES($1,$2,$3)', [id('attempt'), bag.shop, bag.id]);
    });
    state.dispatchStartedAt = wallNow().toISOString(); await ctx.save('dispatching'); return true;
  }
  async function commitCanonical(ctx) {
    const { snapshot, details } = ctx;
    await db.transaction(async tx => {
      const exists = (await tx.query('SELECT id FROM orders WHERE id=$1', [snapshot.id])).rows[0];
      if (exists) return;
      const a = details.amounts;
      await tx.query(`INSERT INTO orders(id,order_ref,status,subtotal_cents,shipping_cents,tax_cents,total_cents,provider_bound)
        VALUES($1,$2,'paid',$3,$4,$5,$6,true)`, [snapshot.id, `AVF-TEST-${snapshot.id.slice(-10).toUpperCase()}`, a.subtotalCents, a.shippingCents, a.taxCents, a.totalCents]);
      for (const bag of snapshot.bags) {
        const value = details.bags[bag.id];
        await tx.query(`INSERT INTO bags(id,order_id,brand_id,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,
          transfer_cents,total_cents,ship_by,return_window_days,provider_bound)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)`, [bag.id, snapshot.id, bag.brandId,
          JSON.stringify(bag.items.map(item => ({ sku: item.sku, title: item.title, qty: item.qty, unitPriceCents: item.unitPriceCents, shopifyVariantId: item.variantId }))),
          JSON.stringify({ encryptedShipping: auth.encrypt(details.shipTo) }), value.subtotalCents, value.shippingCents, value.taxCents,
          value.commissionCents, value.transferCents, value.totalCents, new Date(wallNow().getTime() + 2 * 86400_000), bag.returnWindowDays]);
        await tx.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status) VALUES($1,$2,$3,$4,'scheduled')", [id('transfer'), bag.id, bag.brandId, value.transferCents]);
        await tx.query("INSERT INTO credits(id,bag_id,brand_id,amount_cents,status) VALUES($1,$2,$3,0,'pending')", [id('credit'), bag.id, bag.brandId]);
        await tx.query("INSERT INTO external_orders(bag_id,brand_id,shop,state) VALUES($1,$2,$3,'pending')", [bag.id, bag.brandId, bag.shop]);
        await journal(tx, `provider-payment:${bag.id}`, 'stripe_test_payment', bag, [
          { account: 'stripe_platform_clearing', debitCents: value.totalCents }, { account: 'brand_payable', creditCents: value.transferCents },
          { account: 'commission_revenue', creditCents: value.commissionCents }, { account: 'tax_payable', creditCents: value.taxCents },
        ]);
        await emit(tx, 'bag.created', bag.id, bag.brandId, { bagId: bag.id, orderId: snapshot.id, paymentIntentId: details.paymentIntentId, shop: bag.shop });
      }
      await emit(tx, 'checkout.paid', snapshot.id, null, { orderId: snapshot.id, paymentIntentId: details.paymentIntentId,
        chargeId: details.chargeId, bagIds: snapshot.bags.map(bag => bag.id), totalCents: details.amounts.totalCents });
    });
    details.canonicalCommitted = true; await ctx.save('paid');
  }
  async function dispatch(ctx) {
    for (const bag of ctx.snapshot.bags) {
      const value = ctx.details.bags[bag.id];
      if (value.verified) continue;
      const adapter = await stores.forShop(bag.shop);
      await stores.preflight(bag.shop);
      if (!value.orderId) {
        if (value.dispatchStartedAt) {
          const found = await adapter.findOrder(bag.id);
          if (!found?.id) { value.state = 'order_uncertain'; await ctx.save('needs_review', { code: 'SHOPIFY_OUTCOME_UNCERTAIN', message: 'A prior dispatch has no confirmed mapping. Never repeat orderCreate blindly.' }); continue; }
          value.orderId = found.id; await ctx.save('dispatching');
        } else {
          value.stockBeforeDispatch = {};
          for (const item of bag.items) value.stockBeforeDispatch[item.variantId] = (await eligibleVariant(bag.shop, item.variantId, item.qty, item)).inventoryQty;
          await reserveOrder(ctx, bag);
          const result = await adapter.createOrder({ id: bag.id, orderId: ctx.snapshot.id, orderRef: `TEST_DO_NOT_SHIP_${ctx.snapshot.id}`,
            paid: true, sandbox: true, currency: 'USD', shipTo: ctx.details.shipTo,
            items: bag.items.map(item => ({ ...item, shopifyVariantId: item.variantId })), shippingCents: value.shippingCents,
            taxCents: value.taxCents, totalCents: value.totalCents }, { paid: true, test: true,
            inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', lineTaxLines: value.lineTaxLines,
            shippingTaxLines: value.shippingTaxLines });
          if (!result?.order?.id) throw fail('SHOPIFY_OUTCOME_UNCERTAIN', 'Shopify did not return an order mapping.');
          value.orderId = result.order.id; await ctx.save('dispatching');
        }
      }
      const order = await adapter.getOrderDetails(value.orderId);
      const address = order?.shippingAddress;
      const equalAddress = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
      const fullName = [address?.firstName, address?.lastName].filter(Boolean).join(' ').trim();
      const taxesMatch = (taxes, expected) => Array.isArray(taxes)
        && taxes.reduce((sum, tax) => sum + toMoney(tax.priceSet), 0) === expected;
      if (order?.test !== true || order.taxesIncluded !== false || order.id !== value.orderId || order.displayFinancialStatus !== 'PAID'
        || order.sourceIdentifier !== bag.id || !order.tags?.includes(shopifyBagTag(bag.id)) || !order.tags.includes('TEST_DO_NOT_SHIP')
        || toMoney(order.totalPriceSet) !== value.totalCents || toMoney(order.subtotalPriceSet) !== value.subtotalCents
        || toMoney(order.totalTaxSet) !== value.taxCents || toMoney(order.totalShippingPriceSet) !== value.shippingCents
        || order.lineItems?.pageInfo?.hasNextPage !== false || order.lineItems?.nodes?.length !== bag.items.length
        || bag.items.some(item => !order.lineItems.nodes.some(line => line.variant?.id === item.variantId && line.quantity === item.qty && line.sku === item.sku
          && toMoney(line.originalUnitPriceSet) === item.unitPriceCents && taxesMatch(line.taxLines, value.lineTaxCents[item.sku])))
        || order.shippingLines?.pageInfo?.hasNextPage !== false || order.shippingLines?.nodes?.length !== 1
        || toMoney(order.shippingLines.nodes[0].originalPriceSet) !== value.shippingCents
        || !taxesMatch(order.shippingLines.nodes[0].taxLines, value.shippingTaxCents)
        || !order.transactions?.some(transaction => transaction.test === true && transaction.kind === 'SALE' && transaction.status === 'SUCCESS' && toMoney(transaction.amountSet) === value.totalCents)
        || !equalAddress(fullName, ctx.details.shipTo.name) || !equalAddress(address?.address1, ctx.details.shipTo.line1)
        || !equalAddress(address?.address2, ctx.details.shipTo.line2) || !equalAddress(address?.city, ctx.details.shipTo.city)
        || !equalAddress(address?.provinceCode, ctx.details.shipTo.region) || !equalAddress(address?.zip, ctx.details.shipTo.postal)
        || !equalAddress(address?.countryCodeV2, ctx.details.shipTo.country)
        || order.email !== `bag-${hash(bag.id).slice(0, 24)}@relay.avafem.com`)
        throw fail('SHOPIFY_READBACK_MISMATCH', 'A brand order did not match its captured payment allocation and minimal address.');
      value.stockDecrementVerified = true;
      for (const item of bag.items) {
        const current = await adapter.getVariant(item.variantId);
        if (current.inventoryQty !== value.stockBeforeDispatch?.[item.variantId] - item.qty) value.stockDecrementVerified = false;
      }
      value.verified = true; value.state = 'order_created';
      await db.query("UPDATE external_orders SET external_order_id=$2,state='created',updated_at=now() WHERE bag_id=$1", [bag.id, value.orderId]);
      await ctx.save('dispatching');
    }
    if (ctx.snapshot.bags.every(bag => ctx.details.bags[bag.id].verified)) await ctx.save('orders_created');
  }
  async function reconcile(runId) {
    return withRun(runId, async ctx => {
      const { snapshot, details } = ctx;
      if (ctx.state === 'abandoned_platform_switch') return;
      if (details.authorizationCancelled) return;
      // Checkout dispatch is complete. Lifecycle workers now own shipment,
      // refund and payout state; replaying payment events must not rewind it.
      if (details.canonicalCommitted && snapshot.bags.every(bag => details.bags[bag.id]?.verified)) {
        await db.query('UPDATE unified_checkout_runs SET checkout_dispatch_complete=true WHERE id=$1', [snapshot.id]);
        for (const bag of snapshot.bags) await db.query("UPDATE external_orders SET external_order_id=$2,state='created',updated_at=now() WHERE bag_id=$1 AND (external_order_id IS NULL OR external_order_id=$2)", [bag.id, details.bags[bag.id].orderId]);
        return;
      }
      const { stripe, checked } = await stripeReady(details.accountId);
      details.accountId = checked.accountId;
      if (!details.sessionId) {
        if (details.sessionStartedAt && wallNow().getTime() - new Date(details.sessionStartedAt).getTime() >= 23 * 3600_000)
          throw fail('CHECKOUT_RECONCILIATION_REQUIRED', 'The original Session creation is too old to repeat safely.');
        details.sessionStartedAt ??= wallNow().toISOString(); await ctx.save('checkout_creating');
        const session = await stripe.createCheckoutSession({ orderId: snapshot.id,
          items: snapshot.bags.flatMap(bag => bag.items), shippingCents: snapshot.bags.reduce((sum, bag) => sum + bag.shippingCents, 0),
          shippingTaxCode: 'txcd_92010001', successUrl: snapshot.successUrl, cancelUrl: snapshot.cancelUrl, captureMethod: 'manual' });
        if (session?.livemode !== false || !/^cs_test_[A-Za-z0-9]+$/.test(session.id ?? '') || typeof session.url !== 'string'
          || new URL(session.url).hostname !== 'checkout.stripe.com' || new URL(session.url).protocol !== 'https:')
          throw fail('STRIPE_TEST_REQUIRED', 'Stripe must return a real test hosted Checkout Session.');
        details.sessionId = session.id; details.sessionUrl = session.url; details.sessionExpiresAt = session.expires_at;
        await ctx.save('checkout_open');
      }
      const session = await stripe.getCheckoutSession(details.sessionId);
      if (session.id !== details.sessionId || session.livemode !== false || session.client_reference_id !== snapshot.id)
        throw fail('CHECKOUT_IDENTITY_MISMATCH', 'Stripe returned a Session that is not bound to this cart.');
      if (session.status === 'expired') { await ctx.save('checkout_expired'); return; }
      if (session.status !== 'complete') { await ctx.save('checkout_open'); return; }
      if (!details.paymentVerified) {
        const lines = []; let after;
        for (let page = 0; page < 10; page++) {
          const result = await stripe.listCheckoutLineItems(details.sessionId, { startingAfter: after, limit: 100 });
          lines.push(...result.data);
          if (!result.has_more) break;
          after = result.data.at(-1)?.id;
          if (!after || page === 9) throw fail('CHECKOUT_LINE_MISMATCH', 'Complete Stripe line-item pagination is required.');
        }
        const allocations = allocateCheckout(session, lines, snapshot);
        details.shipTo = checkoutAddress(session);
        details.shopperEmail = typeof session.customer_details?.email === 'string' ? session.customer_details.email : null;
        details.amounts = { subtotalCents: session.amount_subtotal, shippingCents: session.shipping_cost.amount_subtotal,
          taxCents: session.total_details.amount_tax, totalCents: session.amount_total };
        for (const bag of allocations) details.bags[bag.id] = { ...bag, ...(details.bags[bag.id] ?? {}) };
        const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (!/^pi_[A-Za-z0-9]+$/.test(paymentId ?? '') || (details.paymentIntentId && details.paymentIntentId !== paymentId))
          throw fail('PAYMENT_IDENTITY_MISMATCH', 'One immutable PaymentIntent must fund the entire cart.');
        details.paymentIntentId = paymentId; await ctx.save('authorized');
        let payment = await stripe.getPaymentIntent(paymentId);
        const verifyPayment = value => {
          if (value.id !== paymentId || value.livemode !== false || value.currency !== 'usd' || value.amount !== session.amount_total
            || value.metadata?.order_id !== snapshot.id || value.metadata?.integration !== 'avafem' || value.transfer_group !== `ORD_${snapshot.id}`)
            throw fail('PAYMENT_IDENTITY_MISMATCH', 'The PaymentIntent does not match the unified test cart.');
        };
        verifyPayment(payment);
        if (payment.status === 'requires_capture') {
          try { for (const bag of snapshot.bags) for (const item of bag.items) await eligibleVariant(bag.shop, item.variantId, item.qty, item); }
          catch (cause) {
            details.captureBlocked = diagnostic(cause); await ctx.save('capture_blocked', details.captureBlocked);
            const cancelled = await stripe.cancelPaymentIntent({ paymentIntentId: paymentId, orderId: snapshot.id });
            if (cancelled.status !== 'canceled' || cancelled.amount_received) throw fail('AUTHORIZATION_CANCEL_UNVERIFIED', 'Review the original authorization before taking another payment.');
            details.authorizationCancelled = true; await ctx.save('authorization_cancelled', details.captureBlocked); return;
          }
          details.captureStartedAt ??= wallNow().toISOString(); await ctx.save('capture_pending');
          await stripe.capturePaymentIntent({ paymentIntentId: paymentId, orderId: snapshot.id, amountCents: session.amount_total });
          payment = await stripe.getPaymentIntent(paymentId);
        }
        verifyPayment(payment);
        if (payment.status !== 'succeeded' || payment.amount_received !== session.amount_total || payment.livemode !== false)
          throw fail('PAYMENT_NOT_CAPTURED', 'Do not create paid brand orders until the full test payment is captured.');
        const chargeId = typeof payment.latest_charge === 'string' ? payment.latest_charge : payment.latest_charge?.id;
        if (!/^ch_[A-Za-z0-9]+$/.test(chargeId ?? '')) throw fail('PAYMENT_NOT_CAPTURED', 'A real successful test charge is required.');
        const charge = await stripe.getCharge(chargeId);
        if (charge.id !== chargeId || charge.livemode !== false || charge.captured !== true || charge.paid !== true || charge.amount !== session.amount_total
          || charge.payment_intent !== paymentId || charge.currency !== 'usd') throw fail('PAYMENT_NOT_CAPTURED', 'The Stripe charge does not verify this captured unified payment.');
        details.chargeId = chargeId; details.paymentVerified = true; details.chargeBalanceTransactionId = typeof charge.balance_transaction === 'string'
          ? charge.balance_transaction : charge.balance_transaction?.id;
        details.captureVerifiedAt = wallNow().toISOString(); await ctx.save('paid');
      }
      if (!details.canonicalCommitted) await commitCanonical(ctx);
      await dispatch(ctx);
    });
  }
  async function setTestClock(runId, { confirmTestClock, now }) {
    if (confirmTestClock !== true || !Number.isFinite(new Date(now).getTime())) throw fail('TEST_CLOCK_CONFIRMATION_REQUIRED', 'Explicitly confirm this run’s isolated test clock.', 422);
    return withRun(runId, async ctx => {
      const prior = ctx.details.testClock?.now ?? ctx.wallNow().toISOString();
      const next = new Date(now);
      if (next < new Date(prior) || next > new Date(ctx.wallNow().getTime() + 366 * 86400_000)) throw fail('TEST_CLOCK_INVALID', 'The isolated clock only moves forward by at most one year.', 422);
      ctx.details.testClock = { mode: 'isolated_app_test_clock', now: next.toISOString(), approvedAt: ctx.details.testClock?.approvedAt ?? ctx.wallNow().toISOString() };
      await ctx.save(ctx.state);
    });
  }
  return { options, create, get, list, reconcile, setTestClock,
    runtime: { withRun, read, decode, get, journal, emit, wallNow }, stores, stripeReady };
}
