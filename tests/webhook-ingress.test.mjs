import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWebhookIngress } from '../server/webhook-ingress.mjs';

test('webhook ingress never exposes owner routes or forwards browser credentials', async t => {
  const received = [];
  const backend = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString() });
      res.setHeader('content-type', 'application/json'); res.end('{"received":true}');
    });
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const ingress = createWebhookIngress({ backendPort: backend.address().port });
  ingress.listen(0, '127.0.0.1'); await once(ingress, 'listening');
  t.after(async () => { await new Promise(resolve => ingress.close(resolve)); await new Promise(resolve => backend.close(resolve)); });
  const base = `http://127.0.0.1:${ingress.address().port}`;
  for (const path of ['/', '/api/session', '/api/local/stripe-test-credentials', '/webhooks/shopify?path=/api/session', '/webhooks/stripe/../api/session']) {
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, 404);
  }
  assert.equal((await fetch(`${base}/webhooks/shopify`)).status, 404);
  assert.equal((await fetch(`${base}/webhooks/shopify`, { method: 'POST', body: '{}' })).status, 415);
  const raw = '{ "id" : "synthetic_event" }';
  const result = await fetch(`${base}/webhooks/shopify`, { method: 'POST', headers: { 'content-type': 'application/json',
    cookie: 'never-forward', authorization: 'Bearer never-forward', origin: 'https://untrusted.example',
    'x-forwarded-for': 'never-forward', 'x-shopify-hmac-sha256': 'fixture-signature' }, body: raw });
  assert.equal(result.status, 200); assert.equal(received.length, 1); assert.equal(received[0].raw, raw);
  assert.equal(received[0].headers['x-shopify-hmac-sha256'], 'fixture-signature');
  for (const key of ['cookie', 'authorization', 'origin', 'x-forwarded-for']) assert.equal(received[0].headers[key], undefined);
  assert.equal(result.headers.get('set-cookie'), null);
});
