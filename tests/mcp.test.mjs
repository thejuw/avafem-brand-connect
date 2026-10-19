import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { BRAND_SCOPES } from '../server/auth.mjs';

const protocolVersion = '2025-06-18';

async function fixture(t) {
  const providerCalls = [];
  const forbidden = method => async () => { providerCalls.push(method); throw new Error(`Provider call ${method} is disabled in MCP tests.`); };
  const app = await createApp({
    worker: false, seed: true, connectionString: null,
    config: {
      host: '127.0.0.1', port: 4317, allowLocalBootstrap: true,
      sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex'),
    },
    integrations: {
      shopify: {
        status: async () => ({ available: false, configured: false, shop: 'mcp-fixture.myshopify.com' }),
        preflight: forbidden('shopify.preflight'), listProducts: forbidden('shopify.listProducts'),
        createOrder: forbidden('shopify.createOrder'), verifyWebhook: forbidden('shopify.verifyWebhook'),
      },
      stripe: {
        status: async () => ({ available: false, configured: false, mode: 'test' }),
        createRefund: forbidden('stripe.createRefund'), createReversal: forbidden('stripe.createReversal'),
        refundBag: forbidden('stripe.refundBag'), createTransfer: forbidden('stripe.createTransfer'),
        createPaymentIntent: forbidden('stripe.createPaymentIntent'), verifyWebhook: forbidden('stripe.verifyWebhook'),
      },
    },
  });
  t.after(async () => app.close());
  await app.ready();
  let requestId = 0;
  const credential = async (brandId, scopes) => app.avafem.auth.createCredential(brandId, { kind: 'api_key', label: 'MCP capability fixture', scopes });
  const rpc = async (token, method, params = {}, headers = {}) => {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: {
        host: 'localhost:4317', authorization: `Bearer ${token.apiKey ?? token}`,
        accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        'mcp-protocol-version': protocolVersion, ...headers,
      },
      payload: { jsonrpc: '2.0', id: ++requestId, method, params },
    });
    assert.equal(response.statusCode, 200, `MCP ${method}: ${response.body}`);
    const message = response.json();
    assert.equal(message.jsonrpc, '2.0');
    assert.equal(message.id, requestId);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  };
  const call = (token, name, args = {}) => rpc(token, 'tools/call', { name, arguments: args });
  const resultData = result => result.structuredContent?.data ?? JSON.parse(result.content[0].text).data;
  const resultError = result => JSON.parse(result.content[0].text).error;
  return { app, ...app.avafem, credential, rpc, call, resultData, resultError, providerCalls };
}

test('Streamable HTTP MCP initializes and lists actual registered tools through Fastify raw transport', { timeout: 60_000 }, async t => {
  const { rpc, credential, providerCalls } = await fixture(t);
  const token = await credential('brand_bloom', ['orders:read']);
  const initialized = await rpc(token, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'avafem-capability-test', version: '1.0.0' } });
  assert.equal(initialized.serverInfo.name, 'avafem-brand-connect');
  assert.ok(initialized.protocolVersion);
  assert.ok(initialized.capabilities.tools);
  const listed = await rpc(token, 'tools/list');
  const names = listed.tools.map(tool => tool.name);
  for (const required of ['get_bag', 'list_awaiting_shipment', 'get_payout_summary', 'refund_order']) assert.ok(names.includes(required), required);
  assert.equal(listed.tools.find(tool => tool.name === 'get_bag').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(tool => tool.name === 'refund_order').inputSchema.properties.idempotencyKey.type, 'string');
  assert.deepEqual(providerCalls, []);
});

