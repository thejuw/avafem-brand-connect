import { createHash, randomUUID } from 'node:crypto';
import { TEST_STORES } from './test-stores.mjs';
import { SHOPIFY_ALLOWED_WEBHOOK_TOPICS } from './integrations/shopify-policy.mjs';
import { shopifyBagTag } from './integrations/projection.mjs';

const STRIPE_TOPICS = new Set(['checkout.session.completed', 'payment_intent.succeeded']);
const SHOPIFY_WORKFLOWS = new Set(['orders/updated', 'orders/cancelled', 'refunds/create', 'fulfillments/create']);
const RUN_ID = /^uco_[a-f0-9]{32}$/;
const delivery = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/.test(value);
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, eventSafe: true });
const redacted = cause => ({ code: cause?.eventSafe ? cause.code : 'PROVIDER_EVENT_REVIEW', message: cause?.eventSafe ? cause.message : 'Authoritative provider reconciliation remains unverified. Review this encrypted event; no replacement provider operation was requested.' });
const providerId = (value, type) => {
  if (typeof value === 'string' && new RegExp(`^gid://shopify/${type}/\\d+$`).test(value)) return value;
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^\d+$/.test(value))) return `gid://shopify/${type}/${value}`;
  return null;
};

/**
 * Durable queue for ALREADY signature-verified Stripe/Shopify envelopes. This module does
 * not authenticate HTTP requests: callers MUST verify the exact raw body first.
 * Payloads are encrypted; statuses/errors are non-sensitive. Events route only to immutable
 * unified provider bindings and authoritative read/reconciliation APIs, never legacy sandbox
 * workers. Amounts, status and ordering from the event body are not accounting evidence.
 * A claimed event is attempted at most once per processPending call, at most three times
 * automatically. Underlying workflows own durable mutation intents/idempotency/reconciliation;
 * this worker never calls payment/order/refund/transfer create APIs directly.
 */
