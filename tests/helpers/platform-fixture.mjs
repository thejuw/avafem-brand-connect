import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../server/app.mjs';

export const DAY = 86_400_000;
const forbidden = name => async () => { throw new Error(`Provider call ${name} is disabled in platform tests.`); };

/** In-memory app with every external provider stubbed and a movable platform clock. */
export async function platformFixture(t, extra = {}) {
  t.mock.method(https, 'request', () => { throw new Error('External delivery is disabled in platform tests.'); });
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const app = await createApp({ worker: false, seed: true, connectionString: null,
    config: { port: 4317, host: '127.0.0.1', allowLocalBootstrap: true, sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') },
    platform: { clock, ...(extra.platform || {}) },
    integrations: {
      shopify: { status: async () => ({ available: false, configured: false, shop: 'platform-fixture.myshopify.com' }), preflight: forbidden('shopify.preflight'), listProducts: forbidden('shopify.listProducts'), createOrder: forbidden('shopify.createOrder'), verifyWebhook: forbidden('shopify.verifyWebhook') },
      stripe: { status: async () => ({ available: false, configured: false, mode: 'test' }), createRefund: forbidden('stripe.createRefund'), createReversal: forbidden('stripe.createReversal'), refundBag: forbidden('stripe.refundBag'), createTransfer: forbidden('stripe.createTransfer'), createPaymentIntent: forbidden('stripe.createPaymentIntent'), verifyWebhook: forbidden('stripe.verifyWebhook') },
    } });
  t.after(() => app.close());
  await app.ready();
  const request = o => app.inject({ ...o, headers: { host: 'localhost:4317', ...o.headers } });
  const session = await request({ method: 'GET', url: '/api/session' });
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const csrf = session.json().data.csrfToken;
  const owner = o => request({ ...o, headers: { cookie, 'x-csrf-token': csrf, ...o.headers } });
  const ok = async (promise, status = 200) => { const r = await promise; assert.equal(r.statusCode, status, r.body); return r.json().data ?? r.json(); };
  const credential = (brandId, scopes = ['orders:read']) => app.avafem.auth.createCredential(brandId, { kind: 'api_key', label: 'platform test', scopes });
  const bearer = (cred, o) => request({ ...o, headers: { authorization: `Bearer ${cred.apiKey}`, ...o.headers } });
  let rpcId = 0;
  const mcp = async (cred, method, params = {}) => {
    const r = await request({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${cred.apiKey}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }, payload: { jsonrpc: '2.0', id: ++rpcId, method, params } });
    assert.equal(r.statusCode, 200, r.body); return r.json().result;
  };
  const tool = async (cred, name, args = {}) => { const res = await mcp(cred, 'tools/call', { name, arguments: args }); return res.isError ? { error: JSON.parse(res.content[0].text).error } : res.structuredContent.data; };
  const seedOrder = async () => (await app.avafem.db.query("SELECT id FROM orders WHERE order_ref='SANDBOX-EX-1042'")).rows[0].id;
  const bagFor = async (orderId, brandId) => (await app.avafem.db.query('SELECT * FROM bags WHERE order_id=$1 AND brand_id=$2', [orderId, brandId])).rows[0];
  return { app, ...app.avafem, request, owner, ok, credential, bearer, mcp, tool, seedOrder, bagFor, advance: days => { offset += days * DAY; }, clock };
}
export const isoDate = d => d.toISOString().slice(0, 10);
