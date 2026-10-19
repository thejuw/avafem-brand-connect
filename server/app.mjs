import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createDatabase } from './db.mjs';
import { createDomain } from './domain.mjs';
import { seedDatabase } from './seed.mjs';
import { createAuth, requireAdmin, requireScope, BRAND_SCOPES } from './auth.mjs';
import { createOperations } from './operations.mjs';
import { registerMcp } from './mcp.mjs';
import { openApiDocument } from './openapi.mjs';
import { createShopifyConnections } from './shopify-connections.mjs';
import { SHOPIFY_ALLOWED_WEBHOOK_TOPICS } from './integrations/shopify-policy.mjs';
import { createTestCheckout } from './test-checkout.mjs';
import { createTestStores, TEST_STORES } from './test-stores.mjs';
import { createUnifiedCheckout } from './unified-checkout.mjs';
import { createProviderMoney } from './provider-money.mjs';
import { createProviderFulfillment } from './provider-fulfillment.mjs';
import { createProviderEvents } from './provider-events.mjs';
import { createProviderJobs } from './provider-jobs.mjs';
import { createProviderFixtures } from './provider-fixtures.mjs';
import { createProviderFailureFixtures } from './provider-failure-fixtures.mjs';
import { createProviderFailureCheckouts } from './provider-failure-checkouts.mjs';
import { createProviderFailureReadbacks } from './provider-failure-readbacks.mjs';
import { createProviderCatalog } from './provider-catalog.mjs';
import { createProviderReconciliation } from './provider-reconciliation.mjs';
import { createProviderTaxReconciliation } from './provider-tax-reconciliation.mjs';
import { loadObservedTaxEvidence } from './provider-tax-observation.mjs';
import { createProviderPlatformSwitch, APPROVED_TEST_PLATFORM_SWITCH } from './provider-platform-switch.mjs';
import { createProviderAutomation } from './provider-automation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const safeEqual = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? '')); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); };
const limitedString = z.string().trim().min(1).max(200);
const shipmentSchema = z.object({ carrier: limitedString, trackingNumber: limitedString,
  trackingUrl: z.string().url().max(2000).nullable().optional(), items: z.array(z.object({ sku: limitedString, qty: z.number().int().positive() })).optional(), shippedAt: z.string().datetime().optional() });
const productSchema = z.object({ title: z.string().trim().min(1).max(500), description: z.string().max(20000).default(''),
  category: z.string().max(200).default(''), priceCents: z.coerce.number().int().min(0).max(100_000_000),
  inventoryQty: z.coerce.number().int().min(0).max(1_000_000).default(0),
  images: z.array(z.string().url().max(2000)).max(20).default([]), variants: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
  evidence: z.object({ ingredients_inci: z.array(z.string().max(300)).max(300).default([]), certifications: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
    claims: z.array(z.object({ text: z.string().max(3000), source_url: z.string().max(2000).default(''), type: z.enum(['structure','health','none']).default('none') })).max(100).default([]),
    contraindications: z.string().max(10000).default('') }).default({}),
  taxCode: z.string().max(100).default(''), shippingProfile: z.string().max(100).default('standard'),
});
const refundSchema = z.object({ reason: z.string().trim().min(3).max(1000), amountCents: z.number().int().positive().optional(), amount: z.number().int().positive().optional() });

