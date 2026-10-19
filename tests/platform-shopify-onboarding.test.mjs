import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {createShopifyAdapter} from '../server/integrations/shopify.mjs';

const shop='onboarding-fixture.myshopify.com';
test('Shopify profile transport reads only approved-scope display fields and checks exact store/USD',async()=>{
  let query;
  const fetch=async(url,init)=>{assert.equal(url,`https://${shop}/admin/api/2026-10/graphql.json`);query=JSON.parse(init.body).query;
    return {ok:true,status:200,json:async()=>({data:{shop:{name:'Synthetic shop',contactEmail:'store@example.com',myshopifyDomain:shop,currencyCode:'USD'}}})};};
  const adapter=createShopifyAdapter({shop,env:{},accessToken:'isolated-fixture-token',fetch,useKeychain:false});
  const p=await adapter.getStoreProfile();assert.equal(p.contactEmail,'store@example.com');assert.deepEqual(p.unavailableFields,['logoUrl','returnPolicy']);
  assert.doesNotMatch(query,/refundPolicy|shopPolicies|brand\s*{|customers|orders|mutation/);
  const bad=createShopifyAdapter({shop,env:{},accessToken:'isolated-fixture-token',useKeychain:false,fetch:async()=>({ok:true,status:200,json:async()=>({data:{shop:{myshopifyDomain:'other.myshopify.com',currencyCode:'USD'}}})})});
  await assert.rejects(bad.getStoreProfile(),e=>e.code==='SHOPIFY_SHOP_MISMATCH');
});

const row=(id,sku)=>({id:`gid://shopify/Product/${id}`,title:`Synthetic cloth ${id}`,description:'<p>Cotton cloth</p>',sku,priceCents:1000,inventoryQty:3,currency:'USD',images:['https://cdn.shopify.com/s/test/cloth.png'],
  variants:[],variantsPageInfo:{hasNextPage:false},imagesPageInfo:{hasNextPage:false},sourceStatus:'ACTIVE',source:{provider:'shopify',shop,productId:`gid://shopify/Product/${id}`}});
async function fixture(t){
  const f=await platformFixture(t),b=await f.domain.createBrand({name:'Native onboarding fixture'});
  await f.domain.updateBrand(b.id,{agreementSigned:true,connectionTier:'shopify',connectionHealthy:true});
  await f.db.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[b.id,JSON.stringify({platform:'shopify',storeUrl:`https://${shop}`})]);
  await f.db.query("INSERT INTO shopify_connections(brand_id,shop,status,installed_at) VALUES($1,$2,'connected',NOW())",[b.id,shop]);
  const adapter={preflight:async()=>({verified:true,connected:true,shop:{myshopifyDomain:shop,currencyCode:'USD'}}),getStoreProfile:async()=>({name:'Verified native fixture',contactEmail:'native@example.com'})};
  f.shopifyConnections.forBrand=async()=>adapter;
  return {...f,brand:b,adapter};
}
test('native Shopify onboarding exhausts a frozen complete catalog before import and separates activation/curation',async t=>{
  const f=await fixture(t),seen=[];
  f.adapter.listCompleteProducts=async({after})=>{seen.push(after);return {shop,completeChildren:true,products:[row(after?2:1,after?'CLOTH-2':'CLOTH-1')],pageInfo:{hasNextPage:!after,endCursor:after?'end':'page-2'}};};
  const state=await f.platform.onboarding.refreshStore(f.brand.id,{brandId:f.brand.id});
  assert.deepEqual(seen,[null,'page-2']);assert.equal(state.brand.status,'live');assert.equal(state.brand.name,'Verified native fixture');assert.equal(state.catalog.approved,0);
  const products=await f.domain.listProducts({brandId:f.brand.id});assert.equal(products.length,2);assert.ok(products.every(p=>p.sourceProvider==='shopify' && p.status!=='approved'));
  assert.equal(state.steps.payouts.status,'deferred');assert.equal((await f.domain.getBrand(f.brand.id)).payoutsEnabled,false);
});
test('incomplete, duplicated or stalled native Shopify pages cannot partially import or delist',async t=>{
  const f=await fixture(t);
  for(const malformed of ['children','duplicate','cursor']) {
    let calls=0;f.adapter.listCompleteProducts=async()=>{calls++;return {shop,completeChildren:malformed!=='children',products:[row(1,'CLOTH-1')],pageInfo:{hasNextPage:true,endCursor:'same'}};};
    await assert.rejects(f.platform.onboarding.refreshStore(f.brand.id),e=>e.code==='CATALOG_IMPORT_INCOMPLETE');
    assert.equal((await f.domain.listProducts({brandId:f.brand.id})).length,0);assert.ok(calls<=2);
  }
});
