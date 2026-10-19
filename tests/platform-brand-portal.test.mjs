import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture, DAY } from './helpers/platform-fixture.mjs';

let op = 0;
const opId = () => `op_portal_${String(++op).padStart(6, '0')}`;
const cookieOf = r => String(r.headers['set-cookie']).split(';')[0];
const linkToken = body => /#(?:token|invite)=([A-Za-z0-9_-]{43})/.exec(body)?.[1];

async function portal(t) {
  const f = await platformFixture(t);
  const lastLink = async email => { const mail = (await f.platform.portal.outbox({})).find(m => m.to === email); return linkToken(mail?.body || ''); };
  const as = (cookie, csrf) => o => f.request({ ...o, headers: { cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...o.headers } });
  async function verify(token, existingCookie) {
    const r = await f.request({ method: 'POST', url: '/api/brand-auth/login/verify', payload: { token }, headers: existingCookie ? { cookie: existingCookie } : {} });
    if (r.statusCode !== 200) return { r };
    const cookie = cookieOf(r); const csrf = r.json().data.csrfToken;
    return { r, cookie, csrf, req: as(cookie, csrf), body: r.json().data };
  }
  async function invite(brandId, email, role, by = f.owner, path = `/api/brand-portal/members?brandId=${brandId}`) {
    return by({ method: 'POST', url: path, payload: { operationId: opId(), email, role } });
  }
  async function member(brandId, email, role) {
    await f.ok(invite(brandId, email, role));
    const s = await verify(await lastLink(email)); assert.equal(s.r.statusCode, 200, s.r.body); return s;
  }
  return { f, lastLink, verify, invite, member, as };
}

test('magic-link login: generic response, single-use, expiring, rotates the session and logout destroys it', async t => {
  const p = await portal(t); const { f } = p;
  const created = await f.ok(p.invite('brand_bloom', 'Owner@Bloom.example', 'owner'));
  assert.equal(created.status, 'invited'); assert.equal(created.invitation.simulated, true); assert.equal(created.invitation.delivered, false);
  const raw = JSON.stringify((await f.db.query('SELECT * FROM brand_members')).rows) + JSON.stringify((await f.db.query('SELECT * FROM brand_auth_outbox')).rows);
  assert(!raw.toLowerCase().includes('owner@bloom.example'), 'email encrypted at rest'); assert(!raw.includes('#invite='), 'link encrypted at rest');
  const token = await p.lastLink('owner@bloom.example'); assert(token);
  assert(!JSON.stringify((await f.db.query('SELECT * FROM brand_login_tokens')).rows).includes(token), 'only token hash stored');
  // An existing browser session is destroyed on login (rotation).
  const old = await f.request({ method: 'GET', url: '/api/session' }); const oldCookie = cookieOf(old);
  const s = await p.verify(token, oldCookie); assert.equal(s.r.statusCode, 200);
  assert.notEqual(s.cookie, oldCookie); assert.equal(s.body.role, 'owner'); assert.equal(s.body.brandId, 'brand_bloom');
  assert.equal((await f.request({ method: 'GET', url: '/api/brand-auth/me', headers: { cookie: oldCookie } })).statusCode, 401, 'old session gone');
  assert.equal((await p.verify(token)).r.statusCode, 401, 'single use');
  const me = await f.ok(s.req({ method: 'GET', url: '/api/brand-auth/me' }));
  assert.equal(me.email, 'owner@bloom.example'); assert.equal(me.role, 'owner'); assert(me.scopes.includes('members:manage'));
  // Generic response for unknown and known emails; no enumeration.
  const unknown = await f.ok(f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'nobody@nowhere.example' } }));
  const known = await f.ok(f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'owner@bloom.example' } }));
  assert.deepEqual(unknown, known);
  // Expiry
  const fresh = await p.lastLink('owner@bloom.example'); f.advance(16 / (24 * 60));
  assert.equal((await p.verify(fresh)).r.statusCode, 401, 'expired');
  // Logout requires CSRF and kills the server session.
  assert.equal((await f.request({ method: 'POST', url: '/api/brand-auth/logout', headers: { cookie: s.cookie } })).statusCode, 403);
  await f.ok(s.req({ method: 'POST', url: '/api/brand-auth/logout' }));
  assert.equal((await s.req({ method: 'GET', url: '/api/brand-auth/me' })).statusCode, 401);
  for (const bad of ['', 'x'.repeat(43), 'a'.repeat(101), '../../etc']) assert.equal((await p.verify(bad)).r.statusCode, bad.length > 100 ? 422 : 401);
});

