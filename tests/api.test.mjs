import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { createApp } from '../server/app.mjs';

const HOST='localhost:4317';
const SHOP='avafem-injection-test.myshopify.com';
const WEBHOOK_SECRET='injection-test-webhook-secret';
const sign=body=>createHmac('sha256',WEBHOOK_SECRET).update(body).digest('base64');
const payload=response=>response.json().data;
const errorCode=response=>response.json().error?.code;
const cookie=response=>String(response.headers['set-cookie']).split(';')[0];
const assertStatus=(response,status)=>assert.equal(response.statusCode,status,response.body);

async function fixture(t,config={}) {
  // Explicit stubs prevent keychain access, provider calls, real payments and
  // real HTTPS delivery. Tests exercise only an isolated in-memory database.
  const blockedRequests=[];
  t.mock.method(https,'request',()=>{blockedRequests.push(true); throw new Error('External delivery is disabled in API tests.');});
  const app=await createApp({worker:false,seed:true,connectionString:null,config:{port:4317,host:'127.0.0.1',
    allowLocalBootstrap:true,sessionSecret:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex'),...config},
    integrations:{shopify:{
      status:async()=>({available:true,configured:true,verified:false,shop:SHOP,message:'Injected test adapter'}),
      preflight:async()=>({verified:true,missingScopes:[],shop:{myshopifyDomain:SHOP,currencyCode:'USD'}}),
      verifyWebhook:async(raw,signature)=>{
        if (typeof signature!=='string') return false;
        const expected=Buffer.from(sign(raw)), supplied=Buffer.from(signature);
        return expected.length===supplied.length && timingSafeEqual(expected,supplied);
      },
    },stripe:{
      status:async()=>({available:false,configured:false,mode:'test',message:'Injected test adapter'}),
      verifyWebhook:async(raw,signature)=>{
        if (signature!=='injection-stripe-signature') throw Object.assign(new Error('Invalid Stripe signature'),{statusCode:400,code:'INVALID_SIGNATURE'});
        return JSON.parse(raw.toString('utf8'));
      },
    }},
  });
  t.after(()=>app.close());
  await app.ready();
  const request=options=>app.inject({...options,headers:{host:HOST,...options.headers}});
  const session=await request({method:'GET',url:'/api/session'});
  const owner=session.statusCode===200?{cookie:cookie(session),csrfToken:payload(session).csrfToken}:null;
  const ownerRequest=options=>request({...options,headers:{cookie:owner.cookie,'x-csrf-token':owner.csrfToken,...options.headers}});
  const key=async(brandId='brand_bloom',scopes=['orders:read'])=>{
    const response=await ownerRequest({method:'POST',url:`/api/brands/${brandId}/credentials`,payload:{kind:'api_key',scopes,label:'Injection test'}});
    assertStatus(response,200); return payload(response);
  };
  const bearer=(credential,options)=>request({...options,headers:{authorization:`Bearer ${credential.apiKey||credential.access_token}`,...options.headers}});
  return {app,request,ownerRequest,owner,key,bearer,blockedRequests,...app.avafem};
}

test('owner bootstrap, Host/Origin restrictions and cookie CSRF are enforced',async t=>{
  const {request,ownerRequest,owner}=await fixture(t);
  assert.ok(owner.csrfToken);
  const unauthenticated=await request({method:'GET',url:'/api/bags'});
  assertStatus(unauthenticated,401);
  const foreignHost=await request({method:'GET',url:'/api/session',headers:{host:'attacker.example'}});
  assertStatus(foreignHost,403); assert.equal(errorCode(foreignHost),'INVALID_HOST');
  const remoteBootstrap=await request({method:'GET',url:'/api/session',remoteAddress:'198.51.100.20'});
  assertStatus(remoteBootstrap,401);
  const missingCsrf=await request({method:'POST',url:'/api/sandbox/orders',headers:{cookie:owner.cookie},payload:{}});
  assertStatus(missingCsrf,403); assert.equal(errorCode(missingCsrf),'CSRF_REQUIRED');
  const badOrigin=await ownerRequest({method:'POST',url:'/api/sandbox/orders',headers:{origin:'https://attacker.example'},payload:{}});
  assertStatus(badOrigin,403); assert.equal(errorCode(badOrigin),'ORIGIN_DENIED');
  const allowed=await ownerRequest({method:'POST',url:'/api/sandbox/orders',headers:{origin:'http://localhost:4317'},payload:{brandId:'brand_bloom'}});
  assertStatus(allowed,200); assert.ok(payload(allowed).bags.every(bag=>bag.brandId==='brand_bloom'));
  const session=await request({method:'GET',url:'/api/session'});
  assert.match(String(session.headers['set-cookie']),/HttpOnly/i);
  assert.match(String(session.headers['set-cookie']),/SameSite=Strict/i);
  assert.equal(session.headers['cache-control'],'no-store');
});

test('disabled local bootstrap requires the configured owner token',async t=>{
  const {request}=await fixture(t,{allowLocalBootstrap:false,adminToken:'injection-owner-token'});
  assertStatus(await request({method:'GET',url:'/api/session'}),401);
  assertStatus(await request({method:'POST',url:'/api/admin/session',payload:{token:'wrong'}}),401);
  const session=await request({method:'POST',url:'/api/admin/session',payload:{token:'injection-owner-token'}});
  assertStatus(session,200); assert.equal(payload(session).role,'admin');
});

test('an accepted invite creates a non-owner tenant session and cannot grant admin access',async t=>{
  const {request,ownerRequest,domain}=await fixture(t);
  const invitation=await ownerRequest({method:'POST',url:'/api/brands/brand_bloom/invite',payload:{}});
  assertStatus(invitation,200);
  const accepted=await request({method:'POST',url:`/api/invites/${payload(invitation).token}/accept`,payload:{acceptedSandboxTerms:true}});
  assertStatus(accepted,200); assert.equal(payload(accepted).role,'brand');
  const sessionHeaders={cookie:cookie(accepted),'x-csrf-token':payload(accepted).csrfToken};
  const asBrand=options=>request({...options,headers:{...sessionHeaders,...options.headers}});
  const duplicate=await request({method:'POST',url:`/api/invites/${payload(invitation).token}/accept`,payload:{acceptedSandboxTerms:true}});
  assertStatus(duplicate,401);
  const brands=await asBrand({method:'GET',url:'/api/brands'});
  assertStatus(brands,200); assert.deepEqual(payload(brands).map(brand=>brand.id),['brand_bloom']);
  const own=(await domain.listBags({brandId:'brand_bloom'}))[0], foreign=(await domain.listBags({brandId:'brand_lunelle'}))[0];
  assertStatus(await asBrand({method:'GET',url:`/api/bags/${own.id}`}),200);
  assertStatus(await asBrand({method:'GET',url:`/api/bags/${foreign.id}`}),404);
  assertStatus(await asBrand({method:'GET',url:'/api/bags?brandId=brand_lunelle'}),403);
  for (const options of [
    {method:'POST',url:'/api/jobs/run',payload:{}},
    {method:'POST',url:'/api/session/brand',payload:{brandId:null}},
    {method:'POST',url:'/api/brands/brand_bloom/credentials',payload:{scopes:['orders:read']}},
    {method:'POST',url:'/api/products/nonexistent/review',payload:{decision:'approved'}},
    {method:'POST',url:'/api/refunds/nonexistent/approve',payload:{}},
  ]) assertStatus(await asBrand(options),403);
  for (const url of ['/api/bags','/api/finance','/api/events']) {
    const response=await asBrand({method:'GET',url}); assertStatus(response,200);
    assert.ok(!response.body.includes('brand_lunelle')); assert.ok(!response.body.includes('brand_hearth'));
  }
});

test('brand API keys enforce scopes, tenant isolation and revocation without exposing secrets',async t=>{
  const {key,bearer,ownerRequest,domain,db}=await fixture(t);
  const credential=await key();
  const bags=await bearer(credential,{method:'GET',url:'/v1/bags'});
  assertStatus(bags,200); assert.ok(payload(bags).every(bag=>bag.brandId==='brand_bloom'));
  const foreign=(await domain.listBags({brandId:'brand_lunelle'}))[0];
  assertStatus(await bearer(credential,{method:'GET',url:`/v1/bags/${foreign.id}`}),404);
  assertStatus(await bearer(credential,{method:'GET',url:'/v1/products'}),403);
  assertStatus(await bearer(credential,{method:'GET',url:'/v1/payouts'}),403);
  const own=payload(bags)[0];
  assertStatus(await bearer(credential,{method:'POST',url:`/v1/bags/${own.id}/shipments`,headers:{'idempotency-key':'insufficient-scope'},payload:{carrier:'USPS',trackingNumber:'NO-SHIP'}}),403);
  assertStatus(await bearer(credential,{method:'GET',url:'/api/bags'}),403);
  const listed=await ownerRequest({method:'GET',url:'/api/brands/brand_bloom/credentials'});
  assertStatus(listed,200); assert.ok(!listed.body.includes(credential.apiKey)); assert.ok(!listed.body.includes('secret_hash'));
  const stored=(await db.query('SELECT secret_hash FROM api_credentials WHERE id=$1',[credential.id])).rows[0];
  assert.notEqual(stored.secret_hash,credential.apiKey); assert.equal(stored.secret_hash.length,64);
  assertStatus(await ownerRequest({method:'DELETE',url:`/api/brands/brand_bloom/credentials/${credential.id}`}),200);
  assertStatus(await bearer(credential,{method:'GET',url:'/v1/bags'}),401);
});

test('OAuth client credentials reject scope expansion and revoked clients invalidate issued JWTs',async t=>{
  const {request,ownerRequest,bearer}=await fixture(t);
  const created=await ownerRequest({method:'POST',url:'/api/brands/brand_bloom/credentials',payload:{kind:'oauth_client',scopes:['orders:read'],label:'OAuth injection'}});
  assertStatus(created,200); const client=payload(created);
  const authorization=`Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
  const token=await request({method:'POST',url:'/oauth/token',headers:{authorization,'content-type':'application/x-www-form-urlencoded'},payload:'grant_type=client_credentials&scope=orders%3Aread'});
  assertStatus(token,200); assert.equal(token.json().expires_in,3600);
  assertStatus(await bearer(token.json(),{method:'GET',url:'/v1/bags'}),200);
  const expanded=await request({method:'POST',url:'/oauth/token',headers:{authorization},payload:{grant_type:'client_credentials',scope:'orders:read payouts:read'}});
  assertStatus(expanded,400); assert.equal(expanded.json().error.code,'invalid_scope');
  assertStatus(await request({method:'POST',url:'/oauth/token',payload:{grant_type:'client_credentials',client_id:client.clientId,client_secret:'wrong'}}),401);
  const parts=token.json().access_token.split('.');
  parts[1]=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(parts[1],'base64url')),brand_id:'brand_lunelle'})).toString('base64url');
  assertStatus(await bearer({access_token:parts.join('.')},{method:'GET',url:'/v1/bags'}),401);
  assertStatus(await ownerRequest({method:'DELETE',url:`/api/brands/brand_bloom/credentials/${client.id}`}),200);
  assertStatus(await bearer(token.json(),{method:'GET',url:'/v1/bags'}),401);
});

test('POST idempotency requires a key, replays once and rejects changed bodies',async t=>{
  const {key,bearer,domain,db}=await fixture(t);
  const credential=await key('brand_bloom',['orders:read','orders:fulfill']);
  const bag=(await domain.listBags({brandId:'brand_bloom'}))[0];
  const url=`/v1/bags/${bag.id}/shipments`, body={carrier:'USPS',trackingNumber:'INJECTION-ONE'};
  assertStatus(await bearer(credential,{method:'POST',url,payload:body}),400);
  const first=await bearer(credential,{method:'POST',url,headers:{'idempotency-key':'shipment-once'},payload:body});
  assertStatus(first,200);
  const repeated=await bearer(credential,{method:'POST',url,headers:{'idempotency-key':'shipment-once'},payload:{trackingNumber:body.trackingNumber,carrier:body.carrier}});
  assertStatus(repeated,200); assert.equal(repeated.headers['idempotent-replayed'],'true');
  assert.deepEqual(payload(first),payload(repeated));
  const changed=await bearer(credential,{method:'POST',url,headers:{'idempotency-key':'shipment-once'},payload:{...body,trackingNumber:'INJECTION-TWO'}});
  assertStatus(changed,422); assert.equal(errorCode(changed),'IDEMPOTENCY_CONFLICT');
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bag.id])).rows[0].count,1);
  const countBefore=(await domain.listBags()).length;
  const outcomes=await Promise.all([0,1].map(()=>bearer(credential,{method:'POST',url:'/v1/sandbox/orders',headers:{'idempotency-key':'concurrent-order'},payload:{}})));
  assert.ok(outcomes.every(response=>[200,409].includes(response.statusCode)),outcomes.map(response=>response.body).join('\n'));
  assert.ok(outcomes.some(response=>response.statusCode===200));
  assert.equal((await domain.listBags()).length,countBefore+1);
  const replay=await bearer(credential,{method:'POST',url:'/v1/sandbox/orders',headers:{'idempotency-key':'concurrent-order'},payload:{}});
  assertStatus(replay,200); assert.equal(replay.headers['idempotent-replayed'],'true');
});

test('refund APIs create proposals and reserve approval for the owner',async t=>{
  const {key,bearer,ownerRequest,domain}=await fixture(t);
  const credential=await key('brand_lunelle',['orders:read','refunds:write']);
  const bag=(await domain.listBags({brandId:'brand_lunelle'}))[0];
  const proposed=await bearer(credential,{method:'POST',url:`/v1/bags/${bag.id}/refunds`,headers:{'idempotency-key':'refund-proposal'},payload:{reason:'Sandbox return requested'}});
  assertStatus(proposed,200); assert.equal(payload(proposed).status,'proposed'); assert.equal(payload(proposed).requiresApproval,true);
  assert.equal(payload(proposed).amountCents,3139);
  assert.equal((await domain.getBag(bag.id)).status,'shipped');
  assertStatus(await bearer(credential,{method:'POST',url:`/api/refunds/${payload(proposed).id}/approve`,payload:{}}),403);
  assertStatus(await ownerRequest({method:'POST',url:`/api/refunds/${payload(proposed).id}/approve`,payload:{}}),200);
  assert.equal((await domain.getBag(bag.id)).status,'refunded');
});

test('inbound Shopify signatures, store identity, deduplication and encrypted storage',async t=>{
  const {request,db,auth}=await fixture(t);
  const body=JSON.stringify({order_id:123,customer:{email:'private@example.com'},refund_line_items:[]});
  const headers={'content-type':'application/json','x-shopify-hmac-sha256':sign(body),'x-shopify-shop-domain':SHOP,
    'x-shopify-topic':'refunds/create','x-shopify-webhook-id':'injection-webhook-1'};
  assertStatus(await request({method:'POST',url:'/webhooks/shopify',headers:{...headers,'x-shopify-hmac-sha256':'bad'},payload:body}),401);
  assertStatus(await request({method:'POST',url:'/webhooks/shopify',headers:{...headers,'x-shopify-shop-domain':'foreign.myshopify.com'},payload:body}),400);
  const first=await request({method:'POST',url:'/webhooks/shopify',headers,payload:body}); assertStatus(first,200); assert.equal(first.json().duplicate,false);
  const duplicate=await request({method:'POST',url:'/webhooks/shopify',headers,payload:body}); assertStatus(duplicate,200); assert.equal(duplicate.json().duplicate,true);
  const stored=(await db.query("SELECT * FROM inbound_webhooks WHERE provider='shopify' AND delivery_id='injection-webhook-1'")).rows;
  assert.equal(stored.length,1); assert.ok(!stored[0].raw_encrypted.includes('private@example.com'));
  assert.equal(auth.decrypt(stored[0].raw_encrypted).raw,body);
});

test('outbox processing is bounded, replay-safe and suppresses refunded ready-to-ship handoffs',async t=>{
  const {ownerRequest,domain,db,blockedRequests}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_bloom'}))[0];
  const refund=await domain.requestRefund(bag.id,{reason:'Cancelled before handoff'});
  await domain.approveSandboxRefund(refund.id);
  const run=await ownerRequest({method:'POST',url:'/api/jobs/run',payload:{}});
  assertStatus(run,200); assert.equal(payload(run).sandbox,true);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM sandbox_inbox WHERE bag_id=$1',[bag.id])).rows[0].count,0);
  const created=(await domain.listEvents()).find(event=>event.type==='bag.created' && event.aggregateId===bag.id);
  assertStatus(await ownerRequest({method:'POST',url:`/api/events/${created.id}/replay`,payload:{}}),200);
  assertStatus(await ownerRequest({method:'POST',url:'/api/jobs/run',payload:{}}),200);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM sandbox_inbox WHERE bag_id=$1',[bag.id])).rows[0].count,0);
  assert.equal(blockedRequests.length,0);
});

test('orders-only webhook endpoints cannot receive financial or catalog events',async t=>{
  const {key,bearer,ownerRequest,db}=await fixture(t);
  const credential=await key('brand_bloom',['orders:read']);
  // A numeric public address bypasses DNS. HTTPS request is stubbed by fixture.
  const endpoint=await bearer(credential,{method:'POST',url:'/v1/webhook-endpoints',headers:{'idempotency-key':'orders-only-endpoint'},payload:{url:'https://93.184.216.34/injection-test'}});
  assertStatus(endpoint,200); assert.ok(payload(endpoint).signingSecret);
  assertStatus(await ownerRequest({method:'POST',url:'/api/jobs/run',payload:{}}),200);
  const deliveries=(await db.query(`SELECT o.type FROM webhook_deliveries d JOIN outbox_events o ON o.id=d.event_id WHERE d.endpoint_id=$1`,[payload(endpoint).id])).rows;
  assert.ok(deliveries.length>0,'Order events should still be queued for an orders credential.');
  assert.ok(deliveries.every(event=>! /^(credit|transfer|payout|refund|product|inventory)\./.test(event.type)),JSON.stringify(deliveries));
});
