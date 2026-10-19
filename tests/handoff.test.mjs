import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const data=response=>response.json().data;
const code=response=>response.json().error?.code;
const status=(response,expected)=>assert.equal(response.statusCode,expected,response.body);

async function fixture(t,{relay=true}={}) {
  const app=await createApp({worker:false,seed:true,connectionString:null,
    config:{host:'127.0.0.1',port:4317,allowLocalBootstrap:true,
      sessionSecret:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')},
    integrations:{
      shopify:{status:async()=>({available:false,shop:'handoff-test.myshopify.com'}),preflight:async()=>{throw new Error('No provider calls in handoff tests.');},verifyWebhook:async()=>false},
      stripe:{status:async()=>({available:false,mode:'test'}),verifyWebhook:async()=>{throw new Error('No provider calls in handoff tests.');}},
    },
  });
  t.after(()=>app.close()); await app.ready();
  const request=options=>app.inject({...options,headers:{host:'localhost:4317',...options.headers}});
  const {db,domain,auth,operations}=app.avafem;
  if (relay) await operations.runJobs();
  const bag=(await domain.listBags({brandId:'brand_bloom'}))[0];
  const inbox=(await db.query('SELECT * FROM sandbox_inbox WHERE bag_id=$1',[bag.id])).rows[0];
  if (inbox?.body.encryptedBody) inbox.body=auth.decrypt(inbox.body.encryptedBody);
  const path=inbox?.body.handoffPath;
  const token=path?.split('/').at(-1);
  return {app,request,db,domain,auth,operations,bag,inbox,path,token,url:token?`/api/handoffs/${token}`:null};
}

test('public invite preview exposes minimal brand data without creating a session or consuming the invite',async t=>{
  const {request,auth,db}=await fixture(t,{relay:false});
  const invite=await auth.createInvite('brand_bloom');
  const before=(await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions')).rows[0].count;
  const preview=await request({method:'GET',url:`/api/invites/${invite.token}`});
  status(preview,200);
  assert.deepEqual(data(preview).brand,{id:'brand_bloom',name:'Bloom Botanics'});
  assert.deepEqual(Object.keys(data(preview)).sort(),['brand','expiresAt','sandbox']);
  assert.equal(data(preview).sandbox,true); assert.ok(new Date(data(preview).expiresAt)>new Date());
  assert.equal(preview.headers['set-cookie'],undefined); assert.equal(preview.headers['cache-control'],'no-store');
  status(await request({method:'GET',url:`/api/invites/${invite.token}`}),200);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions')).rows[0].count,before);
  assert.equal((await db.query('SELECT consumed_at FROM brand_invites WHERE token_hash=$1',[hash(invite.token)])).rows[0].consumed_at,null);
});

test('invalid, expired and consumed invitation tokens fail without bootstrapping an owner',async t=>{
  const {request,auth,db}=await fixture(t,{relay:false});
  const invalid=await request({method:'GET',url:'/api/invites/not-a-valid-token'});
  status(invalid,401); assert.equal(code(invalid),'INVITE_EXPIRED'); assert.equal(invalid.headers['set-cookie'],undefined);
  const expired=await auth.createInvite('brand_bloom');
  await db.query("UPDATE brand_invites SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(expired.token)]);
  status(await request({method:'GET',url:`/api/invites/${expired.token}`}),401);
  status(await request({method:'POST',url:`/api/invites/${expired.token}/accept`,payload:{acceptedSandboxTerms:true}}),401);
  const invite=await auth.createInvite('brand_bloom');
  const accepted=await request({method:'POST',url:`/api/invites/${invite.token}/accept`,payload:{acceptedSandboxTerms:true}});
  status(accepted,200); assert.equal(data(accepted).role,'brand'); assert.match(String(accepted.headers['set-cookie']),/HttpOnly/i);
  status(await request({method:'GET',url:`/api/invites/${invite.token}`}),401);
  status(await request({method:'POST',url:`/api/invites/${invite.token}/accept`,payload:{acceptedSandboxTerms:true}}),401);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions WHERE owner=true')).rows[0].count,0);
});

test('a token-only shipping preview has minimal fulfillment data and does not consume the link',async t=>{
  const {request,url,token,bag,db}=await fixture(t);
  assert.ok(token); const preview=await request({method:'GET',url}); status(preview,200);
  const safe=data(preview).bag;
  assert.equal(safe.bag_id,bag.id); assert.equal(safe.sandbox,true); assert.ok(safe.items.length); assert.ok(safe.ship_to.line1);
  for (const key of ['customerEmail','email','health','cycleDay','commissionCents','transfer','credit','brandId']) assert.equal(safe[key],undefined);
  assert.equal(preview.headers['set-cookie'],undefined); assert.equal(preview.headers['cache-control'],'no-store');
  status(await request({method:'GET',url}),200);
  const stored=(await db.query('SELECT * FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0];
  assert.equal(stored.used_at,null); assert.equal(stored.bag_id,bag.id); assert.notEqual(stored.token_hash,token);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions')).rows[0].count,0);
});

test('unknown and expired handoff tokens cannot read or ship a Bag',async t=>{
  const {request,url,token,db,bag}=await fixture(t);
  status(await request({method:'GET',url:'/api/handoffs/unknown-token'}),401);
  status(await request({method:'POST',url:'/api/handoffs/unknown-token/shipments',payload:{carrier:'USPS',trackingNumber:'UNKNOWN'}}),401);
  await db.query("UPDATE handoff_links SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(token)]);
  const expired=await request({method:'GET',url}); status(expired,401); assert.equal(code(expired),'HANDOFF_EXPIRED');
  status(await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'EXPIRED'}}),401);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,0);
});

test('one-use handoff shipment is atomic under concurrent submissions and later replay fails',async t=>{
  const {request,url,token,db,bag,domain}=await fixture(t);
  const outcomes=await Promise.all(['CONCURRENT-A','CONCURRENT-B'].map(trackingNumber=>request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber}})));
  assert.deepEqual(outcomes.map(response=>response.statusCode).sort(),[200,401],outcomes.map(response=>response.body).join('\n'));
  const success=outcomes.find(response=>response.statusCode===200);
  assert.equal(data(success).status,'shipped'); assert.equal(data(success).bag.bag_id,bag.id);
  assert.equal(success.headers['set-cookie'],undefined);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,1);
  assert.ok((await db.query('SELECT used_at FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0].used_at);
  assert.equal((await domain.getBag(bag.id)).status,'shipped');
  status(await request({method:'GET',url}),401);
  status(await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'CONCURRENT-A'}}),401);
});