test('link issuance is throttled per member and a newer link supersedes the older one', async t => {
  const p = await portal(t); const { f } = p;
  await f.ok(p.invite('brand_bloom', 'staff@bloom.example', 'staff'));
  const first = await p.lastLink('staff@bloom.example');
  for (let i = 0; i < 5; i++) await f.ok(f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'staff@bloom.example' }, remoteAddress: `10.0.0.${i + 2}` }));
  const issued = (await f.db.query("SELECT COUNT(*)::int AS c FROM brand_login_tokens")).rows[0].c;
  assert.equal(issued, 3, 'at most 3 links per 15 minutes');
  assert.equal((await p.verify(first)).r.statusCode, 401, 'superseded');
  assert.equal((await p.verify(await p.lastLink('staff@bloom.example'))).r.statusCode, 200);
  const limited = []; for (let i = 0; i < 7; i++) limited.push((await f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'x@y.example' } })).statusCode);
  assert(limited.includes(429), 'IP rate limit');
});

test('password login uses scrypt, locks after repeated failures and signs out other sessions on change', async t => {
  const p = await portal(t); const { f } = p;
  const s = await p.member('brand_bloom', 'fin@bloom.example', 'finance');
  assert.equal((await s.req({ method: 'PUT', url: '/api/brand-auth/password', payload: { newPassword: 'short' } })).statusCode, 422);
  await f.ok(s.req({ method: 'PUT', url: '/api/brand-auth/password', payload: { newPassword: 'correct horse battery 1' } }));
  const stored = (await f.db.query("SELECT password_hash FROM brand_members WHERE role='finance'")).rows[0].password_hash;
  assert.match(stored, /^scrypt\$16384\$8\$1\$/); assert(!stored.includes('correct horse'));
  assert.equal((await s.req({ method: 'PUT', url: '/api/brand-auth/password', payload: { newPassword: 'another password 22' } })).statusCode, 403, 'current password required');
  const login = pw => f.request({ method: 'POST', url: '/api/brand-auth/login/password', payload: { email: 'FIN@bloom.example', password: pw } });
  const good = await login('correct horse battery 1'); assert.equal(good.statusCode, 200); assert.equal(good.json().data.role, 'finance');
  const other = cookieOf(good);
  await f.ok(s.req({ method: 'PUT', url: '/api/brand-auth/password', payload: { currentPassword: 'correct horse battery 1', newPassword: 'rotated password 333' } }));
  assert.equal((await f.request({ method: 'GET', url: '/api/brand-auth/me', headers: { cookie: other } })).statusCode, 401, 'other sessions revoked');
  assert.equal((await s.req({ method: 'GET', url: '/api/brand-auth/me' })).statusCode, 200, 'current session kept');
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong password!!')).statusCode, 401);
  const locked = await login('rotated password 333'); assert.equal(locked.statusCode, 401, 'locked out');
  assert.equal(locked.json().error.code, 'INVALID_LOGIN', 'generic error');
  f.advance(16 / (24 * 60));
  assert.equal((await login('rotated password 333')).statusCode, 200, 'unlocks');
  const unknown = await f.request({ method: 'POST', url: '/api/brand-auth/login/password', payload: { email: 'ghost@x.example', password: 'whatever whatever' } });
  assert.equal(unknown.statusCode, 401); assert.equal(unknown.json().error.code, 'INVALID_LOGIN');
  assert(['brand_auth.locked', 'brand_auth.password_set', 'brand_auth.password_login'].every(a => true));
  const actions = (await f.db.query('SELECT action FROM audit_log')).rows.map(r => r.action);
  for (const a of ['brand_auth.locked', 'brand_auth.password_set', 'brand_auth.password_login', 'brand_member.invited', 'brand_auth.link_login']) assert(actions.includes(a), a);
});

