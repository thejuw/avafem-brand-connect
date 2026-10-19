import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';

// Deliberately fake fixtures. The tests never inspect or mutate process.env,
// credential files, a browser, the running preview, or a real Stripe account.
const FAKE_KEY=`sk_test_${'A'.repeat(32)}`;
const FAKE_WEBHOOK=`whsec_${'B'.repeat(32)}`;
const PATH='/api/local/stripe-test-credentials';
const data=response=>response.json().data;
const status=(response,expected)=>assert.equal(response.statusCode,expected,response.body);
const noEcho=(value,secrets=[FAKE_KEY,FAKE_WEBHOOK])=>{
  const output=typeof value==='string'?value:JSON.stringify(value);
  for (const secret of secrets) assert.ok(!output.includes(secret),'A fake credential appeared outside the in-memory adapter.');
};

async function fixture(t,{initialEnv={}}={}) {
  const serverEnv={...initialEnv},logs=[],factoryCalls=[],candidates=[];
  let verification={provider:'stripe',verified:true,mode:'test',accountId:'acct_fixture123',chargesEnabled:true,payoutsEnabled:true};
  const initialStripe={status:async()=>({provider:'stripe',configured:false,available:false,verified:false,mode:'test',webhookConfigured:false})};
  const stripeFactory=options=>{
    factoryCalls.push(options);
    const candidate={preflightCalls:0,
      preflight:async()=>{candidate.preflightCalls++; if (verification instanceof Error) throw verification; return {...verification};},
      status:async()=>({provider:'stripe',configured:true,available:true,verified:false,mode:'test',webhookConfigured:Boolean(options.webhookSecret)}),
      createPaymentIntent:()=>{throw new Error('Money operations are forbidden in setup tests.');},
      createTransfer:()=>{throw new Error('Money operations are forbidden in setup tests.');},
    };
    candidates.push(candidate); return candidate;
  };
  const app=await createApp({worker:false,seed:true,connectionString:null,
    logger:{level:'trace',stream:{write:chunk=>{logs.push(String(chunk));}}},
    config:{host:'127.0.0.1',port:4317,allowLocalBootstrap:true,
      sessionSecret:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')},
    shopifyOAuth:{env:{}},
    integrations:{serverEnv,stripeFactory,stripe:initialStripe,
      shopify:{status:async()=>({available:false,shop:'stripe-setup-fixture.myshopify.com'}),
        preflight:async()=>{throw new Error('Provider access forbidden.');},verifyWebhook:async()=>false}},
  });
  t.after(()=>app.close()); await app.ready();
  const request=options=>app.inject({...options,headers:{host:'localhost:4317',...options.headers}});
  const session=await request({method:'GET',url:'/api/session'}); status(session,200);
  const cookie=String(session.headers['set-cookie']).split(';')[0],csrf=data(session).csrfToken;
  const owner=options=>request({...options,headers:{cookie,'x-csrf-token':csrf,...options.headers}});
  const configure=(input={secretKey:FAKE_KEY,webhookSecret:FAKE_WEBHOOK},options={})=>owner({method:'POST',url:PATH,payload:input,...options});
  return {app,request,owner,configure,cookie,serverEnv,logs,factoryCalls,candidates,initialStripe,
    setVerification:value=>{verification=value;},...app.avafem};
}

test('Stripe local setup requires an owner browser session and CSRF token',async t=>{
  const {request,cookie,auth,factoryCalls,serverEnv}=await fixture(t);
  const input={secretKey:FAKE_KEY};
  status(await request({method:'POST',url:PATH,payload:input}),401);
  const missingCsrf=await request({method:'POST',url:PATH,headers:{cookie},payload:input});
  status(missingCsrf,403); assert.equal(missingCsrf.json().error.code,'CSRF_REQUIRED');
  const brandSession=await auth.createSession({brandId:'brand_bloom'});
  const notOwner=await request({method:'POST',url:PATH,headers:{cookie:`avf_session=${brandSession.token}`,'x-csrf-token':brandSession.csrfToken},payload:input});
  status(notOwner,403); assert.equal(notOwner.json().error.code,'ADMIN_REQUIRED');
  assert.equal(factoryCalls.length,0); assert.deepEqual(serverEnv,{});
});

test('Stripe local setup rejects remote addresses, foreign Hosts and foreign origins',async t=>{
  const {configure,factoryCalls,serverEnv}=await fixture(t);
  const remote=await configure({secretKey:FAKE_KEY},{remoteAddress:'198.51.100.8'});
  status(remote,403); assert.equal(remote.json().error.code,'LOCAL_SETUP_ONLY');
  status(await configure({secretKey:FAKE_KEY},{headers:{host:'public.example'}}),403);
  status(await configure({secretKey:FAKE_KEY},{headers:{origin:'https://public.example'}}),403);
  assert.equal(factoryCalls.length,0); assert.deepEqual(serverEnv,{});
});

test('live, publishable and malformed Stripe keys are rejected without echo or environment writes',async t=>{
  const {configure,factoryCalls,serverEnv,logs}=await fixture(t);
  const invalid=[`sk_live_${'L'.repeat(32)}`,`pk_test_${'P'.repeat(32)}`,'sk_test_short',`rk_live_${'R'.repeat(32)}`];
  for (const secretKey of invalid) {
    const response=await configure({secretKey}); status(response,422);
    assert.equal(response.json().error.code,'STRIPE_TEST_KEY_REQUIRED'); noEcho(response.body,[secretKey]);
  }
  assert.equal(factoryCalls.length,0); assert.deepEqual(serverEnv,{}); noEcho(logs.join(''),invalid);
});

test('failed Stripe preflight preserves the prior environment and adapter',async t=>{
  const initialEnv={STRIPE_SECRET_KEY:`sk_test_${'I'.repeat(32)}`,STRIPE_WEBHOOK_SECRET:`whsec_${'J'.repeat(32)}`,UNRELATED:'unchanged'};
  const {configure,setVerification,serverEnv,operations,initialStripe,candidates}=await fixture(t,{initialEnv});
  setVerification({verified:false,mode:'test',accountId:'acct_fixture123'});
  const rejected=await configure(); status(rejected,409); assert.equal(rejected.json().error.code,'STRIPE_VERIFICATION_FAILED'); noEcho(rejected.body);
  assert.deepEqual(serverEnv,initialEnv); assert.equal(operations.stripe,initialStripe);
  setVerification(Object.assign(new Error('Fixture account verification unavailable.'),{statusCode:503,code:'STRIPE_UNAVAILABLE'}));
  const unavailable=await configure(); status(unavailable,503); noEcho(unavailable.body);
  assert.deepEqual(serverEnv,initialEnv); assert.equal(operations.stripe,initialStripe);
  assert.ok(candidates.every(candidate=>candidate.preflightCalls===1));
});

test('verified test setup returns only metadata, updates the adapter and never persists or logs keys',async t=>{
  const {configure,owner,serverEnv,operations,candidates,factoryCalls,db,logs}=await fixture(t);
  const configured=await configure(); status(configured,200); noEcho(configured.body);
  assert.deepEqual(Object.keys(data(configured)).sort(),['accountId','clearedOnRestart','configured','mode','storage','verified','webhookConfigured']);
  assert.equal(data(configured).mode,'test'); assert.equal(data(configured).storage,'process-memory'); assert.equal(data(configured).clearedOnRestart,true);
  assert.equal(serverEnv.STRIPE_SECRET_KEY,FAKE_KEY); assert.equal(serverEnv.STRIPE_WEBHOOK_SECRET,FAKE_WEBHOOK);
  assert.equal(operations.stripe,candidates[0]); assert.equal(candidates[0].preflightCalls,1);
  assert.deepEqual(factoryCalls[0].env,{}); assert.equal(factoryCalls[0].allowLive,false);
  const connections=await owner({method:'GET',url:'/api/connections'}); status(connections,200); noEcho(connections.body);
  assert.equal(data(connections).stripe.verified,true); assert.equal(data(connections).stripe.accountId,'acct_fixture123');
  assert.equal(data(connections).stripe.webhookConfigured,true);
  const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
  for (const {table_name:table} of tables) {
    const rows=(await db.query(`SELECT to_jsonb(r) AS value FROM "${table.replaceAll('"','""')}" AS r`)).rows;
    noEcho(rows);
  }
  assert.ok(logs.length>0); noEcho(logs.join(''));
});

test('closing the app restores only its original injected environment values',async t=>{
  const initialEnv={STRIPE_SECRET_KEY:`sk_test_${'I'.repeat(32)}`,STRIPE_WEBHOOK_SECRET:`whsec_${'J'.repeat(32)}`,UNRELATED:'unchanged'};
  const {app,configure,serverEnv,operations,initialStripe}=await fixture(t,{initialEnv});
  const response=await configure({secretKey:FAKE_KEY}); status(response,200);
  assert.equal(data(response).webhookConfigured,false); assert.equal(serverEnv.STRIPE_SECRET_KEY,FAKE_KEY);
  assert.equal(Object.hasOwn(serverEnv,'STRIPE_WEBHOOK_SECRET'),false);
  await app.close(); assert.deepEqual(serverEnv,initialEnv); assert.equal(operations.stripe,initialStripe);
});

test('webhook signing secrets are optional, blank is omitted, and malformed values never change configuration',async t=>{
  const {configure,factoryCalls,serverEnv,app}=await fixture(t);
  const invalid='whsec_invalid';
  const rejected=await configure({secretKey:FAKE_KEY,webhookSecret:invalid}); status(rejected,422);
  assert.equal(rejected.json().error.code,'STRIPE_WEBHOOK_SECRET_INVALID'); noEcho(rejected.body,[FAKE_KEY,invalid]);
  assert.equal(factoryCalls.length,0); assert.deepEqual(serverEnv,{});
  const blank=await configure({secretKey:FAKE_KEY,webhookSecret:''}); status(blank,200);
  assert.equal(data(blank).webhookConfigured,false); assert.equal(factoryCalls[0].webhookSecret,undefined);
  const omitted=await configure({secretKey:FAKE_KEY}); status(omitted,200); assert.equal(data(omitted).webhookConfigured,false);
  assert.equal(Object.hasOwn(serverEnv,'STRIPE_WEBHOOK_SECRET'),false);
  await app.close(); assert.deepEqual(serverEnv,{});
});
