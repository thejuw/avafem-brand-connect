import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {createProviderCatalog} from '../server/provider-catalog.mjs';
import {TEST_STORES} from '../server/test-stores.mjs';
import {SHOPIFY_ALLOWED_SCOPES} from '../server/integrations/shopify-policy.mjs';

const code=value=>e=>e.code===value;
const json=body=>({ok:true,status:200,json:async()=>body});
const own={model:'first_party',inventoryAuthority:'native',inventoryOwner:'avafem',fulfiller:'avafem',settlementModel:'retail',commissionBps:0};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const makeNative=f=>f.commerce.policies.saveBrand('brand_bloom',{expectedVersion:0,reason:'Explicit native inventory authority for workflow fence fixture.',...own},'owner');
async function commerceBag(f,extra={}) {
  const row=await f.bagFor(await f.seedOrder(),'brand_bloom');
  await f.db.query('UPDATE bags SET commerce_managed=true WHERE id=$1',[row.id]);
  if(extra.providerBound)await f.db.query('UPDATE bags SET commerce_managed=false,provider_bound=true WHERE id=$1',[row.id]);
  return f.domain.getBag(row.id);
}
async function shopify(f,brandId='brand_bloom') {
  const calls={preflight:0,list:0,create:0,find:0};
  Object.assign(f.operations.shopify,{
    preflight:async()=>{calls.preflight++;return {shop:{myshopifyDomain:'fence.myshopify.com'},missingScopes:[],unexpectedScopes:[]};},
    listProducts:async()=>{calls.list++;return {products:[],pageInfo:{hasNextPage:false}};},
    createOrder:async()=>{calls.create++;return {order:{id:'gid://shopify/Order/9001'}};},
    findOrder:async()=>{calls.find++;return {id:'gid://shopify/Order/9001'};},
  });
  await f.db.query(`INSERT INTO connector_state(provider,brand_id,details) VALUES('shopify',$1,$2)
    ON CONFLICT(provider) DO UPDATE SET brand_id=$1,details=$2`,[brandId,JSON.stringify({verified:true,shop:{myshopifyDomain:'fence.myshopify.com'}})]);
  return calls;
}

test('commerce Bags cannot enter legacy Shopify push, external receipt replay or locked-row dispatch',async t=>{
  const f=await platformFixture(t),bag=await commerceBag(f),calls=await shopify(f);
  await assert.rejects(f.operations.pushShopify(bag.id),code('COMMERCE_WORKFLOW_REQUIRED'));
  await f.db.query("INSERT INTO external_orders(bag_id,brand_id,shop,state,external_order_id) VALUES($1,$2,'fence.myshopify.com','created','gid://shopify/Order/9001')",[bag.id,bag.brandId]);
  await assert.rejects(f.operations.pushShopify(bag.id),code('COMMERCE_WORKFLOW_REQUIRED'));
  // Even a stale caller-side Bag cannot bypass the locked authoritative row.
  const original=f.domain.getBag;
  f.domain.getBag=async(...args)=>({...await original(...args),commerceManaged:false,taxCents:0});
  await assert.rejects(f.operations.pushShopify(bag.id),code('COMMERCE_WORKFLOW_REQUIRED'));
  assert.deepEqual(calls,{preflight:0,list:0,create:0,find:0});
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM shopify_order_attempts WHERE bag_id=$1',[bag.id])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT state FROM external_orders WHERE bag_id=$1',[bag.id])).rows[0].state,'created');
});

test('Woo and BigCommerce receipt replay and admin recovery reject commerce before repairing mappings or reading providers',async t=>{
  const f=await platformFixture(t),bag=await commerceBag(f);let requests=0;
  f.platform.brands.fetch=async()=>{requests++;throw new Error('Forbidden provider request');};
  for(const platform of ['woocommerce','bigcommerce']) {
    await f.db.query('INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at) VALUES($1,$2,$3,$4,NOW())',[bag.id,bag.brandId,platform,'8001']);
    await assert.rejects(f.platform.brands.pushOrder(bag.id),code('COMMERCE_WORKFLOW_REQUIRED'));
    assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM external_orders WHERE bag_id=$1',[bag.id])).rows[0].n,0,'receipt replay must not repair a mapping for commerce');
    await f.db.query('DELETE FROM connector_orders WHERE bag_id=$1',[bag.id]);
  }
  await f.db.query("INSERT INTO external_orders(bag_id,brand_id,shop,state) VALUES($1,$2,'woocommerce:https://shop.example.com','connector_uncertain')",[bag.id,bag.brandId]);
  assert.deepEqual(await f.platform.brands.listRecovery({bagId:bag.id}),[]);
  const input={bagId:bag.id,operationId:'commerce_recovery_replay',action:'confirm',externalId:'8001',reason:'Synthetic previously verified recovery receipt.',actor:'owner'};
  await f.db.query(`INSERT INTO connector_dispatch_attempts(id,bag_id,brand_id,platform,target_ref,state,snapshot_enc,snapshot_hash,created_at,updated_at)
    VALUES('cda_commerce_fixture',$1,$2,'woocommerce','woocommerce:https://shop.example.com','uncertain','fixture',$3,NOW(),NOW())`,[bag.id,bag.brandId,'0'.repeat(64)]);
  await f.db.query(`INSERT INTO connector_order_recoveries(operation_id,bag_id,attempt_id,action,external_id,request_hash,reason_enc,actor,status,result,created_at,updated_at)
    VALUES($1,$2,'cda_commerce_fixture','confirm','8001',$3,'fixture','owner','confirmed',$4,NOW(),NOW())`,[input.operationId,bag.id,hash(input),JSON.stringify({status:'confirmed',bagId:bag.id})]);
  await assert.rejects(f.platform.brands.resolveRecovery(input),code('COMMERCE_WORKFLOW_REQUIRED'));
  assert.equal(requests,0);
  assert.equal((await f.db.query('SELECT state FROM external_orders WHERE bag_id=$1',[bag.id])).rows[0].state,'connector_uncertain');
});

