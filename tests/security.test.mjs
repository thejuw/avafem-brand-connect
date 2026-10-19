import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createDatabase } from '../server/db.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const CLIENT_SECRET='fixture-secret';
const data=response=>response.json().data;
const status=(response,expected)=>assert.equal(response.statusCode,expected,response.body);
const cookies=response=>Array.isArray(response.headers['set-cookie'])?response.headers['set-cookie']:[response.headers['set-cookie']].filter(Boolean);
const cookie=(response,name)=>cookies(response).find(value=>value.startsWith(`${name}=`))?.split(';')[0];
const noPlaintext=value=>{
  const raw=JSON.stringify(value);
  for (const privateValue of ['Alex Sandbox','123 Test Street']) assert.ok(!raw.includes(privateValue),`Persisted private data contains ${privateValue}`);
};

async function fixture(t) {
  const db=await createDatabase({connectionString:null});
  let instant=new Date(); const network=[]; const apps=[]; let app;
  const config={host:'127.0.0.1',port:4317,allowLocalBootstrap:true,
    sessionSecret:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')};
  const integrations={shopify:{status:async()=>({available:false,shop:'own-fixture.myshopify.com'}),
    preflight:async()=>{throw new Error('No real Shopify calls permitted.');},verifyWebhook:async()=>false},
    stripe:{status:async()=>({available:false,mode:'test'}),verifyWebhook:async()=>{throw new Error('No Stripe calls permitted.');}}};
  const shopifyOAuth={env:{},clientId:'fixture-client',clientSecret:CLIENT_SECRET,
    publicBaseUrl:'https://avafem.example.test',clock:()=>instant,fetch:async(url,options)=>{
      assert.match(String(url),/^https:\/\/[a-z0-9-]+\.myshopify\.com\/admin\/oauth\/access_token$/);
      assert.equal(options.method,'POST'); assert.equal(options.redirect,'error');
      const parameters=new URLSearchParams(options.body);
      assert.equal(parameters.get('client_id'),'fixture-client'); assert.equal(parameters.get('client_secret'),CLIENT_SECRET);
      network.push({shop:new URL(url).hostname,code:parameters.get('code')});
      return {ok:true,status:200,json:async()=>({access_token:`fixture-access-${network.length}`,
        refresh_token:`fixture-refresh-${network.length}`,expires_in:3600,refresh_token_expires_in:90*86400,
        scope:SHOPIFY_ALLOWED_SCOPES.join(',')})};
    }};
  const start=async()=>{
    app=await createApp({db,worker:false,seed:true,config,integrations,shopifyOAuth});
    apps.push(app); await app.ready(); return app;
  };
  t.after(async()=>{for (const item of apps.toReversed()) await item.close(); await db.close();});
  await start();
  const request=options=>app.inject({...options,headers:{host:'localhost:4317',...options.headers}});
  const session=await request({method:'GET',url:'/api/session'}); status(session,200);
  const ownerCookie=cookie(session,'avf_session'), csrf=data(session).csrfToken;
  const ownerRequest=options=>request({...options,headers:{cookie:ownerCookie,'x-csrf-token':csrf,...options.headers}});
  const begin=async(brandId,shop)=>{
    const response=await ownerRequest({method:'POST',url:`/api/brands/${brandId}/shopify/authorize`,payload:{shop}});
    status(response,200);
    return {response,url:new URL(data(response).authorizationUrl),browserCookie:cookie(response,'avf_shopify_oauth')};
  };
  const callback=(pending,{browserCookie=pending.browserCookie,signature=true,shop=pending.url.hostname}={})=>{
    const params=new URLSearchParams({code:'fixture-authorization-code',shop,state:pending.url.searchParams.get('state'),timestamp:String(Math.floor(instant.getTime()/1000))});
    const message=[...params.entries()].sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,value])=>`${key}=${value}`).join('&');
    params.set('hmac',signature?createHmac('sha256',CLIENT_SECRET).update(message).digest('hex'):'0'.repeat(64));
    return request({method:'GET',url:`/oauth/shopify/callback?${params}`,headers:browserCookie?{cookie:browserCookie}:{}});
  };
  const install=async(brandId,shop)=>{
    const pending=await begin(brandId,shop); const response=await callback(pending); status(response,200); return response;
  };
  const uninstall=async(shop,deliveryId,occurredAt)=>{
    const body=JSON.stringify({id:444,myshopify_domain:shop});
    return request({method:'POST',url:'/webhooks/shopify',headers:{'content-type':'application/json',
      'x-shopify-shop-domain':shop,'x-shopify-topic':'app/uninstalled','x-shopify-webhook-id':deliveryId,
      'x-shopify-triggered-at':occurredAt,'x-shopify-hmac-sha256':createHmac('sha256',CLIENT_SECRET).update(body).digest('base64')},payload:body});
  };
  return {get app(){return app;},db,config,request,ownerRequest,ownerCookie,begin,callback,install,uninstall,network,
    get clock(){return instant;},advance:milliseconds=>{instant=new Date(instant.getTime()+milliseconds);},
    restart:async()=>{await app.close(); return start();}};
}

