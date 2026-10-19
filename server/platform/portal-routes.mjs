import { z } from 'zod';
import { requireScope, BRAND_SCOPES } from '../auth.mjs';
import { addPaths } from './openapi.mjs';

const err = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const role = z.enum(['owner', 'staff', 'finance']);
const format = z.enum(['json', 'csv']).optional();

/** Brand portal routes: browser session + CSRF only (bearer is rejected by
 * browserRoute). Brand sessions are pinned to their own brand by brandScope;
 * the owner operations workspace may pass ?brandId= for support. */
export function registerPortalRoutes(app, h) {
  const { platform, browserRoute, brandScope, data, setSessionCookie, clearSessionCookie } = h;
  const portal = platform.portal;
  const scoped = async (r, scope) => {
    const ctx = await browserRoute(r, scope);
    const brandId = brandScope(ctx, r.query?.brandId);
    if (!brandId) throw err(422, 'BRAND_REQUIRED', 'Select a brand.');
    return { ctx, brandId };
  };
  const identifiedOwner=ctx=>{if(ctx.owner)return;if(!ctx.memberId)throw err(403,'MEMBER_SESSION_REQUIRED','Sign in with your own owner email before managing the team or API keys.');if(ctx.memberRole!=='owner')throw err(403,'OWNER_REQUIRED','An identified brand owner is required.');};
  const team=async r=>{const result=await scoped(r,'members:manage');identifiedOwner(result.ctx);return result;};
  const brandSession = async r => { const ctx = await browserRoute(r); if (!ctx.brandId) throw err(403, 'BRAND_SESSION_REQUIRED', 'Sign in to a brand first.'); return ctx; };
  const sendReport = (reply, fmt, report, filename) => fmt === 'csv'
    ? reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}.csv"`).header('cache-control', 'no-store').send(report.csv)
    : (reply.header('cache-control', 'no-store'), data((({ csv, ...rest }) => rest)(report)));
  async function startSession(request, reply, member) {
    // Session rotation: any previous session on this browser is destroyed.
    const previous = await platform.auth.resolveSession(request.cookies.avf_session);
    if (previous) await platform.auth.deleteSession(previous.tokenHash);
    const session = await platform.auth.createSession({ brandId: member.brandId, memberId: member.id, memberVersion:member.sessionVersion });
    setSessionCookie(reply, session);
    return data({ csrfToken: session.csrfToken, brandId: member.brandId, memberId: member.id, role: member.role, sandbox: true });
  }

  app.post('/api/brand-auth/login/request', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async r => {
    const i = z.object({ email: z.string().max(254) }).strict().parse(r.body);
    const simulated=platform.portalDelivery?.capabilities().simulated ?? true;
    return data({ ...(await portal.requestLogin(i.email)), message:simulated?'If that email belongs to a brand team, a sign-in link was queued in the simulated local mailbox; no email was sent.':'If that email belongs to a brand team, a sign-in link was requested.', simulated });
  });
  app.post('/api/brand-auth/login/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (r, reply) => {
    const i = z.object({ token: z.string().max(100) }).strict().parse(r.body);
    return startSession(r, reply, await portal.consumeLink(i.token));
  });
  app.post('/api/brand-auth/login/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (r, reply) => {
    const i = z.object({ email: z.string().max(254), password: z.string().max(200), brandId: z.string().max(100).optional() }).strict().parse(r.body);
    return startSession(r, reply, await portal.passwordLogin(i));
  });
  app.post('/api/brand-auth/logout', async (r, reply) => {
    const ctx = await browserRoute(r); z.object({}).strict().parse(r.body || {});
    await platform.auth.deleteSession(ctx.tokenHash); clearSessionCookie(reply);
    if (ctx.brandId) await platform.auth.audit(ctx, 'brand_auth.logout', ctx.memberId || ctx.brandId);
    return data({ signedOut: true });
  });
  app.get('/api/brand-auth/me', async r => data({...await portal.me(await brandSession(r)),emailDelivery:platform.portalDelivery?.capabilities() || {configured:false,simulated:true,provider:'simulated',delivered:false,externalDeliveryAllowed:false}}));
  app.put('/api/brand-auth/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async r => {
    const ctx = await brandSession(r);
    const i = z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().min(12).max(200) }).strict().parse(r.body);
    return data(await portal.setPassword(ctx, i));
  });

  // ---- Team members (owner only: members:manage) ----
  app.get('/api/brand-portal/members', async r => { const { brandId } = await team(r); return data(await portal.listMembers(brandId)); });
  app.post('/api/brand-portal/members', async (r, reply) => {
    const { ctx, brandId } = await team(r);
    const i = z.object({ operationId, email: z.string().max(254), role }).strict().parse(r.body);
    const out = await platform.auth.idempotent(`portal:${brandId}`, 'POST /api/brand-portal/members', i.operationId, i, () => portal.addMember(brandId, i, ctx));
    reply.code(out.statusCode); if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    return out.error ? { error: out.error } : data(out.data);
  });
  app.patch('/api/brand-portal/members/:memberId', async r => { const { ctx, brandId } = await team(r); const i = z.object({ role }).strict().parse(r.body); return data(await portal.changeRole(brandId, r.params.memberId, i.role, ctx)); });
  app.delete('/api/brand-portal/members/:memberId', async r => { const { ctx, brandId } = await team(r); return data(await portal.removeMember(brandId, r.params.memberId, ctx)); });

  // ---- Dashboard, product status, statements ----
  app.get('/api/brand-portal/dashboard', async r => { const { ctx, brandId } = await scoped(r); return data(await portal.dashboard({ ...ctx, brandId })); });
  app.get('/api/brand-portal/products', async r => { const { brandId } = await scoped(r, 'catalog:read'); return data(await portal.productStatus(brandId)); });
  app.post('/api/brand-portal/products/:productId/resubmit', async r => { const { ctx, brandId } = await scoped(r, 'catalog:write'); z.object({}).strict().parse(r.body || {}); return data(await portal.resubmit(brandId, r.params.productId, ctx)); });
  app.get('/api/brand-portal/statements', async (r, reply) => {
    const { ctx, brandId } = await scoped(r, 'reports:read');
    const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format, brandId: z.string().max(100).optional() }).strict().parse(r.query);
    const report = await portal.statement(brandId, q.month); await platform.auth.audit(ctx, 'brand_report.statement_downloaded', `${brandId}:${q.month}`);
    return sendReport(reply, q.format, report, `avafem-statement-${q.month}`);
  });
  app.get('/api/brand-portal/reports/annual', async (r, reply) => {
    const { ctx, brandId } = await scoped(r, 'reports:read');
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100), format, brandId: z.string().max(100).optional() }).strict().parse(r.query);
    const report = await portal.annualReport(brandId, q.year); await platform.auth.audit(ctx, 'brand_report.annual_downloaded', `${brandId}:${q.year}`);
    return sendReport(reply, q.format, report, `avafem-1099k-style-${q.year}`);
  });
  // Sandbox-only simulated mailbox for local testing; operator workspace only.
  app.get('/api/admin/brand-auth/outbox', async r => {
    const host=String(r.headers.host || '').replace(/:\d+$/,'');
    if(!h.allowAuthOutbox || !['localhost','127.0.0.1','[::1]'].includes(host) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(r.ip))throw err(404,'NOT_FOUND','Route not found.');
    const ctx = await browserRoute(r); if (ctx.role !== 'admin' || !ctx.owner) throw err(403, 'OWNER_REQUIRED', 'Owner operations workspace required.');
    const q = z.object({ brandId: z.string().max(100).optional() }).strict().parse(r.query);
    await platform.auth.audit(ctx, 'brand_auth.outbox_viewed', q.brandId || null);
    return data(await portal.outbox({ brandId: q.brandId }));
  });
}

