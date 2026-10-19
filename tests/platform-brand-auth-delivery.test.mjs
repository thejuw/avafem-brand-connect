import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { authLinkOrigin, createBrandAuthDelivery, createResendAuthAdapter } from '../server/platform/brand-auth-delivery.mjs';

const domainId = '12345678-1234-1234-1234-123456789012';
const proof = () => ({ id: domainId, name: 'mail.example.com', status: 'verified', capabilities: { sending: 'enabled' }, click_tracking: false,
  records: [{ record: 'SPF', status: 'verified' }, { record: 'SPF', status: 'verified' }, { record: 'DKIM', status: 'verified' }] });
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });
const adapterOptions = { apiKey: 're_SYNTHETIC_NOT_A_REAL_KEY', from: 'auth@mail.example.com', domainId };

test('auth mail adapter requires verified sending domain, SPF, DKIM and no link tracking; secrets only go to fixed HTTPS endpoints', async () => {
  const calls = []; let domain = proof();
  const adapter = createResendAuthAdapter({ ...adapterOptions, fetch: async (url, options) => { calls.push({ url, ...options }); return response(options.method === 'GET' ? domain : { id: 'synthetic_receipt_1' }); } });
  assert.equal(await adapter.checkDomain(), true);
  for (const mutate of [d => { d.status = 'pending'; }, d => { d.name = 'other.example.com'; }, d => { d.records = []; }, d => { d.records[0].status = 'pending'; }, d => { d.click_tracking = true; }, d => { d.capabilities.sending = 'disabled'; }]) {
    domain = proof(); mutate(domain); assert.equal(await adapter.checkDomain(), false);
  }
  assert.deepEqual(await adapter.send({ to: 'synthetic@example.com', body: 'Synthetic message', subject: 'Synthetic sign in', operationId: 'bmail_test_once' }), { accepted: true, id: 'synthetic_receipt_1' });
  assert(calls.every(c => c.url.startsWith('https://api.resend.com/')));
  assert(calls.every(c => c.redirect === 'error' && c.signal instanceof AbortSignal));
  assert.equal(calls.at(-1).headers['Idempotency-Key'], 'avafem-invite:brand-auth:bmail_test_once');
  assert.equal(createResendAuthAdapter({ ...adapterOptions, domainId: '../emails' }), null);
  assert.equal(createResendAuthAdapter({ ...adapterOptions, from: 'Name <auth@mail.example.com>' }), null);
});

test('auth link origins reject insecure, credentialled, IP, path and reserved-local destinations', () => {
  assert.equal(authLinkOrigin('https://portal.example.com'), 'https://portal.example.com');
  for (const v of ['http://portal.example.com', 'https://127.0.0.1', 'https://localhost', 'https://internal', 'https://portal.local', 'https://portal.invalid', 'https://portal.test', 'https://portal.example', 'https://user:pass@portal.example.com', 'https://portal.example.com/path', 'https://portal.example.com?x=1', 'https://portal.example.com#token=x', 'https://portal.example.com:444']) assert.equal(authLinkOrigin(v), null, v);
});

async function fixture(t, extra = {}) {
  const calls = [], control = { domain: true, send: async () => ({ id: 'synthetic_accepted', accepted: true }) };
  const adapter = { provider: 'synthetic', simulated: true, checkDomain: async () => control.domain, send: async input => { calls.push(input); return control.send(input); } };
  const f = await platformFixture(t, { platform: { publicBaseUrl: 'https://portal.example.com', portalEmail: { adapter }, ...extra } });
  const invite = async email => f.platform.portal.addMember('brand_bloom', { email, role: 'owner' }, { role: 'admin', owner: true });
  return { ...f, calls, control, adapter, invite };
}

test('default/local-only email makes no calls even when an external adapter is supplied without opt-in', async t => {
  const f = await fixture(t); let calls = 0;
  const external = { provider: 'forbidden', simulated: false, checkDomain: async () => { calls++; throw new Error('Forbidden provider'); }, send: async () => { calls++; throw new Error('Forbidden provider'); } };
  const service = await createBrandAuthDelivery(f.db, { auth: f.auth, publicBaseUrl: 'https://portal.example.com', adapter: external });
  await f.invite('synthetic-local@example.com');
  assert.equal(service.capabilities().configured, false);
  assert.equal((await service.run()).status, 'not_configured'); assert.equal(calls, 0);
  assert.equal((await f.db.query('SELECT * FROM brand_auth_deliveries')).rows.length, 0);
});

