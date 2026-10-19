import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStoreDiscovery, sanitizeStoreProfile, storeDiscoveryCapabilities } from '../server/platform/store-discovery.mjs';

const resolve = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const shopify = { token: 'PRIVATE_CART_TOKEN', currency: 'USD', items: [], item_count: 0, total_price: 0, original_total_price: 0, total_discount: 0 };
const bigcommerce = [{ id: 'd4e978c2-bdcf-41b0-a49b-fecf4f5223c1', customerId: 0, email: 'PRIVATE@example.com', currency: { code: 'USD' },
  isTaxIncluded: false, cartAmount: 0, lineItems: { physicalItems: [], digitalItems: [] } }];

test('default discovery is local-only, hostname hints are exact and never authenticate a store', async () => {
  let requests = 0, resolutions = 0;
  const service = createStoreDiscovery({ resolve: async () => { resolutions++; return resolve(); }, fetch: async () => { requests++; return json({}); } });
  for (const [storeUrl, platform] of [['https://my-store.myshopify.com', 'shopify'], ['https://store-ab12.mybigcommerce.com/', 'bigcommerce'], ['https://MY-STORE.MYSHOPIFY.COM./', 'shopify']]) {
    const r = await service.detect({ storeUrl });
    assert.equal(r.platform, platform); assert.equal(r.advisory, true); assert.equal(r.verified, false);
    assert.equal(r.capability.configured, false); assert.equal(r.probeStatus, 'not_needed_hostname_hint');
    assert.deepEqual(r.evidence, [{ platform, kind: 'hostname_hint' }]);
  }
  for (const storeUrl of ['https://shop.myshopify.com.evil.com', 'https://www.shop.myshopify.com', 'https://myshopify.com', 'https://shop.mybigcommerce.com.evil.com', 'https://custom-store.com']) {
    const r = await service.detect({ storeUrl }); assert.equal(r.platform, 'unknown'); assert.equal(r.probeStatus, 'disabled_local_only');
    assert.deepEqual(r.fallback, ['csv', 'feed']);
  }
  assert.equal(requests, 0); assert.equal(resolutions, 0);
});

test('invalid/private origins and arbitrary paths, query, credentials or ports never invoke DNS or fetch', async () => {
  let calls = 0;
  const service = createStoreDiscovery({ allowProbe: true, resolve: async () => { calls++; return resolve(); }, fetch: async () => { calls++; return json({}); } });
  for (const storeUrl of [undefined, null, '', 'not a URL', 'http://shop.example.com', 'https://localhost', 'https://internal', 'https://service.local',
    'https://metadata.google.internal', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'https://[3ffe::1]', 'https://192.168.1.1', 'https://169.254.169.254', 'https://shop.example.com/admin', 'https://shop.example.com/?path=/admin',
    'https://shop.example.com/#fragment', 'https://u:SECRET@shop.example.com', 'https://shop.example.com:8443', `https://${'a'.repeat(2048)}.com`, 'https://shop.\nexample.com']) {
    await assert.rejects(service.detect({ storeUrl }), e => e.code === 'STORE_URL_INVALID' && !e.message.includes('SECRET'));
  }
  assert.equal(calls, 0);
});

