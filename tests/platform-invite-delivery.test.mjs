import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { createInviteDelivery, createResendInviteAdapter } from '../server/platform/invite-delivery.mjs';

async function fixture(t) {
  const calls = [], control = { send: async () => ({ accepted: true, id: `test_email_${calls.length}` }) };
  const adapter = { provider: 'test', simulated: true, send: async input => { calls.push(structuredClone(input)); return control.send(input); } };
  const f = await platformFixture(t, { platform: { inviteDelivery: { publicBaseUrl: 'https://invite.example.com', adapter } } });
  return { ...f, adapter, calls, control };
}
const createPath = brandId => `/api/admin/onboarding/${brandId}/invites`;
const create = (f, operationId, email = 'synthetic-recipient@example.com') => f.owner({ method: 'POST', url: createPath('brand_bloom'), payload: { operationId, email } });
const receipt = response => { assert.equal(response.statusCode, 200, response.body); return response.json().data; };
const controlled = e => e.statusCode === 502 && e.code === 'INVITE_EMAIL_UNCERTAIN' && !/PRIVATE|re_SYNTHETIC|recipient@example.com/.test(e.message);

test('default mail capabilities are unconfigured; owner can generate a signed local link without claiming an email was sent', async t => {
  const f = await platformFixture(t), brand = await f.domain.createBrand({ name: 'Synthetic no-contact brand', slug: 'synthetic-no-contact' });
  const capabilities = f.platform.inviteDelivery.capabilities(); assert.equal(capabilities.configured, false); assert.equal(capabilities.delivered, false); assert.equal(capabilities.provider, null);
  const invitation = await f.ok(f.owner({ method: 'POST', url: createPath(brand.id), payload: { operationId: 'local-only-invite-001' } }));
  assert.match(invitation.token, /^avfi2\./); assert.equal(invitation.path, `/onboard/${invitation.token}`);
  assert.equal(invitation.delivery.status, 'not_configured'); assert.equal(invitation.delivery.providerAccepted, false); assert.equal(invitation.delivery.delivered, false);
  assert.equal((await f.platform.inviteDelivery.list(brand.id)).length, 0);
});

test('configured simulated email uses the signed public HTTPS link and stores only safe delivery identifiers/HMAC', async t => {
  const f = await fixture(t), invitation = receipt(await create(f, 'email-create-once-001'));
  assert.equal(invitation.delivery.status, 'accepted'); assert.equal(invitation.delivery.simulated, true); assert.equal(invitation.delivery.providerAccepted, true); assert.equal(invitation.delivery.delivered, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].to, 'synthetic-recipient@example.com');
  assert(f.calls[0].body.includes(`https://invite.example.com/onboard/${invitation.token}`)); assert(f.calls[0].body.includes('Products remain subject to Avafem curation'));
  const listed = await f.ok(f.owner({ method: 'GET', url: createPath('brand_bloom') }));
  assert.equal(listed.capabilities.configured, true); assert.equal(listed.deliveries.length, 1); assert.equal(listed.deliveries[0].state, 'accepted');
  assert.equal(listed.invites[0].id, invitation.id); assert.equal(listed.invites[0].status, 'pending');
  const raw = JSON.stringify((await f.db.query('SELECT * FROM brand_invite_deliveries')).rows);
  for (const privateValue of [invitation.token, f.calls[0].to, f.calls[0].body, f.config.encryptionKey, f.config.sessionSecret]) {
    assert(!raw.includes(privateValue)); assert(!JSON.stringify(listed).includes(privateValue));
  }
  const idempotency = JSON.stringify((await f.db.query('SELECT * FROM api_idempotency')).rows);
  assert(!idempotency.includes(invitation.token)); assert(!idempotency.includes(f.calls[0].to));
});

test('same HTTP operation concurrent/replayed invitations send once and changed bodies cannot mint a second invite', async t => {
  const f = await fixture(t); let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.control.send = async () => { entered(); await gate; return { accepted: true, id: 'test_email_concurrent' }; };
  const first = create(f, 'email-concurrent-001');
  try {
    await started;
    const pending = await create(f, 'email-concurrent-001'); assert.equal(pending.statusCode, 409); assert.equal(pending.json().error.code, 'REQUEST_PENDING');
    assert.equal(f.calls.length, 1);
  } finally { release(); }
  const invitation = receipt(await first), replayResponse = await create(f, 'email-concurrent-001'), replay = receipt(replayResponse);
  assert.equal(replayResponse.headers['idempotent-replayed'], 'true'); assert.equal(replay.token, invitation.token); assert.equal(replay.id, invitation.id); assert.equal(f.calls.length, 1);
  const conflict = await create(f, 'email-concurrent-001', 'different@example.com'); assert.equal(conflict.statusCode, 422); assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.auth.listInvites('brand_bloom')).length, 1); assert.equal(f.calls.length, 1);
});

