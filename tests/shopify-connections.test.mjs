import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth, hash } from '../server/auth.mjs';
import { createShopifyConnections } from '../server/shopify-connections.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const clientId = 'oauth-fixture-client-id';
const clientSecret = 'oauth-fixture-secret-not-a-real-credential';
const shops = [1, 2, 3, 4].map(number => `avafem-fixture-${number}.myshopify.com`);
const brands = [1, 2, 3, 4].map(number => `brand_fixture_${number}`);

async function fixture(t, overrides = {}) {
  const db = await createDatabase({ connectionString: null });
  t.after(() => db.close());
  await db.query('CREATE TABLE brands(id TEXT PRIMARY KEY)');
  for (const id of brands) await db.query('INSERT INTO brands(id) VALUES($1)', [id]);
  let currentTime = new Date('2026-10-18T15:00:00.000Z');
  const clock = () => new Date(currentTime);
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex'), clock });
  const requests = [];
  const generations = new Map();
  let nextResponse;
  let nextHttpStatus;
  const fetchStub = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.ok(shops.includes(parsed.hostname), 'Only synthetic fixture shops may be contacted by the injected fetch.');
    assert.equal(parsed.protocol, 'https:');
    requests.push({ shop: parsed.hostname, path: parsed.pathname, options });
    if (parsed.pathname === '/admin/oauth/access_token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), clientId);
      assert.equal(body.get('client_secret'), clientSecret);
      assert.equal(options.redirect, 'error');
      if (nextHttpStatus) {
        const status = nextHttpStatus; nextHttpStatus = undefined;
        return { ok: false, status, json: async () => ({ error: 'synthetic_fixture_error' }) };
      }
      const generation = (generations.get(parsed.hostname) ?? 0) + 1;
      generations.set(parsed.hostname, generation);
      const response = nextResponse ?? {
        access_token: `fixture_access_${parsed.hostname}_${generation}`,
        refresh_token: `fixture_refresh_${parsed.hostname}_${generation}`,
        expires_in: 3600, refresh_token_expires_in: 90 * 86400,
        scope: SHOPIFY_ALLOWED_SCOPES.join(','),
      };
      nextResponse = undefined;
      return { ok: true, json: async () => response };
    }
    assert.match(parsed.pathname, /^\/admin\/api\/2026-10\/graphql\.json$/);
    assert.match(JSON.parse(options.body).query, /AvafemPreflight/);
    return { ok: true, status: 200, json: async () => ({ data: {
      shop: { id: `gid://shopify/Shop/${shops.indexOf(parsed.hostname) + 1}`, name: 'Synthetic fixture', myshopifyDomain: parsed.hostname, currencyCode: 'USD' },
      currentAppInstallation: { app: { id: 'gid://shopify/App/1', title: 'Synthetic test connector' }, accessScopes: SHOPIFY_ALLOWED_SCOPES.map(handle => ({ handle })) },
    } }) };
  };
  const config = {
    clientId, clientSecret, publicBaseUrl: 'https://avafem.example', clock, fetch: fetchStub,
    env: { SHOPIFY_ACCESS_TOKEN: 'fixture_must_never_be_inherited', SHOPIFY_AVA4_TOKEN: 'fixture_must_never_be_inherited' },
    ...overrides,
  };
  const service = await createShopifyConnections(db, auth, config);
  function callback(begin, { shop = new URL(begin.url).hostname, timestamp = Math.floor(clock().getTime() / 1000), code = 'fixture-code', state = new URL(begin.url).searchParams.get('state'), ...extra } = {}) {
    const params = new URLSearchParams({ code, shop, state, timestamp: String(timestamp), ...extra });
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => `${key}=${value}`).join('&');
    params.set('hmac', createHmac('sha256', clientSecret).update(message).digest('hex'));
    return params;
  }
  const install = async (index = 0) => {
    const begin = await service.begin(brands[index], shops[index]);
    return service.complete(callback(begin), begin.browserToken);
  };
  return {
    db, auth, service, config, requests, callback, install,
    advance: milliseconds => { currentTime = new Date(currentTime.getTime() + milliseconds); },
    overrideToken: response => { nextResponse = response; },
    overrideHttp: status => { nextHttpStatus = status; },
  };
}