test('providerBound remains a separate explicit fence in Shopify, connector replay and handoff',async t=>{
  const f=await platformFixture(t),bag=await commerceBag(f,{providerBound:true}),calls=await shopify(f);
  await assert.rejects(f.operations.pushShopify(bag.id),code('PROVIDER_WORKFLOW_REQUIRED'));
  await f.db.query("INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at) VALUES($1,$2,'woocommerce','8001',NOW())",[bag.id,bag.brandId]);
  await assert.rejects(f.platform.brands.pushOrder(bag.id),code('PROVIDER_WORKFLOW_REQUIRED'));
  assert.equal(calls.create,0);
  const token='provider-bound-handoff-fixture';
  await f.db.query("INSERT INTO handoff_links(token_hash,event_id,bag_id,brand_id,expires_at) VALUES($1,'event_provider_fixture',$2,$3,NOW()+interval '1 hour')",[hash(token),bag.id,bag.brandId]);
  await assert.rejects(f.operations.getHandoff(token),code('PROVIDER_WORKFLOW_REQUIRED'));
});

test('commerce namespace and forged legacy events create no handoff or outbound deliveries; old deliveries cannot be replayed',async t=>{
  const f=await platformFixture(t),bag=await commerceBag(f);
  await f.db.query("UPDATE outbox_events SET status='delivered'");
  const legacy='evt_commerce_legacy_fixture',native='evt_commerce_namespace_fixture',endpoint='whe_commerce_fixture';
  for(const [eventId,type] of [[legacy,'bag.created'],[native,'commerce.bag.created']])
    await f.db.query('INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload) VALUES($1,$2,$3,$4,$5)',[eventId,type,bag.id,bag.brandId,JSON.stringify({bagId:bag.id,simulated:true})]);
  // Private literal URL ensures even a failing regression cannot contact any
  // actual endpoint; a proper fence rejects it before URL/DNS/transport work.
  await f.db.query('INSERT INTO outbound_webhook_endpoints(id,brand_id,url,secret_encrypted) VALUES($1,$2,$3,$4)',[endpoint,bag.brandId,'https://127.0.0.1/forbidden',f.auth.encrypt({secret:'fixture-secret'})]);
  await f.db.query("INSERT INTO webhook_deliveries(id,event_id,endpoint_id,brand_id) VALUES('whd_commerce_stale',$1,$2,$3)",[legacy,endpoint,bag.brandId]);
  let network=0;t.mock.method(globalThis,'fetch',async()=>{network++;throw new Error('No external request allowed');});
  await f.operations.runJobs();
  assert.equal(network,0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM handoff_links WHERE bag_id=$1',[bag.id])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM sandbox_inbox WHERE bag_id=$1',[bag.id])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE event_id=$1',[native])).rows[0].n,0);
  const delivery=(await f.db.query("SELECT status,last_error FROM webhook_deliveries WHERE id='whd_commerce_stale'")).rows[0];
  assert.deepEqual(delivery,{status:'failed',last_error:'COMMERCE_WORKFLOW_REQUIRED'});
  for(const eventId of [legacy,native])await assert.rejects(f.operations.replayEvent(eventId,bag.brandId),code('COMMERCE_WORKFLOW_REQUIRED'));
  const token='commerce-old-handoff-fixture';
  await f.db.query("INSERT INTO handoff_links(token_hash,event_id,bag_id,brand_id,expires_at) VALUES($1,'event_commerce_fixture',$2,$3,NOW()+interval '1 hour')",[hash(token),bag.id,bag.brandId]);
  await assert.rejects(f.operations.getHandoff(token),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.operations.submitHandoff(token,{carrier:'USPS',trackingNumber:'NEVER'}),code('COMMERCE_WORKFLOW_REQUIRED'));
});

