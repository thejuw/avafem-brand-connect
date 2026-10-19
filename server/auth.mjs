import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const BRAND_SCOPES = ['catalog:read', 'catalog:write', 'orders:read', 'orders:fulfill', 'payouts:read', 'refunds:write'];
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
const random = (size = 32) => randomBytes(size).toString('base64url');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export async function createAuth(db, { sessionSecret, encryptionKey, issuer = 'avafem-local', clock = () => new Date() }) {
  if (!sessionSecret || !encryptionKey) throw new Error('Authentication secrets are required.');
  const encryption = createHash('sha256').update(encryptionKey).digest();
  const schema = `CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, owner BOOLEAN NOT NULL DEFAULT false, brand_id TEXT,
    csrf_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ); CREATE TABLE IF NOT EXISTS api_credentials (
    id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, kind TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
    scopes JSONB NOT NULL, label TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ
  ); CREATE TABLE IF NOT EXISTS brand_invites (
    token_hash TEXT PRIMARY KEY, brand_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ, accepted_terms_version TEXT
  ); CREATE TABLE IF NOT EXISTS api_idempotency (
    brand_id TEXT NOT NULL, endpoint TEXT NOT NULL, key_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', response JSONB,
    status_code INT, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(brand_id,endpoint,key_hash)
  ); CREATE TABLE IF NOT EXISTS brand_rate_limits (
    brand_id TEXT PRIMARY KEY, tokens DOUBLE PRECISION NOT NULL, updated_ms DOUBLE PRECISION NOT NULL
  ); CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY, actor TEXT, brand_id TEXT, action TEXT NOT NULL,
    resource_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  for (const statement of schema.split(';').filter(part => part.trim())) await db.query(statement);
  // Preserve older opaque invitation rows. Domain-separated opaque IDs permit
  // revocation/history without exposing either bearer tokens or their hashes.
  await db.transaction(async tx => {
    await tx.query('ALTER TABLE brand_invites ADD COLUMN IF NOT EXISTS id TEXT');
    await tx.query('ALTER TABLE brand_invites ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ');
    while (true) {
      const legacy = (await tx.query('SELECT token_hash FROM brand_invites WHERE id IS NULL LIMIT 100 FOR UPDATE')).rows;
      if (!legacy.length) break;
      for (const row of legacy) {
        const opaque = createHmac('sha256', sessionSecret).update('avafem:legacy-invite-id:v1\0').update(issuer).update('\0').update(row.token_hash).digest('base64url');
        await tx.query('UPDATE brand_invites SET id=$1 WHERE token_hash=$2 AND id IS NULL', [`invite_legacy_${opaque}`, row.token_hash]);
      }
    }
    await tx.query('CREATE UNIQUE INDEX IF NOT EXISTS brand_invites_id_unique ON brand_invites(id)');
    await tx.query('ALTER TABLE brand_invites ALTER COLUMN id SET NOT NULL');
  });
  const now = () => clock().getTime();
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const sign = body => createHmac('sha256', sessionSecret).update(body).digest('base64url');

  function encrypt(value) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryption, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
  }
  function decrypt(value) {
    const [iv, tag, data] = value.split('.').map(x => Buffer.from(x, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', encryption, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString());
  }
  async function createSession({ owner = false, brandId = null } = {}) {
    const token = random(); const csrfToken = random(); const expiresAt = new Date(now() + 12 * 3600_000);
    await db.query('INSERT INTO auth_sessions(token_hash,owner,brand_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5)', [hash(token), owner, brandId, csrfToken, expiresAt]);
    return { token, csrfToken, owner, brandId, role: brandId ? 'brand' : owner ? 'admin' : 'brand', expiresAt };
  }
  async function resolveSession(token) {
    if (!token) return null;
    const { rows } = await db.query('SELECT * FROM auth_sessions WHERE token_hash=$1 AND expires_at>$2', [hash(token), new Date(now())]);
    const row = rows[0];
    return row ? { tokenHash: row.token_hash, csrfToken: row.csrf_token, owner: row.owner, brandId: row.brand_id,
      role: row.brand_id ? 'brand' : row.owner ? 'admin' : 'brand', scopes: BRAND_SCOPES, expiresAt: row.expires_at } : null;
  }
  async function switchBrand(session, brandId) {
    if (!session?.owner) throw fail(403, 'OWNER_REQUIRED', 'Only the workspace owner can change the preview workspace.');
    await db.query('UPDATE auth_sessions SET brand_id=$1 WHERE token_hash=$2', [brandId, session.tokenHash]);
  }
  function validateScopes(scopes) {
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => !BRAND_SCOPES.includes(s)))
      throw fail(422, 'INVALID_SCOPES', 'Choose one or more supported brand scopes.');
    return [...new Set(scopes)];
  }
  async function createCredential(brandId, { kind = 'api_key', scopes = BRAND_SCOPES, label = 'Brand integration' } = {}) {
    scopes = validateScopes(scopes);
    if (!['api_key', 'oauth_client'].includes(kind)) throw fail(422, 'INVALID_CREDENTIAL_KIND', 'Choose api_key or oauth_client.');
    const id = `client_${random(15)}`;
    const secret = kind === 'api_key' ? `avf_test_${random()}` : random();
    await db.query('INSERT INTO api_credentials(id,brand_id,kind,secret_hash,scopes,label) VALUES($1,$2,$3,$4,$5,$6)',
      [id, brandId, kind, hash(secret), JSON.stringify(scopes), String(label).slice(0, 100)]);
    return { id, brandId, kind, scopes, label, ...(kind === 'api_key' ? { apiKey: secret } : { clientId: id, clientSecret: secret }) };
  }
  async function listCredentials(brandId) {
    const { rows } = await db.query('SELECT id,brand_id,kind,scopes,label,active,created_at,last_used_at FROM api_credentials WHERE brand_id=$1 ORDER BY created_at DESC', [brandId]);
    return rows.map(r => ({ id: r.id, brandId: r.brand_id, kind: r.kind, scopes: r.scopes, label: r.label, active: r.active, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }
  async function revokeCredential(brandId, id) {
    const result = await db.query('UPDATE api_credentials SET active=false WHERE id=$1 AND brand_id=$2 RETURNING id', [id, brandId]);
    if (!result.rows.length) throw fail(404, 'NOT_FOUND', 'Credential not found.');
    return { id, revoked: true };
  }
  async function issueToken(clientId, secret, requestedScope) {
    const { rows } = await db.query("SELECT * FROM api_credentials WHERE id=$1 AND kind='oauth_client' AND active=true", [clientId]);
    const client = rows[0];
    if (!client || !same(client.secret_hash, hash(secret))) throw fail(401, 'invalid_client', 'Invalid client credentials.');
    const scopes = requestedScope ? String(requestedScope).split(/\s+/).filter(Boolean) : client.scopes;
    if (scopes.some(s => !client.scopes.includes(s))) throw fail(400, 'invalid_scope', 'Requested scope exceeds this client’s access.');
    const seconds = Math.floor(now() / 1000);
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode({ iss: issuer, aud: 'avafem-brand-api', sub: client.id, brand_id: client.brand_id,
      scope: scopes.join(' '), iat: seconds, exp: seconds + 3600, jti: random(15) });
    return { access_token: `${header}.${body}.${sign(`${header}.${body}`)}`, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') };
  }
  async function resolveBearer(value) {
    if (!value) return null;
    let row; let scopes;
    if (value.startsWith('avf_test_')) {
      row = (await db.query("SELECT * FROM api_credentials WHERE secret_hash=$1 AND kind='api_key' AND active=true", [hash(value)])).rows[0];
      scopes = row?.scopes;
    } else {
      try {
        const parts = value.split('.'); if (parts.length !== 3 || !same(sign(`${parts[0]}.${parts[1]}`), parts[2])) return null;
        const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
        if (header.alg !== 'HS256' || claims.iss !== issuer || claims.aud !== 'avafem-brand-api'
          || !Number.isFinite(claims.exp) || claims.exp <= now() / 1000 || claims.iat > now() / 1000 + 30) return null;
        row = (await db.query("SELECT * FROM api_credentials WHERE id=$1 AND kind='oauth_client' AND active=true", [claims.sub])).rows[0];
        scopes = String(claims.scope).split(' ');
        if (!row || row.brand_id !== claims.brand_id || scopes.some(s => !row.scopes.includes(s))) return null;
      } catch { return null; }
    }
    if (!row) return null;
    await db.query('UPDATE api_credentials SET last_used_at=$1 WHERE id=$2', [new Date(now()), row.id]);
    return { brandId: row.brand_id, credentialId: row.id, role: 'brand', scopes, bearer: true };
  }
  const inviteError = () => fail(401, 'INVITE_EXPIRED', 'This invitation is invalid, expired, revoked or already used.');
  const validInviteBrand = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const inviteSignature = (body, brandId) => createHmac('sha256', sessionSecret)
    .update('avafem:brand-invite:v2\0').update(issuer).update('\0').update(brandId).update('\0').update(body).digest('base64url');
  function inviteClaims(token) {
    if (typeof token !== 'string' || token.length > 100) throw inviteError();
    if (!token.startsWith('avfi2.')) {
      // Existing invitations were exactly 32 random bytes encoded base64url.
      // They remain usable only while their exact persisted hash is active.
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw inviteError();
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 4 || !/^[A-Za-z0-9_-]{32}$/.test(parts[1]) || !/^[0-9a-z]{1,10}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) throw inviteError();
    const expires = Number.parseInt(parts[2], 36);
    if (!Number.isSafeInteger(expires) || expires.toString(36) !== parts[2] || expires * 1000 <= now()) throw inviteError();
    return { id: `invite_${parts[1]}`, expiresAt: expires * 1000, body: parts.slice(0, 3).join('.'), signature: parts[3] };
  }
  function checkInvite(invite, claims) {
    const expires = new Date(invite?.expires_at).getTime();
    if (!invite || invite.consumed_at || invite.revoked_at || !Number.isFinite(expires) || expires <= now()
      || (claims && (invite.id !== claims.id || expires !== claims.expiresAt || !validInviteBrand(invite.brand_id)
        || !same(inviteSignature(claims.body, invite.brand_id), claims.signature)))) throw inviteError();
    return invite;
  }
  function newInvite(brandId) {
    if (!validInviteBrand(brandId)) throw fail(422, 'INVALID_BRAND', 'A valid brand identity is required.');
    const nonce = random(24), expires = Math.floor(now() / 1000) + 48 * 3600;
    const body = `avfi2.${nonce}.${expires.toString(36)}`;
    return { id: `invite_${nonce}`, token: `${body}.${inviteSignature(body, brandId)}`, brandId, expiresAt: new Date(expires * 1000) };
  }
  const insertInvite = (tx, invite) => tx.query('INSERT INTO brand_invites(id,token_hash,brand_id,expires_at) VALUES($1,$2,$3,$4)',
    [invite.id, hash(invite.token), invite.brandId, invite.expiresAt]);
  async function createInvite(brandId) {
    const invite = newInvite(brandId);
    await insertInvite(db, invite);
    return invite;
  }
  async function lookupInvite(token) {
    const claims = inviteClaims(token);
    return db.transaction(async tx => {
      const invite = checkInvite((await tx.query('SELECT * FROM brand_invites WHERE token_hash=$1 FOR UPDATE', [hash(token)])).rows[0], claims);
      return { id: invite.id, brandId: invite.brand_id, expiresAt: invite.expires_at };
    });
  }
  async function consumeInvite(token, acceptedTermsVersion) {
    const claims = inviteClaims(token);
    return db.transaction(async tx => {
      const invite = checkInvite((await tx.query('SELECT * FROM brand_invites WHERE token_hash=$1 FOR UPDATE', [hash(token)])).rows[0], claims);
      await tx.query('UPDATE brand_invites SET consumed_at=$1,accepted_terms_version=$2 WHERE id=$3', [new Date(now()), acceptedTermsVersion, invite.id]);
      return { id: invite.id, brandId: invite.brand_id };
    });
  }
  async function listInvites(brandId) {
    const invites = (await db.query('SELECT id,brand_id,expires_at,consumed_at,revoked_at FROM brand_invites WHERE brand_id=$1 ORDER BY expires_at DESC,id LIMIT 100', [brandId])).rows;
    return invites.map(invite => ({ id: invite.id, brandId: invite.brand_id, expiresAt: invite.expires_at, consumedAt: invite.consumed_at,
      revokedAt: invite.revoked_at, status: invite.consumed_at ? 'consumed' : invite.revoked_at ? 'revoked' : new Date(invite.expires_at).getTime() <= now() ? 'expired' : 'pending' }));
  }
  async function revokeInvite(brandId, inviteId) {
    return db.transaction(async tx => {
      const invite = (await tx.query('SELECT * FROM brand_invites WHERE brand_id=$1 AND id=$2 FOR UPDATE', [brandId, inviteId])).rows[0];
      if (!invite) throw fail(404, 'NOT_FOUND', 'Invitation not found.');
      if (invite.consumed_at) throw fail(409, 'INVITE_ALREADY_USED', 'This invitation was already accepted; revoking an invitation does not end an existing session.');
      if (!invite.revoked_at) await tx.query('UPDATE brand_invites SET revoked_at=$1 WHERE id=$2', [new Date(now()), invite.id]);
      return { id: invite.id, brandId, revoked: true, replayed: Boolean(invite.revoked_at) };
    });
  }
  async function replaceInvite(brandId, inviteId) {
    return db.transaction(async tx => {
      const previous = (await tx.query('SELECT * FROM brand_invites WHERE brand_id=$1 AND id=$2 FOR UPDATE', [brandId, inviteId])).rows[0];
      if (!previous) throw fail(404, 'NOT_FOUND', 'Invitation not found.');
      if (previous.consumed_at) throw fail(409, 'INVITE_ALREADY_USED', 'An accepted invitation cannot be resent.');
      if (previous.revoked_at) throw fail(409, 'INVITE_REVOKED', 'This invitation was already revoked or replaced; use the recorded replacement rather than issuing another.');
      const replacement = newInvite(brandId);
      await tx.query('UPDATE brand_invites SET revoked_at=$1 WHERE id=$2', [new Date(now()), previous.id]);
      await insertInvite(tx, replacement);
      return replacement;
    });
  }
  async function rateLimit(brandId) {
    const ms = now();
    await db.transaction(async tx => {
      await tx.query('INSERT INTO brand_rate_limits(brand_id,tokens,updated_ms) VALUES($1,30,$2) ON CONFLICT DO NOTHING', [brandId, ms]);
      const row = (await tx.query('SELECT * FROM brand_rate_limits WHERE brand_id=$1 FOR UPDATE', [brandId])).rows[0];
      const available = Math.min(30, Number(row.tokens) + Math.max(0, ms - Number(row.updated_ms)) / 100);
      if (available < 1) throw fail(429, 'RATE_LIMITED', 'Brand rate limit exceeded. Retry in one second.');
      await tx.query('UPDATE brand_rate_limits SET tokens=$1,updated_ms=$2 WHERE brand_id=$3', [available - 1, ms, brandId]);
    });
  }
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  async function idempotent(brandId, endpoint, key, body, handler) {
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key of 1–200 characters is required.');
    const keyHash = hash(key); const requestHash = hash(JSON.stringify(stable(body ?? {})));
    const existing = await db.transaction(async tx => {
      await tx.query('DELETE FROM api_idempotency WHERE brand_id=$1 AND endpoint=$2 AND key_hash=$3 AND expires_at<=$4', [brandId, endpoint, keyHash, new Date(now())]);
      const inserted = await tx.query(`INSERT INTO api_idempotency(brand_id,endpoint,key_hash,request_hash,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING key_hash`, [brandId, endpoint, keyHash, requestHash, new Date(now() + 24 * 3600_000)]);
      if (inserted.rows.length) return null;
      return (await tx.query('SELECT * FROM api_idempotency WHERE brand_id=$1 AND endpoint=$2 AND key_hash=$3', [brandId, endpoint, keyHash])).rows[0];
    });
    if (existing) {
      if (existing.request_hash !== requestHash) throw fail(422, 'IDEMPOTENCY_CONFLICT', 'This key was already used with a different request body.');
      if (existing.state !== 'complete') throw fail(409, 'REQUEST_PENDING', 'This request is pending reconciliation. Do not create a second operation.');
      const response = existing.response?.encryptedResponse ? decrypt(existing.response.encryptedResponse) : existing.response;
      return { ...response, replayed: true };
    }
    let outcome;
    try { outcome = { statusCode: 200, data: await handler() }; }
    catch (error) { outcome = { statusCode: error.statusCode || 500, error: { code: error.code || 'INTERNAL_ERROR', message: error.statusCode ? error.message : 'The operation failed. Its outcome requires review.' } }; }
    await db.query("UPDATE api_idempotency SET state='complete',response=$1,status_code=$2 WHERE brand_id=$3 AND endpoint=$4 AND key_hash=$5", [JSON.stringify({ encryptedResponse: encrypt(outcome) }), outcome.statusCode, brandId, endpoint, keyHash]);
    return outcome;
  }
  async function audit(context, action, resourceId = null) {
    await db.query('INSERT INTO audit_log(actor,brand_id,action,resource_id) VALUES($1,$2,$3,$4)', [context?.credentialId || context?.role || 'system', context?.brandId || null, action, resourceId]);
  }
  // Protect earlier cached responses before serving a persisted workspace again.
  while (true) {
    const changed = await db.transaction(async tx => {
      const old = (await tx.query("SELECT brand_id,endpoint,key_hash,response FROM api_idempotency WHERE response IS NOT NULL AND NOT (response ? 'encryptedResponse') LIMIT 100 FOR UPDATE")).rows;
      for (const row of old) await tx.query('UPDATE api_idempotency SET response=$1 WHERE brand_id=$2 AND endpoint=$3 AND key_hash=$4', [JSON.stringify({ encryptedResponse: encrypt(row.response) }), row.brand_id, row.endpoint, row.key_hash]);
      return old.length;
    });
    if (!changed) break;
  }
  return { createSession, resolveSession, switchBrand, createCredential, listCredentials, revokeCredential,
    issueToken, resolveBearer, createInvite, lookupInvite, consumeInvite, listInvites, revokeInvite, replaceInvite, rateLimit, idempotent, audit, encrypt, decrypt };
}

export function requireScope(context, scope) {
  if (!context || !context.brandId || !context.scopes?.includes(scope)) throw fail(403, 'INSUFFICIENT_SCOPE', `Required scope: ${scope}`);
}

export function requireAdmin(context) {
  if (!context?.owner || context.brandId) throw fail(403, 'ADMIN_REQUIRED', 'This action requires the operations workspace.');
}