test('explicit probing recognizes bounded public JSON signatures using only fixed same-origin GETs', async () => {
  for (const [platform, path, body] of [['woocommerce', '/wp-json/', { namespaces: ['wp/v2', 'wc/store/v1'], name: 'PRIVATE' }],
    ['shopify', '/cart.js', shopify], ['bigcommerce', '/api/storefront/carts', bigcommerce]]) {
    const requests = [];
    const service = createStoreDiscovery({ allowProbe: true, resolve, fetch: async (url, init) => {
      const u = new URL(url); requests.push(u.pathname);
      assert.equal(u.origin, 'https://custom-store.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.accept, 'application/json'); assert.equal(init.headers.authorization, undefined); assert.equal(init.headers.cookie, undefined);
      assert.equal(init.body, undefined); assert(init.signal instanceof AbortSignal);
      return u.pathname === path ? json(body) : json({}, 404);
    } });
    const r = await service.detect({ storeUrl: 'https://custom-store.com' });
    assert.equal(r.platform, platform); assert.equal(r.verified, false); assert.equal(r.probeStatus, 'complete');
    assert.equal(r.capability.configured, false); assert.equal(r.evidence.length, 1); assert.equal(r.evidence[0].kind, 'public_json');
    assert.deepEqual(requests, ['/wp-json/', '/cart.js', '/api/storefront/carts']);
    assert(!/PRIVATE|customerId|lineItems|token/i.test(JSON.stringify(r)));
  }
});

test('incomplete or ambiguous responses stay unverified and fall back instead of guessing or exposing response fields', async () => {
  const ambiguous = createStoreDiscovery({ allowProbe: true, resolve, fetch: async url => json(new URL(url).pathname === '/wp-json/' ? { namespaces: ['wc/v3'] } : new URL(url).pathname === '/cart.js' ? shopify : []) });
  const r = await ambiguous.detect({ storeUrl: 'https://custom-store.com' });
  assert.equal(r.platform, 'unknown'); assert.equal(r.probeStatus, 'ambiguous'); assert.equal(r.evidence.length, 2);
  assert.equal(r.verified, false); assert.deepEqual(r.fallback, ['csv', 'feed']);
  for (const body of [[], {}, '<html>Shopify SECRET</html>', { token: 'SECRET', currency: 'USD', items: [], item_count: -1 }, { namespaces: ['woocommerce/evil'] }, bigcommerce.concat(Array(10).fill(bigcommerce[0]))]) {
    const service = createStoreDiscovery({ allowProbe: true, resolve, fetch: async () => json(body) });
    const unknown = await service.detect({ storeUrl: 'https://custom-store.com' });
    assert.equal(unknown.platform, 'unknown'); assert.equal(unknown.evidence.length, 0); assert(!JSON.stringify(unknown).includes('SECRET'));
  }
});

test('private/mixed DNS and rebinding abort evidence gathering without fetching the denied destination', async () => {
  let requests = 0;
  for (const answer of [[{ address: '10.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], [{ address: '3ffe::1', family: 6 }]]) {
    const service = createStoreDiscovery({ allowProbe: true, resolve: async () => answer, fetch: async () => { requests++; return json({}); } });
    const r = await service.detect({ storeUrl: 'https://custom-store.com' }); assert.equal(r.probeStatus, 'blocked_destination'); assert.equal(r.platform, 'unknown');
  }
  assert.equal(requests, 0);
  let resolutions = 0;
  const service = createStoreDiscovery({ allowProbe: true, resolve: async () => ++resolutions === 1 ? resolve() : [{ address: '127.0.0.1', family: 4 }],
    fetch: async () => { requests++; return json({ namespaces: ['wc/store/v1'] }); } });
  const r = await service.detect({ storeUrl: 'https://custom-store.com' });
  assert.equal(requests, 1); assert.equal(r.platform, 'unknown'); assert.equal(r.probeStatus, 'blocked_destination'); assert.deepEqual(r.evidence, []);
});

test('redirects and bounded deadline stop probes; all raw network/errors remain private', async () => {
  let requests = 0;
  const redirect = createStoreDiscovery({ allowProbe: true, resolve, fetch: async () => { requests++; return { status: 302, ok: false }; } });
  assert.equal((await redirect.detect({ storeUrl: 'https://custom-store.com' })).probeStatus, 'blocked_redirect'); assert.equal(requests, 1);
  const start = Date.now();
  const timeout = createStoreDiscovery({ allowProbe: true, timeoutMs: 20, resolve: () => new Promise(() => {}), fetch: async () => assert.fail('late DNS must never fetch') });
  assert.equal((await timeout.detect({ storeUrl: 'https://custom-store.com' })).probeStatus, 'timed_out'); assert(Date.now() - start < 1000);
  const unavailable = createStoreDiscovery({ allowProbe: true, resolve, fetch: async () => { throw new Error('SECRET shpat_private https://private.internal'); } });
  const r = await unavailable.detect({ storeUrl: 'https://custom-store.com' }); assert.equal(r.platform, 'unknown'); assert(!/SECRET|shpat_|internal/.test(JSON.stringify(r)));
  assert.throws(() => createStoreDiscovery({ allowProbe: 'true' }), e => e.code === 'STORE_DISCOVERY_CONFIG_INVALID');
  assert.throws(() => createStoreDiscovery({ timeoutMs: 2001 }), e => e.code === 'STORE_DISCOVERY_CONFIG_INVALID');
});

test('native discovery requests are DNS-pinned and oversized/malformed JSON cannot become platform evidence', async () => {
  let requests = 0;
  const request = (url, options, callback) => {
    requests++; assert.equal(url.hostname, 'custom-store.com'); assert.equal(options.agent, false); assert.equal(options.method, 'GET');
    options.lookup('custom-store.com', {}, (e, address, family) => { assert.equal(e, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; callback(res);
      res.emit('data', Buffer.from(url.pathname === '/wp-json/' ? 'x'.repeat(128_001) : 'not JSON SECRET')); res.emit('end'); });
    return req;
  };
  const r = await createStoreDiscovery({ allowProbe: true, resolve, request }).detect({ storeUrl: 'https://custom-store.com' });
  assert.equal(requests, 3); assert.equal(r.platform, 'unknown'); assert.deepEqual(r.evidence, []); assert(!JSON.stringify(r).includes('SECRET'));
});

test('authenticated profile sanitizer allowlists display suggestions and never grants commercial or connection authority', () => {
  const profile = sanitizeStoreProfile('shopify', { name: '  Synthetic Store  ', brand: { logo: { image: { url: 'https://cdn.shopify.com/s/logo.png?v=123#hint' } } },
    contactEmail: 'support@example.com', returnPolicy: { text: 'Returns may be requested within 30 days.' }, commissionBps: 0, returnWindowDays: 0, holdDays: 0,
    shipping: { free: true }, status: 'approved', connected: true, connectionHealthy: true, customer: { health: 'PRIVATE' }, token: 'shpat_PRIVATE' });
  assert.equal(profile.name, 'Synthetic Store'); assert.equal(profile.logoUrl, 'https://cdn.shopify.com/s/logo.png'); assert.equal(profile.contactEmail, 'support@example.com');
  assert.equal(profile.returnPolicy.text, 'Returns may be requested within 30 days.'); assert.equal(profile.returnPolicy.untrusted, true); assert.equal(profile.requiresReview, true);
  assert.deepEqual(profile.provenance, { source: 'shopify', kind: 'authenticated_connected_store' });
  assert.deepEqual(Object.keys(profile).sort(), ['contactEmail', 'logoUrl', 'name', 'provenance', 'requiresReview', 'returnPolicy', 'untrusted'].sort());
  assert(!/PRIVATE|commissionBps|returnWindowDays|holdDays|shipping|approved|connectionHealthy/.test(JSON.stringify(profile)));
});

test('profile logos cannot point at arbitrary/private/credential-bearing hosts and no URL is fetched', () => {
  for (const logoUrl of ['http://cdn.shopify.com/logo.png', 'https://127.0.0.1/logo', 'https://service.internal/logo', 'https://public-but-unverified.com/logo.png',
    'https://cdn.shopify.com.evil.com/logo', 'https://cdn.shopify.com@127.0.0.1/logo', 'https://u:p@cdn.shopify.com/logo.png', 'https://cdn.shopify.com:8443/logo', 'javascript:alert(1)', 'data:image/svg+xml,SECRET']) {
    assert.equal(sanitizeStoreProfile('woocommerce', { logoUrl }).logoUrl, null);
  }
  assert.equal(sanitizeStoreProfile('bigcommerce', { logo: { url: 'https://cdn11.bigcommerce.com/s-store/logo.png' } }).logoUrl, 'https://cdn11.bigcommerce.com/s-store/logo.png');
  assert.equal(sanitizeStoreProfile('woocommerce', { logo: 'https://i0.wp.com/public-store.com/logo.png' }).logoUrl, 'https://i0.wp.com/public-store.com/logo.png');
});

test('malformed, HTML, secret and oversized profile fields are omitted rather than interpreted or truncated into authority', () => {
  for (const source of ['shopify', 'woocommerce', 'bigcommerce', 'csv']) {
    const r = sanitizeStoreProfile(source, { name: 'x'.repeat(201), logoUrl: 'https://cdn.shopify.com/shpat_SECRET.png', contactEmail: 'a@example.com\r\nBcc:PRIVATE@example.com',
      returnPolicy: { text: '<script>PRIVATE</script><p>free everything</p>' } });
    assert.equal(r.name, null); assert.equal(r.logoUrl, null); assert.equal(r.contactEmail, null); assert.equal(r.returnPolicy.text, null); assert.equal(r.untrusted, true);
    assert(!/PRIVATE|SECRET|script/.test(JSON.stringify(r)));
  }
  assert.equal(sanitizeStoreProfile('shopify', { returnPolicy: 'x'.repeat(8001) }).returnPolicy.text, null);
  assert.equal(sanitizeStoreProfile('shopify', { name: { toString: () => assert.fail('never coerce provider objects') }, contactEmail: [] }).name, null);
  assert.equal(sanitizeStoreProfile('csv', null).returnPolicy.text, null);
  assert.throws(() => sanitizeStoreProfile('SECRET', {}), e => e.code === 'STORE_PROFILE_SOURCE_INVALID' && !e.message.includes('SECRET'));
});

test('capability metadata is explicit about unconfigured providers and is not shared mutable state', () => {
  const a = storeDiscoveryCapabilities();
  for (const source of ['shopify', 'woocommerce', 'bigcommerce', 'feed']) { assert.equal(a[source].configured, false); assert.equal(a[source].status, 'needs_provider_configuration'); }
  a.shopify.configured = true;
  assert.equal(storeDiscoveryCapabilities().shopify.configured, false); assert.equal(createStoreDiscovery().capabilities().shopify.configured, false);
});