test('invalid shipment input rolls back link consumption and leaves a valid link usable',async t=>{
  const {request,url,token,db,bag}=await fixture(t);
  status(await request({method:'POST',url:`${url}/shipments`,payload:{trackingNumber:'MISSING-CARRIER'}}),422);
  // Valid HTTP URL passes transport validation but is rejected by domain policy
  // inside the same transaction that would consume the handoff token.
  status(await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'BAD-URL',trackingUrl:'http://example.com/tracking'}}),422);
  assert.equal((await db.query('SELECT used_at FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0].used_at,null);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,0);
  status(await request({method:'GET',url}),200);
  status(await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'VALID-AFTER-ERROR'}}),200);
});

test('pending refunds block token and authenticated shipments without consuming the token',async t=>{
  const {request,url,token,db,bag,domain,auth}=await fixture(t);
  await domain.requestRefund(bag.id,{reason:'Refund awaiting operator approval'});
  const preview=await request({method:'GET',url}); status(preview,409); assert.equal(code(preview),'REFUND_PENDING');
  const shipment={carrier:'USPS',trackingNumber:'REFUND-HOLD'};
  const submitted=await request({method:'POST',url:`${url}/shipments`,payload:shipment});
  status(submitted,409); assert.equal(code(submitted),'REFUND_PENDING');
  const credential=await auth.createCredential(bag.brandId,{scopes:['orders:fulfill']});
  const authenticated=await request({method:'POST',url:`/v1/bags/${bag.id}/shipments`,
    headers:{authorization:`Bearer ${credential.apiKey}`,'idempotency-key':'refund-shipment-hold'},payload:shipment});
  status(authenticated,409); assert.equal(code(authenticated),'REFUND_PENDING');
  await assert.rejects(domain.recordShipment(bag.id,shipment),error=>error.statusCode===409 && error.code==='REFUND_PENDING');
  assert.equal((await db.query('SELECT used_at FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0].used_at,null);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,0);
});

test('a handoff token cannot be redirected to another brand or Bag by posted IDs',async t=>{
  const {request,url,bag,domain}=await fixture(t);
  const foreign=await domain.createSandboxOrder({items:[{brandId:'brand_lunelle',sku:'LUNELLE-CUP',qty:1}],
    shipTo:{name:'Another Shopper',line1:'1 Test Lane',city:'Austin',region:'TX',postal:'78701',country:'US'}});
  const response=await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'BOUND-TOKEN',bagId:foreign.bags[0].id,brandId:'brand_lunelle'}});
  status(response,200); assert.equal(data(response).bag.bag_id,bag.id);
  assert.equal((await domain.getBag(bag.id)).status,'shipped');
  assert.equal((await domain.getBag(foreign.bags[0].id)).status,'awaiting_shipment');
});