test('pending or unknown provider outcome never triggers a second send after direct service recreation/replay', async t => {
  const f = await fixture(t), invitation = await f.auth.createInvite('brand_bloom'); let entered, release;
  const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.control.send = async () => { entered(); await gate; throw new Error('PRIVATE SMTP response loss re_SYNTHETIC'); };
  const input = { brandId: 'brand_bloom', invite: invitation, operationId: 'email-unknown-once-001', to: 'synthetic-recipient@example.com' };
  const first = f.platform.inviteDelivery.send(input);
  const restarted = createInviteDelivery(f.db, { auth: f.auth, domain: f.domain, secret: f.config.encryptionKey, publicBaseUrl: 'https://invite.example.com', adapter: f.adapter, clock: f.clock });
  try {
    await started; const pending = await restarted.send(input); assert.equal(pending.status, 'pending'); assert.equal(pending.replayed, true); assert.equal(f.calls.length, 1);
  } finally { release(); }
  const uncertain = await first; assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.requiresReview, true); assert.equal(uncertain.delivered, false);
  const replay = await restarted.send(input); assert.equal(replay.status, 'uncertain'); assert.equal(replay.replayed, true); assert.equal(f.calls.length, 1);
  const raw = JSON.stringify((await f.db.query('SELECT * FROM brand_invite_deliveries')).rows);
  assert(!/PRIVATE|re_SYNTHETIC|synthetic-recipient/.test(raw)); assert(!raw.includes(invitation.token));
});