async function drain(operations) { for (let count=0;count<4;count++) await operations.runJobs(); }
async function rawPrivateRows(db) {
  return {bags:(await db.query('SELECT ship_to FROM bags')).rows,
    events:(await db.query('SELECT payload FROM outbox_events')).rows,
    inbox:(await db.query('SELECT body FROM sandbox_inbox')).rows,
    cache:(await db.query('SELECT response FROM api_idempotency WHERE response IS NOT NULL')).rows};
}

test('private addresses remain encrypted in Bags, outbox, inbox and idempotency cache while API views replay correctly',async t=>{
  const fixtureApp=await fixture(t); const {db,request,ownerRequest,network}=fixtureApp;
  const credential=await fixtureApp.app.avafem.auth.createCredential('brand_bloom',{scopes:['orders:read']});
  const mutation={method:'POST',url:'/v1/sandbox/orders',headers:{authorization:`Bearer ${credential.apiKey}`,'idempotency-key':'encrypted-order-once'},payload:{}};
  const first=await request(mutation); status(first,200);
  assert.equal(data(first).bags[0].shipTo.name,'Alex Sandbox'); assert.equal(data(first).bags[0].shipTo.line1,'123 Test Street');
  const replay=await request(mutation); status(replay,200); assert.equal(replay.headers['idempotent-replayed'],'true');
  assert.deepEqual(data(replay),data(first));
  await drain(fixtureApp.app.avafem.operations);
  const rows=await rawPrivateRows(db); noPlaintext(rows);
  assert.ok(rows.bags.every(row=>typeof row.ship_to.encryptedShipping==='string'));
  assert.ok(rows.events.some(row=>row.payload.shipTo?.encryptedShipping));
  assert.ok(rows.inbox.length>0 && rows.inbox.every(row=>typeof row.body.encryptedBody==='string'));
  assert.ok(rows.cache.every(row=>typeof row.response.encryptedResponse==='string'));
  const events=await ownerRequest({method:'GET',url:'/api/events'}); status(events,200);
  const inbox=data(events).inbox.find(message=>message.bag_id===data(first).bags[0].id);
  assert.equal(inbox.body.ship_to.name,'Alex Sandbox'); assert.equal(inbox.body.ship_to.line1,'123 Test Street');
  const handoff=await request({method:'GET',url:`/api/handoffs/${inbox.body.handoffPath.split('/').at(-1)}`}); status(handoff,200);
  assert.equal(data(handoff).bag.ship_to.line1,'123 Test Street'); assert.equal(network.length,0);
});

test('startup migrates legacy clear shipping, inbox and cached responses without breaking replay',async t=>{
  const fixtureApp=await fixture(t); const {db,request}=fixtureApp;
  const credential=await fixtureApp.app.avafem.auth.createCredential('brand_bloom',{scopes:['orders:read']});
  const mutation={method:'POST',url:'/v1/sandbox/orders',headers:{authorization:`Bearer ${credential.apiKey}`,'idempotency-key':'legacy-cache-replay'},payload:{}};
  const created=await request(mutation); status(created,200);
  await drain(fixtureApp.app.avafem.operations);
  const {auth,domain}=fixtureApp.app.avafem;
  const bag=(await domain.listBags({brandId:'brand_bloom'}))[0];
  await db.query('UPDATE bags SET ship_to=$2 WHERE id=$1',[bag.id,JSON.stringify(bag.shipTo)]);
  const event=(await db.query("SELECT id,payload FROM outbox_events WHERE type='bag.created' AND aggregate_id=$1",[bag.id])).rows[0];
  await db.query('UPDATE outbox_events SET payload=$2 WHERE id=$1',[event.id,JSON.stringify({...event.payload,shipTo:bag.shipTo})]);
  const inbox=(await db.query('SELECT id,body FROM sandbox_inbox LIMIT 1')).rows[0];
  await db.query('UPDATE sandbox_inbox SET body=$2 WHERE id=$1',[inbox.id,JSON.stringify(auth.decrypt(inbox.body.encryptedBody))]);
  const cached=(await db.query('SELECT brand_id,endpoint,key_hash,response FROM api_idempotency LIMIT 1')).rows[0];
  await db.query('UPDATE api_idempotency SET response=$1 WHERE brand_id=$2 AND endpoint=$3 AND key_hash=$4',
    [JSON.stringify(auth.decrypt(cached.response.encryptedResponse)),cached.brand_id,cached.endpoint,cached.key_hash]);
  assert.ok(JSON.stringify(await rawPrivateRows(db)).includes('Alex Sandbox'),'Fixture contains legacy clear rows before restart.');
  await fixtureApp.restart();
  noPlaintext(await rawPrivateRows(db));
  const replay=await request(mutation); status(replay,200); assert.equal(replay.headers['idempotent-replayed'],'true');
  assert.deepEqual(data(replay),data(created));
  assert.equal((await fixtureApp.app.avafem.domain.getBag(bag.id)).shipTo.line1,'123 Test Street');
});

