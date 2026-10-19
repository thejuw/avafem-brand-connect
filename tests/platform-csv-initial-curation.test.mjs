import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';

const owner={owner:true,brandId:null,credentialId:'csv_fixture_owner'};
const clean={title:'Cotton cloth',description:'Plain cotton cloth.',category:'body-care/accessories',priceCents:1000,inventoryQty:5,
  images:['https://cdn.shopify.com/s/test/cloth.png'],taxCode:'txcd_99999999',evidence:{ingredients_inci:['Cotton'],claims:[],certifications:[],contraindications:''}};
const csv=sku=>`sku,title,description,category,price,inventoryQty,images,taxCode\n${sku},Cotton cloth,Plain cloth,body-care/accessories,10.00,5,https://cdn.shopify.com/s/test/cloth.png,txcd_99999999\n`;
async function connected(f,name) {
  const brand=await f.domain.createBrand({name});
  await f.domain.updateBrand(brand.id,{agreementSigned:true});
  await f.platform.onboarding.connect(brand.id,{platform:'csv'},owner);
  return brand.id;
}

test('actual CSV default-off first successful import consumes the opportunity; later opt-in/resync stays unlisted',async t=>{
  const f=await platformFixture(t),brandId=await connected(f,'CSV default-off fixture');
  const originalImport=f.platform.brands.importCsv.bind(f.platform.brands),results=[];
  t.mock.method(f.platform.brands,'importCsv',async(...args)=>{const result=await originalImport(...args);results.push(result);return result;});
  let state=await f.platform.onboarding.importCsv(brandId,{csv:csv('CSV-FIRST')},owner);
  assert.equal(state.catalog.approved,0);
  let brand=await f.domain.getBrand(brandId);assert.equal(brand.autoApproveProducts,false);assert.equal(brand.onboardingState.initialAutoApproveApplied,true);
  const first=(await f.domain.listProducts({brandId}))[0];assert.equal(first.sourceProvider,'csv');assert.equal(first.sourceCatalogKey,`csv:${brandId}`);assert.equal(first.sourceProductId,'CSV-FIRST');
  assert.deepEqual(results[0].acceptedProductIds,[first.id]);assert.equal(results[0].complete,false);
  assert.deepEqual(results[0].acceptedProducts,[{id:first.id,fingerprint:first.reviewFingerprint}]);
  assert.equal(first.status,'draft','basic CSV does not invent missing INCI/evidence');
  await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Enable policy after the completed initial import.'},owner);
  state=await f.platform.onboarding.importCsv(brandId,{csv:csv('CSV-LATER')},owner);
  assert.equal(state.catalog.approved,0);assert.equal((await f.domain.getProduct(first.id)).sourceDeletedAt,null,'partial CSV never delists absent rows');
  brand=await f.domain.getBrand(brandId);assert.equal(brand.onboardingState.initialAutoApproveApplied,true);
  const audit=(await f.db.query("SELECT action FROM curation_audit WHERE brand_id=$1 AND action IN('initial_autoapprove','initial_autoapprove_skipped')",[brandId])).rows;
  assert.deepEqual(audit,[{action:'initial_autoapprove_skipped'}]);
});

