import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { createBrandSide } from '../server/platform/brands.mjs';

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const credentials = { storeUrl: 'https://shop.example.com', consumerKey: 'ck_fake', consumerSecret: 'cs_fake' };
const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
async function fixture(t) {
  const f = await platformFixture(t);
  f.platform.brands.resolve = publicResolve;
  f.platform.brands.fetch = async () => json({ environment: { site_url: credentials.storeUrl } });
  await f.platform.brands.connect('brand_bloom', 'woocommerce', credentials);
  const bag = await f.domain.getBag((await f.bagFor(await f.seedOrder(), 'brand_bloom')).id);
  return { ...f, bag, side: f.platform.brands };
}
const restartSide = (f, { db = f.db, fetch = f.side.fetch, domain = f.domain } = {}) => createBrandSide(db, {
  domain, auth: f.auth, clock: f.clock, secret: f.config.encryptionKey,
  compliance: f.platform.compliance, fetch, resolve: publicResolve,
});

test('public signup cannot use its brand session to request a loopback Woo endpoint', async t => {
  const f = await platformFixture(t);
  let calls = 0; f.platform.brands.resolve = publicResolve;
  f.platform.brands.fetch = async () => { calls++; return json({}); };
  const signup = await f.ok(f.request({ method: 'POST', url: '/api/portal/signup', payload: { brandName: 'Synthetic SSRF Test', email: 'synthetic@example.invalid' } }));
  const accept = await f.request({ method: 'POST', url: `/api/invites/${signup.inviteToken}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(accept.statusCode, 200);
  const cookie = String(accept.headers['set-cookie']).split(';')[0];
  const r = await f.request({ method: 'POST', url: `/api/portal/${signup.brandId}/connect`,
    headers: { cookie, 'x-csrf-token': accept.json().data.csrfToken },
    payload: { platform: 'woocommerce', credentials: { ...credentials, storeUrl: 'https://127.0.0.1:8443' } } });
  assert.equal(r.statusCode, 422); assert.equal(r.json().error.code, 'CONNECTOR_DESTINATION_DENIED');
  assert.equal(calls, 0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS c FROM brand_connectors WHERE brand_id=$1', [signup.brandId])).rows[0].c, 0);
});

test('concurrent pushes reserve once before the provider call and success replay is read-only', async t => {
  const f = await fixture(t);
  let posts = 0; let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  f.side.fetch = async (_url, init) => {
    assert.equal(init.method, 'POST'); posts++;
    const intent = (await f.db.query('SELECT * FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
    assert.equal(intent.state, 'connector_pending'); assert.equal(intent.shop, 'woocommerce:https://shop.example.com');
    assert.equal(JSON.parse(init.body).meta_data[0].value, f.bag.id);
    started(); await gate; return json({ id: 8001 });
  };
  const first = f.side.pushOrder(f.bag.id);
  await entered;
  await assert.rejects(restartSide(f).pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN' && e.statusCode === 409);
  release();
  const receipt = await first;
  assert.equal(receipt.externalId, '8001'); assert.equal(posts, 1);
  const replay = await restartSide(f).pushOrder(f.bag.id);
  assert.equal(replay.externalId, '8001'); assert.equal(replay.replayed, true); assert.equal(posts, 1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS c FROM connector_orders WHERE bag_id=$1', [f.bag.id])).rows[0].c, 1);
  const reservation = (await f.db.query('SELECT * FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
  assert.equal(reservation.state, 'connector_created'); assert.equal(reservation.external_order_id, '8001');
});

test('timeout or response loss persists uncertainty and cannot send again after service recreation', async t => {
  const f = await fixture(t);
  let posts = 0;
  f.side.fetch = async () => { posts++; throw new Error('Socket lost after provider accepted order cs_fake secret'); };
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN' && !/cs_fake|Socket|secret/.test(e.message));
  const row = (await f.db.query('SELECT * FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
  assert.equal(row.state, 'connector_uncertain'); assert.equal(row.last_error, 'CONNECTOR_CREATE_NOT_VERIFIED');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS c FROM connector_orders WHERE bag_id=$1', [f.bag.id])).rows[0].c, 0);
  await assert.rejects(restartSide(f).pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(posts, 1);
  assert(!JSON.stringify(row).includes('cs_fake'));
});

test('legacy success receipts repair shared fulfillment ownership without a provider retry', async t => {
  const f = await fixture(t);
  let posts = 0; f.side.fetch = async () => { posts++; return json({ id: 8999 }); };
  await f.db.query(`INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at)
    VALUES($1,$2,'woocommerce','8998',now())`, [f.bag.id, f.bag.brandId]);
  const receipt = await f.side.pushOrder(f.bag.id);
  assert.equal(receipt.externalId, '8998'); assert.equal(receipt.replayed, true); assert.equal(posts, 0);
  const external = (await f.db.query('SELECT * FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
  assert.equal(external.state, 'connector_created'); assert.equal(external.external_order_id, '8998');
  assert.equal(external.shop, 'woocommerce:legacy-receipt');
  await f.db.query("UPDATE external_orders SET state='created',shop='known.myshopify.com',external_order_id='gid://shopify/Order/123' WHERE bag_id=$1", [f.bag.id]);
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(posts, 0);
});

test('provider success followed by local receipt-write failure remains reserved and is never recreated', async t => {
  const f = await fixture(t);
  let posts = 0;
  const db = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ query: (sql, params) => {
    if (/INSERT INTO connector_orders/.test(sql)) throw new Error('Synthetic local receipt failure cs_fake');
    return tx.query(sql, params);
  } })) };
  const side = restartSide(f, { db, fetch: async () => { posts++; return json({ id: 8002 }); } });
  await assert.rejects(side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN' && !e.message.includes('cs_fake'));
  assert.equal((await f.db.query('SELECT state FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0].state, 'connector_uncertain');
  await assert.rejects(restartSide(f).pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(posts, 1);
});

test('provider-bound Bags and preexisting Shopify reservations cannot create another store order', async t => {
  const f = await fixture(t);
  let posts = 0; f.side.fetch = async () => { posts++; return json({ id: 8003 }); };
  await f.db.query('UPDATE bags SET provider_bound=true WHERE id=$1', [f.bag.id]);
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'PROVIDER_WORKFLOW_REQUIRED');
  await f.db.query('UPDATE bags SET provider_bound=false WHERE id=$1', [f.bag.id]);
  for (const state of ['pending', 'uncertain', 'created']) {
    await f.db.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state,external_order_id) VALUES($1,$2,'known.myshopify.com',$3,$4)
      ON CONFLICT(bag_id) DO UPDATE SET state=EXCLUDED.state,external_order_id=EXCLUDED.external_order_id`, [f.bag.id, f.bag.brandId, state, state === 'created' ? 'gid://shopify/Order/123' : null]);
    const r = await f.owner({ method: 'POST', url: `/api/connectors/orders/${f.bag.id}/push` });
    assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'EXTERNAL_FULFILLMENT_RESERVED');
  }
  assert.equal(posts, 0);
});

