import { z } from 'zod';
import { requireScope } from '../auth.mjs';

/** REST surface for the platform modules. Admin routes require the operations
 * workspace; brand routes are tenant-scoped to the session/bearer brand. */
export function registerPlatformRoutes(app, h) {
  const { platform, browserRoute, context, brandScope, requireAdmin, data, apiMutation } = h;
  const { crm } = platform;
  const admin = async request => { const ctx = await browserRoute(request); requireAdmin(ctx); return ctx; };
  const actor = ctx => ctx?.credentialId || (ctx?.owner ? 'owner' : ctx?.role) || 'system';
  const consent = z.object({ email: z.boolean().optional(), sms: z.boolean().optional(), marketing: z.boolean().optional(), health: z.boolean().optional() });

  // ---- Phase 1: CRM / shopper ----
  app.get('/api/crm/shoppers', async r => { await admin(r); return data(await crm.listShoppers()); });
  app.post('/api/crm/shoppers', async r => { const ctx = await admin(r);
    const input = z.object({ email: z.string().max(320), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(), phone: z.string().max(30).optional(), consent: consent.optional() }).parse(r.body);
    const s = await crm.upsertShopper(input); await platform.auth.audit(ctx, 'shopper.upserted', s.id); return data(s); });
  app.get('/api/crm/shoppers/:id', async r => { const ctx = await admin(r); const p = await crm.profile(r.params.id, { actor: actor(ctx) }); await platform.auth.audit(ctx, 'shopper.profile_viewed', r.params.id); return data(p); });
  app.patch('/api/crm/shoppers/:id/consent', async r => { const ctx = await admin(r); const c = await crm.setConsent(r.params.id, consent.parse(r.body)); await platform.auth.audit(ctx, 'shopper.consent_changed', r.params.id); return data(c); });
  app.put('/api/crm/shoppers/:id/intake', async r => { const ctx = await admin(r);
    const input = z.object({ intake: z.record(z.string(), z.unknown()).optional(), cycle: z.object({ lastPeriodStart: z.string().max(10).optional(), cycleLength: z.number().int().optional() }).optional() }).parse(r.body);
    await crm.summary(r.params.id); await platform.health.write(r.params.id, input, actor(ctx)); return data({ shopperId: r.params.id, saved: true }); });
  app.post('/api/crm/shoppers/:id/orders', async r => { await admin(r); return data(await crm.linkOrder(r.params.id, z.object({ orderId: z.string().min(1).max(100) }).parse(r.body).orderId)); });
  app.post('/api/crm/shoppers/:id/swipes', async r => { await admin(r); const i = z.object({ productId: z.string().min(1).max(100), liked: z.boolean() }).parse(r.body); return data(await crm.recordSwipe(r.params.id, i.productId, i.liked)); });
  app.post('/api/crm/shoppers/:id/reviews', async r => { await admin(r);
    const i = z.object({ bagId: z.string().min(1), productId: z.string().min(1), rating: z.number().int(), body: z.string().max(5000).optional(), photoUrl: z.string().max(2000).optional() }).parse(r.body);
    return data(await crm.createReview(r.params.id, i)); });
  app.get('/api/crm/segments', async r => { await admin(r); return data(await crm.listSegments()); });
  app.post('/api/crm/segments', async r => { await admin(r); return data(await crm.createSegment(r.body)); });
  app.get('/api/crm/segments/:id/members', async r => { await admin(r); return data(await crm.segmentMembers(r.params.id)); });
  app.get('/api/crm/campaigns', async r => { await admin(r); return data(await crm.listCampaigns()); });
  app.post('/api/crm/campaigns', async r => { await admin(r); return data(await crm.createCampaign(r.body)); });
  app.post('/api/crm/campaigns/:id/run', async r => { await admin(r); return data(await crm.runCampaign(r.params.id)); });
  app.get('/api/crm/outbox', async r => { await admin(r); return data(await crm.outbox({ shopperId: r.query.shopperId })); });
  app.post('/api/crm/tickets', async r => { await admin(r); return data(await crm.openTicket(r.body)); });
  app.get('/api/crm/tickets', async r => { const ctx = await browserRoute(r, 'orders:read'); return data(await crm.listTickets({ brandId: brandScope(ctx, r.query.brandId), status: r.query.status })); });
  app.get('/api/crm/tickets/:id', async r => { const ctx = await browserRoute(r, 'orders:read'); return data(await crm.getTicket(r.params.id, ctx.brandId)); });
  app.post('/api/crm/tickets/:id/replies', async r => { const ctx = await browserRoute(r, 'orders:read'); return data(await crm.replyTicket(r.params.id, r.body || {}, ctx.brandId)); });
  app.post('/api/crm/tickets/:id/actions', async r => { const ctx = await admin(r);
    const out = await crm.ticketAction(r.params.id, r.body || {}, {
      refund: (t, reason) => platform.refundBag(t.bagId, reason),
      credit: (t, amountCents, reason) => platform.bank ? platform.bank.grantGoodwill(t.shopperId, { amountCents, reason, ticketId: t.id }) : Promise.reject(Object.assign(new Error('Beauty Bank is unavailable.'), { statusCode: 501, code: 'NOT_AVAILABLE' })),
    });
    await platform.auth.audit(ctx, `ticket.${r.body?.action}`, r.params.id); return data(out); });
  app.get('/api/crm/brand/reviews', async r => { const ctx = await browserRoute(r, 'orders:read'); const brandId = brandScope(ctx, r.query.brandId); if (!brandId) throw Object.assign(new Error('brandId is required.'), { statusCode: 422, code: 'VALIDATION_ERROR' }); return data(await crm.brandReviews(brandId)); });
  app.get('/api/crm/products/:id/reviews', async r => { await browserRoute(r, 'catalog:read'); return data(await crm.productReviews(r.params.id)); });
  app.post('/api/crm/jobs/run', async r => { await admin(r); return data(await platform.jobs()); });

  // Brand bearer API (scoped).
  app.get('/v1/reviews', async r => { const ctx = await context(r, { scope: 'orders:read' }); return data(await crm.brandReviews(ctx.brandId)); });
  app.get('/v1/tickets', async r => { const ctx = await context(r, { scope: 'orders:read' }); return data(await crm.listTickets({ brandId: ctx.brandId, status: r.query.status })); });
  app.post('/v1/tickets/:id/replies', (r, reply) => apiMutation(r, reply, (ctx, input) => crm.replyTicket(input.id, input.body, ctx.brandId), { id: r.params.id, body: r.body || {} }, 'orders:read'));

  registerMoneyRoutes(app, h, admin);
  registerBrandRoutes(app, h, admin);
  for (const extra of h.extra || []) extra(app, h);
}