test('normalized CSV importer fixture: explicit opt-in approves only new clean valid initial rows, never later rows',async t=>{
  const f=await platformFixture(t),brandId=await connected(f,'CSV normalized initial fixture');
  await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Review only clean valid initial import products.'},owner);
  // A server-owned normalized importer fake exercises orchestration. This is not
  // a claim that the basic CSV parser supplies INCI or provider evidence.
  t.mock.method(f.platform.brands,'importCsv',async id=>{
    const acceptedProductIds=[],acceptedProducts=[];
    await f.domain.upsertProduct(id,'UNRELATED-COMMIT',clean);
    for(const [sku,input] of [['INITIAL-CLEAN',clean],['INITIAL-FLAG',{...clean,description:'A miracle cloth.'}],['INITIAL-INVALID',{...clean,evidence:{...clean.evidence,ingredients_inci:[]}}]]) {
      const p=await f.domain.upsertProduct(id,sku,input,{source:{provider:'csv',catalogKey:`csv:${id}`,productId:sku}});
      acceptedProductIds.push(p.id);acceptedProducts.push({id:p.id,fingerprint:p.reviewFingerprint});
    }
    return {total:3,accepted:3,acceptedProductIds,acceptedProducts,errors:[],complete:false};
  });
  await f.platform.onboarding.importCsv(brandId,{csv:'normalized fixture'},owner);
  let products=await f.domain.listProducts({brandId});
  assert.equal(products.find(p=>p.sku==='INITIAL-CLEAN').status,'approved');
  assert.equal(products.find(p=>p.sku==='INITIAL-FLAG').status,'in_review');assert.equal(products.find(p=>p.sku==='INITIAL-INVALID').status,'draft');
  assert.equal(products.find(p=>p.sku==='UNRELATED-COMMIT').status,'in_review','brand-wide concurrent/new IDs do not extend exact upload membership');
  t.mock.method(f.platform.brands,'importCsv',async id=>{
    const p=await f.domain.upsertProduct(id,'LATER-CLEAN',clean,{source:{provider:'csv',catalogKey:`csv:${id}`,productId:'LATER-CLEAN'}});
    return {total:1,accepted:1,acceptedProductIds:[p.id],acceptedProducts:[{id:p.id,fingerprint:p.reviewFingerprint}],errors:[],complete:false};
  });
  await f.platform.onboarding.importCsv(brandId,{csv:'later normalized fixture'},owner);
  products=await f.domain.listProducts({brandId});assert.equal(products.find(p=>p.sku==='LATER-CLEAN').status,'in_review');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM curation_audit WHERE brand_id=$1 AND action='initial_autoapprove'",[brandId])).rows[0].n,1);
});

test('incomplete CSV imports neither apply nor consume initial approval; a later successful import can consume once',async t=>{
  const f=await platformFixture(t),brandId=await connected(f,'CSV incomplete fixture');
  await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Only successful initial imports may use this policy.'},owner);
  const incomplete=csv('PARTIAL').trimEnd()+'\n,Missing SKU,,body,1,1,,\n';
  await assert.rejects(f.platform.onboarding.importCsv(brandId,{csv:incomplete},owner),e=>e.code==='CATALOG_IMPORT_INCOMPLETE');
  let brand=await f.domain.getBrand(brandId);assert.notEqual(brand.onboardingState.catalogImportComplete,true);assert.notEqual(brand.onboardingState.initialAutoApproveApplied,true);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM curation_audit WHERE brand_id=$1 AND action LIKE 'initial_autoapprove%'",[brandId])).rows[0].n,0);
  assert.equal((await f.domain.listProducts({brandId,status:'approved'})).length,0);
  await f.platform.onboarding.importCsv(brandId,{csv:csv('SUCCESS')},owner);
  brand=await f.domain.getBrand(brandId);assert.equal(brand.onboardingState.catalogImportComplete,true);assert.equal(brand.onboardingState.initialAutoApproveApplied,true);
  assert.equal((await f.domain.listProducts({brandId,status:'approved'})).length,0);
});

test('injected import without exact accepted IDs or fingerprints consumes the opportunity but cannot autoapprove rows',async t=>{
  const f=await platformFixture(t);
  t.mock.method(f.platform.brands,'importCsv',async(id,body)=>{
    const p=await f.domain.upsertProduct(id,'NO-PROOF',clean);
    return {total:1,accepted:1,...(body==='ids_only'?{acceptedProductIds:[p.id]}:{}),errors:[]};
  });
  for(const proof of ['none','ids_only']) {
    const brandId=await connected(f,`CSV missing ${proof} proof fixture`);
    await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Only exact server-owned import memberships are eligible.'},owner);
    await f.platform.onboarding.importCsv(brandId,{csv:proof},owner);
    assert.equal((await f.domain.listProducts({brandId}))[0].status,'in_review');
    assert.equal((await f.domain.getBrand(brandId)).onboardingState.initialAutoApproveApplied,true);
  }
});

