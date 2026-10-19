import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createDatabase} from '../server/db.mjs';
import {createDomain} from '../server/domain.mjs';
import {createBrandSide} from '../server/platform/brands.mjs';
import {createCuration} from '../server/platform/curation.mjs';
import {createCompliance,productReviewFingerprint} from '../server/platform/compliance.mjs';
import {createSubscriptions} from '../server/platform/commerce.mjs';
import {createBeautyBank,createConsole} from '../server/platform/money.mjs';
import {platformFixture} from './helpers/platform-fixture.mjs';

const postgresUrl=process.env.AVAFEM_TEST_POSTGRES_URL;
if (process.env.AVAFEM_REQUIRE_POSTGRES==='1' && !postgresUrl) throw new Error('AVAFEM_TEST_POSTGRES_URL is required for the PostgreSQL job.');
const options={skip:!postgresUrl,timeout:60_000};
const json=body=>({status:200,ok:true,json:async()=>body});
const curationListing=extra=>({title:'Postgres fixture body oil',description:'Unscented body oil.',category:'body-care/oil',priceCents:1000,inventoryQty:10,
  images:['https://images.example.com/pg-fixture.jpg'],evidence:{ingredients_inci:['Olive oil'],claims:[],certifications:[],contraindications:'External use only.'},taxCode:'txcd_99999999',...extra});
async function fixture(t) {
  const url=new URL(postgresUrl);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname),'Only an isolated loopback test server is allowed.');
  assert.equal(url.pathname,'/avafem_concurrency','Never run against an application or production database.');
  assert.equal(url.search,'','Connection query overrides are not allowed in the test server URL.');
  assert.equal(url.hash,'','Connection fragments are not allowed.');
  const schema=`avafem_test_${randomUUID().replaceAll('-','')}`;
  assert.match(schema,/^avafem_test_[a-f0-9]{32}$/);
  const control=new Pool({connectionString:url.href});
  let f,db,db2,schemaCreated=false;
  t.after(async()=>{
    try {if(f) await f.app.close();}
    finally {try {if(db) await db.close();}
      finally {try {if(db2) await db2.close();}
        finally {try {if(schemaCreated) await control.query(`DROP SCHEMA "${schema}" CASCADE`);}
          finally {await control.end();}}}}
  });
  await control.query(`CREATE SCHEMA "${schema}"`);schemaCreated=true;
  url.searchParams.set('options',`-c search_path=${schema}`);
  const worker1=new URL(url),worker2=new URL(url);
  worker1.searchParams.set('application_name',`${schema}_one`);worker2.searchParams.set('application_name',`${schema}_two`);
  db=await createDatabase({connectionString:worker1.href});db2=await createDatabase({connectionString:worker2.href});
  f=await platformFixture(t,{db});
  assert.equal(f.db.kind,'postgres');assert.equal(db2.kind,'postgres');
  return {...f,db2,control,worker2Name:`${schema}_two`};
}

test('real Postgres: independent connector workers reserve exactly one provider dispatch',options,async t=>{
  const f=await fixture(t),resolve=async()=>[{address:'93.184.216.34',family:4}];
  f.platform.brands.resolve=resolve;f.platform.brands.fetch=async()=>json({});
  await f.platform.brands.connect('brand_bloom','woocommerce',{storeUrl:'https://shop.example.com',consumerKey:'ck_fixture',consumerSecret:'cs_fixture'});
  const bag=await f.bagFor(await f.seedOrder(),'brand_bloom');
  let posts=0,entered,finish;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;});
  const fetch=async()=>{posts++;entered();await gate;return json({id:9001});};
  f.platform.brands.fetch=fetch;
  const other=createBrandSide(f.db2,{domain:f.domain,auth:f.auth,secret:f.config.encryptionKey,clock:f.clock,resolve,fetch});
  const first=f.platform.brands.pushOrder(bag.id);await started;
  try {await assert.rejects(other.pushOrder(bag.id),e=>e.code==='CONNECTOR_OUTCOME_UNCERTAIN');assert.equal(posts,1);}finally{finish();}
  await first;assert.equal(posts,1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_orders WHERE bag_id=$1',[bag.id])).rows[0].n,1);
});

