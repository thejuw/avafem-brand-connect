import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { createBrandSide } from '../server/platform/brands.mjs';

const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const decimal = cents => (cents / 100).toFixed(2);
const reason = 'Synthetic owner verified native order; no customer content.';
const request = (f, action = 'confirm', operationId = 'recovery_test_0001') => ({ bagId: f.bag.id, operationId, action, externalId: '8001', reason, actor: 'owner' });
const restart = f => createBrandSide(f.db, { domain: f.domain, auth: f.auth, secret: f.config.encryptionKey,
  clock: f.clock, compliance: f.platform.compliance, fetch: (...a) => f.side.fetch(...a), resolve: publicResolve });

async function fixture(t, platform = 'woocommerce') {
  const f = await platformFixture(t), side = f.platform.brands;
  side.resolve = publicResolve;
  side.fetch = async () => json({ environment: { site_url: 'https://shop.example.com' }, domain: 'bc-shop.example.com' });
  const credentials = platform === 'woocommerce' ? { storeUrl: 'https://shop.example.com', consumerKey: 'ck_fake', consumerSecret: 'cs_fake' }
    : { storeHash: 'abc123', accessToken: 'fake_token' };
  await side.connect('brand_bloom', platform, credentials);
  const bag = await f.domain.getBag((await f.bagFor(await f.seedOrder(), 'brand_bloom')).id);
  const native = { order: null, fulfillments: [], products: [], shipping: [], shipments: [] };
  const provider = { posts: 0, gets: 0, succeed: false, mode: 'normal', beforeGet: null, nextId: 8002 };
  side.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      provider.posts++;
      const body = JSON.parse(init.body);
      if (provider.posts === 1) {
        const ship = bag.shipTo;
        if (platform === 'woocommerce') native.order = { id: 8001, status: 'processing', currency: 'USD',
          total: decimal(bag.totalCents), shipping_total: decimal(bag.shippingCents), total_tax: decimal(bag.taxCents), discount_total: '0.00',
          meta_data: body.meta_data, line_items: bag.items.map(i => ({ sku: i.sku, quantity: i.qty, total: decimal(i.unitPriceCents * i.qty) })),
          shipping: { first_name: ship.name, last_name: '', address_1: ship.line1, address_2: ship.line2 || '', city: ship.city, state: ship.region, postcode: ship.postal, country: ship.country },
          fee_lines: [], coupon_lines: [], refunds: [], date_paid: '2026-10-19T12:00:00', date_completed: null };
        else {
          native.order = { id: 8001, is_deleted: false, status_id: 11, currency_code: 'USD', default_currency_code: 'USD', currency_exchange_rate: '1.0000000000',
            total_inc_tax: decimal(bag.totalCents), total_ex_tax: decimal(bag.subtotalCents + bag.shippingCents), subtotal_ex_tax: decimal(bag.subtotalCents),
            shipping_cost_ex_tax: decimal(bag.shippingCents), discount_amount: '0.0000', coupon_discount: '0.0000', handling_cost_ex_tax: '0.0000', wrapping_cost_ex_tax: '0.0000',
            staff_notes: body.staff_notes, payment_status: 'captured', refunded_amount: '0.0000', items_total: bag.items.reduce((s, i) => s + i.qty, 0), items_shipped: 0, shipping_address_count: 1, date_shipped: '' };
          native.products = bag.items.map(i => ({ id: 1, order_id: 8001, sku: i.sku, quantity: i.qty, total_ex_tax: decimal(i.unitPriceCents * i.qty) }));
          native.shipping = [{ id: 1, order_id: 8001, first_name: ship.name, last_name: '', street_1: ship.line1, street_2: ship.line2 || '', city: ship.city, state: ship.region, zip: ship.postal, country_iso2: ship.country }];
        }
      }
      if (provider.succeed) return json({ id: provider.nextId });
      throw new Error('Synthetic connection loss after provider accepted the order, fake_token cs_fake');
    }
    provider.gets++;
    if (provider.beforeGet) await provider.beforeGet(url);
    if (provider.mode === 'unavailable') return json({}, 503);
    if (provider.mode === 'missing') return json({}, 404);
    if (u.pathname.endsWith('/fulfillments')) return provider.mode === 'no_fulfillment_api' ? json({}, 404) : json(native.fulfillments);
    if (u.pathname.endsWith('/products')) return json(native.products);
    if (u.pathname.endsWith('/shipping_addresses')) return json(native.shipping);
    if (u.pathname.endsWith('/shipments')) return json(native.shipments);
    return json(native.order);
  };
  await assert.rejects(side.pushOrder(bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  return { ...f, side, bag, native, provider, credentials };
}

test('authoritative confirmation fills one receipt/mapping without creating remotely; identical recovery replay is read-only', async t => {
  const f = await fixture(t), input = request(f);
  const listed = await f.side.listRecovery();
  assert.equal(listed.length, 1); assert.equal(listed[0].state, 'connector_uncertain'); assert.equal(listed[0].attempts.length, 1);
  const result = await f.side.resolveRecovery(input);
  assert.equal(result.status, 'confirmed'); assert.equal(result.providerWrites, 0); assert.equal(f.provider.posts, 1);
  const gets = f.provider.gets;
  const replay = await restart(f).resolveRecovery(input);
  assert.equal(replay.replayed, true); assert.equal(f.provider.gets, gets); assert.equal(f.provider.posts, 1);
  assert.equal((await f.side.pushOrder(f.bag.id)).externalId, '8001'); assert.equal(f.provider.posts, 1);
  const receipt = (await f.db.query('SELECT * FROM connector_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
  const shared = (await f.db.query('SELECT * FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0];
  assert.equal(receipt.external_id, '8001'); assert.equal(shared.external_order_id, '8001'); assert.equal(shared.state, 'connector_created');
  const audits = (await f.db.query("SELECT action FROM audit_log WHERE resource_id=$1 AND action LIKE 'connector.%'", [f.bag.id])).rows.map(v => v.action);
  assert(audits.includes('connector.dispatch_reserved')); assert(audits.includes('connector.recovery_started')); assert(audits.includes('connector.recovery_confirmed'));
  const raw = JSON.stringify((await f.db.query('SELECT * FROM connector_dispatch_attempts')).rows) + JSON.stringify((await f.db.query('SELECT * FROM connector_order_recoveries')).rows);
  const view = JSON.stringify(listed) + JSON.stringify(result);
  for (const privateValue of [reason, f.bag.shipTo.line1, f.bag.shipTo.postal, 'cs_fake', 'fake_token']) {
    assert(!raw.includes(privateValue), privateValue); assert(!view.includes(privateValue), privateValue);
  }
});

test('void is read-only proof, then exactly one separate push consumes the authorization and preserves history', async t => {
  const f = await fixture(t); f.native.order.status = 'cancelled';
  const result = await f.side.resolveRecovery(request(f, 'void'));
  assert.equal(result.status, 'retry_authorized'); assert.equal(result.requiresSeparatePush, true); assert.equal(f.provider.posts, 1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_orders WHERE bag_id=$1', [f.bag.id])).rows[0].n, 0);
  f.provider.succeed = true;
  const receipt = await restart(f).pushOrder(f.bag.id);
  assert.equal(receipt.externalId, '8002'); assert.equal(f.provider.posts, 2);
  assert.equal((await f.side.pushOrder(f.bag.id)).replayed, true); assert.equal(f.provider.posts, 2);
  const attempts = (await f.db.query('SELECT * FROM connector_dispatch_attempts WHERE bag_id=$1', [f.bag.id])).rows;
  assert.equal(attempts.length, 2); assert.equal(attempts.find(a => a.state === 'voided').external_id, '8001');
  const current = attempts.find(a => a.state === 'created'); assert.equal(current.external_id, '8002');
  const review = (await f.db.query('SELECT * FROM connector_order_recoveries')).rows[0];
  assert.equal(review.status, 'retry_consumed'); assert.equal(review.retry_consumed_by, current.id); assert(review.proof_enc);
  const replay = await f.side.resolveRecovery(request(f, 'void'));
  assert.equal(replay.status, 'retry_authorized'); assert.equal(replay.replayed, true); assert.equal(f.provider.posts, 2);
});

test('wrong identity, markers, currency, item, amount and address proofs remain blocked without another create', async t => {
  const f = await fixture(t), baseline = structuredClone(f.native.order);
  const mutations = [
    o => { o.id = 8009; }, o => { o.meta_data[0].value = 'bag_foreign'; },
    o => { o.meta_data.push({ key: 'avafem_bag_id', value: f.bag.id }); }, o => { o.meta_data[1].value = 'cda_sibling'; },
    o => { o.currency = 'CAD'; }, o => { o.total = '1.00'; }, o => { o.shipping_total = '0.00'; }, o => { o.total_tax = '0.00'; },
    o => { o.line_items[0].quantity++; }, o => { o.line_items[0].sku = 'FOREIGN'; }, o => { o.line_items[0].total = '1.00'; },
    o => { o.shipping.address_1 = 'A different address'; }, o => { o.refunds = [{ id: 123, total: '-1.00' }]; },
    o => { o.discount_total = '0.01'; }, o => { o.fee_lines = [{ name: 'Extra', total: '0.01' }]; },
    o => { o.status = 'pending'; }, o => { o.date_paid = null; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    f.native.order = structuredClone(baseline); mutate(f.native.order);
    const r = await f.side.resolveRecovery(request(f, 'confirm', `bad_proof_${String(i).padStart(3, '0')}`));
    assert.equal(r.status, 'blocked'); assert.equal(r.providerWrites, 0);
    assert.equal((await f.db.query('SELECT state FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0].state, 'connector_uncertain');
  }
  assert.equal(f.provider.posts, 1);
});

test('404, unavailable provider and unavailable fulfillment history never mean a safely voided order', async t => {
  const f = await fixture(t); f.native.order.status = 'cancelled';
  for (const mode of ['missing', 'unavailable', 'no_fulfillment_api']) {
    f.provider.mode = mode;
    const r = await f.side.resolveRecovery(request(f, 'void', `missing_${mode}`));
    assert.equal(r.status, 'blocked');
    await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  }
  f.provider.mode = 'normal'; f.native.order.date_completed = '2026-10-19T12:00:00';
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'completed_before_void'))).status, 'blocked');
  f.native.order.date_completed = null;
  f.native.fulfillments = [{ id: 1, entity_type: 'WC_Order', entity_id: '8001', status: 'fulfilled', is_fulfilled: true }];
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'fulfilled_before_void'))).status, 'blocked');
  assert.equal(f.provider.posts, 1);
});

test('idempotency binds action, native ID, actor and reason; invalid input never reads providers', async t => {
  const f = await fixture(t), input = request(f);
  await f.side.resolveRecovery(input); const gets = f.provider.gets;
  for (const patch of [{ action: 'void' }, { externalId: '8002' }, { reason: 'A changed operator review reason.' }, { actor: 'other_owner' }])
    await assert.rejects(f.side.resolveRecovery({ ...input, ...patch }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  for (const patch of [{ operationId: 'short' }, { externalId: 'https://private.internal' }, { reason: 'short' }, { actor: 'a@example.com' }, { action: 'clear' }])
    await assert.rejects(f.side.resolveRecovery({ ...input, ...patch }), e => e.code === 'INVALID_RECOVERY');
  assert.equal(f.provider.gets, gets); assert.equal(f.provider.posts, 1);
});

test('concurrent admins for the same Bag share a durable lease, even across service instances', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  let first = true; f.provider.beforeGet = async () => { if (first) { first = false; entered(); await gate; } };
  const pending = f.side.resolveRecovery(request(f)); await started;
  await assert.rejects(restart(f).resolveRecovery(request(f, 'void', 'concurrent_review_2')), e => e.code === 'RECOVERY_BUSY');
  await assert.rejects(restart(f).resolveRecovery(request(f)), e => e.code === 'RECOVERY_BUSY');
  release(); assert.equal((await pending).status, 'confirmed'); assert.equal(f.provider.posts, 1);
});

test('expired read lease can be recovered, but the original stale worker cannot commit its proof', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  let first = true; f.provider.beforeGet = async () => { if (first) { first = false; entered(); await gate; } };
  const stale = f.side.resolveRecovery(request(f)); await started;
  await f.db.query("UPDATE connector_order_recoveries SET lease_expires_at=NOW()-interval '1 second'");
  assert.equal((await restart(f).resolveRecovery(request(f))).status, 'confirmed');
  release(); await assert.rejects(stale, e => e.code === 'RECOVERY_LEASE_LOST');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_orders')).rows[0].n, 1); assert.equal(f.provider.posts, 1);
});

test('current store or immutable Bag drift blocks recovery before provider reads', async t => {
  const f = await fixture(t), gets = f.provider.gets;
  const changed = structuredClone(f.bag.items); changed[0].unitPriceCents++;
  await f.db.query('UPDATE bags SET items=$2 WHERE id=$1', [f.bag.id, JSON.stringify(changed)]);
  await assert.rejects(f.side.resolveRecovery(request(f)), e => e.code === 'RECOVERY_BAG_CHANGED');
  await f.db.query('UPDATE bags SET items=$2 WHERE id=$1', [f.bag.id, JSON.stringify(f.bag.items)]);
  const oldFetch = f.side.fetch; f.side.fetch = async () => json({ environment: { site_url: 'https://other.example.com' } });
  await f.side.connect(f.bag.brandId, 'woocommerce', { ...f.credentials, storeUrl: 'https://other.example.com' });
  f.side.fetch = oldFetch;
  await assert.rejects(f.side.resolveRecovery(request(f)), e => e.code === 'RECOVERY_STORE_CHANGED');
  assert.equal(f.provider.gets, gets); assert.equal(f.provider.posts, 1);
});

test('fresh proof rechecks at commit, and a consumed retry grant can never be reused after uncertainty', async t => {
  const f = await fixture(t);
  let changed = false; f.provider.beforeGet = async () => {
    if (!changed) { changed = true; await f.db.query('UPDATE bags SET refunded_cents=1 WHERE id=$1', [f.bag.id]); }
  };
  assert.equal((await f.side.resolveRecovery(request(f))).blockedReason, 'RECOVERY_CONTEXT_CHANGED');
  await f.db.query('UPDATE bags SET refunded_cents=0 WHERE id=$1', [f.bag.id]); f.provider.beforeGet = null;
  f.native.order.status = 'cancelled'; await f.side.resolveRecovery(request(f, 'void', 'void_for_once_retry'));
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(f.provider.posts, 2);
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(f.provider.posts, 2);
  const oldProof = await f.side.resolveRecovery(request(f, 'void', 'old_attempt_for_new'));
  assert.equal(oldProof.status, 'blocked'); assert.equal(oldProof.blockedReason, 'RECOVERY_PROOF_MISMATCH');
});

test('void grants require fresh native cancellation before push; failed read checks do not consume a create', async t => {
  const f = await fixture(t); f.native.order.status = 'cancelled';
  await f.side.resolveRecovery(request(f, 'void'));
  f.native.order.status = 'processing';
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'RECOVERY_RETRY_PROOF_REQUIRED');
  assert.equal(f.provider.posts, 1);
  assert.equal((await f.db.query('SELECT retry_consumed_by FROM connector_order_recoveries')).rows[0].retry_consumed_by, null);
  f.native.order.status = 'cancelled'; f.provider.succeed = true;
  assert.equal((await f.side.pushOrder(f.bag.id)).externalId, '8002'); assert.equal(f.provider.posts, 2);
});

test('two concurrent retry pushes consume one grant and issue only one replacement order', async t => {
  const f = await fixture(t); f.native.order.status = 'cancelled';
  await f.side.resolveRecovery(request(f, 'void'));
  f.provider.succeed = true;
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.provider.beforeGet = async () => { if (first) { first = false; entered(); await gate; } };
  const pending = f.side.pushOrder(f.bag.id); await started;
  await assert.rejects(restart(f).pushOrder(f.bag.id), e => e.code === 'RECOVERY_BUSY');
  release(); assert.equal((await pending).externalId, '8002'); assert.equal(f.provider.posts, 2);
  const review = (await f.db.query('SELECT retry_consumed_by FROM connector_order_recoveries')).rows[0];
  assert(review.retry_consumed_by);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_dispatch_attempts')).rows[0].n, 2);
});

test('database uniqueness defends current-attempt identity and fresh in-flight orders cannot be resolved', async t => {
  const f = await fixture(t);
  await assert.rejects(f.db.query(`INSERT INTO connector_dispatch_attempts(id,bag_id,brand_id,platform,target_ref,state,snapshot_enc,snapshot_hash,created_at,updated_at)
    SELECT 'cda_duplicate',bag_id,brand_id,platform,target_ref,'uncertain',snapshot_enc,snapshot_hash,NOW(),NOW() FROM connector_dispatch_attempts WHERE bag_id=$1`, [f.bag.id]), e => e.code === '23505');
  await f.db.query("UPDATE external_orders SET state='connector_pending',updated_at=NOW() WHERE bag_id=$1", [f.bag.id]);
  await assert.rejects(f.side.resolveRecovery(request(f)), e => e.code === 'RECOVERY_DISPATCH_IN_PROGRESS');
  assert.equal(f.provider.gets, 0); assert.equal(f.provider.posts, 1);
});

test('confirmation receipt-write failure rolls back the proof result and cannot release dispatch', async t => {
  const f = await fixture(t);
  const db = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ query: (sql, params) => {
    if (/INSERT INTO connector_orders/.test(sql)) throw new Error('Synthetic commit failure fake_token');
    return tx.query(sql, params);
  } })) };
  const side = createBrandSide(db, { domain: f.domain, auth: f.auth, secret: f.config.encryptionKey, clock: f.clock,
    fetch: (...a) => f.side.fetch(...a), resolve: publicResolve });
  await assert.rejects(side.resolveRecovery(request(f)), e => e.code === 'RECOVERY_COMMIT_FAILED' && !e.message.includes('fake_token'));
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_orders')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT state FROM external_orders WHERE bag_id=$1', [f.bag.id])).rows[0].state, 'connector_uncertain');
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  assert.equal(f.provider.posts, 1);
});