test('concurrent CSV completions grant one initial opportunity; later completion cannot approve its new rows',async t=>{
  const f=await platformFixture(t),brandId=await connected(f,'CSV concurrent membership fixture');
  await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Only the first successful catalog completion is eligible.'},owner);
  let firstStarted,releaseFirst,helperStarted,releaseHelper,helperCalls=0;
  const firstReady=new Promise(resolve=>{firstStarted=resolve;}),firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const helperReady=new Promise(resolve=>{helperStarted=resolve;}),helperGate=new Promise(resolve=>{releaseHelper=resolve;});
  t.mock.method(f.platform.brands,'importCsv',async(id,body)=>{
    const p=await f.domain.upsertProduct(id,body,clean,{source:{provider:'csv',catalogKey:`csv:${id}`,productId:body}});
    if(body==='FINISHES-LATER'){firstStarted();await firstGate;}
    return {total:1,accepted:1,acceptedProductIds:[p.id],acceptedProducts:[{id:p.id,fingerprint:p.reviewFingerprint}],errors:[],complete:false};
  });
  const originalHelper=f.platform.curation.applyInitialAutoApprove.bind(f.platform.curation);
  t.mock.method(f.platform.curation,'applyInitialAutoApprove',async(...args)=>{
    helperCalls++;assert.equal(helperCalls,1,'only one under-lock initial completion may dispatch the helper');
    helperStarted();await helperGate;return originalHelper(...args);
  });
  const late=f.platform.onboarding.importCsv(brandId,{csv:'FINISHES-LATER'},owner);
  let initial;
  try {
    await firstReady;
    initial=f.platform.onboarding.importCsv(brandId,{csv:'INITIAL-COMPLETION'},owner);
    await helperReady;
    releaseFirst();await late;
    assert.equal(helperCalls,1);
    assert.equal((await f.domain.listProducts({brandId})).find(p=>p.sku==='FINISHES-LATER').status,'in_review');
  } finally {releaseFirst();releaseHelper();await late;if(initial)await initial;}
  const products=await f.domain.listProducts({brandId});
  assert.equal(products.find(p=>p.sku==='INITIAL-COMPLETION').status,'approved');assert.equal(products.find(p=>p.sku==='FINISHES-LATER').status,'in_review');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM curation_audit WHERE brand_id=$1 AND action='initial_autoapprove'",[brandId])).rows[0].n,1);
});

test('descriptive resync after accepted initial snapshot cannot be autoapproved through a fresh row reread',async t=>{
  const f=await platformFixture(t),brandId=await connected(f,'CSV changed initial fingerprint fixture');
  await f.platform.curation.setAutoApprove(brandId,{enabled:true,reason:'Only the exact clean imported snapshot is eligible.'},owner);
  let imported;
  t.mock.method(f.platform.brands,'importCsv',async id=>{
    imported=await f.domain.upsertProduct(id,'FINGERPRINT-RACE',clean,{source:{provider:'csv',catalogKey:`csv:${id}`,productId:'FINGERPRINT-RACE'}});
    return {total:1,accepted:1,acceptedProductIds:[imported.id],acceptedProducts:[{id:imported.id,fingerprint:imported.reviewFingerprint}],errors:[],complete:false};
  });
  const original=f.platform.curation.applyInitialAutoApprove.bind(f.platform.curation);
  t.mock.method(f.platform.curation,'applyInitialAutoApprove',async(...args)=>{
    assert.equal(args[3].expectedFingerprints[imported.id],imported.reviewFingerprint);
    await f.domain.upsertProduct(brandId,imported.sku,{title:'Resynced clean but unreviewed title'});
    return original(...args);
  });
  await f.platform.onboarding.importCsv(brandId,{csv:'normalized fingerprint fixture'},owner);
  const current=await f.domain.getProduct(imported.id);assert.equal(current.status,'in_review');assert.notEqual(current.reviewFingerprint,imported.reviewFingerprint);
  assert.equal((await f.domain.getBrand(brandId)).onboardingState.initialAutoApproveApplied,true);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND type='product.approved'",[imported.id])).rows[0].n,0);
});
