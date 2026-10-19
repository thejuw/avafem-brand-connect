import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';

let seq=0;
async function fixture(t,extra={}) {
  const f=await platformFixture(t,extra);
  const as=(cookie,csrf)=>o=>f.request({...o,headers:{cookie,'x-csrf-token':csrf,...o.headers}});
  async function member(role,brandId='brand_bloom') {
    const m=await f.platform.portal.addMember(brandId,{email:`route-${role}-${++seq}@example.invalid`,role},{owner:true,role:'admin'});
    const mail=(await f.platform.portal.outbox({memberId:m.id}))[0];const token=/#(?:token|invite)=([A-Za-z0-9_-]{43})/.exec(mail.body)[1];
    const r=await f.request({method:'POST',url:'/api/brand-auth/login/verify',payload:{token}});assert.equal(r.statusCode,200,r.body);
    return {id:m.id,request:as(String(r.headers['set-cookie']).split(';')[0],r.json().data.csrfToken),cookie:String(r.headers['set-cookie']).split(';')[0]};
  }
  return {...f,member,as};
}
const status=async(promise,code)=>{const r=await promise;assert.equal(r.statusCode,code,r.body);return r.json().data;};

test('finance browser routes are a financial-only allowlist, including old unscoped APIs',async t=>{
  const f=await fixture(t),finance=await f.member('finance'),own=(await f.domain.listProducts({brandId:'brand_bloom'}))[0];
  const denied=['/api/dashboard','/api/brands','/api/products','/api/bags','/api/events','/api/brands/brand_bloom/shopify','/api/onboarding/session','/api/onboarding/brand_bloom',
    '/api/brands/brand_bloom/analytics','/api/portal/brand_bloom/status','/api/portal/brand_bloom/connectors','/api/placements','/api/refunds','/api/crm/tickets',
    '/api/compliance/brands/brand_bloom',`/api/products/${own.id}/compliance`, '/api/crm/brand/reviews',`/api/crm/products/${own.id}/reviews`, '/api/brands/brand_bloom/credentials','/api/brand-portal/members',
    '/api/brands/brand_bloom/payout-check','/api/admin/disputes'];
  for(const url of denied)await status(finance.request({method:'GET',url}),403);
  for(const url of ['/api/onboarding/brand_bloom/connect','/api/onboarding/brand_bloom/detect','/api/onboarding/brand_bloom/payouts/start','/api/portal/brand_bloom/stripe/link','/api/portal/brand_bloom/stripe/return','/api/placements','/api/brands/brand_bloom/credentials'])await status(finance.request({method:'POST',url,payload:{}}),403);
  for(const url of ['/api/finance','/api/billing','/api/brand-portal/statements?month=2026-10','/api/brand-portal/reports/annual?year=2026','/api/reports/brand-payouts?year=2026'])await status(finance.request({method:'GET',url}),200);
  const dashboard=await status(finance.request({method:'GET',url:'/api/brand-portal/dashboard'}),200);
  assert.ok(dashboard.upcomingPayout);for(const key of ['sales','conversion','returns','topProducts','listings','store','placements'])assert.equal(dashboard[key],undefined,key);
  const me=await status(finance.request({method:'GET',url:'/api/brand-auth/me'}),200);assert.equal(me.emailDelivery.simulated,true);assert.equal(me.emailDelivery.delivered,false);
});

test('staff retain catalog/orders but not mixed-finance aggregates, onboarding or connection settings; review reads stay tenant-bound',async t=>{
  const f=await fixture(t),staff=await f.member('staff');
  for(const url of ['/api/products','/api/bags','/api/crm/tickets','/api/brands'])await status(staff.request({method:'GET',url}),200);
  for(const url of ['/api/dashboard','/api/events','/api/finance','/api/brands/brand_bloom/shopify','/api/onboarding/session','/api/onboarding/brand_bloom','/api/portal/brand_bloom/status','/api/portal/brand_bloom/connectors'])await status(staff.request({method:'GET',url}),403);
  for(const url of ['/api/onboarding/brand_bloom/connect','/api/portal/brand_bloom/connect'])await status(staff.request({method:'POST',url,payload:{platform:'csv'}}),403);
  const foreign=(await f.domain.listProducts({brandId:'brand_lunelle'}))[0];await status(staff.request({method:'GET',url:`/api/crm/products/${foreign.id}/reviews`}),404);
  const own=(await f.domain.listProducts({brandId:'brand_bloom'}))[0];await status(staff.request({method:'GET',url:`/api/crm/products/${own.id}/reviews`}),200);
});

