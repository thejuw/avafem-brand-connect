import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createAuth, hash } from '../server/auth.mjs';
import { createDatabase } from '../server/db.mjs';

const DAY = 86_400_000;
const invalid = error => error.statusCode === 401 && error.code === 'INVITE_EXPIRED';
async function fixture(t, { legacy = false } = {}) {
  const db = await createDatabase({ connectionString: null }); t.after(() => db.close());
  let ms = Date.UTC(2026, 9, 19, 12, 0, 0, 123);
  const config = { sessionSecret: 'synthetic-invite-session-secret-0001', encryptionKey: 'synthetic-invite-encryption-secret-0001', issuer: 'isolated-invite-test', clock: () => new Date(ms) };
  let legacyToken;
  if (legacy) {
    await db.query(`CREATE TABLE brand_invites(token_hash TEXT PRIMARY KEY,brand_id TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,accepted_terms_version TEXT)`);
    legacyToken = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO brand_invites(token_hash,brand_id,expires_at) VALUES($1,$2,$3)', [hash(legacyToken), 'brand_legacy', new Date(ms + DAY)]);
  }
  const auth = await createAuth(db, config);
  return { db, auth, config, legacyToken, advance: value => { ms += value; } };
}

test('new invitation is compact, signed, expiring and hashed at rest; public lookup remains minimal', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one');
  assert.match(invite.id, /^invite_[A-Za-z0-9_-]{32}$/); assert.match(invite.token, /^avfi2\.[A-Za-z0-9_-]{32}\.[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
  assert(invite.token.length <= 100, 'keep the existing Fastify token route parameter bound');
  assert.equal(invite.brandId, 'brand_one'); assert.equal(new Date(invite.expiresAt).getTime() % 1000, 0);
  const lookup = await f.auth.lookupInvite(invite.token);
  assert.deepEqual(Object.keys(lookup).sort(), ['brandId', 'expiresAt', 'id']); assert.equal(lookup.id, invite.id);
  const raw = (await f.db.query('SELECT * FROM brand_invites')).rows;
  assert.equal(raw.length, 1); assert.equal(raw[0].token_hash, hash(invite.token)); assert(!JSON.stringify(raw).includes(invite.token));
  assert.equal(raw[0].revoked_at, null); assert.equal(raw[0].consumed_at, null);
});

test('signed token tampering, malformed encodings and invalid types never authorize even a matching persisted hash', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one'), parts = invite.token.split('.');
  const badSignature = `${parts.slice(0, 3).join('.')}.${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
  await f.db.query('UPDATE brand_invites SET token_hash=$1 WHERE id=$2', [hash(badSignature), invite.id]);
  await assert.rejects(f.auth.lookupInvite(badSignature), invalid); await assert.rejects(f.auth.consumeInvite(badSignature, 'sandbox-v1'), invalid);
  await f.db.query('UPDATE brand_invites SET token_hash=$1 WHERE id=$2', [hash(invite.token), invite.id]);
  for (const token of [undefined, null, 123, {}, '', `${invite.token}.extra`, invite.token.toUpperCase(), `${parts[0]}.${parts[1]}.0${parts[2]}.${parts[3]}`,
    `${parts[0]}.${parts[1]}.ZZZ.${parts[3]}`, `${parts[0]}.${parts[1]}.${parts[2]}=.${parts[3]}`, 'x'.repeat(101)]) {
    await assert.rejects(f.auth.lookupInvite(token), invalid);
    await assert.rejects(f.auth.consumeInvite(token, 'sandbox-v1'), invalid);
  }
  assert.equal((await f.auth.lookupInvite(invite.token)).brandId, 'brand_one');
});

test('signed link binds the brand, persisted ID, issuer and exact database expiry, not only token hash', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one');
  for (const [sql, value] of [['brand_id', 'brand_two'], ['id', 'invite_corrupted'], ['expires_at', new Date(new Date(invite.expiresAt).getTime() + 1000)]]) {
    await f.db.query(`UPDATE brand_invites SET ${sql}=$1 WHERE token_hash=$2`, [value, hash(invite.token)]);
    await assert.rejects(f.auth.lookupInvite(invite.token), invalid);
    await f.db.query(`UPDATE brand_invites SET ${sql}=$1 WHERE token_hash=$2`, [sql === 'brand_id' ? 'brand_one' : sql === 'id' ? invite.id : invite.expiresAt, hash(invite.token)]);
  }
  const otherIssuer = await createAuth(f.db, { ...f.config, issuer: 'other-issuer' });
  await assert.rejects(otherIssuer.lookupInvite(invite.token), invalid);
  const otherSigningKey = await createAuth(f.db, { ...f.config, sessionSecret: 'a-different-signing-key' });
  await assert.rejects(otherSigningKey.lookupInvite(invite.token), invalid);
  assert.equal((await f.auth.lookupInvite(invite.token)).id, invite.id);
});

test('revocation is tenant-bound, idempotent and blocks preview and consumption without pretending to revoke existing sessions', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one');
  await assert.rejects(f.auth.revokeInvite('brand_two', invite.id), e => e.statusCode === 404 && e.code === 'NOT_FOUND');
  assert.equal((await f.auth.lookupInvite(invite.token)).id, invite.id);
  assert.deepEqual(await f.auth.revokeInvite('brand_one', invite.id), { id: invite.id, brandId: 'brand_one', revoked: true, replayed: false });
  assert.equal((await f.auth.revokeInvite('brand_one', invite.id)).replayed, true);
  await assert.rejects(f.auth.lookupInvite(invite.token), invalid); await assert.rejects(f.auth.consumeInvite(invite.token, 'sandbox-v1'), invalid);
  assert.equal((await f.auth.listInvites('brand_one'))[0].status, 'revoked');
  const consumed = await f.auth.createInvite('brand_one'); await f.auth.consumeInvite(consumed.token, 'sandbox-v1');
  await assert.rejects(f.auth.revokeInvite('brand_one', consumed.id), e => e.code === 'INVITE_ALREADY_USED');
});

test('replacement atomically revokes the old link and issues exactly one new signed link under concurrent resends', async t => {
  const f = await fixture(t), old = await f.auth.createInvite('brand_one'), other = await createAuth(f.db, f.config);
  const outcomes = await Promise.allSettled([f.auth.replaceInvite('brand_one', old.id), other.replaceInvite('brand_one', old.id)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'INVITE_REVOKED');
  const replacement = outcomes.find(r => r.status === 'fulfilled').value;
  assert.notEqual(replacement.id, old.id); assert.notEqual(replacement.token, old.token);
  await assert.rejects(f.auth.lookupInvite(old.token), invalid);
  assert.equal((await f.auth.lookupInvite(replacement.token)).brandId, 'brand_one');
  const rows = await f.auth.listInvites('brand_one'); assert.equal(rows.length, 2); assert.equal(rows.filter(r => r.status === 'pending').length, 1);
  assert.equal(rows.find(r => r.id === old.id).status, 'revoked');
  await assert.rejects(f.auth.replaceInvite('brand_one', old.id), e => e.code === 'INVITE_REVOKED');
});

test('replacement rejects cross-brand or consumed IDs; expired links can be replaced once but never consumed', async t => {
  const f = await fixture(t), expired = await f.auth.createInvite('brand_one');
  await assert.rejects(f.auth.replaceInvite('brand_two', expired.id), e => e.code === 'NOT_FOUND');
  f.advance(2 * DAY);
  await assert.rejects(f.auth.lookupInvite(expired.token), invalid); await assert.rejects(f.auth.consumeInvite(expired.token, 'sandbox-v1'), invalid);
  assert.equal((await f.auth.listInvites('brand_one'))[0].status, 'expired');
  const replacement = await f.auth.replaceInvite('brand_one', expired.id);
  assert.equal((await f.auth.lookupInvite(replacement.token)).id, replacement.id);
  await f.auth.consumeInvite(replacement.token, 'sandbox-v1');
  await assert.rejects(f.auth.replaceInvite('brand_one', replacement.id), e => e.code === 'INVITE_ALREADY_USED');
});

test('consume/replace and consume/revoke races cannot leave an accepted old invite plus an active replacement', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one'), other = await createAuth(f.db, f.config);
  const results = await Promise.allSettled([f.auth.consumeInvite(invite.token, 'sandbox-v1'), other.replaceInvite('brand_one', invite.id)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const listed = await f.auth.listInvites('brand_one');
  assert(!(listed.some(r => r.id === invite.id && r.status === 'consumed') && listed.some(r => r.id !== invite.id && r.status === 'pending')));
  const second = await f.auth.createInvite('brand_two');
  const revoked = await Promise.allSettled([f.auth.revokeInvite('brand_two', second.id), other.consumeInvite(second.token, 'sandbox-v1')]);
  assert.equal(revoked.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.auth.lookupInvite(second.token), invalid);
});

test('single-use acceptance remains serialized and records exact accepted terms', async t => {
  const f = await fixture(t), invite = await f.auth.createInvite('brand_one'), other = await createAuth(f.db, f.config);
  const results = await Promise.allSettled([f.auth.consumeInvite(invite.token, 'sandbox-v1'), other.consumeInvite(invite.token, 'sandbox-v1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVITE_EXPIRED');
  const raw = (await f.db.query('SELECT consumed_at,accepted_terms_version FROM brand_invites WHERE id=$1', [invite.id])).rows[0];
  assert.ok(raw.consumed_at); assert.equal(raw.accepted_terms_version, 'sandbox-v1');
  assert.equal((await f.auth.listInvites('brand_one'))[0].status, 'consumed');
});

test('a replacement insert failure rolls back old-link revocation and never issues an orphan invitation', async t => {
  const f = await fixture(t), original = await f.auth.createInvite('brand_one');
  let rejectInsert = false;
  const db = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ query: (sql, params) => {
    if (rejectInsert && /INSERT INTO brand_invites/.test(sql)) throw new Error('Synthetic insert failure');
    return tx.query(sql, params);
  } })) };
  const auth = await createAuth(db, f.config); rejectInsert = true;
  await assert.rejects(auth.replaceInvite('brand_one', original.id), /Synthetic insert failure/);
  assert.equal((await f.auth.lookupInvite(original.token)).id, original.id);
  assert.equal((await f.auth.listInvites('brand_one')).length, 1);
});

test('legacy opaque hashes are explicitly backfilled, survive restart and support revocation/replacement without raw tokens', async t => {
  const f = await fixture(t, { legacy: true });
  const lookup = await f.auth.lookupInvite(f.legacyToken);
  const expected = createHmac('sha256', f.config.sessionSecret).update('avafem:legacy-invite-id:v1\0').update(f.config.issuer).update('\0').update(hash(f.legacyToken)).digest('base64url');
  assert.equal(lookup.id, `invite_legacy_${expected}`); assert.match(lookup.id, /^invite_legacy_[A-Za-z0-9_-]{43}$/); assert.equal(lookup.brandId, 'brand_legacy');
  const restart = await createAuth(f.db, f.config);
  assert.equal((await restart.lookupInvite(f.legacyToken)).id, lookup.id);
  await restart.audit({ role: 'admin' }, 'brand.invite_legacy_reviewed', lookup.id);
  const safeLegacy = JSON.stringify(await restart.listInvites('brand_legacy')) + JSON.stringify(lookup)
    + JSON.stringify((await f.db.query('SELECT * FROM audit_log')).rows);
  for (const privateValue of [f.legacyToken, hash(f.legacyToken), f.config.sessionSecret, f.config.encryptionKey]) assert(!safeLegacy.includes(privateValue));
  const replacement = await restart.replaceInvite('brand_legacy', lookup.id);
  assert.match(replacement.token, /^avfi2\./); await assert.rejects(restart.lookupInvite(f.legacyToken), invalid);
  assert.equal((await restart.lookupInvite(replacement.token)).id, replacement.id);
  await restart.revokeInvite('brand_legacy', replacement.id); await assert.rejects(restart.lookupInvite(replacement.token), invalid);
  assert(!JSON.stringify((await f.db.query('SELECT * FROM brand_invites')).rows).includes(f.legacyToken));
  await assert.rejects(f.db.query('UPDATE brand_invites SET id=NULL WHERE id=$1', [lookup.id]), e => e.code === '23502');
});

test('invite lists contain only safe tenant metadata; signatures, token hashes, terms, keys and tokens are never listed or audited', async t => {
  const f = await fixture(t), a = await f.auth.createInvite('brand_one'), b = await f.auth.createInvite('brand_two');
  const list = await f.auth.listInvites('brand_one'); assert.equal(list.length, 1); assert.equal(list[0].brandId, 'brand_one');
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'brandId', 'expiresAt', 'consumedAt', 'revokedAt', 'status'].sort());
  const serialized = JSON.stringify(list);
  for (const value of [a.token, b.token, hash(a.token), a.token.split('.').at(-1), f.config.sessionSecret, f.config.encryptionKey]) assert(!serialized.includes(value));
  assert.deepEqual(await f.auth.listInvites('brand_missing'), []);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM audit_log')).rows[0].n, 0, 'routes provide audit events without invitation bearer material');
});

test('HTTP idempotency wrapper replays the same replacement securely rather than minting another token', async t => {
  const f = await fixture(t), old = await f.auth.createInvite('brand_one');
  const replace = () => f.auth.idempotent('admin:owner', `POST invite/${old.id}/replace`, 'invite-resend-once-0001', { inviteId: old.id }, () => f.auth.replaceInvite('brand_one', old.id));
  const first = await replace(), replay = await replace();
  assert.equal(first.statusCode, 200); assert.equal(replay.replayed, true); assert.equal(replay.data.token, first.data.token);
  assert.equal((await f.auth.listInvites('brand_one')).length, 2);
  const raw = JSON.stringify((await f.db.query('SELECT * FROM api_idempotency')).rows);
  assert(!raw.includes(first.data.token)); assert(!raw.includes(old.token));
});