test('native first-party policy blocks connector, CSV/feed and Shopify imports before provider calls or catalog writes',async t=>{
  const f=await platformFixture(t),calls=await shopify(f);let requests=0,sourceReads=0;
  const product=(await f.domain.listProducts({brandId:'brand_bloom'}))[0],baseline=structuredClone(product);
  await makeNative(f);
  f.platform.brands.fetch=async()=>{requests++;return json({});};
  f.platform.brands.resolve=async()=>[{address:'93.184.216.34',family:4}];
  for(const provider of ['shopify','woocommerce','bigcommerce','csv','feed'])
    await assert.rejects(f.platform.brands.withCatalogSnapshot('brand_bloom',provider,`${provider}:fixture`,async()=>{sourceReads++;return [];},{complete:true}),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.platform.brands.connect('brand_bloom','woocommerce',{storeUrl:'https://shop.example.com',consumerKey:'ck_fake',consumerSecret:'cs_fake'}),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.platform.brands.importCsv('brand_bloom','sku,title\nOVERWRITE,Forbidden'),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.platform.brands.stripeLink('brand_bloom'),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.platform.brands.stripeReturn('brand_bloom'),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.operations.enqueueImport('brand_bloom',{rows:[{sku:product.sku,title:'Forbidden',inventoryQty:0}]}),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.operations.importShopify(),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.operations.importShopify('brand_bloom'),code('COMMERCE_WORKFLOW_REQUIRED'));
  await assert.rejects(f.operations.preflightShopify(),code('COMMERCE_WORKFLOW_REQUIRED'));
  assert.deepEqual(await f.domain.getProduct(product.id),baseline);
  assert.deepEqual(calls,{preflight:0,list:0,create:0,find:0});assert.equal(requests,0);assert.equal(sourceReads,0);
});

test('a policy changed during an external snapshot fences every upsert and complete-snapshot retirement',async t=>{
  const f=await platformFixture(t),product=(await f.domain.listProducts({brandId:'brand_bloom'}))[0],baseline=structuredClone(product);
  const result=await f.platform.brands.withCatalogSnapshot('brand_bloom','woocommerce','woocommerce:https://shop.example.com',async()=>{
    await makeNative(f);
    return [{...product,externalId:'provider_original_001',title:'Forbidden replacement',inventoryQty:0}];
  },{complete:true});
  assert.equal(result.accepted,0);assert.equal(result.complete,false);assert.equal(result.delisted,0);assert.equal(result.errors.length,1);
  assert.deepEqual(await f.domain.getProduct(product.id),baseline);
  assert.equal((await f.domain.getBrand('brand_bloom')).onboardingState.catalogLease,undefined);
});

test('queued legacy imports and old Shopify events cannot overwrite or disconnect a now-native brand',async t=>{
  const f=await platformFixture(t),product=(await f.domain.listProducts({brandId:'brand_bloom'}))[0],baseline=structuredClone(product),calls=await shopify(f);
  const job=await f.operations.enqueueImport('brand_bloom',{rows:[{sku:product.sku,title:'Forbidden queued replacement',priceCents:1,inventoryQty:0}]});
  await makeNative(f);
  const brand=await f.domain.getBrand('brand_bloom');
  await f.operations.saveInbound('shopify','native_old_app_uninstalled','app/uninstalled',Buffer.from('{}'),'fence.myshopify.com');
  await f.operations.runJobs();
  const imported=(await f.db.query('SELECT accepted,errors,status FROM catalog_imports WHERE id=$1',[job.id])).rows[0];
  assert.equal(imported.accepted,0);assert.equal(imported.status,'completed');assert.equal(imported.errors.length,1);
  assert.deepEqual(await f.domain.getProduct(product.id),baseline);
  assert.equal((await f.domain.getBrand('brand_bloom')).status,brand.status);
  assert.equal((await f.db.query("SELECT status FROM inbound_webhooks WHERE delivery_id='native_old_app_uninstalled'")).rows[0].status,'failed');
  assert.deepEqual(calls,{preflight:0,list:0,create:0,find:0});
});