test('four brand Shopify installations have distinct encrypted credentials and no default-token inheritance', { timeout: 20_000 }, async t => {
  const { db, auth, service, install, requests } = await fixture(t);
  const accessTokens = [];
  for (let index = 0; index < 4; index++) {
    const view = await install(index);
    assert.equal(view.brandId, brands[index]);
    assert.equal(view.shop, shops[index]);
    assert.equal(view.status, 'connected');
    const token = await service.getAccessToken(brands[index], shops[index]);
    accessTokens.push(token);
    const adapter = await service.forBrand(brands[index]);
    assert.equal((await adapter.preflight()).verified, true);
    assert.equal(requests.at(-1).options.headers['x-shopify-access-token'], token);
    await assert.rejects(service.getAccessToken(brands[index], shops[(index + 1) % 4]), { code: 'SHOPIFY_DISCONNECTED' });
  }
  assert.equal(new Set(accessTokens).size, 4);
  const rows = (await db.query('SELECT * FROM shopify_connections ORDER BY brand_id')).rows;
  assert.equal(rows.length, 4);
  for (let index = 0; index < 4; index++) {
    assert.doesNotMatch(rows[index].token_encrypted, /fixture_access|fixture_refresh/);
    assert.equal(auth.decrypt(rows[index].token_encrypted).accessToken, accessTokens[index]);
    assert.deepEqual(rows[index].granted_scopes, SHOPIFY_ALLOWED_SCOPES);
  }
  const views = JSON.stringify(await service.status());
  for (const secret of [...accessTokens, clientSecret, 'fixture_refresh', 'fixture_must_never_be_inherited', 'token_encrypted']) assert.equal(views.includes(secret), false);
  const tokenRequests = requests.filter(request => request.path === '/admin/oauth/access_token');
  assert.equal(tokenRequests.length, 4);
  for (const request of tokenRequests) {
    assert.equal(request.options.body.get('expiring'), '1');
    assert.equal(request.options.body.has('grant_type'), false);
  }
});

test('OAuth state survives service recreation and stores only state/browser hashes', { timeout: 20_000 }, async t => {
  const { db, auth, service, config, callback } = await fixture(t);
  const begin = await service.begin(brands[0], shops[0]);
  const url = new URL(begin.url);
  const state = url.searchParams.get('state');
  assert.deepEqual(url.searchParams.get('scope').split(','), SHOPIFY_ALLOWED_SCOPES);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://avafem.example/oauth/shopify/callback');
  assert.equal(url.searchParams.has('grant_options[]'), false);
  // A caller may serialize or manipulate the returned view, never the service policy.
  if (!Object.isFrozen(begin.scopes)) begin.scopes.push('read_locations');
  const next = await service.begin(brands[0], shops[0]);
  assert.deepEqual(next.scopes, SHOPIFY_ALLOWED_SCOPES);
  assert.deepEqual(new URL(next.url).searchParams.get('scope').split(','), SHOPIFY_ALLOWED_SCOPES);
  const rows = (await db.query('SELECT * FROM shopify_oauth_states')).rows;
  assert.equal(rows[0].state_hash, hash(state));
  assert.equal(rows[0].browser_hash, hash(begin.browserToken));
  assert.equal(JSON.stringify(rows).includes(state), false);
  assert.equal(JSON.stringify(rows).includes(begin.browserToken), false);
  const recreated = await createShopifyConnections(db, auth, config);
  const result = await recreated.complete(callback(begin), begin.browserToken);
  assert.equal(result.brandId, brands[0]);
  assert.match(await recreated.getAccessToken(brands[0]), /^fixture_access_/);
  await assert.rejects(recreated.complete(callback(begin), begin.browserToken), { code: 'OAUTH_STATE_INVALID' });
});

