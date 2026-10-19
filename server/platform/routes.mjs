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

  for (const extra of h.extra || []) extra(app, h);
}

/** MCP tools added to the brand MCP server (tenant-scoped). */
export function platformMcpTools(platform) {
  return ({ read, write, ctx, z: zz }) => {
    const need = scope => requireScope(ctx, scope);
    read('list_reviews', 'Read verified-purchase reviews synced to your brand (no shopper PII).', {}, () => { need('orders:read'); return platform.crm.brandReviews(ctx.brandId); });
    read('list_support_tickets', 'List support tickets linked to your brand’s Bags.', { status: zz.enum(['open', 'pending_brand', 'resolved']).optional() }, input => { need('orders:read'); return platform.crm.listTickets({ brandId: ctx.brandId, status: input.status }); });
    write('reply_support_ticket', 'Reply to a support ticket linked to one of your Bags. The shopper is notified via the simulated outbox.', { id: zz.string(), body: zz.string().min(1).max(4000) }, 'mcp:reply_support_ticket', input => { need('orders:read'); return platform.crm.replyTicket(input.id, { body: input.body }, ctx.brandId); });
    for (const extra of platform.mcpExtras || []) extra({ read, write, ctx, z: zz, need });
  };
}
