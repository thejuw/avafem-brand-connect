import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDatabase} from '../server/db.mjs';
import {createDomain} from '../server/domain.mjs';
import {createCompliance,productReviewFingerprint} from '../server/platform/compliance.mjs';
import {createCuration} from '../server/platform/curation.mjs';
import {createBrandSide} from '../server/platform/brands.mjs';
import {exec} from '../server/platform/util.mjs';
import {woocommerceAdapter,bigcommerceAdapter} from '../server/platform/connectors.mjs';

const owner={owner:true,brandId:null,credentialId:'curator_fixture'};
const listing=(extra={})=>({title:'Simple body oil',description:'Unscented body oil.',category:'body-care/oil',priceCents:1000,inventoryQty:10,
  images:['https://images.example.com/oil.jpg'],evidence:{ingredients_inci:['Olive oil'],claims:[],certifications:[],contraindications:'External use only.'},taxCode:'txcd_99999999',...extra});
const shipTo={name:'Sandbox Shopper',line1:'1 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'};
async function fixture(t) {
  const db=await createDatabase({connectionString:null});t.after(()=>db.close());await db.migrate();
  await exec(db,await readFile(new URL('../server/platform/schema.sql',import.meta.url),'utf8'));
  let instant=new Date('2026-10-19T12:00:00Z');const clock=()=>instant;
  const domain=createDomain(db,{clock}),compliance=createCompliance(db,{clock});
  const curation=createCuration(db,{domain,compliance,clock});
  const brands=createBrandSide(db,{domain,compliance,clock,auth:{},secret:'curation-fixture-secret'});
  const brand=await domain.createBrand({name:'Curation fixture'});
  return {db,domain,compliance,curation,brands,brand,advance:days=>{instant=new Date(+instant+days*86_400_000);}};
}
const bulk=(product,extra={})=>({operationId:'curation_fixture_approval',reason:'Reviewed the exact product revision.',action:'approved',products:[{id:product.id,fingerprint:productReviewFingerprint(product)}],...extra});
async function connected(f) {
  await f.domain.updateBrand(f.brand.id,{agreementSigned:true,connectionTier:'dashboard',connectionHealthy:true});
  await f.db.query("INSERT INTO brand_connectors(brand_id,platform,store_ref,created_at) VALUES($1,'csv','fixture',$2)",[f.brand.id,new Date()]);
  await f.db.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[f.brand.id,JSON.stringify({connected:true,platform:'csv',profileVerified:true,catalogImportComplete:true})]);
}

test('policy defaults off, is admin-only and cannot be injected through public domain payloads',async t=>{
  const f=await fixture(t);
  assert.equal(f.brand.autoApproveProducts,false);
  await assert.rejects(f.curation.setAutoApprove(f.brand.id,{enabled:true,reason:'Trust this clean catalog.'},{brandId:f.brand.id}),e=>e.statusCode===403);
  await f.domain.updateBrand(f.brand.id,{autoApproveProducts:true,onboardingMode:'two_step',payoutSetup:'complete',onboardingState:{connected:true}});
  assert.equal((await f.domain.getBrand(f.brand.id)).autoApproveProducts,false);
  assert.equal((await f.domain.getBrand(f.brand.id)).onboardingMode,'legacy');
  const p=await f.domain.upsertProduct(f.brand.id,'NEW',listing({status:'approved'}));assert.equal(p.status,'in_review');
  await f.curation.setAutoApprove(f.brand.id,{enabled:true,reason:'Trust this clean initial catalog.'},owner);
  assert.equal((await f.db.query("SELECT * FROM curation_audit WHERE action='autoapprove_policy'")).rows.length,1);
});

test('clean connected brand can activate with unlisted invalid drafts and deferred payouts',async t=>{
  const f=await fixture(t);await connected(f);
  const p=await f.domain.upsertProduct(f.brand.id,'DRAFT',{title:'Plain body oil',description:'Oil',category:'body-care',priceCents:1000,inventoryQty:3});
  assert.equal(p.status,'draft');
  const b=await f.domain.activateConnectedBrand(f.brand.id,{actor:'system:onboarding'});
  assert.equal(b.status,'live');assert.equal(b.payoutSetup,'deferred');assert.equal(b.onboardingMode,'two_step');assert.deepEqual(b.onboardingRequirements,[]);
  assert.equal((await f.domain.getProduct(p.id)).status,'draft');
  await assert.rejects(f.domain.createSandboxOrder({items:[{brandId:b.id,sku:p.sku,qty:1}],shipTo}),e=>e.code==='PRODUCT_UNAVAILABLE');
  await assert.rejects(f.brands.activate(b.id),e=>e.code==='ONBOARDING_INCOMPLETE');
});