test('roles: owner manages members; staff and finance get only their scopes; escalation is refused', async t => {
  const p = await portal(t); const { f } = p;
  const owner = await p.member('brand_bloom', 'owner@bloom.example', 'owner');
  await f.ok(p.invite('brand_bloom', 'staff@bloom.example', 'staff', owner.req, '/api/brand-portal/members'));
  const staff = await p.verify(await p.lastLink('staff@bloom.example'));
  await f.ok(p.invite('brand_bloom', 'fin@bloom.example', 'finance', owner.req, '/api/brand-portal/members'));
  const fin = await p.verify(await p.lastLink('fin@bloom.example'));
  const code = async (req, o) => (await req(o)).statusCode;
  // staff: catalog/orders yes; payouts/reports/members/credentials no
  assert.equal(await code(staff.req, { method: 'GET', url: '/api/brand-portal/products' }), 200);
  assert.equal(await code(staff.req, { method: 'GET', url: '/api/bags' }), 200);
  for (const url of ['/api/brand-portal/statements?month=2026-10', '/api/brand-portal/reports/annual?year=2026', '/api/brand-portal/members', '/api/finance', '/api/reports/brand-payouts', '/api/brands/brand_bloom/credentials', '/api/billing'])
    assert.equal(await code(staff.req, { method: 'GET', url }), 403, `staff ${url}`);
  // finance: payouts/reports yes; catalog/orders/members no
  assert.equal(await code(fin.req, { method: 'GET', url: '/api/brand-portal/statements?month=2026-10' }), 200);
  assert.equal(await code(fin.req, { method: 'GET', url: '/api/brand-portal/reports/annual?year=2026' }), 200);
  for (const url of ['/api/brand-portal/products', '/api/bags', '/api/brand-portal/members', '/api/onboarding/brand_bloom', '/api/brands/brand_bloom/credentials'])
    assert.equal(await code(fin.req, { method: 'GET', url }), 403, `finance ${url}`);
  assert.equal(await code(fin.req, { method: 'PUT', url: '/api/brands/brand_bloom/products/HACK', payload: { title: 'x', priceCents: 1 } }), 403);
  // escalation attempts
  assert.equal(await code(staff.req, { method: 'POST', url: '/api/brand-portal/members', payload: { operationId: opId(), email: 'evil@x.example', role: 'owner' } }), 403);
  assert.equal(await code(staff.req, { method: 'PATCH', url: `/api/brand-portal/members/${staff.body.memberId}`, payload: { role: 'owner' } }), 403);
  assert.equal(await code(fin.req, { method: 'POST', url: '/api/session/brand', payload: { brandId: 'brand_lunelle' } }), 403);
  assert.equal(await code(staff.req, { method: 'POST', url: '/api/products/x/review', payload: { decision: 'approved' } }), 403);
  // dashboard sections follow scopes
  const sd = await f.ok(staff.req({ method: 'GET', url: '/api/brand-portal/dashboard' })); assert(sd.sales && sd.listings); assert.equal(sd.upcomingPayout, undefined);
  const fd = await f.ok(fin.req({ method: 'GET', url: '/api/brand-portal/dashboard' })); assert(fd.upcomingPayout); assert.equal(fd.sales, undefined); assert.equal(fd.listings, undefined);
  // demotion takes effect immediately; last owner protected
  await f.ok(owner.req({ method: 'PATCH', url: `/api/brand-portal/members/${staff.body.memberId}`, payload: { role: 'finance' } }));
  assert.equal(await code(staff.req, { method: 'GET', url: '/api/brand-portal/products' }), 403, 'demoted live');
  assert.equal((await owner.req({ method: 'PATCH', url: `/api/brand-portal/members/${owner.body.memberId}`, payload: { role: 'staff' } })).json().error.code, 'LAST_OWNER');
  assert.equal((await owner.req({ method: 'DELETE', url: `/api/brand-portal/members/${owner.body.memberId}` })).json().error.code, 'LAST_OWNER');
  // removal kills sessions and links
  await f.ok(owner.req({ method: 'DELETE', url: `/api/brand-portal/members/${fin.body.memberId}` }));
  assert.equal(await code(fin.req, { method: 'GET', url: '/api/brand-auth/me' }), 401);
  await f.ok(f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'fin@bloom.example' } }));
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS c FROM brand_login_tokens t JOIN brand_members m ON m.id=t.member_id WHERE m.status='removed' AND t.consumed_at IS NULL")).rows[0].c, 0);
  // idempotent invite replays; duplicate member refused
  const body = { operationId: opId(), email: 'new@bloom.example', role: 'staff' };
  const a = await owner.req({ method: 'POST', url: '/api/brand-portal/members', payload: body }); const b = await owner.req({ method: 'POST', url: '/api/brand-portal/members', payload: body });
  assert.equal(a.statusCode, 200); assert.equal(b.headers['idempotent-replayed'], 'true'); assert.equal(a.json().data.id, b.json().data.id);
  assert.equal((await owner.req({ method: 'POST', url: '/api/brand-portal/members', payload: { ...body, operationId: opId() } })).statusCode, 409);
  const audit = (await f.db.query("SELECT actor,action FROM audit_log WHERE action LIKE 'brand_member.%'")).rows;
  assert(audit.some(r => r.action === 'brand_member.removed' && r.actor === `member:${owner.body.memberId}`));
  assert(audit.some(r => r.action === 'brand_member.role_changed.staff_to_finance'));
});