function registerBrandRoutes(app, h, admin) {
  const { platform, browserRoute, context, brandScope, data, apiMutation } = h;
  const side = platform.brands;
  const brandRoute = async (r, scope) => { const ctx = await browserRoute(r, scope); const brandId = brandScope(ctx, r.params.brandId || r.params.id || r.body?.brandId || r.query.brandId); if (!brandId) throw Object.assign(new Error('brandId is required.'), { statusCode: 422, code: 'VALIDATION_ERROR' }); return { ctx, brandId }; };
  // ---- Phase 3: self-serve portal ----
  app.post('/api/portal/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async r => {
    const i = z.object({ brandName: z.string().min(1).max(160), email: z.string().max(320), website: z.string().max(500).optional(), category: z.string().max(100).optional(), contactName: z.string().max(120).optional() }).parse(r.body);
    const out = await side.signup(i); await platform.auth.audit({ role: 'public' }, 'portal.signup', out.brandId); return data(out); });
  app.get('/api/portal/review-queue', async r => { await admin(r); return data(await side.reviewQueue()); });
  app.get('/api/portal/:brandId/status', async r => { const { brandId } = await brandRoute(r, 'catalog:read'); return data(await side.status(brandId)); });
  app.patch('/api/portal/:brandId/profile', async r => { const { brandId } = await brandRoute(r, 'catalog:write'); return data(await side.updateProfile(brandId, r.body || {})); });
  app.post('/api/portal/:brandId/stripe/link', async r => { const { brandId } = await brandRoute(r, 'payouts:read'); return data(await side.stripeLink(brandId)); });
  app.post('/api/portal/:brandId/stripe/return', async r => { const { ctx, brandId } = await brandRoute(r, 'payouts:read'); const out = await side.stripeReturn(brandId); await platform.auth.audit(ctx, 'portal.stripe_onboarded', brandId); return data(out); });
  app.post('/api/portal/:brandId/connect', async r => { const { ctx, brandId } = await brandRoute(r, 'catalog:write'); const i = z.object({ platform: z.enum(['shopify', 'woocommerce', 'bigcommerce', 'csv']), credentials: z.record(z.string(), z.string().max(500)).optional() }).parse(r.body); const out = await side.connect(brandId, i.platform, i.credentials); await platform.auth.audit(ctx, `connector.${i.platform}.connected`, brandId); return data(out); });
  app.get('/api/portal/:brandId/connectors', async r => { const { brandId } = await brandRoute(r, 'catalog:read'); return data(await side.connectors(brandId)); });
  app.post('/api/portal/:brandId/connectors/:platform/sync', async r => { const { brandId } = await brandRoute(r, 'catalog:write'); return data(await side.sync(brandId, r.params.platform)); });
  app.delete('/api/portal/:brandId/connectors/:platform', async r => { const { brandId } = await brandRoute(r, 'catalog:write'); return data(await side.disconnect(brandId, r.params.platform)); });
  app.post('/api/portal/:brandId/catalog/csv', async r => { const { brandId } = await brandRoute(r, 'catalog:write'); return data(await side.importCsv(brandId, r.body?.csv)); });
  app.post('/api/portal/:brandId/activate', async r => { const ctx = await admin(r); const out = await side.activate(r.params.brandId); await platform.auth.audit(ctx, 'brand.activated', r.params.brandId); return data(out); });
  app.post('/api/connectors/orders/:bagId/push', async r => { await admin(r); return data(await side.pushOrder(r.params.bagId)); });
  // ---- Analytics ----
  app.get('/api/brands/:id/analytics', async r => { const { brandId } = await brandRoute(r, 'orders:read'); return data(await side.analytics(brandId, r.query)); });
  app.get('/v1/analytics', async r => { const ctx = await context(r, { scope: 'orders:read' }); return data(await side.analytics(ctx.brandId, r.query)); });
  // ---- Paid placements ----
  const placementBody = z.object({ kind: z.enum(['featured_spot', 'sponsored_swipe', 'sampling_box']), productId: z.string().min(1), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional(), units: z.number().int().optional(), brandId: z.string().optional() });
  app.post('/api/placements', async r => { const { brandId } = await brandRoute(r, 'catalog:write'); return data(await side.requestPlacement(brandId, placementBody.parse(r.body))); });
  app.get('/api/placements', async r => { const ctx = await browserRoute(r, 'catalog:read'); return data(await side.listPlacements(brandScope(ctx, r.query.brandId))); });
  app.post('/api/placements/:id/decision', async r => { const ctx = await admin(r); const out = await side.decidePlacement(r.params.id, r.body?.decision, { method: r.body?.method }); await platform.auth.audit(ctx, `placement.${r.body?.decision}`, r.params.id); return data(out); });
  app.post('/api/placements/:id/cancel', async r => { const ctx = await browserRoute(r, 'catalog:write'); const brandId = ctx.brandId || r.body?.brandId; return data(await side.cancelPlacement(brandId, r.params.id)); });
  app.get('/api/billing', async r => { const ctx = await browserRoute(r, 'payouts:read'); return data(await side.billing(brandScope(ctx, r.query.brandId))); });
  app.post('/api/billing/:id/paid', async r => { await admin(r); return data(await side.markBillingPaid(r.params.id)); });
  app.get('/api/placements/feed/:kind', async r => { await admin(r); return data(await side.feed(r.params.kind, { limit: Number(r.query.limit) || 10 })); });
  app.post('/api/placements/:id/click', async r => { await admin(r); return data(await side.click(r.params.id)); });
  app.get('/v1/placements', async r => { const ctx = await context(r, { scope: 'catalog:read' }); return data(await side.listPlacements(ctx.brandId)); });
  app.post('/v1/placements', (r, reply) => apiMutation(r, reply, (ctx, input) => side.requestPlacement(ctx.brandId, placementBody.parse(input)), r.body, 'catalog:write'));
  app.get('/v1/billing', async r => { const ctx = await context(r, { scope: 'payouts:read' }); return data(await side.billing(ctx.brandId)); });
  app.post('/v1/catalog/csv', (r, reply) => apiMutation(r, reply, (ctx, input) => side.importCsv(ctx.brandId, input?.csv), r.body, 'catalog:write'));
}