export async function createApp(options = {}) {
  const config = { mode: 'sandbox', host: '127.0.0.1', port: 4317, allowLocalBootstrap: true,
    sessionSecret: randomBytes(48).toString('base64url'), encryptionKey: randomBytes(48).toString('base64url'), ...options.config };
  if (config.mode !== 'sandbox') throw new Error('This initial release is sandbox-only. Live payments and production launch are deliberately disabled.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && config.allowLocalBootstrap) throw new Error('Local owner bootstrap may only be enabled on a loopback listener.');
  if (config.publicBaseUrl && config.allowLocalBootstrap) throw new Error('Disable local owner bootstrap before configuring a public origin.');
  if (!['127.0.0.1','localhost','::1'].includes(config.host) && (!options.config?.sessionSecret || !options.config?.encryptionKey || !options.config?.adminToken)) throw new Error('A public listener requires explicit authentication configuration.');
  const db = options.db || await createDatabase({ dataDir: options.dataDir, connectionString: options.connectionString });
  await db.migrate();
  const auth = await createAuth(db, { sessionSecret: config.sessionSecret, encryptionKey: config.encryptionKey, issuer: config.publicBaseUrl || 'avafem-local' });
  const domain = createDomain(db, { ...options.domainOptions, protectShipping: auth.encrypt, revealShipping: auth.decrypt });
  await domain.encryptExistingShipping();
  const shopifyConnections = await createShopifyConnections(db, auth, { publicBaseUrl: config.publicBaseUrl, ...(options.shopifyOAuth || {}) });
  let testStores, unifiedCheckout, providerEvents;
  const operations = await createOperations(db, domain, auth, { ...(options.integrations || {}), shopifyConnections,
    testConnectedAccountIds: async accountId => Boolean(testStores && (await testStores.authorizedTestAccounts()).includes(accountId)),
    isUnifiedEvent: (provider, deliveryId) => providerEvents?.isManagedEvent(provider, deliveryId) ?? false });
  const testCheckout = await createTestCheckout(db, auth, { getStripe: () => operations.stripe, shopify: operations.shopify, ...(options.testCheckout || {}) });
  testStores = await createTestStores(db, auth, domain, { ownShopify: operations.shopify, ...(options.testStores || {}) });
  unifiedCheckout = await createUnifiedCheckout(db, auth, { stores: testStores, getStripe: () => operations.stripe,
    baseUrl: `http://127.0.0.1:${config.port}`, ...(options.unifiedCheckout || {}) });
  const providerMoney = await createProviderMoney(db, auth, { runtime: unifiedCheckout.runtime, stores: testStores, getStripe: () => operations.stripe });
  const providerFulfillment = await createProviderFulfillment(db, auth, { runtime: unifiedCheckout.runtime, stores: testStores });
  const providerFixtures = await createProviderFixtures(db, { stores: testStores });
  let providerFailureCheckouts;
  const providerFailureFixtures = await createProviderFailureFixtures(db, auth, { stores: testStores,
    canDelete: async () => providerFailureCheckouts ? await providerFailureCheckouts.safeToDeleteFixtures() : false });
  providerFailureCheckouts = await createProviderFailureCheckouts(auth, { stores: testStores,
    getStripe: () => operations.stripe, failureFixtures: providerFailureFixtures,
    dataDir: options.dataDir ? resolve(options.dataDir, '../provider-failure-tests') : undefined });
  const providerFailureReadbacks = await createProviderFailureReadbacks(db, auth, { unifiedCheckout, stores: testStores,
    getStripe: () => operations.stripe });
  const providerCatalog = await createProviderCatalog(db, domain, { stores: testStores });
  const providerReconciliation = await createProviderReconciliation(db, auth, { unifiedCheckout, stores: testStores, getStripe: () => operations.stripe });
  const providerTaxReconciliation = await createProviderTaxReconciliation(db, auth, { unifiedCheckout, stores: testStores,
    getStripe: () => operations.stripe, getObservedTaxEvidence: loadObservedTaxEvidence });
  const providerPlatformSwitch = await createProviderPlatformSwitch(db, auth, { unifiedCheckout, stores: testStores, getStripe: () => operations.stripe });
  const providerAutomation = await createProviderAutomation(db, auth, { runtime: unifiedCheckout.runtime,
    stores: testStores, getStripe: () => operations.stripe, providerMoney, providerFulfillment, providerReconciliation });
  providerEvents = await createProviderEvents(db, auth, { unifiedCheckout, stores: testStores, providerMoney, providerFulfillment, providerCatalog });
  const providerJobs = createProviderJobs(db, { unifiedCheckout, providerEvents, providerMoney, providerFulfillment,
    catalog: providerCatalog, reconciliation: providerReconciliation, taxReconciliation: providerTaxReconciliation, automation: providerAutomation });
  if (options.seed !== false) await seedDatabase(db, domain);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 3 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.decorate('avafem', { db, domain, auth, operations, config, shopifyConnections, testCheckout,
    testStores, unifiedCheckout, providerMoney, providerFulfillment, providerEvents, providerJobs, providerFixtures, providerFailureFixtures, providerFailureCheckouts, providerFailureReadbacks, providerCatalog, providerReconciliation, providerTaxReconciliation, providerPlatformSwitch, providerAutomation });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body;
    try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}); } catch { done(fail(400, 'INVALID_JSON', 'Request body must contain valid JSON.')); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (config.allowLocalBootstrap) {
      const hostname = (request.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw fail(403, 'INVALID_HOST', 'Local preview only accepts loopback hostnames.');
    }
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/') || request.url.startsWith('/oauth/')) reply.header('Cache-Control', 'no-store');
    if (request.headers.origin) {
      const allowed = new Set([config.publicBaseUrl, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].filter(Boolean));
      if (!allowed.has(request.headers.origin)) throw fail(403, 'ORIGIN_DENIED', 'This origin is not allowed.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Check the submitted fields.', issues: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) } });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status === 429) reply.header('Retry-After', '1');
    const diagnostics = {};
    if (error.code === 'STRIPE_REQUEST_FAILED' || /^RECIPIENT_(?:CREATION|REVISION|RETRY)_UNCERTAIN$/.test(error.code ?? '')) {
      if (/^req_[A-Za-z0-9]{1,100}$/.test(error.details?.requestId ?? '')) diagnostics.requestId = error.details.requestId;
      if (/^[A-Za-z0-9_]{1,80}$/.test(error.details?.stripeCode ?? '')
        && !/^(?:(?:sk|rk|pk)_(?:test|live)_|whsec_|shpss_|shpat_|shpca_|shpua_)/i.test(error.details.stripeCode)
        && !/client_secret|_secret_/i.test(error.details.stripeCode))
        diagnostics.stripeCode = error.details.stripeCode;
    }
    reply.code(status).send({ error: { code: error.code || 'INTERNAL_ERROR', message: status < 500 ? error.message : error.code ? error.message : 'The operation failed. Check the local server logs.', ...diagnostics } });
  });
  async function context(request, { browser = false, scope } = {}) {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    let ctx = token ? await auth.resolveBearer(token) : await auth.resolveSession(request.cookies.avf_session);
    if (!ctx) throw fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in or provide a valid brand API credential.');
    if (ctx.bearer) await auth.rateLimit(ctx.brandId);
    if (browser && ctx.bearer) throw fail(403, 'BROWSER_SESSION_REQUIRED', 'Use the scoped /v1 API for brand integration credentials.');
    if (!ctx.bearer && !['GET','HEAD','OPTIONS'].includes(request.method)
      && !safeEqual(ctx.csrfToken, request.headers['x-csrf-token'])) throw fail(403, 'CSRF_REQUIRED', 'Refresh your session before making changes.');
    if (scope && ctx.role !== 'admin') requireScope(ctx, scope);
    return ctx;
  }
  function brandScope(ctx, requested) {
    if (ctx.brandId) {
      if (requested && requested !== ctx.brandId) throw fail(403, 'TENANT_MISMATCH', 'This credential belongs to another brand.');
      return ctx.brandId;
    }
    return requested || null;
  }
  async function browserRoute(request, scope) { return context(request, { browser: true, scope }); }
  async function localTestOwner(request) {
    const host = String(request.headers.host || '').replace(/:\d+$/, '');
    if (!config.allowLocalBootstrap || !['127.0.0.1','localhost','[::1]'].includes(host)
      || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip)
      || !['127.0.0.1','localhost','::1'].includes(config.host))
      throw fail(403, 'LOCAL_TEST_ONLY', 'Provider test checkout is available only in the local owner workspace.');
    const ctx = await browserRoute(request); requireAdmin(ctx); return ctx;
  }
  const data = value => ({ data: value });
  const setSessionCookie = (reply, session) => reply.setCookie('avf_session', session.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: Boolean(config.publicBaseUrl?.startsWith('https:')), maxAge: 12 * 3600 });
  app.get('/health', async () => ({ status: 'ok', mode: 'sandbox', database: db.kind }));
  app.get('/api/session', async (request, reply) => {
    let session = await auth.resolveSession(request.cookies.avf_session);
    if (!session) {
      const ip = request.ip;
      if (!config.allowLocalBootstrap || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)) throw fail(401, 'SIGN_IN_REQUIRED', 'Owner authentication is required.');
      session = await auth.createSession({ owner: true }); setSessionCookie(reply, session);
    }
    return data({ csrfToken: session.csrfToken, brandId: session.brandId, role: session.role, sandbox: true, owner: session.owner });
  });
  app.post('/api/admin/session', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!config.adminToken || !safeEqual(config.adminToken, request.body?.token)) throw fail(401, 'INVALID_ADMIN_TOKEN', 'Invalid owner credential.');
    const session = await auth.createSession({ owner: true }); setSessionCookie(reply, session);
    return data({ csrfToken: session.csrfToken, brandId: null, role: 'admin', sandbox: true, owner: true });
  });
  app.post('/api/session/brand', async request => {
    const ctx = await browserRoute(request);
    const brandId = request.body?.brandId || null;
    if (brandId) await domain.getBrand(brandId);
    await auth.switchBrand(ctx, brandId);
    return data({ csrfToken: ctx.csrfToken, brandId, role: brandId ? 'brand' : 'admin', sandbox: true, owner: ctx.owner });
  });
  app.get('/api/dashboard', async request => data(await domain.dashboard({ brandId: (await browserRoute(request)).brandId })));
  app.get('/api/brands', async request => { const ctx = await browserRoute(request); return data(ctx.brandId ? [await domain.getBrand(ctx.brandId)] : await domain.listBrands()); });
  app.post('/api/brands', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); const created = await domain.createBrand(request.body); const result = await domain.updateBrand(created.id, request.body); await auth.audit(ctx, 'brand.created', result.id); return data(result); });
  app.patch('/api/brands/:id', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); return data(await domain.updateBrand(request.params.id, request.body)); });
  app.get('/api/products', async request => { const ctx = await browserRoute(request, 'catalog:read'); return data(await domain.listProducts({ brandId: brandScope(ctx, request.query.brandId), status: request.query.status || undefined })); });
  app.put('/api/brands/:id/products/:sku', async request => { const ctx = await browserRoute(request, 'catalog:write'); brandScope(ctx, request.params.id); return data(await domain.upsertProduct(request.params.id, request.params.sku, productSchema.parse(request.body))); });
  app.post('/api/products/:id/review', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); const input = z.object({ decision: z.enum(['approved','rejected']), reason: z.string().max(3000).optional() }).parse(request.body); return data(await domain.reviewProduct(request.params.id, { status: input.decision, note: input.reason || '' })); });
  app.get('/api/bags', async request => { const ctx = await browserRoute(request, 'orders:read'); return data(await domain.listBags({ brandId: brandScope(ctx, request.query.brandId), status: request.query.status || undefined })); });
  app.get('/api/bags/:id', async request => { const ctx = await browserRoute(request, 'orders:read'); return data(await domain.getBag(request.params.id, ctx.brandId)); });
  app.post('/api/bags/:id/shipments', async request => { const ctx = await browserRoute(request, 'orders:fulfill'); return data(await domain.recordShipment(request.params.id, shipmentSchema.parse(request.body), ctx.brandId)); });
  app.post('/api/bags/:id/delivery', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); const input = z.object({ deliveredAt: z.string().datetime().optional(), source: z.literal('sandbox').default('sandbox') }).parse(request.body || {}); return data(await domain.markDelivered(request.params.id, input)); });
  app.post('/api/bags/:id/refunds', async request => { const ctx = await browserRoute(request, 'refunds:write'); return data(await domain.requestRefund(request.params.id, refundSchema.parse(request.body), ctx.brandId)); });
  app.get('/api/refunds', async request => { const ctx = await browserRoute(request, 'refunds:write'); return data(await domain.listRefunds({ brandId: ctx.brandId })); });
  app.post('/api/refunds/:id/approve', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); return data(await domain.approveSandboxRefund(request.params.id)); });
  app.get('/api/finance', async request => {
    const ctx = await browserRoute(request, 'payouts:read'); const scoped = { brandId: ctx.brandId };
    const [transfers, ledger, credits] = await Promise.all([domain.listTransfers(scoped), domain.listLedger(scoped), domain.listCredits(scoped)]);
    return data({ transfers, ledger, credits, summary: { scheduledCents: transfers.filter(t => t.status === 'scheduled').reduce((s,t) => s + t.amountCents, 0),
      paidCents: transfers.filter(t => t.status === 'paid').reduce((s,t) => s + t.amountCents - (t.reversedCents || 0), 0), sandbox: true } });
  });
  app.get('/api/events', async request => {
    const ctx = await browserRoute(request);
    const [events, jobs] = await Promise.all([domain.listEvents(), domain.listJobs()]);
    return data({ events: ctx.brandId ? events.filter(e => e.brandId === ctx.brandId) : events, jobs: ctx.brandId ? jobs.filter(j => j.brandId === ctx.brandId) : jobs,
      inbox: await operations.listInbox(ctx.brandId) });
  });
  app.post('/api/events/:id/replay', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); return data(await operations.replayEvent(request.params.id)); });
  app.get('/api/connections', async request => { const ctx = await browserRoute(request); requireAdmin(ctx); return data(await operations.connections()); });
  app.post('/api/local/stripe-test-credentials', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const host = String(request.headers.host || '').replace(/:\d+$/, '');
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(host)
      && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip)
      && ['127.0.0.1','localhost','::1'].includes(config.host);
    if (!loopback) throw fail(403, 'LOCAL_SETUP_ONLY', 'Test credentials can only be entered through the local owner workspace.');
    if (request.headers.origin && !new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']).has(request.headers.origin))
      throw fail(403, 'LOCAL_SETUP_ONLY', 'Credential setup is not available through a public origin.');
    const ctx = await browserRoute(request); requireAdmin(ctx);
    const input = z.object({ secretKey: z.string().trim().max(500), webhookSecret: z.string().trim().max(500).optional() }).strict().parse(request.body);
    if (input.webhookSecret === '') delete input.webhookSecret;
    const result = await operations.configureStripeTest(input);
    await auth.audit(ctx, 'stripe.test_credentials_verified', result.accountId);
    return data(result);
  });
  app.post('/api/local/provider-test/initialize', async request => {
    const ctx = await localTestOwner(request);
    z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await testStores.initialize();
    await auth.audit(ctx, 'provider_test.initialized', 'exact-three-test-stores');
    return data(result);
  });
  app.post('/api/local/provider-test/platform-switch', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ fromAccountId: z.literal(APPROVED_TEST_PLATFORM_SWITCH.fromAccountId),
      toAccountId: z.literal(APPROVED_TEST_PLATFORM_SWITCH.toAccountId),
      retireRunIds: z.array(z.string().regex(/^uco_[a-f0-9]{32}$/)).min(1).max(20),
      operatorVerifiedNoProviderObjects: z.literal(true),
      providerRejectedRequestId: z.literal(APPROVED_TEST_PLATFORM_SWITCH.providerRejectedRequestId) }).strict().parse(request.body);
    const result = await providerPlatformSwitch.switchPlatform(input);
    await auth.audit(ctx, 'provider_test.platform_switch_recorded', result.switchId);
    return data(result);
  });
  app.post('/api/local/shopify-test-credentials', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)), clientId: z.string().regex(/^[a-f0-9]{32}$/),
      clientSecret: z.string().min(16).max(500), confirmOwnedStore: z.literal(true) }).strict().parse(request.body);
    const result = await testStores.configure(input);
    await auth.audit(ctx, 'shopify.test_store_credentials_verified', input.shop);
    return data(result);
  });
  app.get('/api/provider-test/fixtures', async request => {
    await localTestOwner(request);
    const shop = z.enum(TEST_STORES.slice(1).map(store => store.shop)).parse(request.query.shop);
    return data(await providerFixtures.inspect({ shop }));
  });
  app.post('/api/provider-test/fixtures', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: z.enum(TEST_STORES.slice(1).map(store => store.shop)), confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFixtures.create(input);
    await auth.audit(ctx, 'provider_test.fixture_setup', input.shop);
    return data(result);
  });
  app.post('/api/provider-test/catalog/sync', async request => {
    await localTestOwner(request);
    const input = z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)) }).strict().parse(request.body);
    return data(await providerCatalog.sync(input));
  });
  const failureShop = z.enum(TEST_STORES.map(store => store.shop));
  const failurePhase = z.enum(['catalog','checkout']).default('catalog');
  app.get('/api/provider-test/failure-fixtures', async request => {
    await localTestOwner(request);
    const input = z.object({ shop: failureShop, phase: failurePhase }).strict().parse(request.query);
    return data(await providerFailureFixtures.inspect(input));
  });
  app.post('/api/provider-test/failure-fixtures/prepare', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: failureShop, confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureFixtures.prepare(input);
    await auth.audit(ctx, 'provider_test.failure_fixture_prepared', input.shop);
    return data(result);
  });
  app.post('/api/provider-test/failure-fixtures/mutate', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: failureShop, scenario: z.enum(['price_changed','out_of_stock','archived']),
      phase: failurePhase, confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureFixtures.mutate(input);
    await auth.audit(ctx, 'provider_test.failure_fixture_mutated', `${input.shop}:${input.phase}:${input.scenario}`);
    return data(result);
  });
  app.post('/api/provider-test/failure-fixtures/restore', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: failureShop, phase: failurePhase, confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureFixtures.restore(input);
    await auth.audit(ctx, 'provider_test.failure_fixture_restored', `${input.shop}:${input.phase}`);
    return data(result);
  });
  app.post('/api/provider-test/failure-fixtures/cleanup', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: failureShop, confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureFixtures.cleanup(input);
    await auth.audit(ctx, 'provider_test.disposable_failure_fixture_deleted', input.shop);
    return data(result);
  });
  app.get('/api/provider-test/failure-checkouts', async request => {
    await localTestOwner(request); return data(await providerFailureCheckouts.list());
  });
  app.post('/api/provider-test/failure-checkouts', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ caseId: z.enum(['declined_payment','stock_changed_002','stock_changed_004','stock_changed_006',
      'price_changed_002','price_changed_004','price_changed_006']), operationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureCheckouts.create(input);
    await auth.audit(ctx, 'provider_test.failure_checkout_created', result.runId ?? input.operationId);
    return data(result);
  });
  app.get('/api/provider-test/failure-checkouts/:id', async request => {
    await localTestOwner(request); return data(await providerFailureCheckouts.get({ runId: request.params.id }));
  });
  app.get('/api/provider-test/failure-checkouts/:id/observe', async request => {
    await localTestOwner(request); return data(await providerFailureCheckouts.observe({ runId: request.params.id }));
  });
  for (const action of ['reconcile','cancel']) app.post(`/api/provider-test/failure-checkouts/:id/${action}`, async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureCheckouts[action]({ runId: request.params.id, ...input });
    await auth.audit(ctx, `provider_test.failure_checkout_${action}`, request.params.id);
    return data(result);
  });
  app.post('/api/provider-test/failure-readbacks', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerFailureReadbacks.run(input);
    await auth.audit(ctx, 'provider_test.readonly_shadow_failures_checked', result.id ?? 'fixed-three-store-failure-audit');
    return data(result);
  });
  app.get('/api/provider-test/failure-readbacks/:id', async request => {
    await localTestOwner(request); return data(await providerFailureReadbacks.get({ reportId: request.params.id }));
  });
  app.get('/api/provider-test/stores', async request => { await localTestOwner(request); return data(await testStores.list()); });
  app.post('/api/provider-test/stores/preflight', async request => {
    await localTestOwner(request);
    const input = z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)) }).strict().parse(request.body);
    return data(await testStores.preflight(input.shop));
  });
  app.get('/api/unified-checkout/options', async request => { await localTestOwner(request); return data(await unifiedCheckout.options()); });
  app.get('/api/unified-checkout', async request => { await localTestOwner(request); return data(await unifiedCheckout.list()); });
  app.get('/api/unified-checkout/:id', async request => { await localTestOwner(request); return data(await unifiedCheckout.get(request.params.id)); });
  app.post('/api/unified-checkout/sessions', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ items: z.array(z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)),
      variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/), quantity: z.number().int().min(1).max(5) }).strict()).min(3).max(15) }).strict().parse(request.body);
    const result = await unifiedCheckout.create(input, request.headers['idempotency-key']);
    await auth.audit(ctx, 'unified_checkout.created', result.id); return data(result);
  });
  app.post('/api/unified-checkout/:id/reconcile', async request => {
    await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    return data(await unifiedCheckout.reconcile(request.params.id));
  });
  app.post('/api/unified-checkout/:id/test-clock', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTestClock: z.literal(true), now: z.string().datetime() }).strict().parse(request.body);
    const result = await unifiedCheckout.setTestClock(request.params.id, input);
    await auth.audit(ctx, 'provider_test.isolated_clock_advanced', request.params.id); return data(result);
  });
  const providerOperation = z.object({ bagId: limitedString, operationId: z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/) });
  app.post('/api/unified-checkout/:id/fulfill', async request => {
    await localTestOwner(request);
    const input = providerOperation.extend({ items: z.array(z.object({ sku: limitedString, qty: z.number().int().positive() }).strict()).min(1).max(15),
      tracking: z.object({ number: z.string().regex(/^AVAFEM-TEST-[A-Z0-9-]{1,80}$/i), company: limitedString,
        url: z.string().url().max(2000).optional() }).strict() }).strict().parse(request.body);
    return data(await providerFulfillment.fulfill({ runId: request.params.id, ...input }));
  });
  app.post('/api/unified-checkout/:id/fulfillment-sync', async request => {
    await localTestOwner(request);
    const input = z.object({ bagId: limitedString }).strict().parse(request.body);
    return data(await providerFulfillment.sync({ runId: request.params.id, ...input }));
  });
  app.post('/api/unified-checkout/:id/test-delivery', async request => {
    await localTestOwner(request);
    const input = providerOperation.extend({ confirmTestDelivery: z.literal(true) }).strict().parse(request.body);
    return data(await providerFulfillment.deliver({ runId: request.params.id, ...input }));
  });
  app.get('/api/unified-checkout/:id/notifications', async request => { await localTestOwner(request); return data(await providerFulfillment.listNotifications(request.params.id)); });
  app.post('/api/unified-checkout/:id/refund', async request => {
    const ctx = await localTestOwner(request);
    const input = providerOperation.extend({ items: z.array(z.object({ sku: limitedString, qty: z.number().int().positive() }).strict()).min(1).max(15),
      refundShipping: z.boolean().default(false) }).strict().parse(request.body);
    const result = await providerMoney.refund({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.refund_requested', `${request.params.id}:${input.operationId}`); return data(result);
  });
  app.post('/api/unified-checkout/:id/refund-proposal/revise', async request => {
    const ctx = await localTestOwner(request);
    const input = providerOperation.extend({ confirmNoProviderWrites: z.literal(true) }).strict().parse(request.body);
    const result = await providerMoney.reviseRefundProposal({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.unwritten_refund_proposal_revised', `${request.params.id}:${input.operationId}`);
    return data(result);
  });
  app.post('/api/unified-checkout/:id/cancel', async request => {
    const ctx = await localTestOwner(request);
    const input = providerOperation.strict().parse(request.body);
    const result = await providerMoney.cancel({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.cancellation_requested', `${request.params.id}:${input.operationId}`); return data(result);
  });
  app.post('/api/unified-checkout/:id/settle', async request => {
    await localTestOwner(request); z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    return data(await providerMoney.settle({ runId: request.params.id }));
  });
  app.post('/api/unified-checkout/:id/payout', async request => {
    const ctx = await localTestOwner(request);
    const input = providerOperation.extend({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerMoney.payout({ runId: request.params.id, bagId: input.bagId, operationId: input.operationId });
    await auth.audit(ctx, 'provider_test.bank_payout_requested', `${request.params.id}:${input.bagId}`); return data(result);
  });
  app.post('/api/unified-checkout/:id/money-reconcile', async request => {
    await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    return data(await providerMoney.reconcile({ runId: request.params.id }));
  });
  app.post('/api/unified-checkout/:id/reconciliation-report', async request => {
    await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    return data(await providerReconciliation.reconcile({ runId: request.params.id }));
  });
  // Tax reporting is a separate read-only provider audit and local memo subledger.
  // It cannot dispatch orders, refund customers, or change the cash ledger.
  app.post('/api/unified-checkout/:id/tax-evidence', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ originalTaxTransactionId: z.string().regex(/^tax_[A-Za-z0-9]{1,100}$/),
      refunds: z.array(z.object({ refundId: z.string().regex(/^re_[A-Za-z0-9]{1,100}$/),
        taxTransactionId: z.string().regex(/^tax_[A-Za-z0-9]{1,100}$/) }).strict()).min(1).max(100),
      binding: z.discriminatedUnion('kind', [z.object({ kind: z.literal('api_reference') }).strict(),
        z.object({ kind: z.literal('operator_dashboard'), artifactRef: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
          evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), confirmedByOwner: z.literal(true) }).strict()]) }).strict().parse(request.body);
    const result = await providerTaxReconciliation.configureEvidence({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.tax_evidence_bound', request.params.id);
    return data(result);
  });
  app.post('/api/unified-checkout/:id/tax-reconciliation-report', async request => {
    await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    return data(await providerTaxReconciliation.reconcile({ runId: request.params.id }));
  });
  app.get('/api/unified-checkout/:id/tax-reconciliation-report/:reportId', async request => {
    await localTestOwner(request);
    const report = await providerTaxReconciliation.getReport({ reportId: request.params.reportId });
    if (report.runId !== request.params.id) throw fail(404, 'TAX_REPORT_NOT_FOUND', 'Tax report not found for this checkout.');
    return data(report);
  });
  app.post('/api/unified-checkout/:id/tax-rounding', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ reportId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), reportHash: z.string().regex(/^[a-f0-9]{64}$/),
      operationId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), confirmPlatformOnly: z.literal(true) }).strict().parse(request.body);
    const report = await providerTaxReconciliation.getReport({ reportId: input.reportId });
    if (report.runId !== request.params.id) throw fail(404, 'TAX_REPORT_NOT_FOUND', 'Tax report not found for this checkout.');
    const result = await providerTaxReconciliation.recordRounding(input);
    await auth.audit(ctx, 'provider_test.platform_tax_rounding_recorded', `${request.params.id}:${input.operationId}`);
    return data(result);
  });
  app.get('/api/unified-checkout/:id/automation', async request => {
    await localTestOwner(request); return data(await providerAutomation.get(request.params.id));
  });
  app.post('/api/unified-checkout/:id/automation/configure', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTest: z.literal(true), autoSettle: z.literal(true), autoPayout: z.literal(true),
      payoutGates: z.array(z.object({ bagId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        refundOperationId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict()).length(3) }).strict().parse(request.body);
    const result = await providerAutomation.configure({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.money_automation_configured', result.policyId ?? request.params.id);
    return data(result);
  });
  app.post('/api/unified-checkout/:id/automation/disable', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerAutomation.disable({ runId: request.params.id, ...input });
    await auth.audit(ctx, 'provider_test.money_automation_disabled', request.params.id);
    return data(result);
  });
  app.post('/api/provider-test/recipients/create', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await providerMoney.createRecipients(input); await auth.audit(ctx, 'provider_test.express_recipients_created', 'exact-three-test-stores');
    return data(result);
  });
  app.post('/api/local/provider-test/recipients/revise-rejected', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: z.literal('i4vd1u-s8.myshopify.com'),
      providerRequestId: z.literal('req_98gvn77VCy6nK8'), confirmRejectedBeforeCreation: z.literal(true) }).strict().parse(request.body);
    const result = await providerMoney.reviseRejectedRecipient(input);
    await auth.audit(ctx, 'provider_test.rejected_recipient_revision', input.shop);
    return data(result);
  });
  app.post('/api/local/provider-test/recipients/revise-v2', async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ shop: z.literal('i4vd1u-s8.myshopify.com'),
      providerRequestId: z.literal('req_kxW4JTIW5nYP4G'), confirmRejectedBeforeCreation: z.literal(true) }).strict().parse(request.body);
    const result = await providerMoney.reviseRejectedRecipientV2(input);
    await auth.audit(ctx, 'provider_test.rejected_recipient_accounts_v2_revision', input.shop);
    return data(result);
  });
  app.post('/api/provider-test/refund-preview', async request => {
    await localTestOwner(request);
    const input = z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)),
      orderId: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
      items: z.array(z.object({ sku: limitedString, qty: z.number().int().min(1).max(5) }).strict()).max(15),
      shippingCents: z.number().int().min(0).max(10000) }).strict().parse(request.body);
    if (new Set(input.items.map(item => item.sku)).size !== input.items.length)
      throw fail(422, 'DUPLICATE_REFUND_ITEMS', 'Refund preview SKUs must be unique.');
    const adapter = await testStores.forShop(input.shop);
    const order = await adapter.getOrderOperations(input.orderId);
    if (order?.test !== true || !order.operationsComplete || !order.tags?.includes('TEST_DO_NOT_SHIP'))
      throw fail(409, 'SHOPIFY_TEST_ORDER_REQUIRED', 'Only complete Avafem DO_NOT_SHIP test orders can be previewed.');
    const lineItems = input.items.map(item => {
      const matches = order.lineItems.nodes.filter(line => line.sku === item.sku);
      if (matches.length !== 1) throw fail(422, 'REFUND_LINE_MISMATCH', 'Each preview SKU must identify one exact test-order line.');
      return { lineItemId: matches[0].id, quantity: item.qty };
    });
    return data(await adapter.getSuggestedRefund({ orderId: input.orderId, lineItems, shippingAmountCents: input.shippingCents }));
  });
  app.get('/api/provider-test/recipients/status', async request => { await localTestOwner(request); return data(await providerMoney.refreshRecipients()); });
  app.post('/api/provider-test/recipients/links', async request => {
    await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    return data(await providerMoney.recipientLinks({ baseUrl: `http://127.0.0.1:${config.port}` }));
  });
  app.get('/api/provider-test/recipients/onboard', async (request, reply) => {
    await localTestOwner(request);
    const { shop } = z.object({ shop: z.enum(TEST_STORES.map(store => store.shop)) }).strict().parse(request.query);
    const links = await providerMoney.recipientLinks({ baseUrl: `http://127.0.0.1:${config.port}` });
    const link = links.find(value => value.shop === shop);
    let target;
    try { target = new URL(link?.url); } catch { throw fail(409, 'TEST_RECIPIENT_REQUIRED', 'A bound new test recipient is required before onboarding.'); }
    const expectedHostedPath = (target.hostname === 'connect.stripe.com' && target.pathname.startsWith('/setup/'))
      || (target.hostname === 'accounts.stripe.com' && /^\/r\/acct_[A-Za-z0-9]{8,}$/.test(target.pathname));
    if (target.protocol !== 'https:' || target.port || target.username || target.password || !expectedHostedPath)
      throw fail(409, 'ONBOARDING_URL_INVALID', 'Stripe did not return an expected hosted onboarding URL.');
    return reply.redirect(target.href);
  });
  app.get('/api/provider-test/recipients/return', async (request, reply) => {
    await localTestOwner(request); await providerMoney.refreshRecipients(); return reply.redirect('/?provider_recipient_returned=1');
  });
  app.get('/api/provider-test/recipients/refresh', async (request, reply) => {
    await localTestOwner(request); return reply.redirect('/?provider_recipient_refresh_required=1');
  });
  app.get('/api/test-checkout/options', async request => { await localTestOwner(request); return data(await testCheckout.options()); });
  app.get('/api/test-checkout', async request => { await localTestOwner(request); return data(await testCheckout.list()); });
  app.get('/api/test-checkout/:id', async request => { await localTestOwner(request); return data(await testCheckout.get(limitedString.parse(request.params.id))); });
  app.post('/api/test-checkout/quote', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const ctx = await localTestOwner(request);
    const input = z.object({ variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/) }).strict().parse(request.body);
    const result = await testCheckout.quote(input);
    await auth.audit(ctx, 'test_checkout.quoted', result.id); return data(result);
  });
  app.post('/api/test-checkout/:id/pay', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const ctx = await localTestOwner(request);
    z.object({ confirmTest: z.literal(true) }).strict().parse(request.body);
    const result = await testCheckout.pay(limitedString.parse(request.params.id));
    await auth.audit(ctx, 'test_checkout.payment_checked', result.id); return data(result);
  });
  app.post('/api/test-checkout/:id/reconcile', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const ctx = await localTestOwner(request); z.object({}).strict().parse(request.body || {});
    const result = await testCheckout.reconcile(limitedString.parse(request.params.id));
    await auth.audit(ctx, 'test_checkout.reconciled', result.id); return data(result);
  });
  app.post('/api/connections/shopify/preflight', async request => { requireAdmin(await browserRoute(request)); return data(await operations.preflightShopify()); });
  app.post('/api/connections/shopify/import', async request => { requireAdmin(await browserRoute(request)); return data(await operations.importShopify()); });
  app.post('/api/bags/:id/push-shopify', async request => { requireAdmin(await browserRoute(request)); return data(await operations.pushShopify(request.params.id)); });
  app.post('/api/jobs/run', async request => { requireAdmin(await browserRoute(request)); return data({ ...await operations.runJobs(), providers: await providerJobs.run() }); });
  async function sandboxOrder(input = {}, scopedBrand) {
    const approved = (await domain.listProducts({ brandId: scopedBrand || input.brandId, status: 'approved' })).filter(p => p.inventoryQty > 0);
    if (!approved.length) throw fail(409, 'NO_APPROVED_STOCK', 'Approve a product with stock before creating a sandbox order.');
    const selected = input.brandId || scopedBrand ? [approved[0]] : [...new Map(approved.map(p => [p.brandId, p])).values()];
    return domain.createSandboxOrder({ externalId: `TEST-${randomUUID().slice(0,8)}`, currency: 'USD',
      shipTo: { name: 'Alex Sandbox', line1: '123 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' },
      items: selected.map(p => ({ brandId: p.brandId, sku: p.sku, qty: 1 })) });
  }
  app.post('/api/sandbox/orders', async request => { requireAdmin(await browserRoute(request)); return data(await sandboxOrder(request.body)); });
  app.post('/api/brands/:id/credentials', async request => { requireAdmin(await browserRoute(request)); await domain.getBrand(request.params.id); return data(await auth.createCredential(request.params.id, request.body)); });
  app.get('/api/brands/:id/credentials', async request => { const ctx = await browserRoute(request); brandScope(ctx, request.params.id); return data(await auth.listCredentials(request.params.id)); });
  app.delete('/api/brands/:id/credentials/:credentialId', async request => { requireAdmin(await browserRoute(request)); return data(await auth.revokeCredential(request.params.id, request.params.credentialId)); });
  app.post('/api/brands/:id/invite', async request => { requireAdmin(await browserRoute(request)); await domain.getBrand(request.params.id); const invite = await auth.createInvite(request.params.id); return data({ ...invite, path: `/onboard/${invite.token}` }); });
  app.get('/api/brands/:id/shopify', async request => { const ctx = await browserRoute(request); brandScope(ctx, request.params.id); return data(await shopifyConnections.status(request.params.id)); });
  app.post('/api/brands/:id/shopify/authorize', async (request, reply) => {
    requireAdmin(await browserRoute(request));
    const pending = await shopifyConnections.begin(request.params.id, limitedString.parse(request.body?.shop));
    reply.setCookie('avf_shopify_oauth', pending.browserToken, { path: '/oauth/shopify/callback', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 600 });
    return data({ authorizationUrl: pending.url, expiresAt: pending.expiresAt, scopes: pending.scopes });
  });
  app.post('/api/brands/:id/shopify/import', async request => { requireAdmin(await browserRoute(request)); return data(await operations.importShopify(request.params.id)); });
  app.get('/oauth/shopify/callback', async (request, reply) => {
    const params = new URL(request.raw.url, config.publicBaseUrl || 'http://localhost').searchParams;
    const installed = await shopifyConnections.complete(params, request.cookies.avf_shopify_oauth);
    reply.clearCookie('avf_shopify_oauth', { path: '/oauth/shopify/callback', secure: true, sameSite: 'lax' });
    await domain.updateBrand(installed.brandId, { connectionTier: 'shopify', connectionHealthy: true });
    // Token exchange establishes the connector, never an owner/browser login.
    return data({ connection: installed, message: 'Store authorization saved. Catalog, webhook and payment acceptance tests are still required.' });
  });
  app.get('/api/invites/:token', async request => {
    const invite = await auth.lookupInvite(request.params.token);
    const brand = await domain.getBrand(invite.brandId);
    return data({ brand: { id: brand.id, name: brand.name }, expiresAt: invite.expiresAt, sandbox: true });
  });
  app.get('/api/handoffs/:token', async request => data(await operations.getHandoff(request.params.token)));
  app.post('/api/handoffs/:token/shipments', async request => data(await operations.submitHandoff(request.params.token, shipmentSchema.parse(request.body))));
  app.post('/api/invites/:token/accept', async (request, reply) => {
    const input = z.object({ acceptedSandboxTerms: z.literal(true) }).parse(request.body);
    const invite = await auth.consumeInvite(request.params.token, 'sandbox-draft-v1');
    const session = await auth.createSession({ brandId: invite.brandId }); setSessionCookie(reply, session);
    await domain.updateBrand(invite.brandId, { agreementSigned: input.acceptedSandboxTerms });
    return data({ csrfToken: session.csrfToken, brandId: session.brandId, role: 'brand', sandbox: true });
  });
  app.post('/oauth/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const input = { ...(request.body || {}) };
    if (request.headers.authorization?.startsWith('Basic ')) {
      const decoded = Buffer.from(request.headers.authorization.slice(6), 'base64').toString(); const index = decoded.indexOf(':');
      if (index > 0) { input.client_id = decoded.slice(0,index); input.client_secret = decoded.slice(index+1); }
    }
    if (input.grant_type !== 'client_credentials') throw fail(400, 'unsupported_grant_type', 'Use client_credentials.');
    return auth.issueToken(input.client_id, input.client_secret, input.scope);
  });
  const actions = {
    listBags: (ctx, input = {}) => { requireScope(ctx, 'orders:read'); return domain.listBags({ brandId: ctx.brandId, status: input.status }); },
    getBag: (ctx, input) => { requireScope(ctx, 'orders:read'); return domain.getBag(input.id, ctx.brandId); },
    listProducts: ctx => { requireScope(ctx, 'catalog:read'); return domain.listProducts({ brandId: ctx.brandId }); },
    upsertProduct: (ctx, input) => { requireScope(ctx, 'catalog:write'); return domain.upsertProduct(ctx.brandId, input.sku, productSchema.parse(input.product)); },
    shipment: (ctx, input) => { requireScope(ctx, 'orders:fulfill'); return domain.recordShipment(input.id, shipmentSchema.parse(input.shipment), ctx.brandId); },
    refund: (ctx, input) => { requireScope(ctx, 'refunds:write'); return domain.requestRefund(input.id, refundSchema.parse(input.refund), ctx.brandId); },
    payouts: async ctx => { requireScope(ctx, 'payouts:read'); return { transfers: await domain.listTransfers({ brandId: ctx.brandId }), credits: await domain.listCredits({ brandId: ctx.brandId }), sandbox: true }; },
    importProducts: (ctx, input) => { requireScope(ctx, 'catalog:write'); return operations.enqueueImport(ctx.brandId, input); },
    inventory: async (ctx, input) => { requireScope(ctx, 'catalog:write'); const product = (await domain.listProducts({ brandId: ctx.brandId })).find(p => p.sku === input.sku); if (!product) throw fail(404,'NOT_FOUND','Product not found.'); return domain.upsertProduct(ctx.brandId, input.sku, { ...product, inventoryQty: z.number().int().min(0).max(1_000_000).parse(input.qty) }); },
  };
  async function apiMutation(request, reply, action, input, scope) {
    const ctx = await context(request, { scope });
    if (!ctx.bearer) throw fail(401, 'BEARER_REQUIRED', 'Use a scoped brand API credential.');
    const outcome = await auth.idempotent(ctx.brandId, `${request.method} ${request.url.split('?')[0]}`, request.headers['idempotency-key'], request.body, () => action(ctx, input));
    reply.code(outcome.statusCode); if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
    return outcome.error ? { error: outcome.error } : data(outcome.data);
  }
  app.get('/v1/bags', async request => data(await actions.listBags(await context(request, { scope: 'orders:read' }), request.query)));
  app.get('/v1/bags/:id', async request => data(await actions.getBag(await context(request, { scope: 'orders:read' }), request.params)));
  app.get('/v1/products', async request => data(await actions.listProducts(await context(request, { scope: 'catalog:read' }))));
  app.put('/v1/products/:sku', async request => data(await actions.upsertProduct(await context(request, { scope: 'catalog:write' }), { sku: request.params.sku, product: request.body })));
  app.patch('/v1/inventory/:sku', async request => data(await actions.inventory(await context(request, { scope: 'catalog:write' }), { sku: request.params.sku, qty: request.body?.qty })));
  app.post('/v1/products/import', (request, reply) => apiMutation(request, reply, actions.importProducts, request.body, 'catalog:write'));
  app.get('/v1/products/import/:id', async request => { const ctx = await context(request, { scope: 'catalog:read' }); const row = (await db.query('SELECT id,status,cursor,accepted,errors,jsonb_array_length(rows) AS total,created_at,completed_at FROM catalog_imports WHERE id=$1 AND brand_id=$2', [request.params.id,ctx.brandId])).rows[0]; if (!row) throw fail(404,'NOT_FOUND','Import not found.'); return data(row); });
  app.post('/v1/bags/:id/shipments', (request, reply) => apiMutation(request, reply, actions.shipment, { id: request.params.id, shipment: request.body }, 'orders:fulfill'));
  app.post('/v1/bags/:id/refunds', (request, reply) => apiMutation(request, reply, actions.refund, { id: request.params.id, refund: request.body }, 'refunds:write'));
  app.get('/v1/payouts', async request => data((await actions.payouts(await context(request, { scope: 'payouts:read' }))).transfers));
  app.get('/v1/payouts/summary', async request => data(await actions.payouts(await context(request, { scope: 'payouts:read' }))));
  app.post('/v1/webhook-endpoints', (request, reply) => apiMutation(request, reply, (ctx, input) => operations.addEndpoint(ctx.brandId, z.string().url().parse(input.url),ctx.scopes), request.body, 'orders:read'));
  app.get('/v1/webhook-endpoints', async request => { const ctx = await context(request, { scope: 'orders:read' }); return data(await operations.listEndpoints(ctx.brandId)); });
  app.post('/v1/webhook-endpoints/:id/replay', (request, reply) => apiMutation(request, reply, async (ctx, input) => {
    const endpoint = (await db.query('SELECT id FROM outbound_webhook_endpoints WHERE id=$1 AND brand_id=$2', [request.params.id, ctx.brandId])).rows[0];
    if (!endpoint) throw fail(404, 'NOT_FOUND', 'Webhook endpoint not found.');
    return operations.replayEvent(limitedString.parse(input.eventId), ctx.brandId);
  }, request.body, 'orders:read'));
  app.post('/v1/sandbox/orders', (request, reply) => apiMutation(request, reply, (ctx, input) => sandboxOrder({}, ctx.brandId), request.body, 'orders:read'));
  app.post('/v1/brands/connect-session', (request, reply) => apiMutation(request, reply, async ctx => ({ brand: await domain.getBrand(ctx.brandId), sandbox: true, requiredActions: (await domain.getBrand(ctx.brandId)).onboardingRequirements }), request.body, 'orders:read'));
  app.post('/webhooks/shopify', async (request, reply) => {
    const supplied = String(request.headers['x-shopify-shop-domain'] || '');
    const registry = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(supplied) ? await testStores.findShop(supplied) : null;
    const installed = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(supplied) ? await shopifyConnections.findShop(supplied) : null;
    const adapter = registry ? await testStores.forShop(supplied) : operations.shopify;
    const valid = registry ? await adapter.verifyWebhook(request.rawBody || Buffer.alloc(0), request.headers['x-shopify-hmac-sha256'])
      : installed ? shopifyConnections.verifyWebhook(request.rawBody || Buffer.alloc(0), request.headers['x-shopify-hmac-sha256'])
      : await operations.shopify.verifyWebhook(request.rawBody || Buffer.alloc(0), request.headers['x-shopify-hmac-sha256']);
    if (!valid) return reply.code(401).send({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid Shopify signature.' } });
    const expected = registry?.shop || installed?.shop || (await operations.shopify.status()).shop;
    if (request.headers['x-shopify-shop-domain'] !== expected) throw fail(400, 'SHOP_MISMATCH', 'Webhook store does not match the configured connector.');
    const topic = String(request.headers['x-shopify-topic'] || '');
    if (!SHOPIFY_ALLOWED_WEBHOOK_TOPICS.includes(topic)) throw fail(400, 'WEBHOOK_TOPIC_NOT_ALLOWED', 'This Shopify topic is outside the configured subscription allowlist.');
    if (topic === 'app/uninstalled' && request.body?.myshopify_domain !== expected)
      throw fail(400, 'SHOP_MISMATCH', 'The signed uninstall payload does not match the webhook store.');
    if (registry) await providerEvents.queue({ provider: 'shopify', deliveryId: request.headers['x-shopify-webhook-id'], topic,
      shop: expected, payload: request.body, occurredAt: request.headers['x-shopify-triggered-at'] });
    return operations.saveInbound('shopify', request.headers['x-shopify-webhook-id'], topic, request.rawBody, expected,
      { brandId: registry?.brandId || installed?.brandId, occurredAt: request.headers['x-shopify-triggered-at'] });
  });
  app.post('/webhooks/stripe', async request => {
    const event = await operations.stripe.verifyWebhook(request.rawBody || Buffer.alloc(0), request.headers['stripe-signature']);
    const object = event.data?.object ?? {};
    const references = [object.id, object.payment_intent, object.charge].filter(value => typeof value === 'string');
    const bound = /^uco_[a-f0-9]{32}$/.test(object.metadata?.order_id ?? '')
      || (await db.query(`SELECT id FROM unified_checkout_runs WHERE checkout_session_id=ANY($1::text[])
        OR payment_intent_id=ANY($1::text[]) OR charge_id=ANY($1::text[]) LIMIT 1`, [references])).rows.length
      || (typeof object.metadata?.bag_id === 'string' && (await db.query('SELECT id FROM bags WHERE id=$1 AND provider_bound=true', [object.metadata.bag_id])).rows.length);
    if (bound) await providerEvents.queue({ provider: 'stripe', deliveryId: event.id, topic: event.type, payload: event });
    return operations.saveInbound('stripe', event.id, event.type, request.rawBody);
  });
  app.get('/openapi.json', async () => openApiDocument(config.publicBaseUrl || `http://127.0.0.1:${config.port}`));
  app.get('/.well-known/oauth-authorization-server', async () => ({ issuer: config.publicBaseUrl || `http://127.0.0.1:${config.port}`, token_endpoint: `${config.publicBaseUrl || `http://127.0.0.1:${config.port}`}/oauth/token`, grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_basic','client_secret_post'], scopes_supported: BRAND_SCOPES }));
  app.get('/.well-known/oauth-protected-resource', async () => ({ resource: `${config.publicBaseUrl || `http://127.0.0.1:${config.port}`}/mcp`, authorization_servers: [config.publicBaseUrl || `http://127.0.0.1:${config.port}`], scopes_supported: BRAND_SCOPES, bearer_methods_supported: ['header'] }));
  await registerMcp(app, { auth, context, actions });
  const dist = resolve(ROOT, 'dist');
  if (existsSync(dist)) await app.register(staticFiles, { root: dist, prefix: '/' });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !/^\/(api|v1|oauth|webhooks|mcp)(\/|$)/.test(request.url) && existsSync(resolve(dist, 'index.html'))) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
  let interval; let lastAlertKey = '';
  if (options.worker !== false) { interval = setInterval(async () => {
    try {
      const result = await providerJobs.run(); await operations.runJobs();
      // Swallowed per-run failures (e.g. nightly_reconciliation_pending) must reach an operator.
      const pending = [...new Set((result?.lifecycle ?? []).map(entry => entry.state).filter(state => /_pending$|_review$/.test(String(state))))].sort();
      const key = pending.join(',');
      if (key && key !== lastAlertKey) app.log.warn({ code: 'WORKER_ATTENTION_REQUIRED', states: pending }, 'Background jobs need attention');
      lastAlertKey = key;
    }
    catch (error) { app.log.error({ code: error.code || 'WORKER_ERROR' }, 'Background job failed'); }
  }, 5000); interval.unref(); }
  app.addHook('onClose', async () => { if (interval) clearInterval(interval); await providerFailureCheckouts.close(); operations.clearLocalStripeCredentials(); if (!options.db) await db.close(); });
  return app;
}
