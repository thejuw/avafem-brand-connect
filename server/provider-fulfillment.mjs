import { createHash } from 'node:crypto';
import { shopifyBagTag } from './integrations/projection.mjs';

const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const problem = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, message, statusCode, unifiedSafe: true });
const fail = (code, message, status) => { throw problem(code, message, status); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const gid = (value, kind) => typeof value === 'string' && new RegExp(`^gid://shopify/${kind}/[A-Za-z0-9-]+$`).test(value);
const iso = value => { const date = new Date(value); if (!Number.isFinite(date.getTime())) fail('FULFILLMENT_TIME_INVALID', 'A valid provider or logical timestamp is required.'); return date.toISOString(); };
// Missing/ambiguous history must never prove a pre-fulfillment refund. This is
// provider wall time, not the accelerated return-window clock.
const historicalTime = (value, now) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now ? time : null;
};
const operation = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/.test(value)) fail('FULFILLMENT_INPUT_INVALID', 'A stable, bounded operation ID is required.', 422);
  return value;
};
const own = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined;
const sorted = items => items.map(({ sku, qty }) => ({ sku, qty })).sort((a, b) => a.sku.localeCompare(b.sku));
const sameItems = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const safeError = () => ({ code: 'PROVIDER_FULFILLMENT_UNCERTAIN', message: 'Preserve this fulfillment intent and reconcile its provider tracking and quantities. No replacement fulfillment was created.' });
function inputItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20 || items.some(item => typeof item?.sku !== 'string'
    || !item.sku || item.sku.length > 128 || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 100)
    || new Set(items.map(item => item.sku)).size !== items.length) fail('FULFILLMENT_INPUT_INVALID', 'Provide unique Bag SKUs and positive bounded quantities.', 422);
  return sorted(items);
}
function trackingInput(value) {
  const number = value?.number;
  if (typeof number !== 'string' || !/^AVAFEM-TEST-[A-Z0-9-]{1,80}$/i.test(number)
    || (value?.company ?? 'Other') !== 'Other') fail('SYNTHETIC_TRACKING_REQUIRED', 'Use an AVAFEM-TEST- tracking number with company Other; no real carrier shipment is authorized.', 422);
  let url;
  if (value.url) {
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'example.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      url = parsed.href;
    } catch { fail('SYNTHETIC_TRACKING_REQUIRED', 'Synthetic tracking URLs must use https://example.com without credentials or query data.', 422); }
  }
  return { number: number.toUpperCase(), company: 'Other', ...(url ? { url } : {}) };
}

/** Actual Shopify TEST fulfillment records, never labels or carrier delivery proof.
 * Caller owns the owner/CSRF boundary. runtime.withRun provides the shared durable
 * lease; every provider mutation has an immutable saved intent before dispatch.
 */
