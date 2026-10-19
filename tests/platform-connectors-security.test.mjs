import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { woocommerceAdapter, bigcommerceAdapter } from '../server/platform/connectors.mjs';

const credentials = { storeUrl: 'https://shop.example.com', consumerKey: 'ck_fake', consumerSecret: 'cs_fake' };
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('Woo rejects private/reserved literal addresses and local hostnames before invoking fetch', async () => {
  let calls = 0;
  const adapter = woocommerceAdapter({ resolve: publicResolve, fetch: async () => { calls++; return json({}); } });
  for (const storeUrl of [
    'https://127.0.0.1:8443', 'https://2130706433', 'https://0x7f000001', 'https://10.1.2.3', 'https://172.16.0.1',
    'https://192.168.0.1', 'https://169.254.169.254', 'https://100.64.0.1', 'https://0.0.0.0', 'https://224.0.0.1',
    'https://198.18.0.1', 'https://192.0.2.1', 'https://198.51.100.1', 'https://203.0.113.1',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fc00::1]', 'https://[fe80::1]', 'https://[2001:db8::1]',
    'https://[2002:7f00:1::]', 'https://[3ffe::1]', 'https://localhost', 'https://LOCALHOST.', 'https://service.internal', 'https://server.local',
    'https://metadata.google.internal', 'https://u:p@shop.example.com', 'https://shop.example.com/#fragment',
  ]) await assert.rejects(adapter.verify({ ...credentials, storeUrl }), e => e.code === 'CONNECTOR_DESTINATION_DENIED', storeUrl);
  assert.equal(calls, 0);
});

test('every request checks all DNS answers; private, mixed, invalid and failed resolutions fail closed', async () => {
  let calls = 0;
  for (const resolve of [
    async () => [{ address: '10.0.0.1', family: 4 }],
    async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    async () => [{ address: 'not-an-address', family: 4 }], async () => [], async () => { throw new Error('DNS failed secret'); },
  ]) {
    const adapter = woocommerceAdapter({ resolve, fetch: async () => { calls++; return json({}); } });
    await assert.rejects(adapter.verify(credentials), e => e.code === 'CONNECTOR_DESTINATION_DENIED' && !e.message.includes('secret'));
  }
  assert.equal(calls, 0);
  let resolutions = 0;
  const rebinding = woocommerceAdapter({ resolve: async () => ++resolutions === 1 ? publicResolve() : [{ address: '127.0.0.1', family: 4 }], fetch: async () => { calls++; return json({}); } });
  await rebinding.verify(credentials);
  await assert.rejects(rebinding.listProducts(credentials), e => e.code === 'CONNECTOR_DESTINATION_DENIED');
  assert.equal(calls, 1);
});

test('redirects are manual and rejected for Woo and BigCommerce; caller-supplied credentials never enter errors', async () => {
  for (const create of [woocommerceAdapter, bigcommerceAdapter]) {
    const c = create === woocommerceAdapter ? credentials : { storeHash: 'abc123', accessToken: 'fake_token' };
    let calls = 0;
    const adapter = create({ resolve: publicResolve, fetch: async (_url, init) => {
      calls++; assert.equal(init.redirect, 'manual'); assert(init.signal instanceof AbortSignal);
      return { status: 302, ok: false, headers: new Headers({ location: 'https://127.0.0.1' }) };
    } });
    await assert.rejects(adapter.verify(c), e => e.code === 'CONNECTOR_REDIRECT_DENIED');
    assert.equal(calls, 1);
    const followed = create({ resolve: publicResolve, fetch: async () => ({ ...json({}), redirected: true, url: 'https://127.0.0.1' }) });
    await assert.rejects(followed.verify(c), e => e.code === 'CONNECTOR_REDIRECT_DENIED');
    const errored = create({ resolve: publicResolve, fetch: async () => { throw new Error('cs_fake fake_token https://private.internal'); } });
    await assert.rejects(errored.verify(c), e => e.code === 'CONNECTOR_ERROR' && !/cs_fake|fake_token|private/.test(e.message));
  }
});

test('DNS, injected fetch and response parsing all share a bounded request deadline', async () => {
  const never = () => new Promise(() => {});
  for (const options of [
    { resolve: never, fetch: async () => json({}) },
    { resolve: publicResolve, fetch: never },
    { resolve: publicResolve, fetch: async () => ({ status: 200, ok: true, json: never }) },
  ]) {
    const start = Date.now();
    await assert.rejects(woocommerceAdapter({ ...options, timeoutMs: 20 }).verify(credentials), e => e.code === 'CONNECTOR_TIMEOUT');
    assert(Date.now() - start < 1000);
  }
});

test('native HTTPS uses only the checked address with no shared agent or second DNS lookup', async () => {
  let calls = 0; let resolutions = 0;
  const request = (url, options, callback) => {
    calls++; assert.equal(url.hostname, 'shop.example.com'); assert.equal(options.agent, false);
    options.lookup('shop.example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
    options.lookup('shop.example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; callback(res); res.emit('data', Buffer.from('{}')); res.emit('end'); });
    return req;
  };
  const adapter = woocommerceAdapter({ request, resolve: async () => { resolutions++; return publicResolve(); } });
  assert.equal((await adapter.verify(credentials)).storeRef, 'https://shop.example.com');
  assert.equal(calls, 1); assert.equal(resolutions, 1);
});

test('native HTTPS responses are size bounded and malformed provider order IDs are rejected', async () => {
  const request = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; callback(res); res.emit('data', Buffer.from('01234567890123456789')); res.emit('end'); });
    return req;
  };
  await assert.rejects(woocommerceAdapter({ request, resolve: publicResolve, maxResponseBytes: 10 }).verify(credentials), e => e.code === 'CONNECTOR_RESPONSE_INVALID');
  const bag = { id: 'bag_test', orderRef: 'TEST', shipTo: { name: 'Test' }, items: [{ sku: 'TEST', qty: 1, unitPriceCents: 100 }] };
  for (const id of [undefined, null, '', 'undefined', 'secret-value', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const adapter = woocommerceAdapter({ resolve: publicResolve, fetch: async () => json({ id }) });
    await assert.rejects(adapter.createOrder(credentials, bag), e => e.code === 'CONNECTOR_RESPONSE_INVALID' && !e.message.includes('secret-value'));
  }
});