test('callback rejects bad HMAC, browser mismatch, store mismatch, duplicate parameters, and stale timestamp before token exchange', { timeout: 20_000 }, async t => {
  const { service, callback, requests } = await fixture(t);
  const begin = await service.begin(brands[0], shops[0]);
  const badHmac = callback(begin); badHmac.set('hmac', '0'.repeat(64));
  await assert.rejects(service.complete(badHmac, begin.browserToken), { code: 'OAUTH_HMAC_INVALID' });
  await assert.rejects(service.complete(callback(begin), 'wrong-browser-token'), { code: 'OAUTH_STATE_INVALID' });
  await assert.rejects(service.complete(callback(begin, { shop: shops[1] }), begin.browserToken), { code: 'OAUTH_STATE_INVALID' });
  const duplicate = callback(begin); duplicate.append('code', 'duplicate');
  await assert.rejects(service.complete(duplicate, begin.browserToken), { code: 'OAUTH_PARAMETERS_INVALID' });
  const stale = callback(begin, { timestamp: 0 });
  await assert.rejects(service.complete(stale, begin.browserToken), { code: 'OAUTH_CALLBACK_INVALID' });
  assert.equal(requests.length, 0);
  assert.equal((await service.complete(callback(begin), begin.browserToken)).status, 'connected');
  await assert.rejects(service.complete(callback(begin), begin.browserToken), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(requests.length, 1);
});

test('expired OAuth state is rejected even with a fresh signed callback', { timeout: 20_000 }, async t => {
  const { service, callback, requests, advance } = await fixture(t);
  const begin = await service.begin(brands[0], shops[0]);
  advance(10 * 60_000 + 1);
  await assert.rejects(service.complete(callback(begin), begin.browserToken), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(requests.length, 0);
});

test('offline refresh rotates the encrypted pair once for concurrent consumers', { timeout: 20_000 }, async t => {
  const { db, auth, service, install, requests, advance } = await fixture(t);
  await install();
  const before = (await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted;
  const old = auth.decrypt(before);
  advance(3600_000);
  const returned = await Promise.all(Array.from({ length: 8 }, () => service.getAccessToken(brands[0], shops[0])));
  assert.equal(new Set(returned).size, 1);
  assert.notEqual(returned[0], old.accessToken);
  const refreshRequests = requests.filter(request => request.options.body.get?.('grant_type') === 'refresh_token');
  assert.equal(refreshRequests.length, 1);
  assert.equal(refreshRequests[0].options.body.get('refresh_token'), old.refreshToken);
  const after = (await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted;
  const renewed = auth.decrypt(after);
  assert.notEqual(after, before);
  assert.notEqual(renewed.refreshToken, old.refreshToken);
  assert.equal(renewed.accessToken, returned[0]);
  assert.equal((await service.status(brands[0])).accessExpiresAt.toISOString(), renewed.expiresAt);
});

test('expired refresh credential requires reinstall and never falls back to any global token', { timeout: 20_000 }, async t => {
  const { db, service, install, advance, requests } = await fixture(t);
  await install();
  advance(91 * 86400_000);
  await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_REINSTALL_REQUIRED' });
  assert.equal((await service.status(brands[0])).status, 'reauthorization_required');
  assert.equal((await db.query('SELECT token_encrypted FROM shopify_connections WHERE brand_id=$1', [brands[0]])).rows[0].token_encrypted, null);
  await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_DISCONNECTED' });
  await assert.rejects(service.getAccessToken(brands[1]), { code: 'SHOPIFY_DISCONNECTED' });
  assert.equal(requests.length, 1);
});

test('invalid refresh HTTP 400/401 commits reauthorization status and erases the token pair', { timeout: 20_000 }, async t => {
  const { db, service, install, advance, requests, overrideHttp } = await fixture(t);
  for (const status of [400, 401]) {
    await install();
    advance(3600_000);
    overrideHttp(status);
    await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_REINSTALL_REQUIRED' });
    const row = (await db.query('SELECT status,token_encrypted FROM shopify_connections WHERE brand_id=$1', [brands[0]])).rows[0];
    assert.equal(row.status, 'reauthorization_required');
    assert.equal(row.token_encrypted, null);
    assert.equal((await service.status(brands[0])).status, 'reauthorization_required');
    const callsBefore = requests.length;
    await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_DISCONNECTED' });
    await assert.rejects(service.forBrand(brands[0]), { code: 'SHOPIFY_DISCONNECTED' });
    assert.equal(requests.length, callsBefore, 'Revoked pair must not be retried or replaced with a default token.');
  }
});

test('transient refresh HTTP 503 preserves the encrypted pair and permits recovery', { timeout: 20_000 }, async t => {
  const { db, service, install, advance, overrideHttp } = await fixture(t);
  await install();
  const before = (await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted;
  advance(3600_000);
  overrideHttp(503);
  await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_TOKEN_REJECTED' });
  const row = (await db.query('SELECT status,token_encrypted FROM shopify_connections')).rows[0];
  assert.equal(row.status, 'connected');
  assert.equal(row.token_encrypted, before);
  assert.match(await service.getAccessToken(brands[0]), /^fixture_access_/);
});

test('reinstall stays bound to the same brand/store and ignores uninstall from an older installation', { timeout: 20_000 }, async t => {
  const { service, install, advance, db } = await fixture(t);
  const installed = await install();
  const oldToken = await service.getAccessToken(brands[0]);
  const oldInstallation = installed.installedAt;
  advance(5000);
  const reinstalled = await install();
  assert.ok(new Date(reinstalled.installedAt) > new Date(oldInstallation));
  assert.notEqual(await service.getAccessToken(brands[0]), oldToken);
  assert.deepEqual(await service.disconnect(shops[0], { occurredAt: oldInstallation }), { ignored: true, reason: 'older_installation_event' });
  assert.equal((await service.status(brands[0])).status, 'connected');
  const disconnected = await service.disconnect(shops[0], { occurredAt: reinstalled.installedAt });
  assert.equal(disconnected.status, 'disconnected');
  assert.equal((await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted, null);
  await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_DISCONNECTED' });
  await assert.rejects(service.forBrand(brands[0]), { code: 'SHOPIFY_DISCONNECTED' });
  assert.equal((await service.findShop(shops[0])).brandId, brands[0]);
});

test('one store cannot be rebound across brands and one brand cannot silently change stores', { timeout: 20_000 }, async t => {
  const { service, install } = await fixture(t);
  await install();
  await assert.rejects(service.begin(brands[1], shops[0]), { code: 'SHOP_ALREADY_BOUND' });
  await assert.rejects(service.begin(brands[0], shops[1]), { code: 'SHOP_ALREADY_BOUND' });
  await service.disconnect(shops[0]);
  await assert.rejects(service.begin(brands[1], shops[0]), { code: 'SHOP_ALREADY_BOUND' });
  await assert.rejects(service.begin('brand_not_present', shops[2]), { code: 'NOT_FOUND' });
});

test('concurrent brands cannot reserve OAuth state for the same store', { timeout: 20_000 }, async t => {
  const { service, callback, requests } = await fixture(t);
  const results = await Promise.allSettled([service.begin(brands[0], shops[0]), service.begin(brands[1], shops[0])]);
  const successful = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'SHOP_ALREADY_BOUND');
  const begin = successful[0].value;
  assert.equal((await service.complete(callback(begin), begin.browserToken)).status, 'connected');
  assert.equal(requests.length, 1);
});

test('a legacy competing callback is rejected before it can rotate an already bound brand token', { timeout: 20_000 }, async t => {
  const { db, service, callback, requests } = await fixture(t);
  const first = await service.begin(brands[0], shops[0]);
  await service.complete(callback(first), first.browserToken);
  // Simulate an in-flight state allocated by an older server before state reservations.
  const state = 'fixture-legacy-conflicting-state';
  const browserToken = 'fixture-legacy-conflicting-browser';
  await db.query('INSERT INTO shopify_oauth_states(state_hash,browser_hash,brand_id,shop,expires_at) VALUES($1,$2,$3,$4,$5)',
    [hash(state), hash(browserToken), brands[1], shops[0], new Date('2026-10-18T15:10:00.000Z')]);
  await assert.rejects(service.complete(callback(first, { state }), browserToken), { code: 'SHOP_ALREADY_BOUND' });
  assert.equal(requests.filter(request => request.path === '/admin/oauth/access_token').length, 1,
    'A conflicting brand must not acquire a new offline token and retire the bound brand token.');
  assert.equal((await service.findShop(shops[0])).brandId, brands[0]);
  assert.equal(await service.status(brands[1]), null);
});

test('concurrent same-brand OAuth completions cannot overwrite the vault with an older retired pair', { timeout: 20_000 }, async t => {
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let active = 0; let maxActive = 0;
  const fetch = async (_url, options) => {
    const code = options.body.get('code');
    active++; maxActive = Math.max(maxActive, active);
    if (code === 'fixture-first-code') { firstEntered(); await firstGate; }
    else if (code === 'fixture-second-code') releaseFirst();
    else assert.fail('Only synthetic authorization-code exchanges are allowed.');
    active--;
    return { ok: true, json: async () => ({
      access_token: `fixture_access_${code}`, refresh_token: `fixture_refresh_${code}`,
      expires_in: 3600, refresh_token_expires_in: 86400, scope: SHOPIFY_ALLOWED_SCOPES.join(','),
    }) };
  };
  const { service, callback } = await fixture(t, { fetch });
  const first = await service.begin(brands[0], shops[0]);
  const second = await service.begin(brands[0], shops[0]);
  const firstCompletion = service.complete(callback(first, { code: 'fixture-first-code' }), first.browserToken);
  await entered;
  const secondCompletion = service.complete(callback(second, { code: 'fixture-second-code' }), second.browserToken);
  // Release a correctly serialized first exchange; an overlapping second exchange releases
  // it earlier and is caught by maxActive. No external network or provider clocks are used.
  const timer = setTimeout(releaseFirst, 50);
  try { await Promise.all([firstCompletion, secondCompletion]); }
  finally { releaseFirst(); clearTimeout(timer); }
  assert.equal(maxActive, 1, 'Code exchange and vault replacement must be one serialized operation per store.');
  assert.equal(await service.getAccessToken(brands[0]), 'fixture_access_fixture-second-code');
});

test('invalid refresh response cannot replace the last durable encrypted token pair', { timeout: 20_000 }, async t => {
  const { db, service, install, advance, overrideToken } = await fixture(t);
  await install();
  const before = (await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted;
  advance(3600_000);
  overrideToken({ access_token: 'fixture_bad_access', refresh_token: 'fixture_bad_refresh', expires_in: 3600,
    refresh_token_expires_in: 86400, scope: 'read_orders' });
  await assert.rejects(service.getAccessToken(brands[0]), { code: 'SHOPIFY_SCOPES_MISSING' });
  assert.equal((await db.query('SELECT token_encrypted FROM shopify_connections')).rows[0].token_encrypted, before);
  assert.match(await service.getAccessToken(brands[0]), /^fixture_access_/);
});

test('uncertain code-exchange failure burns the OAuth state and never retries that authorization code', { timeout: 20_000 }, async t => {
  let exchanges = 0;
  const { db, service, callback } = await fixture(t, { fetch: async () => { exchanges++; throw new TypeError('Synthetic transport failure.'); } });
  const begin = await service.begin(brands[0], shops[0]);
  const signed = callback(begin);
  await assert.rejects(service.complete(signed, begin.browserToken), { code: 'SHOPIFY_TOKEN_UNREACHABLE' });
  await assert.rejects(service.complete(signed, begin.browserToken), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(exchanges, 1);
  const state = (await db.query('SELECT consumed_at FROM shopify_oauth_states WHERE state_hash=$1', [hash(signed.get('state'))])).rows[0];
  assert.ok(state.consumed_at);
  assert.equal(await service.status(brands[0]), null);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM shopify_connections')).rows[0].n, 0);
  const replacement = await service.begin(brands[0], shops[0]);
  assert.notEqual(new URL(replacement.url).searchParams.get('state'), signed.get('state'));
});

test('OAuth service requires explicit configuration and a clean HTTPS callback origin', { timeout: 20_000 }, async t => {
  const { db, auth, config } = await fixture(t);
  for (const publicBaseUrl of ['http://avafem.example', 'https://avafem.example/path', 'https://user:password@avafem.example', 'https://avafem.example?query=1', 'https://avafem.example/#fragment', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.5']) {
    const service = await createShopifyConnections(db, auth, { ...config, publicBaseUrl });
    await assert.rejects(service.begin(brands[0], shops[0]), { code: 'SHOPIFY_CALLBACK_INVALID' });
  }
  const missing = await createShopifyConnections(db, auth, { env: {}, clock: config.clock, fetch: config.fetch });
  await assert.rejects(missing.begin(brands[0], shops[0]), { code: 'SHOPIFY_OAUTH_NOT_CONFIGURED' });
  await assert.rejects(createShopifyConnections(db, auth, { ...config, scopes: ['read_orders', 'read_locations'] }), { code: 'INVALID_INTEGRATION_INPUT' });
});

test('token exchange rejects extra grants, missing required grants, and non-expiring token-only responses', { timeout: 20_000 }, async t => {
  const { service, callback, overrideToken, db } = await fixture(t);
  const good = { access_token: 'fixture_access_only', refresh_token: 'fixture_refresh_only', expires_in: 3600, refresh_token_expires_in: 86400, scope: SHOPIFY_ALLOWED_SCOPES.join(',') };
  for (const [response, code] of [
    [{ ...good, scope: `${good.scope},read_locations` }, 'SHOPIFY_UNAPPROVED_SCOPES'],
    [{ ...good, scope: 'read_orders' }, 'SHOPIFY_SCOPES_MISSING'],
    [{ access_token: 'fixture_nonexpiring', scope: good.scope }, 'SHOPIFY_TOKEN_INVALID'],
    [{ ...good, expires_in: 30 }, 'SHOPIFY_TOKEN_INVALID'],
    [{ ...good, refresh_token_expires_in: 0 }, 'SHOPIFY_TOKEN_INVALID'],
  ]) {
    const begin = await service.begin(brands[0], shops[0]);
    overrideToken(response);
    await assert.rejects(service.complete(callback(begin), begin.browserToken), { code });
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM shopify_connections')).rows[0].n, 0);
  }
  const begin = await service.begin(brands[0], shops[0]);
  overrideToken({ ...good, scope: SHOPIFY_ALLOWED_SCOPES.filter(scope => scope.startsWith('write_') || scope === 'read_shipping').join(',') });
  assert.equal((await service.complete(callback(begin), begin.browserToken)).status, 'connected');
});

test('OAuth webhook signature verification uses exact raw bytes and never exposes app secret', { timeout: 20_000 }, async t => {
  const { service } = await fixture(t);
  const raw = Buffer.from('{"id":1,"note":"synthetic"}');
  const signature = createHmac('sha256', clientSecret).update(raw).digest('base64');
  assert.equal(service.verifyWebhook(raw, signature), true);
  assert.equal(service.verifyWebhook(Buffer.from('{ "id":1,"note":"synthetic"}'), signature), false);
  assert.equal(service.verifyWebhook(raw, 'invalid'), false);
  assert.equal(service.verifyWebhook(raw), false);
  assert.equal(JSON.stringify(await service.status()).includes(clientSecret), false);
});