test('legacy Bag-only proof is allowed once, never inherited by a subsequent dispatch attempt', async t => {
  const f = await fixture(t);
  await f.db.query('DELETE FROM connector_dispatch_attempts WHERE bag_id=$1', [f.bag.id]);
  f.native.order.meta_data = f.native.order.meta_data.filter(m => m.key !== 'avafem_dispatch_id'); f.native.order.status = 'cancelled';
  const r = await f.side.resolveRecovery(request(f, 'void'));
  assert.equal(r.status, 'retry_authorized');
  await assert.rejects(f.side.pushOrder(f.bag.id), e => e.code === 'CONNECTOR_OUTCOME_UNCERTAIN');
  const oldOrder = await f.side.resolveRecovery(request(f, 'void', 'legacy_sibling_attempt'));
  assert.equal(oldOrder.status, 'blocked'); assert.equal(oldOrder.blockedReason, 'RECOVERY_PROOF_MISMATCH');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_dispatch_attempts')).rows[0].n, 2);
  assert.equal(f.provider.posts, 2);
});

test('BigCommerce recovery binds fixed child resources, full item/address/native status and transaction currency', async t => {
  const f = await fixture(t, 'bigcommerce');
  f.native.order.products = { url: 'https://127.0.0.1/ignore' };
  assert.equal((await f.side.resolveRecovery(request(f))).status, 'confirmed');
  assert.equal(f.provider.posts, 1);
});

test('BigCommerce incomplete/truncated or foreign-order child proofs and shipped cancellations remain blocked', async t => {
  const f = await fixture(t, 'bigcommerce'); f.native.order.status_id = 5;
  f.native.shipments = [{ order_id: 8001, id: 77 }];
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'bc_shipped_cancel'))).status, 'blocked');
  f.native.shipments = []; f.native.products[0].order_id = 9999;
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'bc_foreign_child'))).status, 'blocked');
  f.native.products[0].order_id = 8001; f.native.order.default_currency_code = 'CAD';
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'bc_wrong_currency'))).status, 'blocked');
  f.native.order.default_currency_code = 'USD'; f.native.products = Array.from({ length: 250 }, () => ({ ...f.native.products[0] }));
  assert.equal((await f.side.resolveRecovery(request(f, 'void', 'bc_truncated_page'))).status, 'blocked');
  assert.equal(f.provider.posts, 1);
});