export async function createProviderFulfillment(db, auth, { runtime, stores } = {}) {
  if (!db?.transaction || !auth?.encrypt || !runtime?.withRun || !runtime?.get || !stores?.row || !stores?.forShop)
    throw problem('PROVIDER_FULFILLMENT_SETUP', 'Encrypted storage, the unified runtime and exact-store registry are required.', 503);
  await db.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS provider_fulfillment_id TEXT');
  await db.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS provider_status TEXT');
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS shipments_provider_fulfillment ON shipments(bag_id,provider_fulfillment_id) WHERE provider_fulfillment_id IS NOT NULL`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_notifications (
    id TEXT PRIMARY KEY,business_key TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL,bag_id TEXT NOT NULL,
    body_encrypted TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'simulated_delivered',receipt_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const guarded = (runId, bagId, action) => runtime.withRun(runId, async ctx => {
    try { await action(ctx); }
    catch (cause) {
      // Stale delivery eligibility must not survive a failed identity/pagination read.
      if (ctx.snapshot.bags.some(bag => bag.id === bagId) && ctx.details.bags?.[bagId]) ctx.details.bags[bagId].fullyDelivered = false;
      throw cause;
    }
  });

  async function inspect(ctx, bagId) {
    const bag = ctx.snapshot.bags.find(bag => bag.id === bagId);
    const detail = ctx.details.bags?.[bagId];
    if (!bag || !detail || !ctx.details.paymentVerified || !ctx.details.canonicalCommitted || detail.verified !== true
      || !gid(detail.orderId, 'Order')) fail('PROVIDER_BAG_NOT_READY', 'A paid, committed Bag with a verified Shopify test order is required.');
    const registry = await stores.row(bag.shop);
    if (!registry || registry.shop !== bag.shop || registry.brand_id !== bag.brandId) fail('FULFILLMENT_TENANT_MISMATCH', 'The store registry does not match this Bag’s immutable brand binding.');
    const adapter = await stores.forShop(bag.shop);
    const order = await adapter.getOrderOperations(detail.orderId);
    if (!order || order.id !== detail.orderId || order.test !== true || order.sourceIdentifier !== bag.id
      || !order.tags?.includes('TEST_DO_NOT_SHIP') || !order.tags.includes(shopifyBagTag(bag.id))
      || order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD') fail('FULFILLMENT_ORDER_MISMATCH', 'Provider order identity, test mode, currency and Bag marker must match.');
    if (order.operationsComplete !== true || order.lineItems?.pageInfo?.hasNextPage !== false
      || order.fulfillmentOrders?.pageInfo?.hasNextPage !== false || !Array.isArray(order.lineItems.nodes)
      || !Array.isArray(order.fulfillmentOrders.nodes) || !Array.isArray(order.fulfillments) || !Array.isArray(order.refunds)
      || order.fulfillmentsCount?.precision !== 'EXACT' || order.fulfillmentsCount.count !== order.fulfillments.length
      || order.fulfillmentOrders.nodes.some(fo => fo.lineItems?.pageInfo?.hasNextPage !== false || !Array.isArray(fo.lineItems.nodes))
      || order.fulfillments.some(f => f.fulfillmentLineItems?.pageInfo?.hasNextPage !== false || f.events?.pageInfo?.hasNextPage !== false
        || !Array.isArray(f.fulfillmentLineItems.nodes) || !Array.isArray(f.events.nodes))
      || order.refunds.some(refund => refund.refundLineItems?.pageInfo?.hasNextPage !== false || refund.transactions?.pageInfo?.hasNextPage !== false
        || !Array.isArray(refund.refundLineItems.nodes))) fail('FULFILLMENT_PAGINATION_REQUIRED', 'All provider line, fulfillment-order, fulfillment, event and refund pages must be complete.');
    if (!Array.isArray(bag.items) || !bag.items.length || new Set(bag.items.map(item => item.sku)).size !== bag.items.length
      || order.lineItems.nodes.length !== bag.items.length) fail('FULFILLMENT_LINES_AMBIGUOUS', 'Exact, unique Bag SKU identities are required for this bounded fulfillment API.');
    const byId = new Map(); const lines = new Map();
    for (const item of bag.items) {
      const matches = order.lineItems.nodes.filter(line => line.sku === item.sku && line.variant?.id === item.variantId);
      if (matches.length !== 1) fail('FULFILLMENT_LINES_MISMATCH', 'Shopify lines do not match the frozen variant/SKU mapping.');
      const line = matches[0];
      if (!gid(line.id, 'LineItem') || line.quantity !== item.qty || !count(line.currentQuantity) || line.currentQuantity > item.qty
        || !count(line.unfulfilledQuantity) || line.unfulfilledQuantity > item.qty) fail('FULFILLMENT_QUANTITY_MISMATCH', 'Provider ordered/current/unfulfilled quantities do not match the Bag.');
      lines.set(item.sku, { ...item, lineId: line.id, current: line.currentQuantity, unfulfilled: line.unfulfilledQuantity,
        refunded: 0, localRefunded: 0, fulfilled: 0, delivered: 0, foRemaining: 0, provenPreFulfillmentRefunded: 0 });
      byId.set(line.id, item.sku);
    }
    for (const refund of order.refunds) for (const line of refund.refundLineItems.nodes) {
      const sku = byId.get(line.lineItem?.id);
      if (!sku || !count(line.quantity)) fail('FULFILLMENT_REFUND_MISMATCH', 'Provider refund quantities must map to this Bag’s original line IDs.');
      lines.get(sku).refunded += line.quantity;
    }
    const refundOps = Object.values(detail.refundOps ?? {});
    for (const refund of refundOps.filter(op => op.stripeStatus === 'succeeded')) {
      // A separately completed shipping-only refund consumes no item quantities.
      // Preserve strict validation for missing records and unlabelled empty refunds.
      if (!Array.isArray(refund.items) || (!refund.items.length && (refund.refundShipping !== true
        || refund.subtotalCents !== 0 || !Number.isSafeInteger(refund.shippingCents) || refund.shippingCents <= 0)))
        fail('FULFILLMENT_REFUND_MISMATCH', 'Successful refunds require original item quantities or an explicit shipping-only allocation.');
      for (const item of refund.items) {
      if (!lines.has(item.sku) || !count(item.qty)) fail('FULFILLMENT_REFUND_MISMATCH', 'Successful refund quantities do not match this Bag.');
      lines.get(item.sku).localRefunded += item.qty;
      }
    }
    let refundMismatch = false;
    for (const line of lines.values()) {
      if (line.refunded > line.qty || line.localRefunded > line.qty || line.current !== line.qty - line.refunded)
        fail('FULFILLMENT_REFUND_MISMATCH', 'Provider refunded/current quantities contradict the immutable order.');
      line.remaining = line.qty - Math.max(line.refunded, line.localRefunded);
      if (line.refunded !== line.localRefunded) refundMismatch = true;
    }
    for (const fo of order.fulfillmentOrders.nodes) {
      if (!gid(fo.id, 'FulfillmentOrder')) fail('FULFILLMENT_ORDER_MISMATCH', 'A provider fulfillment order ID is invalid.');
      for (const item of fo.lineItems.nodes) {
        const sku = byId.get(item.lineItem?.id);
        if (!sku || item.lineItem.sku !== sku || !gid(item.id, 'FulfillmentOrderLineItem')
          || !count(item.remainingQuantity) || !count(item.totalQuantity) || item.remainingQuantity > item.totalQuantity)
          fail('FULFILLMENT_LINES_MISMATCH', 'Fulfillment-order lines must belong to this exact provider order.');
        if (!['CANCELLED', 'CANCELED'].includes(fo.status)) lines.get(sku).foRemaining += item.remainingQuantity;
      }
    }
    const fulfillments = []; const ids = new Set();
    for (const fulfillment of order.fulfillments) {
      if (!gid(fulfillment.id, 'Fulfillment') || ids.has(fulfillment.id)) fail('FULFILLMENT_ID_MISMATCH', 'Fulfillment identities are invalid or duplicated.');
      ids.add(fulfillment.id);
      const quantities = new Map();
      for (const item of fulfillment.fulfillmentLineItems.nodes) {
        const sku = byId.get(item.lineItem?.id);
        if (!sku || item.lineItem.sku !== sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1)
          fail('FULFILLMENT_LINES_MISMATCH', 'Fulfillment quantities must map to the original provider line IDs.');
        quantities.set(sku, (quantities.get(sku) || 0) + item.quantity);
      }
      if (!quantities.size) fail('FULFILLMENT_LINES_MISMATCH', 'A provider fulfillment must contain mapped items.');
      const active = fulfillment.status === 'SUCCESS';
      const tracking = Array.isArray(fulfillment.trackingInfo) ? fulfillment.trackingInfo.map(item => trackingInput(item)) : [];
      if (active && (!tracking.length || tracking.some(item => !/^AVAFEM-TEST-[A-Z0-9-]{1,80}$/i.test(item.number ?? ''))))
        fail('SYNTHETIC_TRACKING_REQUIRED', 'Active fixture fulfillments require synthetic tracking; no carrier proof is inferred.');
      const deliveredEvents = fulfillment.events.nodes.filter(event => event.status === 'DELIVERED');
      const observed = [...(fulfillment.deliveredAt ? [fulfillment.deliveredAt] : []), ...deliveredEvents.map(event => event.happenedAt)].map(iso);
      if (observed.some(value => new Date(value) > new Date(ctx.wallNow().getTime() + 60_000))) fail('FULFILLMENT_TIME_INVALID', 'Provider delivery timestamps cannot come from the isolated future clock.');
      const deliveredAt = observed.length ? observed.sort().at(-1) : null;
      for (const [sku, qty] of quantities) if (active) {
        const line = lines.get(sku); line.fulfilled += qty; if (deliveredAt) line.delivered += qty;
        if (line.fulfilled > line.qty) fail('FULFILLMENT_QUANTITY_MISMATCH', 'Active provider fulfillments exceed the original ordered quantity.');
      }
      fulfillments.push({ id: fulfillment.id, status: fulfillment.status, displayStatus: fulfillment.displayStatus ?? null,
        createdAt: historicalTime(fulfillment.createdAt, ctx.wallNow().getTime()) === null ? null : iso(fulfillment.createdAt),
        active, items: sorted([...quantities].map(([sku, qty]) => ({ sku, qty }))),
        tracking: tracking.map(item => ({ number: String(item.number || '').toUpperCase(), company: typeof item.company === 'string' ? item.company.slice(0, 100) : 'Other', ...(item.url ? { url: item.url } : {}) })),
        providerDeliveredAt: deliveredAt, carrierVerified: false });
    }
    // NO_RESTOCK does not identify whether refunded units had shipped. Only a
    // fully correlated, completed refund strictly BEFORE EVERY fulfillment
    // (including cancelled history) can explain the native unfulfilled/FO
    // residual. Mixed or incomplete history gets no exception at all.
    const historyTimes = fulfillments.map(value => value.createdAt === null ? null : Date.parse(value.createdAt));
    const itemRefunds = order.refunds.filter(refund => refund.refundLineItems.nodes.some(line => line.quantity > 0));
    let provenHistory = historyTimes.length > 0 && historyTimes.every(value => value !== null)
      && itemRefunds.length > 0 && new Set(order.refunds.map(refund => refund.id)).size === order.refunds.length;
    for (const refund of itemRefunds) {
      const refundTime = historicalTime(refund.createdAt, ctx.wallNow().getTime());
      const matches = refundOps.filter(op => op.shopifyRefundId === refund.id || op.sourceShopifyRefundId === refund.id);
      const op = matches[0];
      const nativeItems = refund.refundLineItems.nodes.map(line => ({ sku: byId.get(line.lineItem?.id), qty: line.quantity }));
      if (!gid(refund.id, 'Refund') || refundTime === null || historyTimes.some(time => time === null || refundTime >= time)
        || matches.length !== 1 || op.status !== 'complete' || op.stripeStatus !== 'succeeded' || op.shopifyVerified !== true
        || op.shopifyRefundId !== refund.id || (op.sourceShopifyRefundId && op.sourceShopifyRefundId !== refund.id)
        || new Set(nativeItems.map(item => item.sku)).size !== nativeItems.length
        || refund.refundLineItems.nodes.some(line => line.restockType !== 'NO_RESTOCK' || line.quantity < 1)
        || !Array.isArray(op.items) || !sameItems(nativeItems, op.items)
        || !Array.isArray(op.lineItems) || op.lineItems.length !== nativeItems.length
        || new Set(op.lineItems.map(line => line.lineItemId)).size !== op.lineItems.length
        || refund.refundLineItems.nodes.some(line => !op.lineItems.some(expected => expected.lineItemId === line.lineItem.id
          && expected.sku === byId.get(line.lineItem.id) && expected.qty === line.quantity))
        || !gid(op.parentTransactionId, 'OrderTransaction') || !Array.isArray(refund.transactions.nodes)
        || !refund.transactions.nodes.some(tx => tx.kind === 'REFUND' && tx.status === 'SUCCESS' && tx.test === true
          && tx.gateway === 'manual' && tx.parentTransaction?.id === op.parentTransactionId)) {
        provenHistory = false; break;
      }
      for (const item of nativeItems) lines.get(item.sku).provenPreFulfillmentRefunded += item.qty;
    }
    if (!provenHistory || [...lines.values()].some(line => line.provenPreFulfillmentRefunded !== line.refunded
      || line.provenPreFulfillmentRefunded !== line.localRefunded)) {
      for (const line of lines.values()) line.provenPreFulfillmentRefunded = 0;
    }
    return { bag, detail, registry, adapter, order, lines, fulfillments, refundMismatch,
      refundPending: refundOps.some(op => op.status !== 'complete') };
  }

  function matches(fulfillment, op) {
    return sameItems(fulfillment.items, op.items) && fulfillment.tracking.some(tracking => tracking.number === op.tracking.number
      && tracking.company === op.tracking.company && (!op.tracking.url || tracking.url === op.tracking.url));
  }
  function reconcileIntents(info) {
    let unresolved = false;
    for (const op of Object.values(info.detail.fulfillmentOps ?? {})) {
      const found = info.fulfillments.filter(fulfillment => (!op.fulfillmentId || fulfillment.id === op.fulfillmentId) && matches(fulfillment, op));
      if (found.length > 1) fail('FULFILLMENT_DUPLICATE_PROVIDER_MATCH', 'Multiple provider fulfillments match one saved intent. Manual review is required.');
      if (found.length === 1) { op.fulfillmentId = found[0].id; op.status = 'complete'; op.providerStatus = found[0].status; }
      else if (op.status !== 'complete') unresolved = true;
      else fail('FULFILLMENT_READBACK_MISMATCH', 'A completed fulfillment intent no longer matches its provider tracking and quantities.');
    }
    return unresolved;
  }
  async function applySnapshot(ctx, info) {
    const unresolved = reconcileIntents(info);
    for (const op of Object.values(info.detail.deliveryOps ?? {})) {
      for (const [fulfillmentId, child] of Object.entries(op.children ?? {})) {
        if (info.fulfillments.some(fulfillment => fulfillment.id === fulfillmentId && fulfillment.providerDeliveredAt)) child.status = 'complete';
      }
      if (Object.values(op.children ?? {}).length && Object.values(op.children).every(child => child.status === 'complete')) op.status = 'complete';
    }
    const lineValues = [...info.lines.values()];
    // A pending/confirmed cancellation or a closed canonical Bag is a hard
    // eligibility hold even if a delayed provider snapshot omits cancelledAt.
    const canonicalState = (await db.query('SELECT status FROM bags WHERE id=$1 AND brand_id=$2', [info.bag.id, info.bag.brandId])).rows[0]?.status;
    const cancellationHold = Boolean(info.order.cancelledAt || info.detail.cancelOp || info.detail.cancellationVerified
      || ['cancelled','refunded'].includes(info.detail.state) || ['cancelled','refunded'].includes(canonicalState));
    const hasRemaining = lineValues.some(line => line.remaining > 0);
    const hasShipment = info.fulfillments.some(f => f.active);
    const shipped = hasRemaining && !cancellationHold && lineValues.every(line => (line.unfulfilled === 0
      && line.foRemaining === 0 && line.fulfilled >= line.remaining)
      || (!info.refundPending && !info.refundMismatch && line.provenPreFulfillmentRefunded > 0
        && line.fulfilled === line.remaining && line.unfulfilled <= line.provenPreFulfillmentRefunded
        && line.foRemaining <= line.provenPreFulfillmentRefunded));
    const delivered = shipped && !unresolved && !info.refundPending && !info.refundMismatch
      && info.fulfillments.filter(f => f.active).every(f => f.providerDeliveredAt)
      && lineValues.every(line => line.delivered >= line.remaining);
    const shippingStatus = !hasRemaining ? 'fully_refunded' : cancellationHold ? 'cancellation_review' : delivered ? 'delivered' : shipped ? 'shipped' : hasShipment ? 'partially_fulfilled' : 'unfulfilled';
    const previousDelivered = info.detail.deliveredAt;
    let deliveredAt = null; let providerDeliveredAt = null; let payoutDueAt = null;
    if (delivered) {
      deliveredAt = iso(previousDelivered ?? ctx.now());
      providerDeliveredAt = info.fulfillments.filter(f => f.active).map(f => f.providerDeliveredAt).sort().at(-1);
      const snapshotDays = info.bag.returnWindowDays ?? 30; const currentDays = info.registry.return_window_days ?? 30;
      if (!count(snapshotDays) || !count(currentDays)) fail('FULFILLMENT_POLICY_INVALID', 'Snapshot and current return windows must be nonnegative whole days.');
      payoutDueAt = new Date(Math.max(new Date(deliveredAt).getTime() + Math.max(30, snapshotDays, currentDays) * DAY,
        info.detail.payoutDueAt ? new Date(iso(info.detail.payoutDueAt)).getTime() : 0)).toISOString();
    }
    await db.transaction(async tx => {
      const canonical = (await tx.query('SELECT id,order_id,brand_id,provider_bound,status,delivered_at,payout_due_at FROM bags WHERE id=$1 FOR UPDATE', [info.bag.id])).rows[0];
      if (!canonical?.provider_bound || canonical.order_id !== ctx.snapshot.id || canonical.brand_id !== info.bag.brandId)
        fail('FULFILLMENT_CANONICAL_MISMATCH', 'The canonical provider Bag must match this run and brand.');
      if (delivered && canonical.payout_due_at) payoutDueAt = new Date(Math.max(new Date(payoutDueAt).getTime(), new Date(canonical.payout_due_at).getTime())).toISOString();
      for (const fulfillment of info.fulfillments) {
        const shipmentId = `pful_${hash(`${info.bag.shop}:${fulfillment.id}`)}`;
        const firstTracking = fulfillment.tracking[0];
        if (!firstTracking?.number) { if (fulfillment.active) fail('SYNTHETIC_TRACKING_REQUIRED', 'Active provider fulfillment tracking is missing.'); continue; }
        const prior = (await tx.query('SELECT id FROM shipments WHERE id=$1', [shipmentId])).rows[0];
        await tx.query(`INSERT INTO shipments(id,bag_id,brand_id,carrier,tracking_number,tracking_url,items,shipped_at,provider_fulfillment_id,provider_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET carrier=$4,tracking_number=$5,tracking_url=$6,items=$7,provider_status=$10`,
        [shipmentId, info.bag.id, info.bag.brandId, firstTracking.company, firstTracking.number, firstTracking.url ?? null,
          JSON.stringify(fulfillment.items), ctx.wallNow(), fulfillment.id, fulfillment.status]);
        if (fulfillment.active) {
          const businessKey = `provider-shipping-notice:${info.bag.shop}:${fulfillment.id}`;
          const key = hash(businessKey);
          const inserted = await tx.query(`INSERT INTO provider_notifications(id,business_key,run_id,bag_id,body_encrypted,state,receipt_id)
            VALUES($1,$2,$3,$4,$5,'simulated_delivered',$6) ON CONFLICT(business_key) DO NOTHING RETURNING id`,
          [`notice_${key}`, businessKey, ctx.snapshot.id, info.bag.id, auth.encrypt({ mode: 'simulated_inbox', externalEmailDelivered: false,
            runId: ctx.snapshot.id, bagId: info.bag.id, shop: info.bag.shop, fulfillmentId: fulfillment.id,
            items: fulfillment.items, tracking: fulfillment.tracking, recordedAt: ctx.wallNow().toISOString() }), `simulated_${key}`]);
          if (!prior || inserted.rows.length) await ctx.emit(tx, 'bag.shipment_recorded', info.bag.id, info.bag.brandId,
            { bagId: info.bag.id, shop: info.bag.shop, fulfillmentId: fulfillment.id, items: fulfillment.items,
              trackingNumber: firstTracking.number, noticeMode: 'simulated_inbox', externalEmailDelivered: false });
        }
      }
      const canonicalStatus = delivered ? 'delivered' : shipped ? 'shipped' : 'awaiting_shipment';
      if (!['refunded', 'cancelled'].includes(canonical.status)) {
        await tx.query(`UPDATE bags SET status=$2,delivered_at=CASE WHEN $3::timestamptz IS NULL THEN delivered_at ELSE COALESCE(delivered_at,$3) END,
          payout_due_at=CASE WHEN $4::timestamptz IS NULL THEN payout_due_at ELSE $4 END,updated_at=$5 WHERE id=$1`,
        [info.bag.id, canonicalStatus, deliveredAt, payoutDueAt, ctx.wallNow()]);
        if (payoutDueAt) await tx.query("UPDATE transfers SET due_at=GREATEST(COALESCE(due_at,$2),$2) WHERE bag_id=$1 AND status IN ('scheduled','held')", [info.bag.id, payoutDueAt]);
        if (canonical.status !== canonicalStatus && ['shipped', 'delivered'].includes(canonicalStatus)) await ctx.emit(tx,
          delivered ? 'bag.delivered' : 'bag.shipped', info.bag.id, info.bag.brandId,
          { bagId: info.bag.id, shop: info.bag.shop, shippingStatus, logicalAt: deliveredAt ?? ctx.now().toISOString(),
            providerDeliveredAt, deliveryEvidence: delivered ? 'shopify_test_delivery_event' : null, carrierVerified: false });
      }
    });
    Object.assign(info.detail, { shippingStatus, fullyDelivered: delivered, fulfillmentReview: unresolved || info.refundPending || info.refundMismatch,
      fulfillments: info.fulfillments, fulfillmentSyncedAt: ctx.wallNow().toISOString() });
    if (!['refunded', 'cancelled'].includes(info.detail.state)) info.detail.state = delivered ? 'delivered' : shipped ? 'shipped' : hasShipment ? 'partially_fulfilled' : 'order_created';
    if (delivered) Object.assign(info.detail, { deliveredAt, providerDeliveredAt, payoutDueAt, deliveryEvidence: 'shopify_test_delivery_event', carrierVerified: false });
    await ctx.save(undefined, unresolved ? safeError() : info.refundPending || info.refundMismatch
      ? { code: 'FULFILLMENT_REFUND_REVIEW', message: 'Refund quantities or recovery are unresolved; no delivery eligibility is inferred.' } : null);
    return { shipped, delivered, unresolved, cancellationHold };
  }
  async function sync({ runId, bagId }) {
    return guarded(runId, bagId, async ctx => { await applySnapshot(ctx, await inspect(ctx, bagId)); });
  }
  async function fulfill({ runId, bagId, operationId, items, tracking }) {
    operation(operationId); const requested = inputItems(items); const synthetic = trackingInput(tracking);
    const fingerprint = hash(JSON.stringify({ items: requested, tracking: synthetic }));
    return guarded(runId, bagId, async ctx => {
      let info = await inspect(ctx, bagId);
      info.detail.fulfillmentOps ??= {};
      const prior = own(info.detail.fulfillmentOps, operationId);
      if (prior && prior.fingerprint !== fingerprint) fail('FULFILLMENT_OPERATION_CHANGED', 'This operation ID belongs to different immutable items or tracking.', 422);
      const current = await applySnapshot(ctx, info);
      if (prior) return; // A prior mutation can only be reconciled; never recreate it.
      if (current.cancellationHold) fail('FULFILLMENT_ORDER_CLOSED', 'A pending or confirmed cancellation/closed Bag cannot start another shipment.');
      if (info.refundPending || info.refundMismatch) fail('FULFILLMENT_REFUND_REVIEW', 'Resolve refund quantities and recovery before creating a shipment.');
      if (Object.values(info.detail.fulfillmentOps).some(op => op.status !== 'complete')) fail('FULFILLMENT_PRIOR_UNCERTAIN', 'Reconcile the earlier fulfillment intent before another provider mutation.');
      if (info.order.cancelledAt || !['PAID', 'PARTIALLY_REFUNDED'].includes(info.order.displayFinancialStatus)) fail('FULFILLMENT_ORDER_CLOSED', 'Only an open paid or partially refunded test order can be fulfilled.');
      for (const item of requested) {
        const line = info.lines.get(item.sku);
        if (!line || item.qty > Math.max(0, line.remaining - line.fulfilled) || item.qty > line.unfulfilled)
          fail('FULFILLMENT_QUANTITY_EXCEEDED', 'Requested quantities exceed nonrefunded units not already fulfilled.', 422);
      }
      const intent = { fingerprint, items: requested, tracking: synthetic, status: 'intent',
        providerOperationId: `ful_${hash(`${runId}:${bagId}:${operationId}`)}`, createdAt: ctx.wallNow().toISOString() };
      const existing = info.fulfillments.filter(fulfillment => matches(fulfillment, intent));
      if (existing.length > 1) fail('FULFILLMENT_DUPLICATE_PROVIDER_MATCH', 'Multiple fulfillments already match this tracking and item subset.');
      if (existing.length === 1) {
        intent.fulfillmentId = existing[0].id; intent.status = 'complete'; info.detail.fulfillmentOps[operationId] = intent;
        await applySnapshot(ctx, info); return;
      }
      if (info.fulfillments.some(fulfillment => fulfillment.tracking.some(item => item.number === synthetic.number)))
        fail('FULFILLMENT_TRACKING_REUSED', 'This synthetic tracking number already belongs to a different provider item subset.');
      // Location.isFulfillmentService requires unapproved read_locations. The
      // adapter re-verifies the merchant-managed-only scope ceiling before its
      // write; choose only an actual assigned location with a native action here.
      const plans = info.order.fulfillmentOrders.nodes.filter(fo => /^gid:\/\/shopify\/Location\/[A-Za-z0-9-]+$/.test(fo.assignedLocation?.location?.id ?? '')
        && fo.supportedActions?.some(action => action.action === 'CREATE_FULFILLMENT') && !['CANCELLED', 'CANCELED', 'CLOSED'].includes(fo.status))
        .map(fo => ({ fo, items: requested.map(item => {
          const line = fo.lineItems.nodes.find(line => line.lineItem.sku === item.sku && line.remainingQuantity >= item.qty);
          return line ? { fulfillmentOrderLineItemId: line.id, qty: item.qty } : null;
        }) })).filter(plan => plan.items.every(Boolean));
      if (!plans.length) fail('FULFILLMENT_ORDER_UNAVAILABLE', 'No single merchant-managed fulfillment order covers this subset. Split it into separate explicit operations.');
      intent.fulfillmentOrderId = plans[0].fo.id; intent.providerItems = plans[0].items;
      info.detail.fulfillmentOps[operationId] = intent; await ctx.save();
      try {
        const result = await info.adapter.createPartialFulfillment({ orderId: info.detail.orderId, fulfillmentOrderId: intent.fulfillmentOrderId,
          items: intent.providerItems, tracking: intent.tracking, operationId: intent.providerOperationId });
        if (result?.shop !== info.bag.shop || result.orderId !== info.detail.orderId || !gid(result.fulfillment?.id, 'Fulfillment')) throw problem('FULFILLMENT_READBACK_MISMATCH', 'Provider create response did not match the saved intent.');
        intent.fulfillmentId = result.fulfillment.id; intent.status = 'uncertain'; await ctx.save();
      } catch { intent.status = 'uncertain'; await ctx.save('needs_review', safeError()); return; }
      info = await inspect(ctx, bagId); await applySnapshot(ctx, info);
    });
  }
  async function deliver({ runId, bagId, operationId, confirmTestDelivery }) {
    operation(operationId);
    if (confirmTestDelivery !== true) fail('TEST_DELIVERY_CONFIRMATION_REQUIRED', 'Confirm that this creates synthetic Shopify test delivery evidence, not carrier proof.', 422);
    return guarded(runId, bagId, async ctx => {
      let info = await inspect(ctx, bagId);
      const current = await applySnapshot(ctx, info);
      if (info.refundPending || info.refundMismatch || current.unresolved) fail('FULFILLMENT_REFUND_REVIEW', 'Resolve uncertain shipment/refund evidence before test delivery.');
      if (!current.shipped) fail('FULFILLMENT_PARTIAL_DELIVERY_BLOCKED', 'All remaining nonrefunded quantities must be fulfilled before delivery can start the hold.');
      if (current.delivered) return;
      info.detail.deliveryOps ??= {};
      const active = info.fulfillments.filter(f => f.active);
      const fingerprint = hash(JSON.stringify(active.map(f => f.id).sort()));
      let intent = own(info.detail.deliveryOps, operationId);
      if (intent && intent.fingerprint !== fingerprint) fail('FULFILLMENT_OPERATION_CHANGED', 'This delivery operation was bound to different fulfillment IDs.', 422);
      if (!intent) { intent = { fingerprint, children: {}, status: 'intent', createdAt: ctx.wallNow().toISOString() }; info.detail.deliveryOps[operationId] = intent; await ctx.save(); }
      for (const fulfillment of active) {
        const prior = own(intent.children, fulfillment.id);
        if (fulfillment.providerDeliveredAt) { if (prior) prior.status = 'complete'; continue; }
        if (prior) { await ctx.save('needs_review', { code: 'PROVIDER_TEST_DELIVERY_UNCERTAIN', message: 'A prior test delivery event has no matching provider evidence. Inspect it instead of recreating the event.' }); return; }
        const child = { operationId: `del_${hash(`${runId}:${bagId}:${operationId}:${fulfillment.id}`)}`, status: 'intent' };
        intent.children[fulfillment.id] = child; await ctx.save();
        try {
          const result = await info.adapter.createTestDeliveryEvent({ orderId: info.detail.orderId, fulfillmentId: fulfillment.id, operationId: child.operationId });
          if (result?.shop !== info.bag.shop || result.orderId !== info.detail.orderId || result.fulfillmentEvent?.status !== 'DELIVERED') throw new Error();
          child.eventId = result.fulfillmentEvent.id; child.status = 'uncertain'; await ctx.save();
        } catch { child.status = 'uncertain'; await ctx.save('needs_review', { code: 'PROVIDER_TEST_DELIVERY_UNCERTAIN', message: 'Test delivery outcome is uncertain. Reconcile this existing event; it is not carrier proof.' }); return; }
      }
      info = await inspect(ctx, bagId);
      const final = await applySnapshot(ctx, info);
      if (!final.delivered) { await ctx.save('needs_review', { code: 'PROVIDER_TEST_DELIVERY_UNVERIFIED', message: 'Complete provider delivery readback is required before the return-window hold starts.' }); return; }
      for (const child of Object.values(intent.children)) child.status = 'complete';
      intent.status = 'complete'; await ctx.save();
    });
  }
  async function listNotifications(runId) {
    await runtime.get(runId);
    return (await db.query('SELECT id,run_id,bag_id,state,receipt_id,created_at FROM provider_notifications WHERE run_id=$1 ORDER BY created_at,id', [runId])).rows.map(row => ({
      id: row.id, runId: row.run_id, bagId: row.bag_id, state: row.state, receiptId: row.receipt_id, createdAt: row.created_at,
      mode: 'simulated_inbox', simulated: true, externalEmailDelivered: false,
    }));
  }
  return { fulfill, sync, deliver, listNotifications };
}