test('real Postgres: concurrent renewal claims from separate pools call the simulated charger once',options,async t=>{
  const f=await fixture(t),s=await f.platform.crm.upsertShopper({email:'pg-renewal@example.invalid'});
  const sub=await f.platform.subscriptions.create(s.id,{items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16',qty:1}],shipTo:{name:'Synthetic',line1:'1 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'}});
  let calls=0,entered,finish;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{finish=r;});
  const charge=async input=>{calls++;entered();await gate;return {ok:true,ref:'pi_sim_pg_single',amountCents:input.amountCents};};
  f.platform.subscriptions.charge=charge;
  const other=createSubscriptions(f.db2,{clock:f.clock,domain:f.domain,crm:f.platform.crm,health:f.platform.health,bank:f.platform.bank,secret:f.config.encryptionKey,charge});
  const first=f.platform.subscriptions.runDue();await started;
  try {assert.deepEqual(await other.runDue(),[]);assert.equal(calls,1);}finally{finish();}
  assert.equal((await first)[0].status,'paid');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM subscription_runs WHERE subscription_id=$1 AND status='paid'",[sub.id])).rows[0].n,1);
});

test('real Postgres: credit expiry waits on a real row lock, reevaluates eligibility and books once',options,async t=>{
  const f=await fixture(t),s=await f.platform.crm.upsertShopper({email:'pg-credit@example.invalid'});
  const lot=await f.platform.bank.grantGoodwill(s.id,{amountCents:100,reason:'Postgres concurrency fixture'});
  f.advance(366);
  const other=createBeautyBank(f.db2,{clock:f.clock});
  const client=await f.control.connect();
  let waiting;
  try {
    await client.query('BEGIN');
    // Qualified relation: control deliberately does not share the application
    // advisory lock, so only real PostgreSQL row locking protects this race.
    const target=(await f.db.query('SELECT current_schema() AS schema')).rows[0].schema;
    assert.match(target,/^avafem_test_[a-f0-9]{32}$/);
    await client.query(`SELECT id FROM "${target}".bank_lots WHERE id=$1 FOR UPDATE`,[lot.id]);
    waiting=other.expire();
    const deadline=Date.now()+5000;let locked=false;
    while(Date.now()<deadline){
      const rows=(await f.control.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[f.worker2Name])).rows;
      if(rows.length){locked=true;break;}await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(locked,true,'the worker must actually wait on the held row lock');
    await client.query(`UPDATE "${target}".bank_lots SET expires_at=$2 WHERE id=$1`,[lot.id,new Date(f.clock().getTime()+86_400_000)]);
    await client.query('COMMIT');assert.equal(await waiting,0,'eligibility is rechecked after the concurrent row update');
  } finally {await client.query('ROLLBACK');client.release();}
  await f.db.query("UPDATE bank_lots SET expires_at=NOW()-interval '1 day' WHERE id=$1",[lot.id]);
  assert.equal((await Promise.all([f.platform.bank.expire(),other.expire()])).reduce((a,b)=>a+b,0),1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM bank_events WHERE lot_id=$1 AND kind='expired'",[lot.id])).rows[0].n,1);
  assert.equal((await f.platform.bank.liabilityReport()).balanced,true);
});

test('real Postgres: lost/won dispute races retain the hold and audited releases are exactly once',options,async t=>{
  const f=await fixture(t),bag=await f.bagFor(await f.seedOrder(),'brand_hearth');
  const other=createConsole(f.db2,{clock:f.clock,domain:f.domain,risk:f.platform.risk,secret:f.config.encryptionKey});
  const first=await f.platform.console.openDispute({externalId:'dp_pg_lost',bagId:bag.id});
  const second=await other.openDispute({externalId:'dp_pg_won',bagId:bag.id});
  await Promise.all([f.platform.console.resolveDispute(first.id,'lost'),other.resolveDispute(second.id,'won')]);
  const transfer=(await f.db.query('SELECT * FROM transfers WHERE bag_id=$1',[bag.id])).rows[0];
  assert.equal(transfer.status,'held');
  const proof={resolution:'operator_verified_recovery',reason:'Synthetic operator recovery verified for isolated concurrency test',idempotencyKey:'pg-recovery-once',recoveryReference:'mock_recovery_pg_001'};
  await Promise.all([f.platform.console.resolveLostDispute(first.id,proof,'test_operator'),other.resolveLostDispute(first.id,proof,'test_operator')]);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM financial_resolutions WHERE kind='lost_dispute'",[])).rows[0].n,1);
  f.advance(90);
  const input={reason:'Return hold elapsed and recovery verified in synthetic test',idempotencyKey:'pg-hold-release-once'};
  await Promise.all([f.platform.console.releaseHold(transfer.id,input,'test_operator'),other.releaseHold(transfer.id,input,'test_operator')]);
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1',[transfer.id])).rows[0].status,'scheduled');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM financial_resolutions WHERE kind='hold'",[])).rows[0].n,1);
});

test('real Postgres: verified void authorizes one replacement across independent connector workers',options,async t=>{
  const f=await fixture(t),side=f.platform.brands,resolve=async()=>[{address:'93.184.216.34',family:4}];
  side.resolve=resolve;side.fetch=async()=>json({});
  await side.connect('brand_bloom','woocommerce',{storeUrl:'https://shop.example.com',consumerKey:'ck_fixture',consumerSecret:'cs_fixture'});
  const bag=await f.domain.getBag((await f.bagFor(await f.seedOrder(),'brand_bloom')).id);
  const decimal=cents=>(cents/100).toFixed(2);
  let native,posts=0,gets=0,holdProof=false,proofEntered,releaseProof,createEntered,releaseCreate;
  const proofStarted=new Promise(r=>{proofEntered=r;}),proofGate=new Promise(r=>{releaseProof=r;});
  const createStarted=new Promise(r=>{createEntered=r;}),createGate=new Promise(r=>{releaseCreate=r;});
  const postedMarkers=[];
  const fetch=async(url,init={})=>{
    const u=new URL(url);
    assert.equal(u.origin,'https://shop.example.com');
    if(init.method==='POST'){
      assert.equal(u.pathname,'/wp-json/wc/v3/orders');posts++;
      const body=JSON.parse(init.body);postedMarkers.push(body.meta_data.find(m=>m.key==='avafem_dispatch_id')?.value);
      if(posts===1){
        const ship=bag.shipTo;
        native={id:8001,status:'cancelled',currency:'USD',total:decimal(bag.totalCents),shipping_total:decimal(bag.shippingCents),
          total_tax:decimal(bag.taxCents),discount_total:'0.00',meta_data:body.meta_data,
          line_items:bag.items.map(i=>({sku:i.sku,quantity:i.qty,total:decimal(i.unitPriceCents*i.qty)})),
          shipping:{first_name:ship.name,last_name:'',address_1:ship.line1,address_2:ship.line2 || '',city:ship.city,state:ship.region,postcode:ship.postal,country:ship.country},
          fee_lines:[],coupon_lines:[],refunds:[],date_paid:'2026-10-19T12:00:00',date_completed:null};
        throw new Error('Synthetic response loss after the fake provider accepted the original order.');
      }
      assert.equal(posts,2,'the single grant cannot produce a third remote order');
      createEntered();await createGate;return json({id:8002});
    }
    assert.equal(init.method || 'GET','GET');gets++;
    assert.ok(['/wp-json/wc/v3/orders/8001','/wp-json/wc/v3/orders/8001/fulfillments'].includes(u.pathname));
    if(holdProof && u.pathname.endsWith('/8001')){holdProof=false;proofEntered();await proofGate;}
    return json(u.pathname.endsWith('/fulfillments')?[]:native);
  };
  side.fetch=fetch;
  const other=createBrandSide(f.db2,{domain:f.domain,auth:f.auth,secret:f.config.encryptionKey,clock:f.clock,resolve,fetch});
  await assert.rejects(side.pushOrder(bag.id),e=>e.code==='CONNECTOR_OUTCOME_UNCERTAIN');
  const input={bagId:bag.id,operationId:'pg_connector_void_once',action:'void',externalId:'8001',
    reason:'Synthetic owner verified the exact cancelled native order and empty fulfillment history.',actor:'test_operator'};
  const resolved=await side.resolveRecovery(input);
  assert.equal(resolved.status,'retry_authorized');assert.equal(resolved.providerWrites,0);assert.equal(posts,1);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM connector_orders WHERE bag_id=$1',[bag.id])).rows[0].n,0);

  // Pause the second pool's fresh authoritative proof after its lease commits.
  // The first pool must see that durable lease, not merely an in-process mutex.
  holdProof=true;
  const retry=other.pushOrder(bag.id);
  try{
    await Promise.race([proofStarted,retry.then(()=>assert.fail('retry completed without its required proof read'))]);
    await assert.rejects(side.pushOrder(bag.id),e=>e.code==='RECOVERY_BUSY');assert.equal(posts,1);
    releaseProof();
    await Promise.race([createStarted,retry.then(()=>assert.fail('retry completed before its reserved replacement request'))]);
    const grant=(await f.db.query('SELECT status,retry_consumed_by FROM connector_order_recoveries WHERE operation_id=$1',[input.operationId])).rows[0];
    assert.equal(grant.status,'retry_consumed');assert.ok(grant.retry_consumed_by);
    await assert.rejects(side.pushOrder(bag.id),e=>e.code==='CONNECTOR_OUTCOME_UNCERTAIN');assert.equal(posts,2);
  }finally{releaseProof();releaseCreate();}
  assert.equal((await retry).externalId,'8002');
  const getsBeforeReplay=gets;
  assert.equal((await side.pushOrder(bag.id)).replayed,true);
  assert.equal((await other.resolveRecovery(input)).replayed,true);
  assert.equal(posts,2);assert.equal(gets,getsBeforeReplay);
  assert.ok(postedMarkers.every(Boolean));assert.notEqual(postedMarkers[0],postedMarkers[1]);
  const attempts=(await f.db.query('SELECT id,state,external_id FROM connector_dispatch_attempts WHERE bag_id=$1',[bag.id])).rows;
  assert.equal(attempts.length,2);assert.equal(attempts.find(a=>a.state==='voided').external_id,'8001');
  const created=attempts.find(a=>a.state==='created');assert.equal(created.external_id,'8002');
  const grant=(await f.db.query('SELECT status,retry_consumed_by FROM connector_order_recoveries WHERE operation_id=$1',[input.operationId])).rows[0];
  assert.equal(grant.status,'retry_consumed');assert.equal(grant.retry_consumed_by,created.id);
  const receipt=(await f.db.query('SELECT external_id FROM connector_orders WHERE bag_id=$1',[bag.id])).rows;
  assert.deepEqual(receipt,[{external_id:'8002'}]);
  const shared=(await f.db.query('SELECT state,external_order_id FROM external_orders WHERE bag_id=$1',[bag.id])).rows[0];
  assert.equal(shared.state,'connector_created');assert.equal(shared.external_order_id,'8002');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE resource_id=$1 AND action='connector.retry_reserved'",[bag.id])).rows[0].n,1);
});

test('real Postgres: concurrent exact-fingerprint curation operations commit one decision and immutable audit',options,async t=>{
  const f=await fixture(t),domain2=createDomain(f.db2,{clock:f.clock});
  const other=createCuration(f.db2,{domain:domain2,compliance:createCompliance(f.db2,{clock:f.clock}),clock:f.clock});
  const product=await f.domain.upsertProduct('brand_bloom','PG-CURATION-ONCE',curationListing());
  const actor={owner:true,brandId:null,credentialId:'postgres_curator'};
  const input={operationId:'postgres_curation_once',reason:'Exact fixture revision reviewed by an authorized test operator.',action:'approved',
    products:[{id:product.id,fingerprint:productReviewFingerprint(product)}]};
  const results=await Promise.all([f.platform.curation.bulk(input,actor),other.bulk(input,actor)]);
  assert.equal(results.filter(r=>r.replayed===true).length,1);
  assert.ok(results.every(r=>r.changed===1 && r.products[0].fingerprint===input.products[0].fingerprint));
  assert.equal((await f.domain.getProduct(product.id)).status,'approved');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM curation_operations WHERE operation_id=$1',[input.operationId])).rows[0].n,1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM curation_audit WHERE operation_id=$1 AND product_id=$2 AND action='approved'",[input.operationId,product.id])).rows[0].n,1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND type='product.approved'",[product.id])).rows[0].n,1);
});

test('real Postgres: catalog leases fence independent readers and expired writers cannot delist a newer snapshot',options,async t=>{
  const f=await fixture(t),domain2=createDomain(f.db2,{clock:f.clock});
  const other=createBrandSide(f.db2,{domain:domain2,auth:f.auth,secret:f.config.encryptionKey,clock:f.clock});
  const brand=await f.domain.createBrand({name:'Postgres isolated catalog fixture'}),key='shopify:postgres-fixture.myshopify.com';
  const row=(sku,num)=>curationListing({sku,externalId:`gid://shopify/Product/${num}`});
  await f.platform.brands.importConnectedSnapshot(brand.id,'shopify',key,[row('PG-BASE',1),row('PG-REMOVED',2)],{complete:true});
  let entered,release,otherReads=0;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const stale=f.platform.brands.withCatalogSnapshot(brand.id,'shopify',key,async()=>{entered();await gate;return [row('PG-STALE',3)];},{complete:true});
  let staleResult;
  try {
    await started;
    await assert.rejects(other.withCatalogSnapshot(brand.id,'shopify',key,async()=>{otherReads++;return [];},{complete:true}),e=>e.code==='CATALOG_IMPORT_BUSY');
    assert.equal(otherReads,0,'the second pool must be rejected before its provider read');
    await f.db2.query("UPDATE brands SET onboarding_state=jsonb_set(onboarding_state,'{catalogLease,expiresAt}',to_jsonb($2::text)) WHERE id=$1",[brand.id,'2000-01-01T00:00:00Z']);
    const newest=await other.withCatalogSnapshot(brand.id,'shopify',key,async()=>{otherReads++;return [row('PG-BASE',1),row('PG-NEWEST',4)];},{complete:true});
    assert.equal(newest.accepted,2);assert.equal(newest.delisted,1);assert.equal(otherReads,1);
  } finally {release();staleResult=await stale;}
  assert.equal(staleResult.accepted,0);assert.equal(staleResult.complete,false);assert.equal(staleResult.delisted,0);
  const products=await f.domain.listProducts({brandId:brand.id});
  assert.deepEqual(products.filter(p=>!p.sourceDeletedAt).map(p=>p.sku).sort(),['PG-BASE','PG-NEWEST']);
  assert.equal(products.some(p=>p.sku==='PG-STALE'),false);
  assert.equal((await f.domain.getBrand(brand.id)).onboardingState.catalogLease,undefined);
  const queue=await f.platform.curation.queue({brandId:brand.id});
  assert.equal(queue.products.some(p=>p.sku==='PG-REMOVED'),false,'delisted rows are not offered for approval');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE brand_id=$1 AND type='product.delisted'",[brand.id])).rows[0].n,1);
});