test('identified owners create one-time API keys, durable replay has no secret, tenant revocation is idempotent and audited',async t=>{
  const f=await fixture(t),owner=await f.member('owner'),base='/api/brands/brand_bloom/credentials';
  const input={operationId:'owner_key_create_once',kind:'api_key',label:'Warehouse fixture',scopes:['orders:read']};
  const first=await status(owner.request({method:'POST',url:base,payload:input}),200);assert.match(first.apiKey,/^avf_test_/);assert.equal(first.secretAvailable,true);
  const replay=await status(owner.request({method:'POST',url:base,payload:input}),200);assert.equal(replay.id,first.id);assert.equal(replay.apiKey,undefined);assert.equal(replay.secretAvailable,false);assert.equal(replay.replayed,true);
  await status(owner.request({method:'POST',url:base,payload:{...input,label:'Changed request'}}),422);
  for(const scopes of [['members:manage'],['reports:read'],['credentials:manage']])await status(owner.request({method:'POST',url:base,payload:{...input,operationId:'disallowed_scope_fixture',scopes}}),422);
  await status(owner.request({method:'POST',url:base,payload:{...input,kind:'oauth_client'}}),422);
  const list=await status(owner.request({method:'GET',url:base}),200);assert.equal(list.find(k=>k.id===first.id).apiKey,undefined);
  const raw=JSON.stringify((await f.db.query('SELECT * FROM api_credentials')).rows)+JSON.stringify((await f.db.query('SELECT * FROM member_api_key_operations')).rows)+JSON.stringify((await f.db.query('SELECT * FROM api_idempotency')).rows);
  assert.equal(raw.includes(first.apiKey),false,'raw and encrypted secret are absent from durable key/operation/cache storage');
  assert.match((await f.db.query('SELECT secret_hash FROM api_credentials WHERE id=$1',[first.id])).rows[0].secret_hash,/^[a-f0-9]{64}$/);
  await status(f.request({method:'GET',url:'/v1/bags',headers:{authorization:`Bearer ${first.apiKey}`}}),200);
  await status(f.request({method:'POST',url:base,headers:{authorization:`Bearer ${first.apiKey}`},payload:input}),403);
  await status(f.request({method:'POST',url:base,headers:{cookie:owner.cookie},payload:input}),403);
  const foreign=await f.auth.createCredential('brand_lunelle',{scopes:['orders:read']});await status(owner.request({method:'DELETE',url:`${base}/${foreign.id}`}),404);
  await status(owner.request({method:'POST',url:'/api/brands/brand_lunelle/credentials',payload:input}),403);
  const oauth=await f.auth.createCredential('brand_bloom',{kind:'oauth_client',scopes:['orders:read']});await status(owner.request({method:'DELETE',url:`${base}/${oauth.id}`}),404);
  const revoked=await status(owner.request({method:'DELETE',url:`${base}/${first.id}`}),200);assert.equal(revoked.revoked,true);
  const again=await status(owner.request({method:'DELETE',url:`${base}/${first.id}`}),200);assert.equal(again.replayed,true);
  await status(f.request({method:'GET',url:'/v1/bags',headers:{authorization:`Bearer ${first.apiKey}`}}),401);
  const audits=(await f.db.query("SELECT actor,action FROM audit_log WHERE resource_id=$1 AND action LIKE 'brand_credential.%'",[first.id])).rows;
  assert.deepEqual(audits.map(a=>a.action).sort(),['brand_credential.created','brand_credential.revoked']);assert.ok(audits.every(a=>a.actor===`member:${owner.id}`));
  const adminInput={...input,operationId:'workspace_managed_key_once'};
  const adminFirst=await status(f.owner({method:'POST',url:base,payload:adminInput}),200);assert.equal(adminFirst.secretAvailable,true);assert.match(adminFirst.apiKey,/^avf_test_/);
  const adminReplay=await status(f.owner({method:'POST',url:base,payload:adminInput}),200);assert.equal(adminReplay.id,adminFirst.id);assert.equal(adminReplay.apiKey,undefined);assert.equal(adminReplay.secretAvailable,false);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM member_api_key_operations WHERE operation_id=$1',[adminInput.operationId])).rows[0].n,1);
});

test('onboarding invite sessions cannot manage keys/team or access customer/financial operational APIs',async t=>{
  const f=await fixture(t),b=await f.domain.createBrand({name:'Invite capability fixture'}),previous=await f.member('owner'),invite=await f.auth.createInvite(b.id);
  const accepted=await f.request({method:'POST',url:`/api/invites/${invite.token}/accept`,headers:{cookie:previous.cookie},payload:{acceptedSandboxTerms:true}});assert.equal(accepted.statusCode,200,accepted.body);
  const request=f.as(String(accepted.headers['set-cookie']).split(';')[0],accepted.json().data.csrfToken);
  await status(previous.request({method:'GET',url:'/api/brand-auth/me'}),401);
  for(const url of [`/api/brands/${b.id}/credentials`,'/api/brand-portal/members','/api/bags','/api/finance','/api/dashboard','/api/events'])await status(request({method:'GET',url}),403);
  await status(request({method:'POST',url:`/api/brands/${b.id}/credentials`,payload:{operationId:'invite_no_authority',label:'No',scopes:['orders:read']}}),403);
  await status(request({method:'POST',url:'/api/brand-portal/members',payload:{operationId:'invite_no_member',email:'owner@example.invalid',role:'owner'}}),403);
  await status(request({method:'GET',url:'/api/onboarding/session'}),200);await status(request({method:'GET',url:`/api/onboarding/${b.id}`}),200);
  await status(request({method:'POST',url:`/api/onboarding/${b.id}/detect`,payload:{storeUrl:'https://fixture.example.com'}}),200);
});

test('raw authentication mailbox is off by default; explicit local opt-in still requires operator, loopback host/IP and audit',async t=>{
  const f=await fixture(t);await status(f.owner({method:'GET',url:'/api/admin/brand-auth/outbox'}),404);
  const local=await fixture(t,{config:{allowAuthOutbox:true}}),owner=await local.member('owner');
  const list=await status(local.owner({method:'GET',url:'/api/admin/brand-auth/outbox'}),200);assert.ok(list.length);
  await status(owner.request({method:'GET',url:'/api/admin/brand-auth/outbox'}),403);
  await status(local.owner({method:'GET',url:'/api/admin/brand-auth/outbox',remoteAddress:'192.0.2.12'}),404);
  assert.equal((await local.db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action='brand_auth.outbox_viewed'")).rows[0].n,1);
  // openapi.json is intentionally unwrapped, inspect its policy directly.
  const api=(await local.request({method:'GET',url:'/openapi.json'})).json();assert.match(api.paths['/api/brands/{id}/credentials'].post.description,/first response contains apiKey/);
  assert.match(api.paths['/api/admin/brand-auth/outbox'].get.description,/Disabled by default/);
});