test('MCP get_bag returns only the bearer brand and foreign Bag IDs are denied', { timeout: 20_000 }, async t => {
  const { credential, call, domain, resultData, resultError, providerCalls } = await fixture(t);
  const token = await credential('brand_bloom', ['orders:read']);
  const own = (await domain.listBags({ brandId: 'brand_bloom' }))[0];
  const foreign = (await domain.listBags({ brandId: 'brand_lunelle' }))[0];
  const allowed = await call(token, 'get_bag', { id: own.id });
  assert.equal(allowed.isError, undefined);
  assert.equal(resultData(allowed).brandId, 'brand_bloom');
  assert.equal(resultData(allowed).id, own.id);
  assert.doesNotMatch(JSON.stringify(resultData(allowed)), /cycleDay|healthNotes|customerEmail/);
  const denied = await call(token, 'get_bag', { id: foreign.id });
  assert.equal(denied.isError, true);
  assert.equal(resultError(denied).code, 'NOT_FOUND');
  assert.ok(!JSON.stringify(denied).includes(foreign.id));
  assert.deepEqual(providerCalls, []);
});

test('orders:read bearer cannot use MCP payout or refund capabilities', { timeout: 20_000 }, async t => {
  const { credential, call, domain, resultError, providerCalls } = await fixture(t);
  const token = await credential('brand_bloom', ['orders:read']);
  const bag = (await domain.listBags({ brandId: 'brand_bloom' }))[0];
  const payouts = await call(token, 'get_payout_summary');
  assert.equal(payouts.isError, true);
  assert.equal(resultError(payouts).code, 'INSUFFICIENT_SCOPE');
  const refund = await call(token, 'refund_order', { id: bag.id, refund: { reason: 'Sandbox return requested' }, idempotencyKey: 'read-only-cannot-refund' });
  assert.equal(refund.isError, true);
  assert.equal(resultError(refund).code, 'INSUFFICIENT_SCOPE');
  assert.equal((await domain.listRefunds({ brandId: 'brand_bloom' })).length, 0);
  assert.deepEqual(providerCalls, []);
});

test('full-scope MCP refund_order only proposes a refund, replays once, and never issues money', { timeout: 20_000 }, async t => {
  const { credential, call, domain, db, resultData, providerCalls } = await fixture(t);
  const token = await credential('brand_lunelle', BRAND_SCOPES);
  const bag = (await domain.listBags({ brandId: 'brand_lunelle' }))[0];
  const priorLedger = await domain.listLedger({ brandId: 'brand_lunelle' });
  const args = { id: bag.id, refund: { reason: 'Sandbox MCP return proposal' }, idempotencyKey: 'mcp-refund-proposal-once' };
  const first = await call(token, 'refund_order', args);
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const proposal = resultData(first);
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.bagId, bag.id);
  assert.equal(proposal.amountCents, bag.totalCents);
  const replay = await call(token, 'refund_order', args);
  assert.equal(resultData(replay).id, proposal.id);
  assert.equal((await domain.listRefunds({ brandId: 'brand_lunelle' })).length, 1);
  const afterBag = await domain.getBag(bag.id);
  assert.equal(afterBag.status, bag.status);
  assert.equal(afterBag.refundedCents, bag.refundedCents);
  const moneyJournals = await db.query("SELECT id FROM ledger_journals WHERE bag_id=$1 AND kind IN ('sandbox_refund','sandbox_transfer_reversal')", [bag.id]);
  assert.equal(moneyJournals.rows.length, 0);
  assert.equal((await domain.listLedger({ brandId: 'brand_lunelle' })).length, priorLedger.length);
  assert.deepEqual(providerCalls, []);
});

test('MCP rejects unauthenticated requests before transport and refuses browser cookies as bearer authority', { timeout: 20_000 }, async t => {
  const { app } = await fixture(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const missing = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'localhost:4317', accept: 'application/json, text/event-stream' }, payload: body });
  assert.equal(missing.statusCode, 401);
  const session = await app.inject({ method: 'GET', url: '/api/session', headers: { host: 'localhost:4317' } });
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const sessionOnly = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'localhost:4317', accept: 'application/json, text/event-stream', cookie, 'x-csrf-token': session.json().data.csrfToken }, payload: body });
  assert.equal(sessionOnly.statusCode, 401);
  assert.equal(sessionOnly.json().error.code, 'BEARER_REQUIRED');
});