test('queued auth email dispatch is outside login HTTP, once across concurrent workers; accepted is never delivered', async t => {
  const f = await fixture(t);
  await f.invite('synthetic-auth@example.com');
  const req = await f.request({ method: 'POST', url: '/api/brand-auth/login/request', payload: { email: 'synthetic-auth@example.com' } });
  assert.equal(req.statusCode, 200); assert.equal(f.calls.length, 0, 'login makes no provider call');
  const runs = await Promise.all([f.platform.portalDelivery.run(), f.platform.portalDelivery.run()]);
  assert.equal(f.calls.length, 1, 'superseded invitation skipped; newest link dispatched once');
  assert.equal(runs.reduce((n, r) => n + r.providerAccepted, 0), 1); assert(runs.every(r => r.delivered === false && r.simulated === true));
  assert(f.calls[0].body.includes('https://portal.example.com/brand/login#'));
  assert.equal((await f.platform.portalDelivery.run()).dispatched, 0);
  const records = JSON.stringify((await f.db.query('SELECT * FROM brand_auth_deliveries')).rows);
  assert(!records.includes('synthetic-auth@example.com')); assert(!records.includes('#token='));
});

test('unverified DNS is fail-closed; removed/expired/bad-origin links cannot be dispatched and unknown outcomes are not replayed', async t => {
  const f = await fixture(t);
  const member = await f.invite('synthetic-expired@example.com');
  f.control.domain = false;
  assert.equal((await f.platform.portalDelivery.run()).status, 'domain_unverified'); assert.equal(f.calls.length, 0);
  f.control.domain = true; f.advance(16 / 1440);
  assert.equal((await f.platform.portalDelivery.run()).dispatched, 0);
  await f.platform.portal.addMember('brand_bloom', { email: 'synthetic-stale@example.com', role: 'staff' }, { role: 'admin', owner: true });
  await f.db.query("UPDATE brand_members SET status='removed' WHERE email_key IN (SELECT email_key FROM brand_members WHERE id<>$1)", [member.id]);
  assert.equal((await f.platform.portalDelivery.run()).dispatched, 0);
  await f.invite('synthetic-origin@example.com');
  const mails = (await f.db.query('SELECT id,body_enc FROM brand_auth_outbox ORDER BY created_at DESC')).rows;
  const newest = mails[0];
  await f.db.query('UPDATE brand_auth_outbox SET body_enc=$2 WHERE id=$1', [newest.id, f.auth.encrypt(f.auth.decrypt(newest.body_enc).replace('https://portal.example.com', 'https://attacker.example.com'))]);
  assert.equal((await f.platform.portalDelivery.run()).dispatched, 0);
  await f.invite('synthetic-uncertain@example.com');
  f.control.send = async () => { throw new Error('Synthetic provider response loss with private details'); };
  const uncertain = await f.platform.portalDelivery.run(); assert.equal(uncertain.dispatched, 1); assert.equal(uncertain.providerAccepted, 0); assert.equal(uncertain.delivered, false);
  assert.equal((await f.platform.portalDelivery.run()).dispatched, 0, 'no retry after uncertain response');
  assert.equal(f.calls.length, 1);
  const row = (await f.db.query("SELECT * FROM brand_auth_deliveries WHERE state='uncertain'")).rows[0];
  assert.equal(row.error_code, 'AUTH_EMAIL_UNCERTAIN'); assert(!JSON.stringify(row).includes('private details'));
});

test('batch delivery rechecks removed membership immediately before each message dispatch', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const a = await f.invite('synthetic-first@example.com');
  f.advance(1 / 86400);
  const b = await f.platform.portal.addMember('brand_bloom', { email: 'synthetic-next@example.com', role: 'staff' }, { owner: true, role: 'admin' });
  let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.control.send = async () => { entered(); await gate; return { accepted: true, id: 'synthetic_receipt' }; };
  const pending = f.platform.portalDelivery.run();
  try {
    await Promise.race([started, pending.then(() => { throw new Error('Expected the first synthetic send to start.'); })]);
    await f.platform.portal.removeMember('brand_bloom', b.id, { owner: true, role: 'admin' });
  } finally { release(); }
  const result = await pending;
  assert.equal(result.dispatched, 1); assert.equal(result.providerAccepted, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].to, 'synthetic-first@example.com');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM brand_auth_deliveries WHERE state='expired'")).rows[0].n, 1);
  assert.equal(a.status, 'invited'); // no real member identity or provider used
});
