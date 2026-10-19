import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { woocommerceAdapter, bigcommerceAdapter, csvRows } from '../server/platform/connectors.mjs';
import { parse } from 'csv-parse/sync';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
function mockStores(calls) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    const u = new URL(url);
    if (u.hostname === 'shop.example.com') {
      if (init.headers.authorization !== `Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`) return json({}, 401);
      if (u.pathname.endsWith('/system_status')) return json({ environment: { site_url: 'https://shop.example.com' } });
      if (u.pathname.endsWith('/products')) return json(u.searchParams.get('page') === '1' ? [
        { id: 11, sku: 'WC-SERUM', name: 'Woo serum', description: '<p>Hydrating <b>serum</b></p>', price: '24.50', stock_quantity: 7, images: [{ src: 'https://img.example.com/s.jpg' }], categories: [{ slug: 'skin' }] },
        { id: 12, sku: '', name: 'No sku balm', price: '9', stock_quantity: null, images: [{ src: 'http://insecure/x.jpg' }] }] : []);
      if (u.pathname.endsWith('/orders') && init.method === 'POST') return json({ id: 9001 });
    }
    if (u.hostname === 'api.bigcommerce.com') {
      if (init.headers['x-auth-token'] !== 'bc_token') return json({}, 401);
      if (u.pathname.endsWith('/v2/store')) return json({ domain: 'bc-store.example.com' });
      if (u.pathname.endsWith('/v3/catalog/products')) return json({ data: [{ id: 5, sku: 'BC-TINT', name: 'BC tint', description: 'Tinted balm', price: 18, inventory_level: 4, images: [{ url_standard: 'https://img.example.com/t.jpg' }] }], meta: { pagination: { total_pages: 1 } } });
      if (u.pathname.endsWith('/v2/orders') && init.method === 'POST') return json({ id: 777 });
    }
    return json({}, 404);
  };
}