async function providerCatalog(f) {
  const shop=TEST_STORES[0].shop,calls={adapter:0,preflight:0,list:0},control={read:null};
  const source={id:'gid://shopify/Product/1001',source:{provider:'shopify',shop,productId:'gid://shopify/Product/1001'},
    title:'Fixture provider catalog',description:'Synthetic provider source.',sku:'FENCE-PROVIDER-SKU',priceCents:100,currency:'USD',images:[],sourceStatus:'ACTIVE',
    variants:[{id:'gid://shopify/ProductVariant/2001',sku:'FENCE-PROVIDER-SKU',price:{amount:100,currency:'USD'},inventory:{qty:4,policy:'deny'},tracked:true,requiresShipping:true}],
    variantsPageInfo:{hasNextPage:false},imagesPageInfo:{hasNextPage:false}};
  const page=products=>({shop,products,completeChildren:true,pageInfo:{hasNextPage:false}});
  const adapter={shop,preflight:async()=>{calls.preflight++;return {shop:{myshopifyDomain:shop,currencyCode:'USD'},grantedScopes:[...SHOPIFY_ALLOWED_SCOPES]};},
    listCompleteProducts:async()=>{calls.list++;return control.read?control.read():page([source]);}};
  const stores={row:async()=>({shop,brand_id:'brand_bloom',state:'connected'}),forShop:async()=>{calls.adapter++;return adapter;}};
  return {shop,calls,control,page,service:await createProviderCatalog(f.db,f.domain,{stores})};
}

test('special three-store provider catalog refuses native authority before any adapter or provider read',async t=>{
  const f=await platformFixture(t),catalog=await providerCatalog(f);await makeNative(f);
  const before=await f.domain.listProducts({brandId:'brand_bloom'});
  await assert.rejects(catalog.service.sync({shop:catalog.shop}),code('COMMERCE_WORKFLOW_REQUIRED'));
  assert.deepEqual(catalog.calls,{adapter:0,preflight:0,list:0});
  assert.deepEqual(await f.domain.listProducts({brandId:'brand_bloom'}),before);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM provider_catalog_products')).rows[0].n,0);
});

test('special provider snapshot cannot retire canonical rows after authority changes while the read is in flight',async t=>{
  const f=await platformFixture(t),catalog=await providerCatalog(f);
  await catalog.service.sync({shop:catalog.shop});
  const before=await f.domain.listProducts({brandId:'brand_bloom'}),mappings=(await f.db.query('SELECT * FROM provider_catalog_products')).rows;
  catalog.control.read=async()=>{await makeNative(f);return catalog.page([]);};
  await assert.rejects(catalog.service.sync({shop:catalog.shop}),code('COMMERCE_WORKFLOW_REQUIRED'));
  assert.deepEqual(await f.domain.listProducts({brandId:'brand_bloom'}),before);
  assert.deepEqual((await f.db.query('SELECT * FROM provider_catalog_products')).rows,mappings);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM provider_catalog_locks')).rows[0].n,0);
});

test('native brands never publish legacy parent stock counters; unrelated partner catalog deliveries remain enabled',async t=>{
  const f=await platformFixture(t);await makeNative(f);
  await f.db.query("UPDATE outbox_events SET status='delivered'");
  let transportCalls=0;t.mock.method(globalThis,'fetch',async()=>{transportCalls++;throw new Error('No external request permitted');});
  for(const [brandId,suffix] of [['brand_bloom','native'],['brand_lunelle','partner']]) {
    await f.db.query('INSERT INTO outbound_webhook_endpoints(id,brand_id,url,secret_encrypted,scopes) VALUES($1,$2,$3,$4,$5)',
      [`whe_catalog_${suffix}`,brandId,'https://127.0.0.1/forbidden',f.auth.encrypt({secret:'fixture-secret'}),JSON.stringify(['catalog:read'])]);
    await f.db.query("INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload) VALUES($1,'inventory.changed','fixture-product',$2,$3)",
      [`evt_catalog_${suffix}`,brandId,JSON.stringify({inventoryQty:999,sku:'STALE-PARENT-COUNTER'})]);
  }
  // Simulate a delivery queued before a brand switched to explicit native stock.
  await f.db.query("INSERT INTO webhook_deliveries(id,event_id,endpoint_id,brand_id) VALUES('whd_native_parent_stale','evt_catalog_native','whe_catalog_native','brand_bloom')");
  await f.operations.runJobs();
  assert.equal(transportCalls,0,'private literal fixture endpoints never perform network I/O');
  assert.deepEqual((await f.db.query("SELECT status,last_error FROM webhook_deliveries WHERE id='whd_native_parent_stale'")).rows[0],{status:'failed',last_error:'COMMERCE_WORKFLOW_REQUIRED'});
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE event_id='evt_catalog_native'")).rows[0].n,1);
  const partner=(await f.db.query("SELECT status,attempts,last_error FROM webhook_deliveries WHERE event_id='evt_catalog_partner'")).rows[0];
  assert.ok(partner,'a normal partner catalog delivery is still scheduled');assert.equal(partner.status,'pending');assert.equal(partner.attempts,1);
  assert.notEqual(partner.last_error,'COMMERCE_WORKFLOW_REQUIRED');
  await assert.rejects(f.operations.replayEvent('evt_catalog_native','brand_bloom'),code('COMMERCE_WORKFLOW_REQUIRED'));
});