test('fresh Bag checks block refunded, refund-pending and stale provider-bound snapshots', async t => {
  const f = await fixture(t);
  let posts = 0; f.side.fetch = async () => { posts++; return json({ id: 8004 }); };
  await f.db.query('UPDATE bags SET refunded_cents=1 WHERE id=$1', [f.bag.id]);
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'INVALID_BAG_STATE');
  await f.db.query('UPDATE bags SET refunded_cents=0 WHERE id=$1', [f.bag.id]);
  const side = restartSide(f, { domain: { ...f.domain, getBag: async id => {
    const bag = await f.domain.getBag(id);
    await f.db.query('UPDATE bags SET provider_bound=true WHERE id=$1', [id]);
    return bag;
  } } });
  await assert.rejects(side.pushOrder(f.bag.id), e => e.code === 'PROVIDER_WORKFLOW_REQUIRED');
  await f.db.query('UPDATE bags SET provider_bound=false WHERE id=$1', [f.bag.id]);
  await f.domain.requestRefund(f.bag.id, { reason: 'Synthetic review proposal' });
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'INVALID_BAG_STATE');
  assert.equal(posts, 0);
});

test('reserving a connector closes manual handoff and inbox before the remote write', async t => {
  const f = await fixture(t);
  await f.db.query(`INSERT INTO handoff_links(token_hash,event_id,bag_id,brand_id,expires_at)
    VALUES('synthetic_handoff','synthetic_event',$1,$2,now()+interval '1 hour')`, [f.bag.id, f.bag.brandId]);
  await f.db.query(`INSERT INTO sandbox_inbox(id,event_id,bag_id,brand_id,subject,body) VALUES('synthetic_inbox','synthetic_event',$1,$2,'Synthetic','{}')`, [f.bag.id, f.bag.brandId]);
  f.side.fetch = async () => {
    const handoff = (await f.db.query("SELECT used_at FROM handoff_links WHERE token_hash='synthetic_handoff'")).rows[0];
    const inbox = (await f.db.query("SELECT status FROM sandbox_inbox WHERE id='synthetic_inbox'")).rows[0];
    assert(handoff.used_at); assert.equal(inbox.status, 'closed');
    return json({ id: 8005 });
  };
  await f.side.pushOrder(f.bag.id);
});