test('connector adapters normalize WooCommerce and BigCommerce products and reject bad credentials (mocked HTTP)', async () => {
  const calls = []; const fetch = mockStores(calls);
  const woo = woocommerceAdapter({ fetch, resolve: publicResolve });
  const creds = { storeUrl: 'https://shop.example.com/any/path', consumerKey: 'ck_test', consumerSecret: 'cs_test' };
  assert.equal((await woo.verify(creds)).storeRef, 'https://shop.example.com');
  const products = await woo.listProducts(creds);
  assert.deepEqual(products[0], { sku: 'WC-SERUM', title: 'Woo serum', description: 'Hydrating serum', priceCents: 2450, inventoryQty: 7, images: ['https://img.example.com/s.jpg'], category: 'skin', externalId: '11',collections:['skin'] });
  assert.equal(products[1].sku, 'WC-12'); assert.deepEqual(products[1].images, []); assert.equal(products[1].inventoryQty, 0);
  await assert.rejects(woo.verify({ ...creds, consumerSecret: 'cs_wrong' }), e => e.code === 'CONNECTOR_UNAUTHORIZED');
  await assert.rejects(woo.verify({ ...creds, storeUrl: 'http://shop.example.com' }), /https/);
  await assert.rejects(woo.verify({ ...creds, consumerKey: 'nope' }), /ck_/);
  const bc = bigcommerceAdapter({ fetch, resolve: publicResolve });
  const bcCreds = { storeHash: 'abc123', accessToken: 'bc_token' };
  assert.equal((await bc.verify(bcCreds)).storeRef, 'bc-store.example.com');
  assert.equal((await bc.listProducts(bcCreds))[0].priceCents, 1800);
  assert.ok(calls.every(c => c.url.startsWith('https://')));
  const csv = 'Handle,Title,Body (HTML),Variant SKU,Variant Price,Variant Inventory Qty,Image Src\nglow,Glow oil,<p>Oil</p>,GLOW-1,12.00,5,https://img.example.com/1.jpg\nglow,,,,,,https://img.example.com/2.jpg\n';
  const rows = csvRows(parse, csv);
  assert.equal(rows.length, 1); assert.equal(rows[0].priceCents, 1200); assert.deepEqual(rows[0].images, ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg']);
});

test('self-serve portal: signup -> invite -> profile -> Stripe Express (mocked) -> WooCommerce connect + sync -> review queue -> live', { timeout: 90_000 }, async t => {
  const f = await platformFixture(t);
  f.platform.brands.resolve = publicResolve;
  const calls = []; f.platform.brands.fetch = mockStores(calls);
  const signup = await f.ok(f.request({ method: 'POST', url: '/api/portal/signup', payload: { brandName: 'Fern & Flow', email: 'Founder@FernFlow.com', website: 'https://fernflow.example.com' } }));
  assert.equal(signup.status, 'invited'); assert.equal(signup.contactHint, 'f***@fernflow.com');
  const raw = JSON.stringify((await f.db.query('SELECT * FROM brand_applications')).rows);
  assert.ok(!raw.includes('founder@fernflow.com'), 'contact encrypted');
  const accept = await f.request({ method: 'POST', url: `/api/invites/${signup.inviteToken}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(accept.statusCode, 200, accept.body);
  const cookie = String(accept.headers['set-cookie']).split(';')[0]; const csrf = accept.json().data.csrfToken;
  const brand = o => f.request({ ...o, headers: { cookie, 'x-csrf-token': csrf, ...o.headers } });
  const brandId = signup.brandId;
  let status = await f.ok(brand({ method: 'GET', url: `/api/portal/${brandId}/status` }));
  assert.equal(status.nextStep, 'profile');
  assert.equal((await brand({ method: 'GET', url: '/api/portal/brand_bloom/status' })).statusCode, 403, 'tenant isolation');
  status = await f.ok(brand({ method: 'PATCH', url: `/api/portal/${brandId}/profile`, payload: { shipFromAddress: { name: 'Fern', line1: '1 Main', city: 'Austin', region: 'TX', postal: '78701', country: 'US' }, shippingTable: [{ method: 'standard', priceCents: 500, days: 5 }], supportEmail: 'help@fernflow.com' } }));
  assert.equal(status.status, 'onboarding'); assert.equal(status.nextStep, 'store_connection');
  const bad = await brand({ method: 'POST', url: `/api/portal/${brandId}/connect`, payload: { platform: 'woocommerce', credentials: { storeUrl: 'https://shop.example.com', consumerKey: 'ck_test', consumerSecret: 'cs_bad' } } });
  assert.equal(bad.statusCode, 401);
  await f.ok(brand({ method: 'POST', url: `/api/portal/${brandId}/connect`, payload: { platform: 'woocommerce', credentials: { storeUrl: 'https://shop.example.com', consumerKey: 'ck_test', consumerSecret: 'cs_test' } } }));
  assert.ok(!JSON.stringify((await f.db.query('SELECT * FROM brand_connectors')).rows).includes('cs_test'), 'connector secret encrypted');
  const listed = await f.ok(brand({ method: 'GET', url: `/api/portal/${brandId}/connectors` }));
  assert.equal(listed[0].platform, 'woocommerce'); assert.equal(listed[0].credentialsEnc, undefined);
  const link = await f.ok(brand({ method: 'POST', url: `/api/portal/${brandId}/stripe/link` }));
  assert.equal(link.simulated, true); assert.match(link.account, /^acct_sandbox_/);
  status = await f.ok(brand({ method: 'POST', url: `/api/portal/${brandId}/stripe/return` }));
  assert.ok(status.steps.find(s => s.key === 'stripe_express').done);
  const sync = await f.ok(brand({ method: 'POST', url: `/api/portal/${brandId}/connectors/woocommerce/sync` }));
  assert.equal(sync.total, 2); assert.equal(sync.accepted, 2);
  const shopify = await f.ok(brand({ method: 'POST', url: `/api/portal/${brandId}/connect`, payload: { platform: 'shopify' } }));
  assert.equal(shopify.next.path, `/api/brands/${brandId}/shopify/authorize`);
  const queue = await f.ok(f.owner({ method: 'GET', url: '/api/portal/review-queue' }));
  const mine = queue.filter(p => p.brandId === brandId);
  assert.equal(mine.length, 2); assert.ok(mine.every(p => p.validationIssues.length > 0));
  // Brand completes the listing, then an operator approves it.
  const put = await brand({ method: 'PUT', url: `/api/brands/${brandId}/products/WC-SERUM`, payload: { title: 'Woo serum', description: 'Hydrating serum', category: 'skin/serum', priceCents: 2450, inventoryQty: 7, images: ['https://img.example.com/s.jpg'], taxCode: 'txcd_99999999', evidence: { ingredients_inci: ['Aqua', 'Glycerin'], certifications: [], claims: [], contraindications: '' } } });
  assert.equal(put.statusCode, 200, put.body);
  const product = (await f.domain.listProducts({ brandId })).find(p => p.sku === 'WC-SERUM');
  await f.ok(f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } }));
  const early = await f.owner({ method: 'POST', url: `/api/portal/${brandId}/activate` });
  assert.equal(early.statusCode, 409); assert.match(early.body, /sandbox order/i);
  await f.domain.updateBrand(brandId, { testOrderPassed: true });
  status = await f.ok(f.owner({ method: 'POST', url: `/api/portal/${brandId}/activate` }));
  assert.equal(status.status, 'live'); assert.equal(status.nextStep, null);
  assert.equal((await brand({ method: 'POST', url: `/api/portal/${brandId}/activate` })).statusCode, 403, 'brands cannot self-activate');
  // Orders push to the WooCommerce store once (idempotent).
  const order = await f.domain.createSandboxOrder({ externalId: 'WOO-1', shipTo: { name: 'Ana', line1: '2 St', city: 'Austin', region: 'TX', postal: '78701', country: 'US' }, items: [{ brandId, sku: 'WC-SERUM', qty: 1 }] });
  const pushed = await f.ok(f.owner({ method: 'POST', url: `/api/connectors/orders/${order.bags[0].id}/push` }));
  assert.equal(pushed.externalId, '9001');
  assert.equal((await f.ok(f.owner({ method: 'POST', url: `/api/connectors/orders/${order.bags[0].id}/push` }))).replayed, true);
  const orderCall = calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders'));
  assert.equal(orderCall.length, 1); assert.equal(JSON.parse(orderCall[0].body).shipping.city, 'Austin');
});

test('BigCommerce connector and CSV fallback import via REST, /v1 and MCP', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  f.platform.brands.resolve = publicResolve;
  f.platform.brands.fetch = mockStores([]);
  await f.ok(f.owner({ method: 'POST', url: '/api/portal/brand_bloom/connect', payload: { platform: 'bigcommerce', credentials: { storeHash: 'abc123', accessToken: 'bc_token' } } }));
  const sync = await f.ok(f.owner({ method: 'POST', url: '/api/portal/brand_bloom/connectors/bigcommerce/sync' }));
  assert.equal(sync.accepted, 1);
  assert.ok((await f.domain.listProducts({ brandId: 'brand_bloom' })).some(p => p.sku === 'BC-TINT'));
  await f.ok(f.owner({ method: 'DELETE', url: '/api/portal/brand_bloom/connectors/bigcommerce' }));
  assert.equal((await f.owner({ method: 'POST', url: '/api/portal/brand_bloom/connectors/bigcommerce/sync' })).statusCode, 404);
  const csv = 'sku,title,description,price,inventoryQty,images,category\nCSV-1,CSV cream,Rich cream,15.00,3,https://img.example.com/c.jpg,body\n,Missing sku,,1,1,,\n';
  const out = await f.ok(f.owner({ method: 'POST', url: '/api/portal/brand_bloom/catalog/csv', payload: { csv } }));
  assert.equal(out.accepted, 1); assert.equal(out.errors.length, 1);
  const key = await f.credential('brand_hearth', ['catalog:write', 'catalog:read']);
  const v1 = await f.bearer(key, { method: 'POST', url: '/v1/catalog/csv', headers: { 'idempotency-key': 'csv-1' }, payload: { csv: 'sku,title,price\nH-CSV,Hearth csv,9.99\n' } });
  assert.equal(v1.statusCode, 200, v1.body); assert.equal(v1.json().data.accepted, 1);
  const viaMcp = await f.tool(key, 'upload_catalog_csv', { csv: 'sku,title,price\nH-MCP,Hearth mcp,5\n', idempotencyKey: 'mcp-csv-1' });
  assert.equal(viaMcp.accepted, 1);
  assert.equal((await f.domain.listProducts({ brandId: 'brand_hearth' })).find(p => p.sku === 'H-MCP').priceCents, 500);
  assert.equal((await f.owner({ method: 'POST', url: '/api/portal/brand_bloom/catalog/csv', payload: { csv: '' } })).statusCode, 422);
});

test('brand analytics: sales, conversion from swipes, returns and top products; tenant-scoped', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const orderId = await f.seedOrder();
  const s = await f.platform.crm.upsertShopper({ email: 'an@example.com' });
  await f.platform.crm.linkOrder(s.id, orderId);
  const lurker = await f.platform.crm.upsertShopper({ email: 'lurk@example.com' });
  const hearthProduct = (await f.domain.listProducts({ brandId: 'brand_hearth', status: 'approved' }))[0];
  await f.platform.crm.recordSwipe(s.id, hearthProduct.id, true);
  await f.platform.crm.recordSwipe(lurker.id, hearthProduct.id, true);
  const a = await f.ok(f.owner({ method: 'GET', url: '/api/brands/brand_hearth/analytics' }));
  const bag = await f.bagFor(orderId, 'brand_hearth');
  assert.equal(a.sales.bags, 1); assert.equal(a.sales.grossSalesCents, bag.subtotal_cents);
  assert.equal(a.conversion.swipers, 2); assert.equal(a.conversion.likedThenPurchased, 1); assert.equal(a.conversion.likeToPurchaseRate, 0.5);
  assert.equal(a.topProducts[0].sku, bag.items[0].sku);
  await f.platform.refundBag(bag.id, 'Return');
  const after = await f.platform.brands.analytics('brand_hearth');
  assert.equal(after.returns.refundedBags, 1); assert.equal(after.returns.returnRate, 1); assert.equal(after.sales.netSalesCents, 0);
  const key = await f.credential('brand_bloom', ['orders:read']);
  const own = await f.ok(f.bearer(key, { method: 'GET', url: '/v1/analytics' }));
  assert.equal(own.brandId, 'brand_bloom');
  assert.equal((await f.tool(key, 'get_brand_analytics')).brandId, 'brand_bloom');
});

test('paid placements: pricing, approval -> billing record, sponsored swipe feed caps impressions, cancellation voids billing', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const product = (await f.domain.listProducts({ brandId: 'brand_bloom', status: 'approved' }))[0];
  const draft = (await f.domain.listProducts({ brandId: 'brand_bloom' })).find(p => p.status !== 'approved');
  const key = await f.credential('brand_bloom', ['catalog:write', 'catalog:read', 'payouts:read']);
  const swipe = await f.bearer(key, { method: 'POST', url: '/v1/placements', headers: { 'idempotency-key': 'p1' }, payload: { kind: 'sponsored_swipe', productId: product.id, units: 1000 } });
  assert.equal(swipe.statusCode, 200, swipe.body);
  const placement = swipe.json().data; assert.equal(placement.priceCents, 1000); assert.equal(placement.status, 'requested');
  if (draft) assert.equal((await f.bearer(key, { method: 'POST', url: '/v1/placements', headers: { 'idempotency-key': 'p2' }, payload: { kind: 'featured_spot', productId: draft.id } })).statusCode, 409);
  const featured = await f.platform.brands.requestPlacement('brand_bloom', { kind: 'featured_spot', productId: product.id, startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() });
  assert.equal(featured.priceCents, 7500);
  const box = await f.tool(key, 'request_placement', { kind: 'sampling_box', productId: product.id, units: 100, idempotencyKey: 'mcp-p1' });
  assert.equal(box.priceCents, 15000);
  const decided = await f.ok(f.owner({ method: 'POST', url: `/api/placements/${placement.id}/decision`, payload: { decision: 'approved', method: 'payout_offset' } }));
  assert.equal(decided.billing.amountCents, 1000); assert.equal(decided.billing.method, 'payout_offset');
  assert.equal((await f.ok(f.owner({ method: 'POST', url: `/api/placements/${placement.id}/decision`, payload: { decision: 'approved' } }))).billing.id, decided.billing.id, 'decision is idempotent');
  const feed = await f.ok(f.owner({ method: 'GET', url: '/api/placements/feed/sponsored_swipe' }));
  assert.equal(feed.length, 1); assert.equal(feed[0].sponsored, true);
  await f.ok(f.owner({ method: 'POST', url: `/api/placements/${placement.id}/click` }));
  await f.db.query('UPDATE placements SET impressions=units WHERE id=$1', [placement.id]);
  assert.equal((await f.platform.brands.feed('sponsored_swipe')).length, 0, 'stops at purchased impressions');
  const f2 = await f.platform.brands.decidePlacement(featured.id, 'approved');
  const cancelled = await f.platform.brands.cancelPlacement('brand_bloom', featured.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await f.platform.brands.billing('brand_bloom')).find(b => b.id === f2.billing.id).status, 'void');
  await assert.rejects(f.platform.brands.cancelPlacement('brand_hearth', box.id), e => e.statusCode === 404);
  const billing = await f.ok(f.bearer(key, { method: 'GET', url: '/v1/billing' }));
  assert.equal(billing.length, 2);
  assert.equal((await f.ok(f.owner({ method: 'POST', url: `/api/billing/${decided.billing.id}/paid` }))).status, 'paid');
  const other = await f.credential('brand_lunelle', ['catalog:read', 'payouts:read']);
  assert.equal((await f.ok(f.bearer(other, { method: 'GET', url: '/v1/placements' }))).length, 0);
  assert.equal((await f.ok(f.bearer(other, { method: 'GET', url: '/v1/billing' }))).length, 0);
});