test('flagged catalog blocks brand activation even when exact product override exists',async t=>{
  const f=await fixture(t);await connected(f);
  const p=await f.domain.upsertProduct(f.brand.id,'FLAG',listing({description:'A miracle oil.'}));
  await f.compliance.override(p.id,'Operator reviewed this exact wording.','owner',productReviewFingerprint(p));
  await assert.rejects(f.domain.activateConnectedBrand(f.brand.id),e=>e.code==='ONBOARDING_COMPLIANCE_REVIEW');
});

test('bulk decisions require exact fingerprints and explicit override for warnings as well as blocks',async t=>{
  const f=await fixture(t);
  let p=await f.domain.upsertProduct(f.brand.id,'FLAG',listing({description:'A miracle oil.'}));
  await assert.rejects(f.domain.reviewProduct(p.id,{status:'approved'}),e=>e.code==='COMPLIANCE_BLOCKED');
  await assert.rejects(f.curation.bulk(bulk(p),owner),e=>e.code==='COMPLIANCE_OVERRIDE_REQUIRED');
  const request=bulk(p,{products:[{id:p.id,fingerprint:productReviewFingerprint(p),overrideReason:'Reviewed the substantiation and exact claim.'}]});
  const response=await f.curation.bulk(request,owner);assert.equal(response.changed,1);
  assert.equal((await f.curation.bulk(request,owner)).replayed,true);
  await assert.rejects(f.curation.bulk({...request,reason:'A different operator decision.'},owner),e=>e.code==='IDEMPOTENCY_CONFLICT');
  p=await f.domain.upsertProduct(f.brand.id,p.sku,{images:['https://images.example.com/revised.jpg']});
  assert.equal(p.status,'in_review');assert.equal((await f.compliance.check(p.id)).overridden,false);
  await assert.rejects(f.curation.bulk({...request,operationId:'curation_stale_approval'},owner),e=>e.code==='CURATION_STALE');
});

test('bulk stale selection rolls back all changes and filter decisions use current metadata',async t=>{
  const f=await fixture(t);
  const a=await f.domain.upsertProduct(f.brand.id,'A',listing({productType:'Oil',tags:['clean'],collections:['Summer']}));
  let b=await f.domain.upsertProduct(f.brand.id,'B',listing({productType:'Balm',tags:['other'],collections:['Winter']}));
  const old=productReviewFingerprint(b);b=await f.domain.upsertProduct(f.brand.id,'B',{title:'Revised balm'});
  await assert.rejects(f.curation.bulk(bulk(a,{products:[{id:a.id,fingerprint:productReviewFingerprint(a)},{id:b.id,fingerprint:old}]}),owner),e=>e.code==='CURATION_STALE');
  assert.equal((await f.domain.getProduct(a.id)).status,'in_review');
  const queue=await f.curation.queue({brandId:f.brand.id,collection:'Summer',productType:'Oil',tag:'clean',sinceReview:'new'});assert.deepEqual(queue.products.map(p=>p.id),[a.id]);
  const result=await f.curation.bulk({operationId:'curation_filter_approval',reason:'Reviewed summer collection products.',action:'approved',filter:{brandId:f.brand.id,collection:'Summer',tag:'clean'}},owner);
  assert.equal(result.changed,1);assert.equal((await f.domain.getProduct(b.id)).status,'in_review');
});

test('commercial edits preserve approval while all descriptive and evidence edits withdraw it',async t=>{
  const f=await fixture(t);let p=await f.domain.upsertProduct(f.brand.id,'A',listing());
  await f.curation.bulk(bulk(p),owner);
  p=await f.domain.upsertProduct(f.brand.id,p.sku,{priceCents:2000,inventoryQty:8});assert.equal(p.status,'approved');
  for(const patch of [{title:'A new title'},{images:['https://images.example.com/new.jpg']},{evidence:{...p.evidence,ingredients_inci:['Olive oil','Aqua']}},{evidence:{...p.evidence,claims:[{text:'Smooth feeling',source_url:'https://example.com/evidence',type:'structure'}]}}]) {
    p=await f.domain.upsertProduct(f.brand.id,p.sku,patch);assert.equal(p.status,'in_review');
    assert.equal((await f.curation.queue({brandId:f.brand.id,sinceReview:'changed'})).products.some(row=>row.id===p.id),true);
    p=await f.domain.reviewProduct(p.id,{status:'approved'});
  }
});