function registerMoneyRoutes(app, h, admin) {
  const { platform, browserRoute, context, brandScope, data } = h;
  const { bank, console: con, risk, reports } = platform;
  const sendReport = (reply, r, report) => r.query.format === 'csv' ? reply.type('text/csv; charset=utf-8').send(report.csv) : data(report);
  // ---- Phase 2: Beauty Bank ----
  app.get('/api/bank/shoppers/:id', async r => { await admin(r); await platform.crm.summary(r.params.id); return data({ balance: await bank.balance(r.params.id), lots: await bank.lots(r.params.id), history: await bank.history(r.params.id) }); });
  app.post('/api/bank/shoppers/:id/earn', async r => { await admin(r); return data(await bank.earnForOrder(r.params.id, z.object({ orderId: z.string().min(1) }).parse(r.body).orderId)); });
  app.post('/api/bank/shoppers/:id/goodwill', async r => { const ctx = await admin(r); await platform.crm.summary(r.params.id); const i = z.object({ amountCents: z.number().int(), reason: z.string().max(300).optional() }).parse(r.body); const lot = await bank.grantGoodwill(r.params.id, i); await platform.auth.audit(ctx, 'bank.goodwill', lot.id); return data(lot); });
  app.post('/api/bank/shoppers/:id/redeem', async r => { await admin(r); await platform.crm.summary(r.params.id); const i = z.object({ amountCents: z.number().int(), orderRef: z.string().max(100).optional() }).parse(r.body); return data(await bank.redeem(r.params.id, { ...i, idempotencyKey: r.headers['idempotency-key'] })); });
  app.get('/api/bank/liability', async r => { await admin(r); return data(await bank.liabilityReport()); });
  app.post('/api/bank/run', async r => { await admin(r); return data(await bank.run()); });
  // ---- Admin console ----
  app.get('/api/admin/console', async r => { await admin(r); return data(await con.summary()); });
  app.get('/api/admin/disputes', async r => { const ctx = await browserRoute(r, 'payouts:read'); return data(await con.listDisputes(brandScope(ctx, r.query.brandId))); });
  app.post('/api/admin/disputes', async r => { const ctx = await admin(r); const d = await con.openDispute(r.body); await platform.auth.audit(ctx, 'dispute.opened', d.id); return data(d); });
  app.post('/api/admin/disputes/:id/evidence', async r => { await admin(r); return data(await con.submitEvidence(r.params.id, r.body || {})); });
  app.post('/api/admin/disputes/:id/resolve', async r => { const ctx = await admin(r); const d = await con.resolveDispute(r.params.id, r.body?.outcome); await platform.auth.audit(ctx, `dispute.${d.status}`, d.id); return data(d); });
  app.get('/api/admin/holds', async r => { await admin(r); return data(await con.holds()); });
  app.post('/api/admin/holds/:id/release', async r => { const ctx = await admin(r); const out = await con.releaseHold(r.params.id); await platform.auth.audit(ctx, 'transfer.hold_released', r.params.id); return data(out); });
  app.get('/api/admin/stuck-transfers', async r => { await admin(r); return data(await con.stuckTransfers()); });
  app.post('/api/admin/stuck-transfers/:id/retry', async r => { await admin(r); return data(await con.retryStuck(r.params.id)); });
  app.get('/api/admin/alerts', async r => { await admin(r); return data(await con.alerts({ all: r.query.all === 'true' })); });
  app.post('/api/admin/alerts/scan', async r => { await admin(r); return data(await con.scan()); });
  app.post('/api/admin/alerts/:id/ack', async r => { await admin(r); return data(await con.acknowledge(r.params.id)); });
  app.post('/api/admin/payout-checks', async r => { const ctx = await admin(r); const out = await con.payoutChecks({ enforce: r.body?.enforce === true }); await platform.auth.audit(ctx, 'payout_checks.run', null); return data(out); });
  // ---- Risk ----
  app.post('/api/risk/checkout', async r => { await admin(r); return data(await risk.scoreCheckout(r.body || {})); });
  app.get('/api/risk/assessments', async r => { await admin(r); return data(await risk.list(r.query.type)); });
  app.get('/api/brands/:id/payout-check', async r => { const ctx = await browserRoute(r, 'payouts:read'); brandScope(ctx, r.params.id); return data(await risk.brandPayoutCheck(r.params.id)); });
  // ---- Reports ----
  app.get('/api/reports/sales-tax', async (r, reply) => { await admin(r); return sendReport(reply, r, await reports.salesTax({ from: r.query.from, to: r.query.to })); });
  app.get('/api/reports/brand-payouts', async (r, reply) => { const ctx = await browserRoute(r, 'payouts:read'); return sendReport(reply, r, await reports.brandAnnualPayouts(r.query.year || new Date().getUTCFullYear(), brandScope(ctx, r.query.brandId))); });
  app.get('/v1/disputes', async r => { const ctx = await context(r, { scope: 'payouts:read' }); return data(await con.listDisputes(ctx.brandId)); });
  app.get('/v1/reports/payouts', async (r, reply) => { const ctx = await context(r, { scope: 'payouts:read' }); return sendReport(reply, r, await reports.brandAnnualPayouts(r.query.year || new Date().getUTCFullYear(), ctx.brandId)); });
}