export async function createProviderEvents(db, auth, { unifiedCheckout, stores, providerMoney, providerFulfillment, providerCatalog } = {}) {
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !unifiedCheckout?.reconcile || !stores?.row || !stores?.forShop
    || !stores?.disconnect || !providerMoney?.ingestShopifyRefund || !providerMoney?.ingestShopifyCancellation || !providerFulfillment?.sync)
    throw fail('PROVIDER_EVENT_SETUP', 'Encrypted storage, unified checkout and authoritative provider workflows are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS unified_provider_events (
    provider TEXT NOT NULL,delivery_id TEXT NOT NULL,topic TEXT NOT NULL,shop TEXT,payload_encrypted TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_until TIMESTAMPTZ,
    last_error JSONB,received_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(provider,delivery_id))`);
  for (const column of ['lease_token TEXT', 'processed_at TIMESTAMPTZ', 'last_attempt_at TIMESTAMPTZ', 'run_id TEXT', 'bag_id TEXT', 'payload_hash TEXT'])
    await db.query(`ALTER TABLE unified_provider_events ADD COLUMN IF NOT EXISTS ${column}`);

  async function queue({ provider, deliveryId, topic, shop = null, payload, occurredAt = null } = {}) {
    if (!['stripe', 'shopify'].includes(provider) || !delivery(deliveryId) || typeof topic !== 'string' || !/^[a-z_]+(?:[./][a-z_]+){1,3}$/.test(topic)
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('PROVIDER_EVENT_INPUT', 'A verified, bounded provider envelope is required.', 422);
    if (provider === 'shopify' && (!TEST_STORES.some(store => store.shop === shop) || !SHOPIFY_ALLOWED_WEBHOOK_TOPICS.includes(topic)))
      throw fail('PROVIDER_EVENT_STORE', 'Only exact authorized test-store Shopify topics can enter this queue.', 422);
    if (provider === 'stripe' && shop !== null) throw fail('PROVIDER_EVENT_INPUT', 'Stripe envelopes cannot select a Shopify store.', 422);
    if (occurredAt !== null && (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now() + 300_000)) throw fail('PROVIDER_EVENT_INPUT', 'An occurrence timestamp must be valid and not in the future.', 422);
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > 262_144) throw fail('PROVIDER_EVENT_INPUT', 'The verified event exceeds the bounded encrypted queue size.', 422);
    const fingerprint = createHash('sha256').update(JSON.stringify({ topic, shop, payload, occurredAt })).digest('hex');
    const result = await db.query(`INSERT INTO unified_provider_events(provider,delivery_id,topic,shop,payload_encrypted,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,delivery_id) DO NOTHING RETURNING state`,
    [provider, deliveryId, topic, shop, auth.encrypt({ payload, occurredAt }), fingerprint]);
    const stored = result.rows[0] ?? (await db.query('SELECT state,payload_hash FROM unified_provider_events WHERE provider=$1 AND delivery_id=$2', [provider, deliveryId])).rows[0];
    if (!result.rows.length && stored.payload_hash && stored.payload_hash !== fingerprint) throw fail('PROVIDER_EVENT_DUPLICATE_CONFLICT', 'This delivery ID is already bound to a different verified envelope. Preserve the original event.', 409);
    return { accepted: true, duplicate: !result.rows.length, provider, deliveryId, state: stored.state };
  }
  async function isManagedEvent(provider, deliveryId) {
    if (!['stripe', 'shopify'].includes(provider) || !delivery(deliveryId)) return false;
    return Boolean((await db.query('SELECT 1 FROM unified_provider_events WHERE provider=$1 AND delivery_id=$2', [provider, deliveryId])).rows.length);
  }
  const decode = row => ({ snapshot: auth.decrypt(row.snapshot_encrypted), details: auth.decrypt(row.details_encrypted) });
  async function runRow(runId) {
    const row = (await db.query('SELECT * FROM unified_checkout_runs WHERE id=$1', [runId])).rows[0];
    if (!row) throw fail('PROVIDER_EVENT_BINDING_PENDING', 'No immutable unified run is bound to this provider event yet.');
    if (row.lock_token && row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw fail('PROVIDER_EVENT_RUN_BUSY', 'The bound unified run is currently owned by another worker.');
    const value = decode(row);
    if (value.snapshot.id !== row.id || value.snapshot.currency !== 'USD' || !Array.isArray(value.snapshot.bags)) throw fail('PROVIDER_EVENT_BINDING_INVALID', 'The immutable unified run could not be verified.');
    return { row, ...value };
  }
  function verifiedResult(result, runId) {
    if (result?.id !== runId || result.processing === true || result.leaseBusy === true || result.lastError)
      throw fail('PROVIDER_EVENT_WORKFLOW_PENDING', 'The bound authoritative workflow is busy or still requires reconciliation.');
  }
  async function route(event) {
    const envelope = auth.decrypt(event.payload_encrypted);
    // Backward-compatible with the previously queued encrypted raw body.
    const payload = envelope.payload ?? envelope;
    if (event.provider === 'stripe') {
      if (!STRIPE_TOPICS.has(event.topic)) return { state: 'ignored', reason: 'UNSUPPORTED_STRIPE_TOPIC' };
      const object = payload.data?.object;
      if (payload.id !== event.delivery_id || payload.type !== event.topic || payload.livemode !== false || object?.livemode !== false
        || object.metadata?.integration !== 'avafem' || !RUN_ID.test(object.metadata?.order_id ?? ''))
        throw fail('PROVIDER_EVENT_IDENTITY_INVALID', 'Stripe test-mode envelope and Avafem run metadata must match.');
      const runId = object.metadata.order_id;
      const { details } = await runRow(runId);
      const expected = event.topic === 'checkout.session.completed' ? details.sessionId : details.paymentIntentId;
      const pattern = event.topic === 'checkout.session.completed' ? /^cs_test_[A-Za-z0-9]+$/ : /^pi_[A-Za-z0-9]+$/;
      if (!pattern.test(object.id ?? '') || (expected && expected !== object.id)) throw fail('PROVIDER_EVENT_IDENTITY_INVALID', 'Stripe object identity does not match this unified run.');
      verifiedResult(await unifiedCheckout.reconcile(runId), runId);
      return { state: 'complete', action: 'unified_checkout_reconciled', runId };
    }
    if (event.topic === 'app/uninstalled') {
      if (payload.myshopify_domain !== event.shop) throw fail('PROVIDER_EVENT_IDENTITY_INVALID', 'Uninstall body and verified shop binding must match.');
      if (!envelope.occurredAt) throw fail('PROVIDER_EVENT_UNINSTALL_TIME_REQUIRED', 'The verified ingress must retain Shopify’s triggered-at timestamp for uninstall review.');
      const result = await stores.disconnect(event.shop, envelope.occurredAt);
      return result?.ignored ? { state: 'ignored', reason: 'STALE_INSTALLATION_EVENT' } : { state: 'complete', action: 'test_installation_disconnected' };
    }
    if (!SHOPIFY_WORKFLOWS.has(event.topic)) {
      if (!providerCatalog?.sync) return { state: 'ignored', reason: 'CATALOG_REQUIRES_EXPLICIT_VERIFIED_IMPORT' };
      const registry = await stores.row(event.shop);
      const result = await providerCatalog.sync({ shop: event.shop });
      if (result?.test !== true || result.complete !== true || result.shop !== event.shop || result.brandId !== registry?.brand_id)
        throw fail('PROVIDER_EVENT_CATALOG_PENDING', 'A complete authoritative exact-store catalog snapshot is required.');
      return { state: 'complete', action: 'provider_catalog_synced' };
    }
    const orderId = event.topic.startsWith('orders/') ? providerId(payload.admin_graphql_api_id ?? payload.id, 'Order') : providerId(payload.order_id ?? payload.order?.admin_graphql_api_id, 'Order');
    if (!orderId) throw fail('PROVIDER_EVENT_IDENTITY_INVALID', 'A precise Shopify order identity is required for authoritative reconciliation.');
    const mapped = (await db.query(`SELECT e.bag_id,e.brand_id,b.order_id FROM external_orders e
      JOIN bags b ON b.id=e.bag_id JOIN orders o ON o.id=b.order_id
      WHERE e.shop=$1 AND e.external_order_id=$2 AND b.brand_id=e.brand_id AND b.provider_bound=true AND o.provider_bound=true`, [event.shop, orderId])).rows;
    if (mapped.length !== 1) throw fail('PROVIDER_EVENT_BINDING_PENDING', 'No unique canonical provider order is bound to this exact shop and event.');
    const mapping = mapped[0]; const runId = mapping.order_id;
    if (!RUN_ID.test(runId)) throw fail('PROVIDER_EVENT_BINDING_INVALID', 'The mapped order is not an isolated unified provider run.');
    const { snapshot, details } = await runRow(runId);
    const bag = snapshot.bags.find(item => item.id === mapping.bag_id);
    const registry = await stores.row(event.shop);
    if (!bag || bag.shop !== event.shop || bag.brandId !== mapping.brand_id || registry.shop !== bag.shop || registry.brand_id !== bag.brandId
      || details.bags?.[bag.id]?.orderId !== orderId || details.bags[bag.id].verified !== true || details.paymentVerified !== true || details.canonicalCommitted !== true)
      throw fail('PROVIDER_EVENT_BINDING_INVALID', 'The event does not match the frozen shop, brand, Bag and captured payment.');
    const order = await (await stores.forShop(event.shop)).getOrderOperations(orderId);
    if (order?.id !== orderId || order.test !== true || order.currencyCode !== 'USD' || order.presentmentCurrencyCode !== 'USD'
      || order.sourceIdentifier !== bag.id || !order.tags?.includes(shopifyBagTag(bag.id)) || !order.tags.includes('TEST_DO_NOT_SHIP') || order.operationsComplete !== true)
      throw fail('PROVIDER_EVENT_ORDER_UNVERIFIED', 'The current Shopify test order does not verify this immutable Bag.');
    const target = { runId, bagId: bag.id };
    let result; let action;
    if (event.topic === 'refunds/create') {
      const refundId = providerId(payload.admin_graphql_api_id ?? payload.id, 'Refund');
      if (!refundId || !order.refunds?.some(refund => refund.id === refundId)) throw fail('PROVIDER_EVENT_REFUND_PENDING', 'The event refund is not present in authoritative order readback yet.');
      result = await providerMoney.ingestShopifyRefund({ ...target, shopifyRefundId: refundId }); action = 'native_refund_reconciled';
    } else if (event.topic === 'orders/cancelled') {
      if (!order.cancelledAt || !Number.isFinite(Date.parse(order.cancelledAt))) throw fail('PROVIDER_EVENT_CANCELLATION_PENDING', 'Cancellation is not present in authoritative order readback yet.');
      result = await providerMoney.ingestShopifyCancellation(target); action = 'native_cancellation_reconciled';
    } else { result = await providerFulfillment.sync(target); action = 'provider_fulfillment_synced'; }
    verifiedResult(result, runId);
    return { state: 'complete', action, ...target };
  }

  async function processPending({ limit = 10 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw fail('PROVIDER_EVENT_LIMIT', 'Process between one and twenty verified events at a time.', 422);
    // A process can die during its third attempt. Expiry must retire that unknown outcome
    // for review, not strand it in processing forever or grant a fourth remote attempt.
    await db.query(`UPDATE unified_provider_events SET state='pending_review',lease_token=NULL,lease_until=NULL,
      processed_at=now(),last_error=$1 WHERE attempts>=3 AND (state='pending' OR
        (state='processing' AND (lease_until IS NULL OR lease_until<now())))`,
    [JSON.stringify({ code: 'PROVIDER_EVENT_ATTEMPTS_EXHAUSTED', message: 'The final worker lease expired. Reconcile authoritative provider state before any further action.' })]);
    const candidates = (await db.query(`SELECT provider,delivery_id FROM unified_provider_events
      WHERE attempts<3 AND (state='pending' OR (state='processing' AND (lease_until IS NULL OR lease_until<now())))
      ORDER BY received_at,provider,delivery_id LIMIT $1`, [limit])).rows;
    const outcomes = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const event = (await db.query(`UPDATE unified_provider_events SET state='processing',attempts=attempts+1,
        lease_token=$3,lease_until=now()+interval '5 minutes',last_attempt_at=now()
        WHERE provider=$1 AND delivery_id=$2 AND attempts<3 AND (state='pending' OR (state='processing' AND (lease_until IS NULL OR lease_until<now()))) RETURNING *`,
      [candidate.provider, candidate.delivery_id, leaseToken])).rows[0];
      if (!event) continue;
      let result; let error = null;
      try { result = await route(event); }
      catch (cause) { error = redacted(cause); result = { state: event.attempts >= 3 ? 'pending_review' : 'pending' }; }
      const reason = result.reason ? { code: result.reason, message: 'This verified event was retained without invoking a provider or legacy sandbox mutation.' } : error;
      const saved = await db.query(`UPDATE unified_provider_events SET state=$4,last_error=$5,run_id=$6,bag_id=$7,
        processed_at=CASE WHEN $4 IN ('complete','ignored','pending_review') THEN now() ELSE NULL END,lease_token=NULL,lease_until=NULL
        WHERE provider=$1 AND delivery_id=$2 AND lease_token=$3 RETURNING delivery_id`,
      [event.provider, event.delivery_id, leaseToken, result.state, reason ? JSON.stringify(reason) : null, result.runId ?? null, result.bagId ?? null]);
      if (saved.rows.length) outcomes.push({ provider: event.provider, deliveryId: event.delivery_id, state: result.state, attempts: event.attempts,
        ...(result.action ? { action: result.action } : {}), ...(result.runId ? { runId: result.runId } : {}), ...(result.bagId ? { bagId: result.bagId } : {}) });
    }
    return { processed: outcomes.length, events: outcomes };
  }
  return { queue, isManagedEvent, processPending };
}