test('owner resend revokes the old link, sends once under HTTP concurrency, replays encrypted response and the replacement accepts a brand session', async t => {
  const f = await fixture(t), original = receipt(await create(f, 'resend-original-001'));
  const path = `${createPath('brand_bloom')}/${original.id}/resend`, payload = { operationId: 'email-resend-once-001', email: 'synthetic-recipient@example.com' };
  let entered, release; const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  f.control.send = async () => { entered(); await gate; return { accepted: true, id: 'test_email_replacement' }; };
  const first = f.owner({ method: 'POST', url: path, payload });
  try { await started; const concurrent = await f.owner({ method: 'POST', url: path, payload }); assert.equal(concurrent.statusCode, 409); assert.equal(f.calls.length, 2); }
  finally { release(); }
  const replacement = receipt(await first); assert.notEqual(replacement.token, original.token); assert.notEqual(replacement.id, original.id);
  const replay = receipt(await f.owner({ method: 'POST', url: path, payload })); assert.equal(replay.token, replacement.token); assert.equal(f.calls.length, 2);
  assert.equal((await f.request({ method: 'GET', url: `/api/onboarding/invites/${original.token}` })).statusCode, 401);
  const accept = await f.request({ method: 'POST', url: `/api/invites/${replacement.token}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(accept.statusCode, 200, accept.body); assert.equal(accept.json().data.brandId, 'brand_bloom'); assert.equal(accept.json().data.role, 'brand');
  const cookie = String(accept.headers['set-cookie']).split(';')[0];
  assert.equal((await f.request({ method: 'GET', url: '/api/admin/curation', headers: { cookie } })).statusCode, 403);
  const invites = await f.auth.listInvites('brand_bloom'); assert.equal(invites.find(i => i.id === original.id).status, 'revoked'); assert.equal(invites.find(i => i.id === replacement.id).status, 'consumed');
});

test('owner revocation, tenant/auth/CSRF restrictions and strict request schemas prevent unauthorized email actions', async t => {
  const f = await fixture(t), invitation = receipt(await create(f, 'email-for-revoke-001'));
  const revoke = `${createPath('brand_bloom')}/${invitation.id}/revoke`;
  assert.equal((await f.owner({ method: 'POST', url: `${createPath('brand_hearth')}/${invitation.id}/revoke`, payload: {} })).statusCode, 404);
  await f.ok(f.owner({ method: 'POST', url: revoke, payload: {} }));
  assert.equal((await f.request({ method: 'GET', url: `/api/onboarding/invites/${invitation.token}` })).statusCode, 401);
  assert.equal((await f.request({ method: 'POST', url: `/api/invites/${invitation.token}/accept`, payload: { acceptedSandboxTerms: true } })).statusCode, 401);
  const session = await f.auth.createSession({ brandId: 'brand_bloom' });
  const brand = o => f.request({ ...o, headers: { cookie: `avf_session=${session.token}`, 'x-csrf-token': session.csrfToken } });
  assert.equal((await brand({ method: 'POST', url: createPath('brand_bloom'), payload: { operationId: 'unauthorized-send-001' } })).statusCode, 403);
  assert.equal((await brand({ method: 'GET', url: createPath('brand_bloom') })).statusCode, 403);
  const credential = await f.credential('brand_bloom', ['catalog:read', 'catalog:write']);
  assert.equal((await f.bearer(credential, { method: 'POST', url: createPath('brand_bloom'), payload: { operationId: 'bearer-send-001' } })).statusCode, 403);
  assert.equal((await f.owner({ method: 'POST', url: createPath('brand_bloom'), headers: { 'x-csrf-token': 'wrong' }, payload: { operationId: 'csrf-email-001' } })).statusCode, 403);
  assert.equal((await f.owner({ method: 'POST', url: createPath('brand_bloom'), payload: { operationId: 'injected-email-001', url: 'https://private.internal', apiKey: 'PRIVATE' } })).statusCode, 422);
  assert.equal(f.calls.length, 1);
});

test('delivery validates authoritative invite identity and blocks reused operations with changed brand/recipient', async t => {
  const f = await fixture(t), invitation = await f.auth.createInvite('brand_bloom'), foreign = await f.auth.createInvite('brand_hearth');
  const input = { brandId: 'brand_bloom', invite: invitation, operationId: 'direct-delivery-001', to: 'synthetic-recipient@example.com' };
  await assert.rejects(f.platform.inviteDelivery.send({ ...input, invite: { ...foreign, brandId: 'brand_bloom' } }), e => e.code === 'INVITE_BRAND_MISMATCH');
  await assert.rejects(f.platform.inviteDelivery.send({ ...input, invite: { ...invitation, id: foreign.id } }), e => e.code === 'INVITE_BRAND_MISMATCH');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.platform.inviteDelivery.send(input)).status, 'accepted');
  await assert.rejects(f.platform.inviteDelivery.send({ ...input, to: 'different@example.com' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.calls.length, 1);
});

test('external delivery requires explicit opt-in and a safe public HTTPS origin; no fallback fake acceptance', async t => {
  const f = await fixture(t); let calls = 0;
  const adapter = { provider: 'test-external', simulated: false, send: async () => { calls++; return { accepted: true, id: 'unused' }; } };
  const options = { auth: f.auth, domain: f.domain, secret: f.config.encryptionKey, publicBaseUrl: 'https://invite.example.com', adapter };
  assert.equal(createInviteDelivery(f.db, options).capabilities().configured, false);
  assert.equal(createInviteDelivery(f.db, { ...options, allowExternal: true }).capabilities().configured, true);
  for (const publicBaseUrl of [undefined, 'http://invite.example.com', 'https://127.0.0.1', 'https://localhost', 'https://private.internal', 'https://u:p@invite.example.com',
    'https://invite.example.com:8443', 'https://invite.example.com/path', 'https://invite.example.com/?token=PRIVATE', 'https://invite.example.com/#fragment'])
    assert.equal(createInviteDelivery(f.db, { ...options, allowExternal: true, publicBaseUrl }).capabilities().configured, false);
  assert.equal(calls, 0);
});

test('Resend transport uses only its fixed endpoint, configured sender, bearer header and stable provider idempotency', async () => {
  const calls = [], apiKey = 're_SYNTHETIC_SECRET';
  const adapter = createResendInviteAdapter({ apiKey, from: 'invite-sender@example.com', fetch: async (url, init) => {
    calls.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ id: 'resend_native_receipt' }) };
  } });
  assert.equal(adapter.simulated, false); assert.equal(adapter.provider, 'resend');
  assert.deepEqual(await adapter.send({ to: 'recipient@example.com', subject: 'Synthetic invite', body: 'Synthetic body', operationId: 'provider-once-001' }), { id: 'resend_native_receipt', accepted: true });
  assert.equal(calls.length, 1); const { url, init } = calls[0];
  assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert(init.signal instanceof AbortSignal);
  assert.equal(init.headers.authorization, `Bearer ${apiKey}`); assert.equal(init.headers['Idempotency-Key'], 'avafem-invite:provider-once-001');
  assert.deepEqual(JSON.parse(init.body), { from: 'invite-sender@example.com', to: ['recipient@example.com'], subject: 'Synthetic invite', text: 'Synthetic body' });
  assert.equal(createResendInviteAdapter({ from: 'sender@example.com' }), null); assert.equal(createResendInviteAdapter({ apiKey, from: 'invalid' }), null);
});

test('Resend transport errors, read errors, rejected/malformed/oversized responses surface only safe uncertainty', async () => {
  for (const fetch of [async () => { throw new Error('PRIVATE re_SYNTHETIC recipient@example.com'); }, async () => ({ ok: false }),
    async () => ({ ok: true, text: async () => { throw new Error('PRIVATE raw response'); } }),
    async () => ({ ok: true, text: async () => 'PRIVATE malformed JSON' }), async () => ({ ok: true, text: async () => JSON.stringify({ error: 'PRIVATE' }) }),
    async () => ({ ok: true, text: async () => 'x'.repeat(16_385) }), async () => ({ ok: true, text: async () => JSON.stringify({ id: 'PRIVATE unsafe/id' }) })]) {
    const adapter = createResendInviteAdapter({ apiKey: 're_SYNTHETIC_SECRET', from: 'sender@example.com', fetch });
    await assert.rejects(adapter.send({ to: 'recipient@example.com', subject: 'Synthetic', body: 'Synthetic', operationId: 'provider-error-001' }), controlled);
  }
});