/** MCP tools added to the brand MCP server (tenant-scoped). */
export function platformMcpTools(platform) {
  return ({ read, write, ctx, z: zz }) => {
    const need = scope => requireScope(ctx, scope);
    read('list_reviews', 'Read verified-purchase reviews synced to your brand (no shopper PII).', {}, () => { need('orders:read'); return platform.crm.brandReviews(ctx.brandId); });
    read('list_support_tickets', 'List support tickets linked to your brand’s Bags.', { status: zz.enum(['open', 'pending_brand', 'resolved']).optional() }, input => { need('orders:read'); return platform.crm.listTickets({ brandId: ctx.brandId, status: input.status }); });
    write('reply_support_ticket', 'Reply to a support ticket linked to one of your Bags. The shopper is notified via the simulated outbox.', { id: zz.string(), body: zz.string().min(1).max(4000) }, 'mcp:reply_support_ticket', input => { need('orders:read'); return platform.crm.replyTicket(input.id, { body: input.body }, ctx.brandId); });
    read('list_disputes', 'List chargeback disputes on your Bags (simulated Stripe disputes).', {}, () => { need('payouts:read'); return platform.console.listDisputes(ctx.brandId); });
    read('get_annual_payout_report', 'Read your 1099-K style annual gross volume and net transfer data.', { year: zz.number().int().min(2000).max(2100) }, async input => { need('payouts:read'); const r = await platform.reports.brandAnnualPayouts(input.year, ctx.brandId); return r.brands[0]; });
    read('get_brand_analytics', 'Read your sales, conversion, returns and top products.', { from: zz.string().optional(), to: zz.string().optional() }, input => { need('orders:read'); return platform.brands.analytics(ctx.brandId, input); });
    read('get_onboarding_status', 'Read your self-serve onboarding checklist and next step.', {}, () => { need('catalog:read'); return platform.brands.status(ctx.brandId); });
    read('list_placements', 'List your paid placements, sponsored swipe cards and sampling boxes.', {}, () => { need('catalog:read'); return platform.brands.listPlacements(ctx.brandId); });
    write('request_placement', 'Request a paid placement for an approved product. Avafem approves it and issues a billing record.', { kind: zz.enum(['featured_spot', 'sponsored_swipe', 'sampling_box']), productId: zz.string(), units: zz.number().int().optional(), startsAt: zz.string().optional(), endsAt: zz.string().optional() }, 'mcp:request_placement', input => { need('catalog:write'); return platform.brands.requestPlacement(ctx.brandId, input); });
    write('upload_catalog_csv', 'Import catalog rows from CSV (Avafem columns or a Shopify product export). Products enter human review.', { csv: zz.string().min(1).max(3_000_000) }, 'mcp:upload_catalog_csv', input => { need('catalog:write'); return platform.brands.importCsv(ctx.brandId, input.csv); });
    for (const extra of platform.mcpExtras || []) extra({ read, write, ctx, z: zz, need });
  };
}