test('initial opt-in approves only clean valid products, consumes once, and never autoapproves resyncs',async t=>{
  const f=await fixture(t);await connected(f);await f.curation.setAutoApprove(f.brand.id,{enabled:true,reason:'Allow only this clean initial catalog.'},owner);
  const clean=await f.domain.upsertProduct(f.brand.id,'A',listing()),flag=await f.domain.upsertProduct(f.brand.id,'B',listing({description:'Miracle oil'}));
  const result=await f.curation.applyInitialAutoApprove(f.brand.id,[clean.id,flag.id],'system:onboarding',{expectedFingerprints:{[clean.id]:productReviewFingerprint(clean),[flag.id]:productReviewFingerprint(flag)}});assert.deepEqual(result.approved,[clean.id]);assert.deepEqual(result.skipped,[flag.id]);
  const later=await f.domain.upsertProduct(f.brand.id,'C',listing());assert.equal((await f.curation.applyInitialAutoApprove(f.brand.id,[later.id],'system:onboarding')).applied,false);
  assert.equal((await f.domain.getProduct(later.id)).status,'in_review');
});

test('default-off initial import cannot be retroactively autoapproved after a later sync',async t=>{
  const f=await fixture(t);await connected(f);const p=await f.domain.upsertProduct(f.brand.id,'A',listing());
  assert.equal((await f.curation.applyInitialAutoApprove(f.brand.id,[p.id],'system:onboarding')).enabled,false);
  await f.curation.setAutoApprove(f.brand.id,{enabled:true,reason:'Changed policy for future onboarding.'},owner);
  assert.equal((await f.curation.applyInitialAutoApprove(f.brand.id,[p.id],'system:onboarding')).applied,false);
  assert.equal((await f.domain.getProduct(p.id)).status,'in_review');
});

test('complete source snapshot delists absent imported rows only; partial/error snapshots preserve listings',async t=>{
  const f=await fixture(t),brandId=f.brand.id,key='shopify:fixture.myshopify.com';
  const manual=await f.domain.upsertProduct(brandId,'MANUAL',listing());
  let result=await f.brands.importConnectedSnapshot(brandId,'shopify',key,[{...listing(),sku:'A',externalId:'gid://shopify/Product/1'},{...listing(),sku:'B',externalId:'gid://shopify/Product/2'}],{complete:true});assert.equal(result.accepted,2);
  const list=await f.domain.listProducts({brandId});const a=list.find(p=>p.sku==='A'),b=list.find(p=>p.sku==='B');assert.deepEqual(result.acceptedProductIds.sort(),[a.id,b.id].sort());assert.deepEqual(result.acceptedProducts,[{id:a.id,fingerprint:productReviewFingerprint(a)},{id:b.id,fingerprint:productReviewFingerprint(b)}]);await f.domain.reviewProduct(a.id,{status:'approved'});await f.domain.reviewProduct(b.id,{status:'approved'});
  await f.brands.importConnectedSnapshot(brandId,'shopify',key,[],{complete:false});assert.equal((await f.domain.getProduct(a.id)).status,'approved');
  result=await f.brands.importConnectedSnapshot(brandId,'shopify',key,[{...listing(),sku:'MANUAL',externalId:'gid://shopify/Product/3'}],{complete:true});assert.equal(result.errors.length,1);assert.deepEqual(result.acceptedProductIds,[]);assert.equal((await f.domain.getProduct(a.id)).status,'approved');
  result=await f.brands.importConnectedSnapshot(brandId,'shopify',key,[{...listing(),sku:'A',externalId:'gid://shopify/Product/1'}],{complete:true});assert.equal(result.delisted,1);assert.equal((await f.domain.getProduct(a.id)).status,'approved');assert.equal((await f.domain.getProduct(b.id)).status,'draft');assert.ok((await f.domain.getProduct(b.id)).sourceDeletedAt);assert.equal((await f.domain.getProduct(manual.id)).sourceProvider,null);
  await assert.rejects(f.domain.reviewProduct(b.id,{status:'approved'}),e=>e.code==='PRODUCT_DELISTED');
  result=await f.brands.importConnectedSnapshot(brandId,'shopify',key,[{...listing(),sku:'A-RENAMED',externalId:'gid://shopify/Product/1'}],{complete:true});assert.equal(result.accepted,1);
  assert.equal((await f.domain.getProduct(a.id)).sku,'A-RENAMED');assert.equal((await f.domain.getProduct(a.id)).status,'in_review');assert.equal((await f.domain.listProducts({brandId})).filter(p=>p.sourceProductId==='gid://shopify/Product/1').length,1);
  assert.equal((await f.brands.importConnectedSnapshot(brandId,'shopify',key,[],{complete:true})).delisted,1);
});

