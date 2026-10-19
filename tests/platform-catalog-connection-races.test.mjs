import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';

const listing={sku:'STALE',externalId:'gid://shopify/Product/2',title:'Synthetic stale cloth',description:'Plain cotton cloth.',category:'body-care/accessories',
  priceCents:1200,inventoryQty:10,images:['https://cdn.shopify.com/s/test/cloth.png'],taxCode:'txcd_99999999',
  evidence:{ingredients_inci:['Cotton'],claims:[],certifications:[],contraindications:''}};

for(const empty of [false,true])test(`changed connection fences an old catalog ${empty?'deletion snapshot':'writer'} even when its lease token survives`,async t=>{
  const f=await platformFixture(t),b=await f.domain.createBrand({name:'Isolated connection race'}),key='shopify:old.myshopify.com';
  await f.db.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[b.id,JSON.stringify({platform:'shopify',connected:true,connectionVersion:'old_connection'})]);
  const initial=await f.platform.brands.importConnectedSnapshot(b.id,'shopify',key,[{...listing,sku:'BASE',externalId:'gid://shopify/Product/1'}],{complete:true});
  assert.equal(initial.accepted,1);
  let started,release;
  const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const pending=f.platform.brands.withCatalogSnapshot(b.id,'shopify',key,async()=>{started();await gate;return empty?[]:[listing];},{complete:true});
  await entered;
  // Reconnect to a newer instance of the same platform while preserving the
  // old worker's token; token/expiry checks alone cannot detect this change.
  await f.db.query("UPDATE brands SET onboarding_state=onboarding_state||$2::jsonb WHERE id=$1",[b.id,JSON.stringify({platform:'shopify',connected:true,connectionVersion:'new_connection',storeUrl:'https://new.myshopify.com'})]);
  release();
  if(empty)await assert.rejects(pending,e=>e.code==='STORE_CONNECTION_CHANGED');
  else {const result=await pending;assert.equal(result.accepted,0);assert.equal(result.complete,false);assert.equal(result.delisted,0);}
  const products=await f.domain.listProducts({brandId:b.id});
  assert.deepEqual(products.map(p=>p.sku),['BASE']);assert.equal(products[0].sourceDeletedAt,null);
  assert.equal((await f.domain.getBrand(b.id)).onboardingState.catalogLease,undefined);
});