test('OAuth authorization start requires owner CSRF and sets only a Secure Lax HttpOnly browser-state cookie',async t=>{
  const {request,ownerCookie,begin,db}=await fixture(t);
  const route={method:'POST',url:'/api/brands/brand_bloom/shopify/authorize',payload:{shop:'security-bloom.myshopify.com'}};
  status(await request(route),401);
  const noCsrf=await request({...route,headers:{cookie:ownerCookie}}); status(noCsrf,403); assert.equal(noCsrf.json().error.code,'CSRF_REQUIRED');
  const pending=await begin('brand_bloom','security-bloom.myshopify.com');
  assert.equal(pending.url.hostname,'security-bloom.myshopify.com');
  assert.equal(pending.url.searchParams.get('client_id'),'fixture-client');
  assert.deepEqual(pending.url.searchParams.get('scope').split(','),[...SHOPIFY_ALLOWED_SCOPES]);
  assert.equal(pending.url.searchParams.get('grant_options[]'),null);
  const header=cookies(pending.response).find(value=>value.startsWith('avf_shopify_oauth='));
  assert.match(header,/Secure/i); assert.match(header,/HttpOnly/i); assert.match(header,/SameSite=Lax/i);
  assert.match(header,/Path=\/oauth\/shopify\/callback/i);
  assert.equal(data(pending.response).browserToken,undefined); assert.ok(!pending.response.body.includes(CLIENT_SECRET));
  assert.ok(!pending.response.body.includes(pending.browserCookie.split('=')[1]));
  const stored=(await db.query('SELECT state_hash,browser_hash FROM shopify_oauth_states')).rows[0];
  assert.notEqual(stored.state_hash,pending.url.searchParams.get('state'));
  assert.notEqual(stored.browser_hash,pending.browserCookie.split('=')[1]);
});