/** Brand MCP tools (bearer credentials keep the existing API scopes). */
export function portalMcpTools(platform) {
  return ({ read, ctx, z: zz }) => {
    read('get_product_review_status', 'Read each of your products’ review status (draft, in review, approved, rejected) with compliance reasons and what to fix.', {}, () => { requireScope(ctx, 'catalog:read'); return platform.portal.productStatus(ctx.brandId); });
    read('get_payout_statement', 'Read your monthly payout statement of simulated transfers (integer USD cents).', { month: zz.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }, async input => { requireScope(ctx, 'payouts:read'); const { csv, ...s } = await platform.portal.statement(ctx.brandId, input.month); return s; });
  };
}

const s = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const strict = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const note = 'Brand portal browser session only; API/OAuth bearer credentials are forbidden. Brand sessions are pinned to their own brand (owner workspace may pass ?brandId=). Mutations require x-csrf-token. Identified owner members manage team/API keys. Invite-link sessions are catalog/onboarding capabilities only, not customer/order/finance/team authority. Staff handles catalog/orders/fulfilment/refund proposals, not store settings or finance. Finance sees statements/payouts/billing and the payout-only portal dashboard, never general analytics/customer/catalog/Shopify/onboarding data.';
const pub = 'Public, rate limited. Sign-in mail is queued encrypted; default simulated with no external email. An explicitly configured server provider may dispatch asynchronously. HTTP responses never prove inbox delivery and never vary with whether the email is registered.';
addPaths([
  ['post', '/api/brand-auth/login/request', 'requestBrandMagicLink', 'public', strict({ email: s(254) }, ['email']), { description: `${pub} Always returns the same generic response (no account enumeration). Links are single-use, expire in 15 minutes, and at most 3 are issued per member per 15 minutes.` }],
  ['post', '/api/brand-auth/login/verify', 'verifyBrandMagicLink', 'public', strict({ token: s(100) }, ['token']), { description: `${pub} Consumes a single-use link atomically, destroys any previous session on this browser (rotation) and sets a new brand member session cookie.` }],
  ['post', '/api/brand-auth/login/password', 'brandPasswordLogin', 'public', strict({ email: s(254), password: s(200), brandId: s(100) }, ['email', 'password']), { description: `${pub} scrypt-hashed passwords; 5 failures lock the member for 15 minutes. Generic errors only.` }],
  ['post', '/api/brand-auth/logout', 'brandLogout', 'brand-session', strict({}), { optionalBody: true, description: 'Destroys the current session server-side and clears the cookie. Requires x-csrf-token.' }],
  ['get', '/api/brand-auth/me', 'brandSessionMe', 'brand-session', null, { description: `${note} Returns member, role, effective scopes and secret-free global emailDelivery capabilities; configured/accepted never means inbox-delivered.` }],
  ['put', '/api/brand-auth/password', 'setBrandMemberPassword', 'brand-session', strict({ currentPassword: s(200), newPassword: s(200, { minLength: 12 }) }, ['newPassword']), { description: `${note} Member sessions only. Signs out the member’s other sessions.` }],
  ['get', '/api/brand-portal/members', 'listBrandMembers', 'members:manage', null, { description: `${note} Owner only.` }],
  ['post', '/api/brand-portal/members', 'inviteBrandMember', 'members:manage', strict({ operationId: s(100, { pattern: '^[A-Za-z0-9_-]{8,100}$' }), email: s(254, { format: 'email' }), role: { type: 'string', enum: ['owner', 'staff', 'finance'] } }, ['operationId', 'email', 'role']), { description: `${note} Owner only. Body operationId gives 24-hour idempotency. Sends a simulated invitation link. Audit-logged.`, bodyIdempotency: true }],
  ['patch', '/api/brand-portal/members/{memberId}', 'changeBrandMemberRole', 'members:manage', strict({ role: { type: 'string', enum: ['owner', 'staff', 'finance'] } }, ['role']), { description: `${note} Owner only. The last owner cannot be demoted. Takes effect on the member’s next request.` }],
  ['delete', '/api/brand-portal/members/{memberId}', 'removeBrandMember', 'members:manage', null, { description: `${note} Owner only. Ends the member’s sessions and outstanding links. The last owner cannot be removed.` }],
  ['get', '/api/brand-portal/dashboard', 'brandPortalDashboard', 'brand-session', null, { description: `${note} Sections are included only when the role has their scope.` }],
  ['get', '/api/brand-portal/products', 'brandProductReviewStatus', 'catalog:read', null, { description: `${note} Each product’s review status with validation issues, compliance flags and what to fix.` }],
  ['post', '/api/brand-portal/products/{productId}/resubmit', 'resubmitBrandProduct', 'catalog:write', strict({}), { optionalBody: true, description: `${note} Moves a draft or edited rejected product back to in_review. Never approves anything.` }],
  ['get', '/api/brand-portal/statements', 'brandPayoutStatement', 'reports:read', null, { description: `${note} Finance/owner only. format=csv downloads.`, query: { month: s(7, { pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }), format: { type: 'string', enum: ['json', 'csv'] }, brandId: s(100) } }],
  ['get', '/api/brand-portal/reports/annual', 'brandPortalAnnualPayoutReport', 'reports:read', null, { description: `${note} Finance/owner only. 1099-K style data, not a tax form.`, query: { year: { type: 'integer', minimum: 2000, maximum: 2100 }, format: { type: 'string', enum: ['json', 'csv'] }, brandId: s(100) } }],
  ['get', '/api/admin/brand-auth/outbox', 'adminSimulatedBrandAuthOutbox', 'admin', null, { description: 'Disabled by default (404). Only explicit allowAuthOutbox local sandbox configuration without a public origin exposes this raw sign-in-link mailbox. Requires actual loopback host/IP and owner operations session; every access is audit-logged. Never a production support endpoint.' }],
  ['get','/api/brands/{id}/credentials','listManagedBrandKeys','credentials:manage',null,{description:`${note} Identified owner only; lists API-key metadata without secret/hash. Operator admin support may also inspect OAuth-client metadata.`}],
  ['post','/api/brands/{id}/credentials','createManagedBrandKey','credentials:manage',strict({operationId:s(100,{pattern:'^[A-Za-z0-9_-]{8,100}$'}),kind:{const:'api_key'},label:s(100,{minLength:1}),scopes:{type:'array',minItems:1,maxItems:6,items:{enum:BRAND_SCOPES}}},['operationId','label','scopes']),{description:`${note} Brand self-service creates api_key only with the six pre-existing integration scopes, never portal/session scopes. operationId binds creation durably; only the first response contains apiKey (secretAvailable:true), replay returns metadata with secretAvailable:false. No raw/encrypted API secret is retained, including idempotency storage. Revoke and create a new operation if the one-time secret is lost. Operator admin retains the legacy OAuth-client provisioning path.`,bodyIdempotency:true}],
  ['delete','/api/brands/{id}/credentials/{credentialId}','revokeManagedBrandKey','credentials:manage',null,{description:`${note} Identified owner only, own-brand api_key only. Idempotent revocation, live actor authorization and immutable audit; other brands return not found.`}],
  ['get','/api/dashboard','getLegacyAggregateDashboard','brand-session',null,{description:`${note} Aggregate operational+financial response additionally requires orders:read,catalog:read,payouts:read together; staff/finance/invite sessions must use their filtered portal views instead.`}],
  ['get','/api/events','getBrandOperationalEvents','brand-session',null,{description:`${note} Operational events/inbox additionally require orders:read and payouts:read together. Tenant filtered; not a finance/staff aggregate-data bypass.`}],
  ['get','/api/brands','listBrowserBrands','catalog:read',null,{description:`${note} Tenant-only brand configuration. Not available to finance sessions.`}],
  ['get','/api/brands/{id}/shopify','getBrowserShopifyConnection','catalog:read',null,{description:`${note} Owner member or onboarding invitation only; never returns connector tokens.`}],
]);