test('strict brand isolation across browser, API and MCP', async t => {
  const p = await portal(t); const { f } = p;
  const bloom = await p.member('brand_bloom', 'owner@bloom.example', 'owner');
  const lunelleOwner = await p.member('brand_lunelle', 'owner@lunelle.example', 'owner');
  const lunelleMember = (await f.platform.portal.listMembers('brand_lunelle'))[0];
  const lunelleProduct = (await f.domain.listProducts({ brandId: 'brand_lunelle' }))[0];
  const code = async o => (await bloom.req(o)).statusCode;
  for (const url of ['/api/brand-portal/members?brandId=brand_lunelle', '/api/brand-portal/dashboard?brandId=brand_lunelle', '/api/brand-portal/products?brandId=brand_lunelle',
    '/api/brand-portal/statements?month=2026-10&brandId=brand_lunelle', '/api/brand-portal/reports/annual?year=2026&brandId=brand_lunelle', '/api/admin/brand-auth/outbox'])
    assert.equal(await code({ method: 'GET', url }), url === '/api/admin/brand-auth/outbox' ? 404 : 403, url);
  assert.equal(await code({ method: 'PATCH', url: `/api/brand-portal/members/${lunelleMember.id}`, payload: { role: 'staff' } }), 404, 'other brand member invisible');
  assert.equal(await code({ method: 'DELETE', url: `/api/brand-portal/members/${lunelleMember.id}` }), 404);
  assert.equal(await code({ method: 'POST', url: `/api/brand-portal/products/${lunelleProduct.id}/resubmit` }), 404);
  assert.equal(await code({ method: 'POST', url: '/api/brand-portal/members?brandId=brand_lunelle', payload: { operationId: opId(), email: 'spy@x.example', role: 'owner' } }), 403);
  assert.equal((await lunelleOwner.req({ method: 'GET', url: '/api/brand-auth/me' })).statusCode, 200, 'lunelle untouched');
  // A Bloom link cannot mint a Lunelle session; same email on two brands gets per-brand links.
  await f.ok(p.invite('brand_lunelle', 'owner@bloom.example', 'staff'));
  const mails = (await f.platform.portal.outbox({})).filter(m => m.to === 'owner@bloom.example');
  assert.deepEqual([...new Set(mails.map(m => m.brandId))].sort(), ['brand_bloom', 'brand_lunelle']);
  const viaLunelle = await p.verify(linkToken(mails.find(m => m.brandId === 'brand_lunelle').body));
  assert.equal(viaLunelle.body.brandId, 'brand_lunelle'); assert.equal(viaLunelle.body.role, 'staff');
  assert.equal((await viaLunelle.req({ method: 'GET', url: '/api/brand-portal/members' })).statusCode, 403, 'staff in lunelle is not owner there');
  // Bearer credentials cannot use browser-only portal routes; MCP stays tenant-scoped.
  const cred = await f.credential('brand_bloom', ['catalog:read', 'payouts:read']);
  for (const url of ['/api/brand-portal/dashboard', '/api/brand-portal/members', '/api/brand-auth/me'])
    assert.equal((await f.bearer(cred, { method: 'GET', url })).statusCode, 403, `bearer ${url}`);
  const status = await f.tool(cred, 'get_product_review_status');
  assert(status.products.length); assert(status.products.every(p => p.id !== lunelleProduct.id)); assert.equal(status.brandId, 'brand_bloom');
  const st = await f.tool(cred, 'get_payout_statement', { month: '2026-10' }); assert.equal(st.brandId, 'brand_bloom');
  const ordersOnly = await f.credential('brand_bloom', ['orders:read']);
  assert.equal((await f.tool(ordersOnly, 'get_product_review_status')).error.code, 'INSUFFICIENT_SCOPE');
  assert.equal((await f.tool(ordersOnly, 'get_payout_statement', { month: '2026-10' })).error.code, 'INSUFFICIENT_SCOPE');
  // Forged/legacy cookies and session pinned to a removed membership are rejected.
  await f.db.query("UPDATE auth_sessions SET brand_id='brand_hearth' WHERE member_id IS NOT NULL AND brand_id='brand_bloom'");
  assert.equal((await bloom.req({ method: 'GET', url: '/api/brand-auth/me' })).statusCode, 401, 'session/member brand mismatch rejected');
});

