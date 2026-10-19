import { randomUUID, randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { hash } from './auth.mjs';
import { SHOPIFY_ALLOWED_SCOPES, missingShopifyScopes } from './integrations/shopify-policy.mjs';
import { createShopifyAdapter, createStripeAdapter, projectBrandBag, deliverOutboundWebhook, validatePublicHttpsUrl } from './integrations/index.mjs';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const text = value => String(value ?? '').slice(0, 500);

export async function createOperations(db, domain, auth, config = {}) {
  const schema = `CREATE TABLE IF NOT EXISTS connector_state (
    provider TEXT PRIMARY KEY, brand_id TEXT, details JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS external_orders (
    bag_id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, shop TEXT NOT NULL, external_order_id TEXT,
    state TEXT NOT NULL, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS shopify_order_attempts (
    id TEXT PRIMARY KEY, shop TEXT NOT NULL, bag_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS inbound_webhooks (
    provider TEXT NOT NULL, delivery_id TEXT NOT NULL, topic TEXT NOT NULL, shop TEXT,
    raw_encrypted TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    last_error TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ,
    PRIMARY KEY(provider,delivery_id)
  ); CREATE TABLE IF NOT EXISTS outbound_webhook_endpoints (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, url TEXT NOT NULL, secret_encrypted TEXT NOT NULL,
    scopes JSONB NOT NULL DEFAULT '["orders:read"]', active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, brand_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '72 hours',
    last_error TEXT, delivered_at TIMESTAMPTZ, UNIQUE(event_id,endpoint_id)
  ); CREATE TABLE IF NOT EXISTS sandbox_inbox (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, brand_id TEXT, bag_id TEXT,
    subject TEXT NOT NULL, body JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS handoff_links (
    token_hash TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, bag_id TEXT NOT NULL, brand_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
  ); CREATE TABLE IF NOT EXISTS catalog_imports (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    rows JSONB NOT NULL, cursor INT NOT NULL DEFAULT 0, accepted INT NOT NULL DEFAULT 0,
    errors JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
  ); CREATE TABLE IF NOT EXISTS checkout_sessions (
    id TEXT PRIMARY KEY, payment_intent_id TEXT UNIQUE, snapshot JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', order_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  for (const statement of schema.split(';').filter(part => part.trim())) await db.query(statement);
  await db.query(`ALTER TABLE outbound_webhook_endpoints ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '["orders:read"]'`);
  await db.query("ALTER TABLE sandbox_inbox ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await db.query('ALTER TABLE inbound_webhooks ADD COLUMN IF NOT EXISTS brand_id TEXT');
  await db.query('ALTER TABLE inbound_webhooks ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ');
  // Encrypt legacy private dispatch bodies, including capability URLs, on startup.
  while (true) {
    const changed = await db.transaction(async tx => {
      const old = (await tx.query("SELECT id,body FROM sandbox_inbox WHERE NOT (body ? 'encryptedBody') LIMIT 100 FOR UPDATE")).rows;
      for (const row of old) await tx.query('UPDATE sandbox_inbox SET body=$1 WHERE id=$2', [JSON.stringify({ encryptedBody: auth.encrypt(row.body) }), row.id]);
      return old.length;
    });
    if (!changed) break;
  }
  const shopify = config.shopify ?? createShopifyAdapter({ test: true });
  const initialStripe = config.stripe ?? createStripeAdapter({ allowLive: false, testConnectedAccountIds: config.testConnectedAccountIds });
  let stripe = initialStripe;
  let stripeVerification = null;
  const serverEnv = config.serverEnv ?? process.env;
  const originalStripeEnvironment = { secretKey: serverEnv.STRIPE_SECRET_KEY, webhookSecret: serverEnv.STRIPE_WEBHOOK_SECRET };
  let localStripeConfigured = false;
  let running = false;

  async function connections() {
    const stored = (await db.query("SELECT * FROM connector_state WHERE provider='shopify'")).rows[0];
    const status = await shopify.status();
    const missingScopes = stored?.details?.grantedScopes ? missingShopifyScopes(stored.details.grantedScopes) : [];
    const unexpectedScopes = (stored?.details?.grantedScopes || []).filter(scope => !SHOPIFY_ALLOWED_SCOPES.includes(scope));
    const verified = Boolean(status.available && stored?.details?.verified && !missingScopes.length && !unexpectedScopes.length);
    return {
      shopify: { ...(stored?.details || {}), ...status, connected: verified,
        verified, missingScopes, unexpectedScopes, lastVerification: stored?.details || null,
        brandId: stored?.brand_id || null, lastCheckedAt: stored?.updated_at || null,
        mode: 'own-store-test', message: missingScopes.length || unexpectedScopes.length ? 'The installed app needs reauthorization to match the approved scope policy.' : verified ? 'My Store 2 verified. Brand stores require their own app and OAuth installation.' : status.message },
      brandShopifyConnections: config.shopifyConnections ? await config.shopifyConnections.status() : [],
      stripe: { ...await stripe.status(), ...(stripeVerification || {}) },
      fallback: { available: true, mode: 'sandbox-inbox', message: 'Dashboard handoff is working. Email delivery needs an email provider.' },
      api: { available: true, tokenLifetimeSeconds: 3600, idempotencyHours: 24, requestsPerSecond: 10, burst: 30 },
      mcp: { available: true, path: '/mcp', transport: 'streamable-http' },
      productionReady: false,
      missingSetup: ['Stripe test credentials and webhook secret', 'Public HTTPS callback/webhook URL',
        'Email provider and delivery verification', 'Carrier delivery-verification source', 'Legal, tax and brand-policy decisions'],
    };
  }
  async function configureStripeTest({ secretKey, webhookSecret }) {
    if (typeof secretKey !== 'string' || !/^(sk|rk)_test_[A-Za-z0-9]{16,}$/.test(secretKey))
      throw fail(422, 'STRIPE_TEST_KEY_REQUIRED', 'Enter a Stripe secret test key, not a publishable or live key.');
    if (webhookSecret !== undefined && (typeof webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]{16,}$/.test(webhookSecret)))
      throw fail(422, 'STRIPE_WEBHOOK_SECRET_INVALID', 'Enter a valid webhook signing secret or leave the field empty.');
    const factory = config.stripeFactory ?? createStripeAdapter;
    const candidate = factory({ secretKey, webhookSecret, env: {}, allowLive: false, testConnectedAccountIds: config.testConnectedAccountIds });
    // Read-only verification; no account, PaymentIntent, order, transfer or refund is created.
    const checked = await candidate.preflight();
    if (!checked?.verified || checked.mode !== 'test' || !/^acct_[A-Za-z0-9]+$/.test(checked.accountId || ''))
      throw fail(409, 'STRIPE_VERIFICATION_FAILED', 'Stripe test account verification did not pass. Existing configuration was not changed.');
    serverEnv.STRIPE_SECRET_KEY = secretKey;
    if (webhookSecret) serverEnv.STRIPE_WEBHOOK_SECRET = webhookSecret;
    else delete serverEnv.STRIPE_WEBHOOK_SECRET;
    stripe = candidate;
    localStripeConfigured = true;
    stripeVerification = { provider: 'stripe', available: true, connected: true, verified: true, mode: 'test', accountId: checked.accountId,
      chargesEnabled: Boolean(checked.chargesEnabled), payoutsEnabled: Boolean(checked.payoutsEnabled), configured: true, storage: 'process-memory', clearedOnRestart: true,
      webhookConfigured: Boolean(webhookSecret), verifiedAt: new Date().toISOString() };
    return { configured: true, verified: true, mode: 'test', accountId: checked.accountId,
      webhookConfigured: Boolean(webhookSecret), storage: 'process-memory', clearedOnRestart: true };
  }
  function clearLocalStripeCredentials() {
    if (!localStripeConfigured) return;
    for (const [key, value] of [['STRIPE_SECRET_KEY', originalStripeEnvironment.secretKey], ['STRIPE_WEBHOOK_SECRET', originalStripeEnvironment.webhookSecret]]) {
      if (value === undefined) delete serverEnv[key]; else serverEnv[key] = value;
    }
    stripeVerification = null;
    stripe = initialStripe;
    localStripeConfigured = false;
  }
  async function ensureShopifyBrand() {
    const existing = (await db.query("SELECT brand_id FROM connector_state WHERE provider='shopify'")).rows[0];
    if (existing?.brand_id) return domain.getBrand(existing.brand_id);
    const found = (await domain.listBrands()).find(brand => brand.slug === 'avafem-shopify-test');
    return found ?? domain.createBrand({ name: 'Avafem Shopify Test', slug: 'avafem-shopify-test', commissionBps: 1500,
      connectionTier: 'shopify', supportEmail: 'sandbox@example.com', shippingTable: [{ country: 'US', priceCents: 0 }] });
  }
  async function preflightShopify() {
    const details = await shopify.preflight();
    if (details.missingScopes?.length) throw fail(409, 'MISSING_SHOPIFY_SCOPES', 'The installed app is missing required scopes.');
    if (details.unexpectedScopes?.length) throw fail(409, 'UNAPPROVED_SHOPIFY_SCOPES', 'The installed app has scopes outside the approved allowlist. Review and reinstall before acceptance testing.');
    const brand = await ensureShopifyBrand();
    await db.query(`INSERT INTO connector_state(provider,brand_id,details) VALUES('shopify',$1,$2)
      ON CONFLICT(provider) DO UPDATE SET brand_id=$1,details=$2,updated_at=now()`, [brand.id, JSON.stringify(details)]);
    await domain.updateBrand(brand.id, { connectionHealthy: true, connectionTier: 'shopify' });
    return { ...details, brandId: brand.id };
  }
  async function importShopify(brandId) {
    const adapter = brandId ? await config.shopifyConnections.forBrand(brandId) : shopify;
    const verified = brandId ? { ...await adapter.preflight(), brandId } : await preflightShopify();
    if (verified.missingScopes?.length || verified.unexpectedScopes?.length) throw fail(409, 'SHOPIFY_SCOPE_POLICY', 'Reauthorize this store with the approved permissions before syncing.');
    let after = null; const imported = []; const issues = [];
    const existing = await domain.listProducts({ brandId: verified.brandId });
    for (let page = 0; page < 100; page++) {
      const result = await adapter.listProducts({ first: 25, after });
      for (const product of result.products) {
        if (product.currency !== 'USD') { issues.push({ sku: product.sku, message: 'Only USD catalogs are supported in this sandbox.' }); continue; }
        if (product.variantsPageInfo?.hasNextPage) { issues.push({ sku: product.sku, message: 'Product has additional variants; complete pagination before listing.' }); continue; }
        const prior = existing.find(p => p.sku === product.sku);
        imported.push(await domain.upsertProduct(verified.brandId, product.sku, {
          ...product, description: String(product.description).replace(/<[^>]*>/g, '').slice(0, 20_000),
          category: prior?.category || 'uncategorized', taxCode: prior?.taxCode || '',
          evidence: prior?.evidence || { ingredients_inci: [], certifications: [], claims: [] },
        }));
      }
      if (!result.pageInfo.hasNextPage) return { brandId: verified.brandId, imported: imported.length, products: imported, issues };
      after = result.pageInfo.endCursor;
    }
    throw fail(422, 'CATALOG_LIMIT', 'Catalog exceeded the bounded import size; use a bulk import job.');
  }
  async function pushShopify(bagId) {
    const connection = (await db.query("SELECT * FROM connector_state WHERE provider='shopify'")).rows[0];
    const bag = await domain.getBag(bagId);
    if (!connection || bag.brandId !== connection.brand_id) throw fail(409, 'WRONG_SHOPIFY_BRAND', 'This Bag is not assigned to the connected test store.');
    if (bag.taxCents > 0) throw fail(409, 'AUTHORITATIVE_TAX_REQUIRED', 'Configure authoritative Stripe Tax lines before pushing a taxable Bag. The local tax fixture must not be sent as a real tax calculation.');
    if (bag.status !== 'awaiting_shipment' || bag.refundedCents > 0) throw fail(409, 'BAG_NOT_PUSHABLE', 'Only an unpaid-out, unshipped, unrefunded fulfillment instruction can be pushed.');
    const reserved = await db.transaction(async tx => {
      const current = (await tx.query(`SELECT b.status,b.refunded_cents,
        EXISTS(SELECT 1 FROM refunds r WHERE r.bag_id=b.id AND r.status='proposed') AS refund_pending
        FROM bags b WHERE b.id=$1 FOR UPDATE`, [bag.id])).rows[0];
      if (current.status !== 'awaiting_shipment' || current.refunded_cents > 0 || current.refund_pending)
        throw fail(409, 'BAG_NOT_PUSHABLE', 'This Bag is shipped, refunded or held for refund review.');
      const inserted = await tx.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state) VALUES($1,$2,$3,'pending')
        ON CONFLICT DO NOTHING RETURNING *`, [bag.id, bag.brandId, connection.details.shop.myshopifyDomain]);
      if (inserted.rows.length) {
        const attempts = (await tx.query("SELECT COUNT(*)::integer AS count FROM shopify_order_attempts WHERE shop=$1 AND created_at>now()-interval '60 seconds'", [connection.details.shop.myshopifyDomain])).rows[0].count;
        if (attempts >= 5) throw fail(429, 'SHOPIFY_DEV_ORDER_LIMIT', 'The development store has reached five order attempts per minute. Wait before dispatching another Bag.');
        await tx.query('INSERT INTO shopify_order_attempts(id,shop,bag_id) VALUES($1,$2,$3)', [id('attempt'), connection.details.shop.myshopifyDomain, bag.id]);
      }
      // One fulfillment instruction channel only, even if the remote outcome becomes uncertain.
      await tx.query('UPDATE handoff_links SET used_at=now() WHERE bag_id=$1 AND used_at IS NULL', [bag.id]);
      await tx.query("UPDATE sandbox_inbox SET status='closed' WHERE bag_id=$1", [bag.id]);
      return { fresh: Boolean(inserted.rows.length), row: inserted.rows[0] || (await tx.query('SELECT * FROM external_orders WHERE bag_id=$1', [bag.id])).rows[0] };
    });
    if (!reserved.fresh) {
      if (reserved.row.external_order_id) return { orderId: reserved.row.external_order_id, alreadyExists: true };
      const found = await shopify.findOrder(bag.id);
      if (found) {
        await db.query("UPDATE external_orders SET external_order_id=$1,state='created',updated_at=now() WHERE bag_id=$2", [found.id, bag.id]);
        return { order: found, alreadyExists: true };
      }
      throw fail(409, 'SHOPIFY_OUTCOME_UNCERTAIN', 'A previous push needs reconciliation. Dashboard fallback must not send a second fulfillment instruction.');
    }
    const products = await domain.listProducts({ brandId: bag.brandId });
    const enriched = { ...bag, items: bag.items.map(item => {
      const product = products.find(p => p.sku === item.sku);
      const variant = product?.variants?.find(v => v.sku === (item.variantSku || item.sku))
        || (product?.variants?.length === 1 ? product.variants[0] : null);
      if (!variant?.shopifyVariantId) throw fail(409, 'VARIANT_MAPPING_REQUIRED', 'Map the exact Shopify variant before pushing this Bag.');
      return { ...item, shopifyVariantId: variant.shopifyVariantId };
    }) };
    try {
      const result = await shopify.createOrder(enriched, { paid: true, test: true, inventoryBehaviour: 'BYPASS', taxLines: [] });
      await db.query("UPDATE external_orders SET external_order_id=$1,state='created',updated_at=now() WHERE bag_id=$2", [result.order.id, bag.id]);
      return result;
    } catch (error) {
      // A persistent uncertain state survives process restarts. Never turn this into a duplicate email handoff.
      await db.query('UPDATE external_orders SET state=$1,last_error=$2,updated_at=now() WHERE bag_id=$3',
        [error.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' : 'needs_review', text(error.message), bag.id]);
      throw error;
    }
  }
  async function saveInbound(provider, deliveryId, topic, raw, shop, metadata = {}) {
    if (!deliveryId || deliveryId.length > 200) throw fail(400, 'DELIVERY_ID_REQUIRED', 'A webhook delivery ID is required.');
    const occurredAt = metadata.occurredAt ? new Date(metadata.occurredAt) : null;
    if (occurredAt && !Number.isFinite(occurredAt.getTime())) throw fail(400, 'INVALID_EVENT_TIME', 'Webhook event time is invalid.');
    const result = await db.query(`INSERT INTO inbound_webhooks(provider,delivery_id,topic,raw_encrypted,shop,brand_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING delivery_id`, [provider, deliveryId, topic, auth.encrypt({ raw: raw.toString('utf8') }), shop || null, metadata.brandId || null, occurredAt]);
    return { received: true, duplicate: !result.rows.length };
  }
  async function addEndpoint(brandId, url, scopes = ['orders:read']) {
    await validatePublicHttpsUrl(url);
    const secret = `avf_whsec_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    const endpointId = id('whe');
    await db.query('INSERT INTO outbound_webhook_endpoints(id,brand_id,url,secret_encrypted,scopes) VALUES($1,$2,$3,$4,$5)', [endpointId, brandId, url, auth.encrypt({ secret }), JSON.stringify(scopes)]);
    return { id: endpointId, url, scopes, signingSecret: secret, message: 'Shown once. Store this signing secret securely.' };
  }
  async function listEndpoints(brandId) {
    return (await db.query('SELECT id,brand_id,url,active,created_at FROM outbound_webhook_endpoints WHERE brand_id=$1', [brandId])).rows;
  }
  async function enqueueImport(brandId, input) {
    const rows = Array.isArray(input.rows) ? input.rows : typeof input.csv === 'string'
      ? parse(input.csv, { columns: true, skip_empty_lines: true, trim: true, max_record_size: 100_000 }) : null;
    if (!rows || !rows.length || rows.length > 5000) throw fail(422, 'INVALID_IMPORT', 'Provide 1–5,000 catalog rows.');
    const importId = id('imp');
    await db.query('INSERT INTO catalog_imports(id,brand_id,rows) VALUES($1,$2,$3)', [importId, brandId, JSON.stringify(rows)]);
    return { id: importId, status: 'queued', total: rows.length };
  }
  async function processImports() {
    const rows = (await db.query("SELECT * FROM catalog_imports WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 1")).rows;
    for (const job of rows) {
      const errors = [...job.errors]; let accepted = job.accepted; let cursor = job.cursor;
      for (const row of job.rows.slice(cursor, cursor + 25)) {
        try {
          const input = { ...row, priceCents: Number(row.priceCents ?? row.price_cents ?? row.price?.amount),
            inventoryQty: Number(row.inventoryQty ?? row.inventory_qty ?? row.inventory?.qty ?? 0) };
          if (typeof row.evidence === 'string') input.evidence = JSON.parse(row.evidence);
          if (typeof row.images === 'string') input.images = row.images.split('|').filter(Boolean);
          await domain.upsertProduct(job.brand_id, row.sku, input); accepted++;
        } catch (error) { errors.push({ row: cursor + 2, sku: text(row.sku), message: text(error.message) }); }
        cursor++;
      }
      await db.query('UPDATE catalog_imports SET cursor=$1,accepted=$2,errors=$3,status=$4,completed_at=$5 WHERE id=$6',
        [cursor, accepted, JSON.stringify(errors), cursor >= job.rows.length ? 'completed' : 'processing', cursor >= job.rows.length ? new Date() : null, job.id]);
    }
  }
  async function processOutbox() {
    await db.query("UPDATE outbox_events SET status='pending',available_at=now(),last_error='Recovered expired processing lease' WHERE status='processing' AND processed_at<now()-interval '5 minutes'");
    const rows = await db.transaction(async tx => {
      const claimed = (await tx.query("SELECT * FROM outbox_events WHERE status='pending' AND available_at<=now() ORDER BY created_at LIMIT 30 FOR UPDATE SKIP LOCKED")).rows;
      for (const event of claimed) await tx.query("UPDATE outbox_events SET status='processing',attempts=attempts+1,processed_at=now() WHERE id=$1", [event.id]);
      return claimed;
    });
    for (const event of rows) {
      try {
        const bag = event.type === 'bag.created' ? await domain.getBag(event.aggregate_id) : null;
        const safe = bag ? projectBrandBag(bag, { paid: true }) : null;
        await db.transaction(async tx => {
          // Lock and recheck lifecycle inside the transaction: stale events cannot re-open a refunded handoff.
          const eligible = bag ? (await tx.query(`SELECT b.status,b.refunded_cents,
            EXISTS(SELECT 1 FROM external_orders e WHERE e.bag_id=b.id) AS external_reserved,
            EXISTS(SELECT 1 FROM refunds r WHERE r.bag_id=b.id AND r.status='proposed') AS refund_pending
            FROM bags b WHERE b.id=$1 FOR UPDATE`, [bag.id])).rows[0] : null;
          if (bag && eligible?.status === 'awaiting_shipment' && eligible.refunded_cents === 0 && !eligible.refund_pending && !eligible.external_reserved) {
            const existing = (await tx.query('SELECT id FROM sandbox_inbox WHERE event_id=$1', [event.id])).rows[0];
            if (!existing) {
              const token = randomBytes(32).toString('base64url');
              const expiresAt = new Date(Date.now() + 48 * 3600_000);
              await tx.query('INSERT INTO handoff_links(token_hash,event_id,bag_id,brand_id,expires_at) VALUES($1,$2,$3,$4,$5)', [hash(token), event.id, bag.id, bag.brandId, expiresAt]);
              await tx.query(`INSERT INTO sandbox_inbox(id,event_id,brand_id,bag_id,subject,body)
                VALUES($1,$2,$3,$4,$5,$6)`, [id('msg'), event.id, event.brand_id, bag.id, `Sandbox order ${bag.orderRef}: ready to ship`,
                JSON.stringify({ encryptedBody: auth.encrypt({ ...safe, handoffPath: `/handoff/${token}`, handoffExpiresAt: expiresAt }) })]);
            }
          }
          if (['bag.shipped','bag.cancelled','bag.refunded','refund.requested','refund.issued'].includes(event.type)) {
            const bagId = event.payload.bagId || event.payload.bag_id || event.aggregate_id;
            await tx.query("UPDATE sandbox_inbox SET status='closed' WHERE bag_id=$1", [bagId]);
          }
          if (event.brand_id) {
            const endpoints = (await tx.query('SELECT id,scopes FROM outbound_webhook_endpoints WHERE brand_id=$1 AND active=true', [event.brand_id])).rows;
            const family = event.type.split('.')[0];
            const scope = ['product','inventory'].includes(family) ? 'catalog:read' : ['transfer','payout','credit'].includes(family) ? 'payouts:read' : family === 'refund' ? 'refunds:write' : 'orders:read';
            for (const endpoint of endpoints.filter(endpoint => endpoint.scopes.includes(scope))) await tx.query(`INSERT INTO webhook_deliveries(id,event_id,endpoint_id,brand_id)
              VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id('whd'), event.id, endpoint.id, event.brand_id]);
          }
          await tx.query("UPDATE outbox_events SET status='delivered',processed_at=now(),last_error=NULL WHERE id=$1", [event.id]);
        });
      } catch (error) {
        await db.query('UPDATE outbox_events SET status=$1,last_error=$2,available_at=$3 WHERE id=$4',
          [event.attempts >= 9 ? 'failed' : 'pending', text(error.message), new Date(Date.now() + Math.min(86400, 60 * 2 ** event.attempts) * 1000), event.id]);
      }
    }
    return rows.length;
  }
  async function processOutbound() {
    const deliveries = (await db.query(`SELECT d.*,e.url,e.secret_encrypted,o.type,o.payload,o.aggregate_id,o.version
      FROM webhook_deliveries d JOIN outbound_webhook_endpoints e ON e.id=d.endpoint_id
      JOIN outbox_events o ON o.id=d.event_id WHERE d.status='pending' AND d.available_at<=now() AND e.active=true LIMIT 10`)).rows;
    for (const delivery of deliveries) {
      if (new Date(delivery.expires_at) < new Date()) {
        await db.query("UPDATE webhook_deliveries SET status='failed',last_error='72-hour retry window expired' WHERE id=$1", [delivery.id]); continue;
      }
      try {
        const eventData = delivery.type === 'bag.created' ? projectBrandBag(await domain.getBag(delivery.aggregate_id, delivery.brand_id), { paid: true }) : delivery.payload;
        const payload = { event_id: delivery.event_id, type: delivery.type, version: delivery.version, sandbox: true, data: eventData };
        const result = await deliverOutboundWebhook({ url: delivery.url, secret: auth.decrypt(delivery.secret_encrypted).secret, event: payload });
        if (!result.ok) {
          if (!result.retryable) {
            await db.query("UPDATE webhook_deliveries SET status='failed',attempts=attempts+1,last_error=$1 WHERE id=$2", [`Destination returned permanent HTTP ${result.status}`, delivery.id]);
            continue;
          }
          throw new Error(`Webhook destination returned retryable HTTP ${result.status}.`);
        }
        await db.query("UPDATE webhook_deliveries SET status='delivered',attempts=attempts+1,delivered_at=now() WHERE id=$1", [delivery.id]);
      } catch (error) {
        const wait = Math.min(86400_000, 60_000 * 2 ** Math.min(delivery.attempts, 10)) * (0.8 + Math.random() * 0.4);
        await db.query('UPDATE webhook_deliveries SET attempts=attempts+1,last_error=$1,available_at=$2 WHERE id=$3', [text(error.message), new Date(Date.now() + wait), delivery.id]);
      }
    }
  }
  async function processInbound() {
    const rows = (await db.query("SELECT * FROM inbound_webhooks WHERE status='pending' ORDER BY received_at LIMIT 10")).rows;
    for (const event of rows) {
      try {
        if (config.isUnifiedEvent && await config.isUnifiedEvent(event.provider, event.delivery_id)) {
          await db.query("UPDATE inbound_webhooks SET status='processed',processed_at=now(),last_error=NULL WHERE provider=$1 AND delivery_id=$2", [event.provider, event.delivery_id]);
          continue;
        }
        const payload = JSON.parse(auth.decrypt(event.raw_encrypted).raw);
        if (event.provider === 'stripe') {
          await db.query("UPDATE inbound_webhooks SET status='requires_review',attempts=attempts+1,last_error=$1 WHERE provider=$2 AND delivery_id=$3", [
            'Verified Stripe event retained. Real Stripe account/checkout reconciliation is not configured; no sandbox ledger entry or money action was fabricated.', event.provider, event.delivery_id]);
          continue;
        }
        if (event.provider === 'shopify') {
          const connection = (await db.query("SELECT * FROM connector_state WHERE provider='shopify'")).rows[0];
          const installed = event.brand_id && config.shopifyConnections ? await config.shopifyConnections.findShop(event.shop) : null;
          if (event.brand_id && installed?.brandId !== event.brand_id) throw fail(409, 'SHOPIFY_TENANT_MISMATCH', 'The webhook store is not bound to its recorded brand.');
          if (event.topic === 'app/uninstalled') {
            if (installed) {
              if (!event.occurred_at) throw fail(409, 'INSTALLATION_EVENT_REVIEW', 'Uninstall event has no occurrence time; review before invalidating a newer installation.');
              const disconnected = await config.shopifyConnections.disconnect(event.shop, { occurredAt: event.occurred_at });
              if (!disconnected.ignored) await domain.updateBrand(installed.brandId, { status: 'disconnected', connectionHealthy: false });
            } else if (connection?.brand_id) await domain.updateBrand(connection.brand_id, { status: 'disconnected', connectionHealthy: false });
          }
          else if (event.topic.startsWith('products/') || event.topic === 'inventory_levels/update') await importShopify(event.brand_id || undefined);
          else if (event.topic.startsWith('fulfillments/')) {
            const mapping = (await db.query('SELECT * FROM external_orders WHERE external_order_id=$1 AND shop=$2 AND ($3::text IS NULL OR brand_id=$3)', [`gid://shopify/Order/${payload.order_id}`, event.shop, event.brand_id || null])).rows[0];
            if (mapping && payload.tracking_number) {
              const bag = await domain.getBag(mapping.bag_id, mapping.brand_id);
              const actual = new Map((payload.line_items || []).map(item => [item.sku, item.quantity]));
              if (actual.size !== bag.items.length || bag.items.some(item => actual.get(item.variantSku || item.sku) !== item.qty))
                throw fail(409,'PARTIAL_FULFILLMENT_REVIEW','Partial or unmapped fulfillment requires review; it must not mark the whole Bag shipped.');
              await domain.recordShipment(mapping.bag_id, { carrier: payload.tracking_company || 'other', trackingNumber: payload.tracking_number, trackingUrl: payload.tracking_url || null, items:bag.items.map(item=>({sku:item.sku,qty:item.qty})) }, mapping.brand_id);
            }
          }
          // Refund webhooks are retained for review; a brand-store event never automatically refunds Stripe.
          else if (event.topic === 'refunds/create' || event.topic.startsWith('orders/')) {
            await db.query("UPDATE inbound_webhooks SET status='requires_review',attempts=attempts+1,last_error=$1 WHERE provider=$2 AND delivery_id=$3", ['Order/refund event retained. Bidirectional cancellation and real Stripe reconciliation are not yet enabled; no payment action was fabricated.', event.provider, event.delivery_id]);
            continue;
          }
        }
        await db.query("UPDATE inbound_webhooks SET status='processed',processed_at=now(),attempts=attempts+1 WHERE provider=$1 AND delivery_id=$2", [event.provider, event.delivery_id]);
      } catch (error) { await db.query("UPDATE inbound_webhooks SET status='failed',attempts=attempts+1,last_error=$1 WHERE provider=$2 AND delivery_id=$3", [text(error.message), event.provider, event.delivery_id]); }
    }
  }
  async function runJobs() {
    if (running) return { alreadyRunning: true };
    running = true;
    try {
      const payouts = await domain.runDueSandboxPayouts();
      await processImports(); await processInbound();
      const relayed = await processOutbox(); await processOutbound();
      return { sandbox: true, relayed, payouts, completedAt: new Date().toISOString() };
    } finally { running = false; }
  }
  async function replayEvent(eventId, brandId) {
    const result = await db.query("UPDATE outbox_events SET status='pending',available_at=now(),last_error=NULL WHERE id=$1 AND ($2::text IS NULL OR brand_id=$2) RETURNING id", [eventId, brandId || null]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'Event not found.');
    await db.query("UPDATE webhook_deliveries SET status='pending',available_at=now(),last_error=NULL,expires_at=now()+interval '72 hours' WHERE event_id=$1 AND ($2::text IS NULL OR brand_id=$2)", [eventId, brandId || null]);
    return { id: eventId, queued: true };
  }
  async function getHandoff(token) {
    const link = (await db.query('SELECT bag_id,brand_id,expires_at FROM handoff_links WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()', [hash(token)])).rows[0];
    if (!link) throw fail(401, 'HANDOFF_EXPIRED', 'This shipping link has expired or has already been used.');
    const bag = await domain.getBag(link.bag_id, link.brand_id);
    const external = (await db.query('SELECT state FROM external_orders WHERE bag_id=$1', [bag.id])).rows[0];
    if (external) throw fail(409, 'EXTERNAL_FULFILLMENT_RESERVED', 'This Bag is reserved for Shopify fulfillment. Do not create a second shipment instruction.');
    if (bag.status !== 'awaiting_shipment' || bag.refundedCents > 0) throw fail(401, 'HANDOFF_EXPIRED', 'This shipping link is no longer available.');
    const pending = (await db.query("SELECT id FROM refunds WHERE bag_id=$1 AND status='proposed' LIMIT 1", [bag.id])).rows[0];
    if (pending) throw fail(409, 'REFUND_PENDING', 'This Bag is on hold while a refund is reviewed.');
    return { bag: { ...projectBrandBag(bag, { paid: true }), sandbox: true }, expiresAt: link.expires_at };
  }
  async function listInbox(brandId) {
    return (await db.query('SELECT id,event_id,brand_id,bag_id,subject,body,status,created_at FROM sandbox_inbox WHERE ($1::text IS NULL OR brand_id=$1) ORDER BY created_at DESC LIMIT 100', [brandId || null])).rows
      .map(row => ({ ...row, body: row.body.encryptedBody ? auth.decrypt(row.body.encryptedBody) : row.body }));
  }
  async function submitHandoff(token, shipment) {
    const preview = await getHandoff(token);
    const result = await domain.recordShipment(preview.bag.bag_id, shipment, undefined, { handoffTokenHash: hash(token) });
    return { bag: { ...projectBrandBag(result, { paid: true }), sandbox: true }, status: 'shipped', sandbox: true };
  }
  return { shopify, get stripe() { return stripe; }, connections, configureStripeTest, clearLocalStripeCredentials,
    preflightShopify, importShopify, pushShopify, saveInbound, addEndpoint, listEndpoints, enqueueImport, runJobs, replayEvent, getHandoff, submitHandoff, listInbox };
}