test('dispatch selects the current connector, not the first alphabetical connection', async t => {
  const f = await fixture(t);
  f.side.fetch = async () => json({ domain: 'bc-shop.example.com' });
  await f.side.connect('brand_bloom', 'bigcommerce', { storeHash: 'abc123', accessToken: 'fake_token' });
  const urls = [];
  f.side.fetch = async url => { urls.push(url); return json({ id: 8006 }); };
  const receipt = await f.side.pushOrder(f.bag.id);
  assert.equal(receipt.platform, 'bigcommerce');
  assert.deepEqual(urls, ['https://api.bigcommerce.com/stores/abc123/v2/orders']);
  assert.equal((await f.db.query('SELECT shop FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0].shop, 'bigcommerce:abc123');
});

test('disconnecting the active connector withdraws approval and blocks activation until explicit reconnection/review', async t => {
  const f = await fixture(t);
  await f.side.disconnect('brand_bloom', 'woocommerce');
  const brand = await f.domain.getBrand('brand_bloom');
  assert.equal(brand.connectionHealthy, false); assert.equal(brand.status, 'disconnected');
  assert((await f.domain.listProducts({ brandId: 'brand_bloom' })).every(p => p.status !== 'approved'));
  assert.equal((await f.db.query("SELECT credentials_enc FROM brand_connectors WHERE brand_id='brand_bloom' AND platform='woocommerce'")).rows[0].credentials_enc, null);
  await assert.rejects(f.side.activate('brand_bloom'), e => e.code === 'ONBOARDING_INCOMPLETE');
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'NO_CONNECTOR');
  await f.side.connect('brand_bloom', 'woocommerce', credentials);
  assert.equal((await f.domain.getBrand('brand_bloom')).status, 'onboarding');
  await assert.rejects(f.side.activate('brand_bloom'), e => e.code === 'ONBOARDING_INCOMPLETE');
});

test('disconnecting an unused connector does not disable the selected connection; activation requires a store', async t => {
  const f = await fixture(t);
  f.side.fetch = async () => json({ domain: 'bc-shop.example.com' });
  await f.side.connect('brand_bloom', 'bigcommerce', { storeHash: 'abc123', accessToken: 'fake_token' });
  await f.side.disconnect('brand_bloom', 'woocommerce');
  const brand = await f.domain.getBrand('brand_bloom');
  assert.equal(brand.connectionHealthy, true); assert.notEqual(brand.status, 'disconnected');
  assert.equal((await f.side.status('brand_bloom')).steps.find(s => s.key === 'store_connection').done, true);
  await assert.rejects(f.side.activate('brand_hearth'), e => e.code === 'ONBOARDING_INCOMPLETE');
});