test('deferred payout remains held from purchase through delivery and cannot release without verified setup',async t=>{
  const f=await fixture(t);await connected(f);await f.domain.activateConnectedBrand(f.brand.id);
  let p=await f.domain.upsertProduct(f.brand.id,'A',listing());p=await f.domain.reviewProduct(p.id,{status:'approved'});
  const order=await f.domain.createSandboxOrder({items:[{brandId:f.brand.id,sku:'A',qty:1}],shipTo});const bag=order.bags[0];
  assert.equal((await f.domain.listTransfers())[0].status,'held');assert.equal((await f.domain.listJobs())[0].status,'held');
  await f.domain.recordShipment(bag.id,{carrier:'Sandbox',trackingNumber:'CURATION_FIXTURE'});await f.domain.markDelivered(bag.id);
  f.advance(31);assert.equal((await f.domain.runDueSandboxPayouts()).processed,0);assert.equal((await f.domain.listTransfers())[0].status,'held');
  await f.db.query("UPDATE transfers SET status='scheduled' WHERE bag_id=$1",[bag.id]);await f.db.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1",[bag.id]);
  assert.equal((await f.domain.runDueSandboxPayouts()).processed,0);assert.equal((await f.domain.listTransfers())[0].status,'held');
});

test('catalog lease starts before reads, blocks concurrency and prevents expired snapshot writes/deletions',async t=>{
  const f=await fixture(t),key='shopify:fixture.myshopify.com';let resolveRead,started;
  const observed=new Promise(resolve=>{started=resolve;});const wait=new Promise(resolve=>{resolveRead=resolve;});
  const old=f.brands.withCatalogSnapshot(f.brand.id,'shopify',key,async()=>{started();await wait;return [{...listing(),sku:'OLD',externalId:'gid://shopify/Product/1'}];},{complete:true});
  await observed;
  await assert.rejects(f.brands.withCatalogSnapshot(f.brand.id,'shopify',key,async()=>{throw Error('must not read while busy');},{complete:true}),e=>e.code==='CATALOG_IMPORT_BUSY');
  await f.db.query("UPDATE brands SET onboarding_state=jsonb_set(onboarding_state,'{catalogLease,expiresAt}',to_jsonb($2::text)) WHERE id=$1",[f.brand.id,'2000-01-01T00:00:00Z']);
  const fresh=await f.brands.withCatalogSnapshot(f.brand.id,'shopify',key,async()=>[{...listing(),sku:'NEW',externalId:'gid://shopify/Product/2'}],{complete:true});assert.equal(fresh.accepted,1);
  resolveRead();const stale=await old;assert.equal(stale.accepted,0);assert.equal(stale.complete,false);assert.equal(stale.delisted,0);
  assert.deepEqual((await f.domain.listProducts({brandId:f.brand.id})).map(p=>p.sku),['NEW']);
  assert.equal((await f.domain.getBrand(f.brand.id)).onboardingState.catalogLease,undefined);
  await assert.rejects(f.brands.withCatalogSnapshot(f.brand.id,'shopify',key,async()=>{throw Object.assign(new Error('Read failed'),{code:'FIXTURE_READ_ERROR'});}),e=>e.code==='FIXTURE_READ_ERROR');
  assert.equal((await f.domain.getBrand(f.brand.id)).onboardingState.catalogLease,undefined,'read failure releases only own lease');
});

test('authenticated connector profile metadata never invents identity from a site URL',async()=>{
  const resolve=async()=>[{address:'93.184.216.34',family:4}],response=value=>({ok:true,status:200,json:async()=>value});
  const woo=woocommerceAdapter({resolve,fetch:async()=>response({environment:{site_url:'https://fixture.example.com'}})});
  assert.deepEqual(await woo.profile({storeUrl:'https://fixture.example.com',consumerKey:'ck_fixture',consumerSecret:'cs_fixture'}),{});
  const bc=bigcommerceAdapter({resolve,fetch:async()=>response({name:'Actual store',admin_email:'owner@example.com',logo:{url:'https://cdn.example.com/logo.png'}})});
  assert.deepEqual(await bc.profile({storeHash:'fixture',accessToken:'fixture-token'}),{name:'Actual store',contactEmail:'owner@example.com',logoUrl:'https://cdn.example.com/logo.png'});
});