test('another fulfillment path invalidates the token and outbox replay never creates another link',async t=>{
  const {request,url,token,path,bag,domain,db,operations,auth}=await fixture(t);
  await domain.recordShipment(bag.id,{carrier:'USPS',trackingNumber:'DASHBOARD-SHIPMENT'});
  status(await request({method:'GET',url}),401);
  status(await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:'STALE-LINK'}}),401);
  const event=(await domain.listEvents()).find(event=>event.type==='bag.created' && event.aggregateId===bag.id);
  await operations.replayEvent(event.id); await operations.runJobs();
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM handoff_links WHERE bag_id=$1',[bag.id])).rows[0].count,1);
  const inbox=(await db.query('SELECT body,status FROM sandbox_inbox WHERE bag_id=$1',[bag.id])).rows;
  assert.equal(inbox.length,1); assert.equal(auth.decrypt(inbox[0].body.encryptedBody).handoffPath,path); assert.equal(inbox[0].status,'closed');
  assert.equal((await db.query('SELECT used_at FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0].used_at,null);
});

test('external fulfillment reservations block handoffs in pending, created and uncertain states',async t=>{
  const {request,url,token,bag,db,domain}=await fixture(t);
  await db.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state) VALUES($1,$2,'reserved-test.myshopify.com','pending')`,[bag.id,bag.brandId]);
  for (const state of ['pending','created','uncertain']) {
    await db.query('UPDATE external_orders SET state=$2 WHERE bag_id=$1',[bag.id,state]);
    const preview=await request({method:'GET',url}); status(preview,409); assert.equal(code(preview),'EXTERNAL_FULFILLMENT_RESERVED');
    const submitted=await request({method:'POST',url:`${url}/shipments`,payload:{carrier:'USPS',trackingNumber:`RESERVED-${state}`}});
    status(submitted,409); assert.equal(code(submitted),'EXTERNAL_FULFILLMENT_RESERVED');
    // The transaction guard must also enforce this when a caller has an older
    // preview snapshot and invokes the shipment method after reservation.
    await assert.rejects(domain.recordShipment(bag.id,{carrier:'USPS',trackingNumber:`STALE-${state}`},undefined,{handoffTokenHash:hash(token)}),
      error=>error.statusCode===409 && error.code==='EXTERNAL_FULFILLMENT_RESERVED');
  }
  assert.equal((await db.query('SELECT used_at FROM handoff_links WHERE token_hash=$1',[hash(token)])).rows[0].used_at,null);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,0);
  // Brand store fulfillment callbacks still need the canonical non-token path.
  await domain.recordShipment(bag.id,{carrier:'USPS',trackingNumber:'CONNECTED-STORE-CALLBACK'});
  assert.equal((await domain.getBag(bag.id)).status,'shipped');
});