test('OAuth callback requires its browser binding, never creates owner sessions and never returns token secrets',async t=>{
  const {begin,callback,db,network,ownerRequest}=await fixture(t);
  const pending=await begin('brand_bloom','security-bloom.myshopify.com');
  const ownerBefore=(await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions WHERE owner=true')).rows[0].count;
  status(await callback(pending,{browserCookie:null}),401);
  status(await callback(pending,{browserCookie:'avf_shopify_oauth=other-browser'}),401);
  status(await callback(pending,{signature:false}),401);
  assert.equal(network.length,0);
  const completed=await callback(pending); status(completed,200);
  assert.equal(data(completed).connection.brandId,'brand_bloom'); assert.equal(data(completed).connection.status,'connected');
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM auth_sessions WHERE owner=true')).rows[0].count,ownerBefore);
  assert.equal(cookie(completed,'avf_session'),undefined); assert.ok(cookie(completed,'avf_shopify_oauth'));
  for (const secret of [CLIENT_SECRET,'fixture-access-1','fixture-refresh-1','token_encrypted','browserToken']) assert.ok(!completed.body.includes(secret));
  const view=await ownerRequest({method:'GET',url:'/api/brands/brand_bloom/shopify'}); status(view,200);
  assert.ok(!view.body.includes('fixture-access-1')); assert.ok(!view.body.includes('fixture-refresh-1'));
  const stored=(await db.query('SELECT token_encrypted FROM shopify_connections WHERE brand_id=$1',['brand_bloom'])).rows[0];
  assert.ok(stored.token_encrypted && !stored.token_encrypted.includes('fixture-access-1'));
  status(await callback(pending),401); assert.equal(network.length,1);
});

test('a signed fourth-store uninstall clears only its bound brand tokens and disconnects that brand',async t=>{
  const fixtureApp=await fixture(t); const {db,install,uninstall}=fixtureApp;
  await fixtureApp.app.avafem.domain.createBrand({id:'brand_fourth',name:'Fourth Security Fixture',slug:'fourth-security-fixture'});
  const bindings=[['brand_bloom','security-bloom.myshopify.com'],['brand_lunelle','security-lunelle.myshopify.com'],
    ['brand_hearth','security-hearth.myshopify.com'],['brand_fourth','security-fourth.myshopify.com']];
  for (const [brand,shop] of bindings) await install(brand,shop);
  const before=(await db.query('SELECT brand_id,token_encrypted FROM shopify_connections ORDER BY brand_id')).rows;
  status(await uninstall(bindings[3][1],'fourth-store-uninstall',fixtureApp.clock.toISOString()),200);
  await fixtureApp.app.avafem.operations.runJobs();
  const after=(await db.query('SELECT brand_id,status,token_encrypted FROM shopify_connections ORDER BY brand_id')).rows;
  assert.equal(after.length,4);
  for (const row of after) {
    if (row.brand_id==='brand_fourth') { assert.equal(row.status,'disconnected'); assert.equal(row.token_encrypted,null); }
    else { assert.equal(row.status,'connected'); assert.equal(row.token_encrypted,before.find(old=>old.brand_id===row.brand_id).token_encrypted); }
  }
  assert.equal((await fixtureApp.app.avafem.domain.getBrand('brand_fourth')).status,'disconnected');
  assert.notEqual((await fixtureApp.app.avafem.domain.getBrand('brand_bloom')).status,'disconnected');
  assert.notEqual((await fixtureApp.app.avafem.domain.getBrand('brand_lunelle')).status,'disconnected');
  const inbound=(await db.query("SELECT brand_id,status FROM inbound_webhooks WHERE delivery_id='fourth-store-uninstall'")).rows[0];
  assert.equal(inbound.brand_id,'brand_fourth'); assert.equal(inbound.status,'processed');
});

test('a delayed uninstall from an older installation cannot clear a newer token pair',async t=>{
  const fixtureApp=await fixture(t); const {db,install,uninstall}=fixtureApp;
  const shop='security-bloom.myshopify.com';
  await install('brand_bloom',shop);
  const oldOccurrence=new Date(fixtureApp.clock.getTime()+30_000).toISOString();
  fixtureApp.advance(60_000); await install('brand_bloom',shop);
  const newer=(await db.query('SELECT token_encrypted,installed_at FROM shopify_connections WHERE brand_id=$1',['brand_bloom'])).rows[0];
  status(await uninstall(shop,'older-install-uninstall',oldOccurrence),200);
  await fixtureApp.app.avafem.operations.runJobs();
  const current=(await db.query('SELECT status,token_encrypted,installed_at FROM shopify_connections WHERE brand_id=$1',['brand_bloom'])).rows[0];
  assert.equal(current.status,'connected'); assert.equal(current.token_encrypted,newer.token_encrypted);
  assert.deepEqual(current.installed_at,newer.installed_at);
  assert.notEqual((await fixtureApp.app.avafem.domain.getBrand('brand_bloom')).status,'disconnected');
  assert.equal((await db.query("SELECT status FROM inbound_webhooks WHERE delivery_id='older-install-uninstall'")).rows[0].status,'processed');
});

test('a valid uninstall signature for store A cannot be replayed with store B headers',async t=>{
  const fixtureApp=await fixture(t); const {db,install,request}=fixtureApp;
  const shopA='security-bloom.myshopify.com',shopB='security-lunelle.myshopify.com';
  await install('brand_bloom',shopA); await install('brand_lunelle',shopB);
  const before=(await db.query('SELECT brand_id,status,token_encrypted FROM shopify_connections ORDER BY brand_id')).rows;
  const body=JSON.stringify({id:123,myshopify_domain:shopA});
  const response=await request({method:'POST',url:'/webhooks/shopify',headers:{'content-type':'application/json',
    'x-shopify-shop-domain':shopB,'x-shopify-topic':'app/uninstalled','x-shopify-webhook-id':'cross-shop-replayed-uninstall',
    'x-shopify-triggered-at':fixtureApp.clock.toISOString(),
    'x-shopify-hmac-sha256':createHmac('sha256',CLIENT_SECRET).update(body).digest('base64')},payload:body});
  status(response,400); assert.equal(response.json().error.code,'SHOP_MISMATCH');
  assert.equal((await db.query("SELECT COUNT(*)::integer AS count FROM inbound_webhooks WHERE delivery_id='cross-shop-replayed-uninstall'")).rows[0].count,0);
  await fixtureApp.app.avafem.operations.runJobs();
  const after=(await db.query('SELECT brand_id,status,token_encrypted FROM shopify_connections ORDER BY brand_id')).rows;
  assert.deepEqual(after,before);
  assert.notEqual((await fixtureApp.app.avafem.domain.getBrand('brand_lunelle')).status,'disconnected');
});