test('invite-link sessions retain onboarding catalog access without identified owner authority', async t => {
  const { f } = await portal(t);
  const invite = await f.ok(f.owner({ method: 'POST', url: '/api/admin/onboarding/brand_hearth/invites', payload: { operationId: opId() } }));
  const accepted = await f.request({ method: 'POST', url: `/api/invites/${invite.token}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const cookie = cookieOf(accepted); const csrf = accepted.json().data.csrfToken;
  const me = await f.ok(f.request({ method: 'GET', url: '/api/brand-auth/me', headers: { cookie } }));
  assert.equal(me.role, 'invite'); assert.equal(me.session, 'invite_link');
  assert.deepEqual(me.scopes, ['catalog:read','catalog:write']);
  assert.equal((await f.request({ method: 'POST', url: '/api/brand-portal/members', headers: { cookie, 'x-csrf-token': csrf }, payload: { operationId: opId(), email: 'boss@hearth.example', role: 'owner' } })).statusCode,403);
  assert.equal((await f.request({method:'GET',url:'/api/brand-portal/products',headers:{cookie}})).statusCode,200);
  assert.equal((await f.request({ method: 'PUT', url: '/api/brand-auth/password', headers: { cookie, 'x-csrf-token': csrf }, payload: { newPassword: 'long enough password' } })).json().error.code, 'MEMBER_SESSION_REQUIRED');
});

test('product status explains compliance reasons; resubmission requires an edit and never approves', async t => {
  const p = await portal(t); const { f } = p;
  const staff = await p.member('brand_bloom', 'staff@bloom.example', 'staff');
  const put = (sku, body) => staff.req({ method: 'PUT', url: `/api/brands/brand_bloom/products/${sku}`, payload: body });
  const base = { title: 'Calm Rose Serum', description: 'This serum cures infection fast.', category: 'skin/serum', priceCents: 3200, inventoryQty: 5, images: ['https://img.example.com/r.jpg'], taxCode: 'txcd_99999999', evidence: { ingredients_inci: ['Aqua'], certifications: [], claims: [], contraindications: '' } };
  await f.ok(put('ROSE-1', base));
  let status = await f.ok(staff.req({ method: 'GET', url: '/api/brand-portal/products' }));
  let rose = status.products.find(x => x.sku === 'ROSE-1');
  assert.equal(rose.status, 'in_review'); assert.equal(rose.compliance.status, 'blocked');
  assert(rose.whatToFix.some(x => x.code === 'DISEASE_CLAIM' && /disease/i.test(x.message)));
  await f.ok(f.owner({ method: 'POST', url: `/api/products/${rose.id}/review`, payload: { decision: 'rejected', reason: 'Remove the disease claim.' } }));
  status = await f.ok(staff.req({ method: 'GET', url: '/api/brand-portal/products' })); rose = status.products.find(x => x.sku === 'ROSE-1');
  assert.equal(rose.status, 'rejected'); assert(rose.whatToFix.some(x => x.kind === 'reviewer_note' && x.message.includes('disease claim'))); assert.equal(rose.canResubmit, false);
  assert.equal((await staff.req({ method: 'POST', url: `/api/brand-portal/products/${rose.id}/resubmit` })).json().error.code, 'EDIT_REQUIRED');
  // Edit content; the product returns to review automatically and cannot be resubmitted twice.
  await f.ok(put('ROSE-1', { ...base, description: 'A soothing rose serum for daily glow.' }));
  rose = (await f.ok(staff.req({ method: 'GET', url: '/api/brand-portal/products' }))).products.find(x => x.sku === 'ROSE-1');
  assert.equal(rose.status, 'in_review'); assert.equal(rose.compliance.status, 'pass');
  assert.equal((await staff.req({ method: 'POST', url: `/api/brand-portal/products/${rose.id}/resubmit` })).json().error.code, 'NOT_RESUBMITTABLE');
  // Manually-rejected then edited via direct DB edit path → resubmit works and lands in_review, not approved.
  await f.ok(f.owner({ method: 'POST', url: `/api/products/${rose.id}/review`, payload: { decision: 'rejected', reason: 'Needs a better photo.' } }));
  await f.db.query("UPDATE products SET images='[\"https://img.example.com/r2.jpg\"]' WHERE id=$1", [rose.id]);
  const ok = await f.ok(staff.req({ method: 'POST', url: `/api/brand-portal/products/${rose.id}/resubmit` }));
  assert.equal(ok.status, 'in_review');
  assert((await f.db.query("SELECT 1 FROM audit_log WHERE action='product.resubmitted' AND resource_id=$1", [rose.id])).rows.length);
  // Staff can't resubmit via CSRF-less request
  assert.equal((await f.request({ method: 'POST', url: `/api/brand-portal/products/${rose.id}/resubmit`, headers: { cookie: staff.cookie } })).statusCode, 403);
});

test('statements and annual report are brand-scoped, finance/owner only, CSV-safe and audit-logged', async t => {
  const p = await portal(t); const { f } = p;
  const fin = await p.member('brand_lunelle', 'fin@lunelle.example', 'finance');
  const transfers = await f.domain.listTransfers({ brandId: 'brand_lunelle' });
  const month = (transfers[0]?.createdAt || new Date().toISOString()).slice(0, 7);
  const st = await f.ok(fin.req({ method: 'GET', url: `/api/brand-portal/statements?month=${month}` }));
  assert.equal(st.brandId, 'brand_lunelle'); assert.equal(st.csv, undefined, 'JSON omits csv blob');
  assert.equal(st.lines.length, transfers.filter(x => x.createdAt.slice(0, 7) === month).length);
  assert(transfers.length > 0, 'seed has lunelle transfers');
  const all = await f.db.query('SELECT brand_id FROM transfers t WHERE t.id = ANY($1)', [st.lines.map(l => l.transferId)]);
  assert(all.rows.every(r => r.brand_id === 'brand_lunelle'));
  const csv = await fin.req({ method: 'GET', url: `/api/brand-portal/statements?month=${month}&format=csv` });
  assert.equal(csv.statusCode, 200); assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['content-disposition'], /attachment/);
  assert.match(csv.body.split('\n')[0], /^transferId,bagId/);
  const annual = await f.ok(fin.req({ method: 'GET', url: `/api/brand-portal/reports/annual?year=${month.slice(0, 4)}` }));
  assert.equal(annual.report.brandId, 'brand_lunelle'); assert.equal(annual.report.connectedAccount, undefined, 'connected account ID not exposed');
  const annualCsv = await fin.req({ method: 'GET', url: `/api/brand-portal/reports/annual?year=${month.slice(0, 4)}&format=csv` });
  assert.equal(annualCsv.body.trim().split('\n').length, 2, 'one brand row only');
  for (const bad of ['month=2026-13', 'month=26-1', 'month=2026-10&format=xml', 'month=2026-10&extra=1']) assert.equal((await fin.req({ method: 'GET', url: `/api/brand-portal/statements?${bad}` })).statusCode, 422, bad);
  const actions = (await f.db.query("SELECT action,actor FROM audit_log WHERE action LIKE 'brand_report.%'")).rows;
  assert.equal(actions.length, 4); assert(actions.every(a => a.actor.startsWith('member:')));
  const { csvCell } = await import('../server/platform/brand-portal.mjs');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`); assert.equal(csvCell('-1+1'), `"'-1+1"`); assert.equal(csvCell(42), '42');
  // Raw sign-in links are not exposed over HTTP without explicit local-only opt-in.
  assert.equal((await f.owner({ method: 'GET', url: '/api/admin/brand-auth/outbox' })).statusCode, 404);
  f.advance(0); assert.ok(DAY);
});
