import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { hash } from './auth.mjs';
import { normalizeShop, createShopifyAdapter } from './integrations/shopify.mjs';
import { requestedShopifyScopes, missingShopifyScopes } from './integrations/shopify-policy.mjs';

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const equal = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
const connectionView = row => row ? ({ brandId: row.brand_id, shop: row.shop, status: row.status,
  grantedScopes: row.granted_scopes, installedAt: row.installed_at, disconnectedAt: row.disconnected_at,
  accessExpiresAt: row.access_expires_at, authMode: 'offline_authorization_code' }) : null;

/** Durable per-brand offline OAuth. No token material is ever returned by a browser route. */
export async function createShopifyConnections(db, auth, config = {}) {
  const env = config.env ?? process.env;
  const clientId = config.clientId ?? env.SHOPIFY_OAUTH_CLIENT_ID;
  const clientSecret = config.clientSecret ?? env.SHOPIFY_OAUTH_CLIENT_SECRET;
  const baseUrl = config.publicBaseUrl ?? env.PUBLIC_BASE_URL;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const clock = config.clock ?? (() => new Date());
  const scopes = Object.freeze([...requestedShopifyScopes(config.scopes)]);
  const schema = `CREATE TABLE IF NOT EXISTS shopify_connections (
    brand_id TEXT PRIMARY KEY REFERENCES brands(id), shop TEXT NOT NULL UNIQUE,
    token_encrypted TEXT, granted_scopes JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL,
    access_expires_at TIMESTAMPTZ, installed_at TIMESTAMPTZ NOT NULL, disconnected_at TIMESTAMPTZ
  ); CREATE TABLE IF NOT EXISTS shopify_oauth_states (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, brand_id TEXT NOT NULL REFERENCES brands(id),
    shop TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
  )`;
  for (const statement of schema.split(';').filter(s => s.trim())) await db.query(statement);
  const now = () => clock().getTime();
  const requireSetup = () => {
    if (!clientId || !clientSecret || !baseUrl) throw fail(503, 'SHOPIFY_OAUTH_NOT_CONFIGURED', 'Configure the server OAuth client and public HTTPS callback before installing brand stores.');
    const origin = new URL(baseUrl);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
      || isIP(origin.hostname.replace(/^\[|\]$/g, '')) || origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost') || origin.hostname.endsWith('.local'))
      throw fail(503, 'SHOPIFY_CALLBACK_INVALID', 'The OAuth base URL must be an HTTPS origin without credentials or a path.');
    return new URL('/oauth/shopify/callback', origin).href;
  };
  async function status(brandId) {
    if (brandId) return connectionView((await db.query('SELECT * FROM shopify_connections WHERE brand_id=$1', [brandId])).rows[0]);
    return (await db.query('SELECT * FROM shopify_connections ORDER BY shop')).rows.map(connectionView);
  }
  async function begin(brandId, shopInput) {
    const redirectUri = requireSetup(); const shop = normalizeShop(shopInput);
    return db.transaction(async tx => {
      if (!(await tx.query('SELECT id FROM brands WHERE id=$1', [brandId])).rows.length) throw fail(404, 'NOT_FOUND', 'Brand not found.');
      const bound = (await tx.query('SELECT brand_id,shop FROM shopify_connections WHERE shop=$1 OR brand_id=$2 FOR UPDATE', [shop, brandId])).rows;
      if (bound.some(row => row.brand_id !== brandId || row.shop !== shop)) throw fail(409, 'SHOP_ALREADY_BOUND', 'This store or brand is already bound to a different connection.');
      // Keep even consumed states reserved until expiry: token exchange happens after the claim.
      const pending = (await tx.query('SELECT brand_id,shop FROM shopify_oauth_states WHERE (shop=$1 OR brand_id=$2) AND expires_at>$3 FOR UPDATE', [shop, brandId, new Date(now())])).rows;
      if (pending.some(row => row.brand_id !== brandId || row.shop !== shop)) throw fail(409, 'SHOP_ALREADY_BOUND', 'A different brand/store authorization is already pending.');
      const state = randomBytes(32).toString('base64url'); const browserToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now() + 10 * 60_000);
      await tx.query('INSERT INTO shopify_oauth_states(state_hash,browser_hash,brand_id,shop,expires_at) VALUES($1,$2,$3,$4,$5)', [hash(state), hash(browserToken), brandId, shop, expiresAt]);
      const url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.search = new URLSearchParams({ client_id: clientId, scope: scopes.join(','), redirect_uri: redirectUri, state }).toString();
      // Omission of grant_options[]=per-user intentionally requests offline access.
      return { url: url.href, browserToken, expiresAt, scopes: [...scopes] };
    });
  }
  async function tokenRequest(shop, body) {
    let response;
    try { response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }) }); }
    catch { throw fail(503, 'SHOPIFY_TOKEN_UNREACHABLE', 'Shopify token exchange could not be reached. Retry authorization or wait for recovery.'); }
    if (!response.ok) {
      if (body.grant_type === 'refresh_token' && [400,401].includes(response.status))
        throw fail(401, 'SHOPIFY_REINSTALL_REQUIRED', 'Shopify rejected the offline refresh token. Reinstall authorization is required.');
      throw fail(503, 'SHOPIFY_TOKEN_REJECTED', 'Shopify rejected the token exchange. Reinstall authorization may be required.');
    }
    let token; try { token = await response.json(); } catch { throw fail(502, 'SHOPIFY_TOKEN_INVALID', 'Shopify returned an invalid token response.'); }
    const granted = String(token.scope ?? '').split(',').filter(Boolean);
    const missing = missingShopifyScopes(granted, scopes);
    if (missing.length) throw fail(409, 'SHOPIFY_SCOPES_MISSING', 'Shopify did not grant the requested permissions. Reauthorize before enabling the connection.');
    if (granted.some(scope => !requestedShopifyScopes().includes(scope))) throw fail(409, 'SHOPIFY_UNAPPROVED_SCOPES', 'The token contains permissions outside the approved allowlist. Review and reinstall the app.');
    if (typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token
      || !Number.isSafeInteger(Number(token.expires_in)) || Number(token.expires_in) <= 60
      || !Number.isSafeInteger(Number(token.refresh_token_expires_in)) || Number(token.refresh_token_expires_in) <= 0)
      throw fail(502, 'SHOPIFY_TOKEN_INVALID', 'An expiring offline access and refresh token pair is required.');
    return { accessToken: token.access_token, refreshToken: token.refresh_token, grantedScopes: granted,
      expiresAt: new Date(now() + Number(token.expires_in) * 1000).toISOString(),
      refreshExpiresAt: new Date(now() + Number(token.refresh_token_expires_in) * 1000).toISOString() };
  }
  async function complete(callbackInput, browserToken) {
    requireSetup();
    const params = new URLSearchParams(callbackInput);
    if (new Set([...params.keys()]).size !== [...params.keys()].length) throw fail(400, 'OAUTH_PARAMETERS_INVALID', 'Duplicate OAuth parameters are not allowed.');
    const state = params.get('state'); const signature = params.get('hmac'); const shop = normalizeShop(params.get('shop'));
    const timestamp = Number(params.get('timestamp'));
    if (!state || !browserToken || !params.get('code') || !Number.isFinite(timestamp) || Math.abs(now() / 1000 - timestamp) > 300 || !/^[a-f0-9]{64}$/i.test(signature || ''))
      throw fail(401, 'OAUTH_CALLBACK_INVALID', 'The OAuth callback is missing, stale or invalid.');
    params.delete('hmac');
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => `${key}=${value}`).join('&');
    if (!equal(createHmac('sha256', clientSecret).update(message).digest('hex'), signature.toLowerCase())) throw fail(401, 'OAUTH_HMAC_INVALID', 'The OAuth signature is invalid.');
    const outcome = await db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM shopify_oauth_states WHERE state_hash=$1 FOR UPDATE', [hash(state)])).rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now() || row.shop !== shop || !equal(row.browser_hash, hash(browserToken)))
        throw fail(401, 'OAUTH_STATE_INVALID', 'OAuth state is expired, already used, or belongs to another browser/store.');
      const bound = (await tx.query('SELECT brand_id,shop FROM shopify_connections WHERE shop=$1 OR brand_id=$2 FOR UPDATE', [shop, row.brand_id])).rows;
      if (bound.some(connection => connection.brand_id !== row.brand_id || connection.shop !== shop)) throw fail(409, 'SHOP_ALREADY_BOUND', 'This store or brand is already bound to another connection.');
      await tx.query('UPDATE shopify_oauth_states SET consumed_at=$1 WHERE state_hash=$2', [new Date(now()), hash(state)]);
      // Acquisition and refresh share the DB serialization boundary, so a slower
      // callback cannot overwrite a newer pair after Shopify retires the old one.
      let token;
      try { token = await tokenRequest(shop, { code: params.get('code'), expiring: '1' }); }
      catch (error) { return { failure: error }; } // Commit the one-use state even if exchange is uncertain.
      const result = (await tx.query(`INSERT INTO shopify_connections(brand_id,shop,token_encrypted,granted_scopes,status,access_expires_at,installed_at)
        VALUES($1,$2,$3,$4,'connected',$5,$6) ON CONFLICT(brand_id) DO UPDATE SET token_encrypted=$3,granted_scopes=$4,
        status='connected',access_expires_at=$5,installed_at=$6,disconnected_at=NULL RETURNING *`,
      [row.brand_id, shop, auth.encrypt(token), JSON.stringify(token.grantedScopes), token.expiresAt, new Date(now())])).rows[0];
      return connectionView(result);
    });
    if (outcome.failure) throw outcome.failure;
    return outcome;
  }
  async function getAccessToken(brandId, expectedShop) {
    requireSetup();
    const outcome = await db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM shopify_connections WHERE brand_id=$1 FOR UPDATE', [brandId])).rows[0];
      if (!row || row.status !== 'connected' || !row.token_encrypted || (expectedShop && row.shop !== normalizeShop(expectedShop)))
        throw fail(409, 'SHOPIFY_DISCONNECTED', 'This brand does not have an active Shopify connection.');
      const token = auth.decrypt(row.token_encrypted);
      if (new Date(token.expiresAt).getTime() > now() + 60_000) return token.accessToken;
      if (new Date(token.refreshExpiresAt).getTime() <= now()) {
        await tx.query("UPDATE shopify_connections SET status='reauthorization_required',token_encrypted=NULL WHERE brand_id=$1", [brandId]);
        return { failure: fail(409, 'SHOPIFY_REINSTALL_REQUIRED', 'The offline refresh token has expired. Reinstall authorization is required.') };
      }
      // Serialized row refresh prevents two workers from rotating the same token concurrently.
      let renewed;
      try { renewed = await tokenRequest(row.shop, { grant_type: 'refresh_token', refresh_token: token.refreshToken }); }
      catch (error) {
        if (error.code !== 'SHOPIFY_REINSTALL_REQUIRED') throw error;
        await tx.query("UPDATE shopify_connections SET status='reauthorization_required',token_encrypted=NULL WHERE brand_id=$1", [brandId]);
        return { failure: error };
      }
      await tx.query('UPDATE shopify_connections SET token_encrypted=$1,granted_scopes=$2,access_expires_at=$3 WHERE brand_id=$4', [auth.encrypt(renewed), JSON.stringify(renewed.grantedScopes), renewed.expiresAt, brandId]);
      return renewed.accessToken;
    });
    if (outcome.failure) throw outcome.failure;
    return outcome;
  }
  async function forBrand(brandId) {
    const row = (await db.query("SELECT shop FROM shopify_connections WHERE brand_id=$1 AND status='connected'", [brandId])).rows[0];
    if (!row) throw fail(409, 'SHOPIFY_DISCONNECTED', 'Install this brand store before using its connector.');
    return createShopifyAdapter({ shop: row.shop, clientId, clientSecret, authMode: 'authorization_code', env: {}, useKeychain: false,
      fetch: fetchImpl, getAccessToken: shop => getAccessToken(brandId, shop), scopes });
  }
  async function findShop(shopInput) {
    return connectionView((await db.query('SELECT * FROM shopify_connections WHERE shop=$1', [normalizeShop(shopInput)])).rows[0]);
  }
  async function disconnect(shopInput, { occurredAt } = {}) {
    const shop = normalizeShop(shopInput);
    return db.transaction(async tx => {
      const row = (await tx.query('SELECT * FROM shopify_connections WHERE shop=$1 FOR UPDATE', [shop])).rows[0];
      if (!row) return { ignored: true };
      if (occurredAt && new Date(occurredAt).getTime() < new Date(row.installed_at).getTime()) return { ignored: true, reason: 'older_installation_event' };
      return connectionView((await tx.query("UPDATE shopify_connections SET status='disconnected',token_encrypted=NULL,disconnected_at=$1 WHERE shop=$2 RETURNING *", [new Date(now()), shop])).rows[0]);
    });
  }
  function verifyWebhook(raw, signature) {
    if (!clientSecret || typeof signature !== 'string') return false;
    return equal(createHmac('sha256', clientSecret).update(raw).digest('base64'), signature);
  }
  return { begin, complete, status, getAccessToken, forBrand, findShop, disconnect, verifyWebhook };
}
