import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { PLATFORM_PATHS } from '../server/platform/openapi.mjs';
import { openApiDocument } from '../server/openapi.mjs';

const onboardingRoutes=[
  ['get','/api/onboarding/session'],['get','/api/onboarding/{brandId}'],['post','/api/onboarding/{brandId}/detect'],
  ['post','/api/onboarding/{brandId}/connect'],['post','/api/onboarding/{brandId}/catalog'],['post','/api/onboarding/{brandId}/sync'],
  ['post','/api/onboarding/{brandId}/refresh'],['patch','/api/onboarding/{brandId}/profile'],['post','/api/onboarding/{brandId}/payouts/skip'],
  ['post','/api/onboarding/{brandId}/payouts/start'],['post','/api/onboarding/{brandId}/shopify/authorize'],
];
const adminRoutes=[
  ['get','/api/admin/curation'],['post','/api/admin/curation/bulk'],['put','/api/admin/curation/brands/{brandId}/auto-approve'],
  ['get','/api/admin/onboarding/{brandId}/invites'],['post','/api/admin/onboarding/{brandId}/invites'],
  ['post','/api/admin/onboarding/{brandId}/invites/{inviteId}/resend'],['post','/api/admin/onboarding/{brandId}/invites/{inviteId}/revoke'],
];
const doc=()=>openApiDocument('https://docs.example.com');
const body=operation=>operation.requestBody.content['application/json'].schema;
const result=operation=>operation.responses['200'].content['application/json'].schema.properties.data;

test('every documented platform path is a registered route and appears in /openapi.json', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const doc = (await f.request({ method: 'GET', url: '/openapi.json' })).json();
  for (const [method, path] of PLATFORM_PATHS) {
    assert.ok(f.app.hasRoute({ method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1') }), `${method} ${path} registered`);
    assert.ok(doc.paths[path]?.[method], `${method} ${path} documented`);
  }
  for(const [path,methods] of Object.entries(doc.paths).filter(([path])=>path.startsWith('/api/admin/recovery'))) {
    for(const operation of Object.values(methods)) {
      assert.deepEqual(operation.security,[{sessionCookie:[]}],path);
      assert.match(operation.description,/x-csrf-token/);
      assert.ok(operation.responses['409'],path);
    }
  }
  assert.deepEqual(doc.paths['/api/admin/recovery/subscriptions/{id}/continue'].post.requestBody.content['application/json'].schema.required,['operationId']);
  assert.equal(doc.paths['/api/crm/outbox'].get.parameters.find(p=>p.name==='limit').schema.maximum,500);
});

test('onboarding and admin lifecycle routes explicitly require browser cookies, never bearer, and mutation CSRF headers',()=>{
  const d=doc();
  for(const [method,path] of [...onboardingRoutes,...adminRoutes]){
    const operation=d.paths[path]?.[method];assert(operation,`${method} ${path}`);
    assert.deepEqual(operation.security,[{sessionCookie:[]}]);assert.equal(operation['x-browser-session-required'],true);
    assert.equal(operation['x-bearer-allowed'],false);assert.equal(operation['x-owner-required'],path.startsWith('/api/admin/'));
    assert(!operation.security.some(s=>s.apiKey || s.oauth2));
    const csrf=operation.parameters.filter(p=>p.in==='header' && p.name==='x-csrf-token');
    assert.equal(csrf.length,method==='get'?0:1,path);assert.equal(operation['x-csrf-required'],method!=='get');
    if(method!=='get'){assert.equal(csrf[0].required,true);assert.equal(csrf[0].schema.minLength,1);assert.match(operation.description,/x-csrf-token/);}
    if(path.includes('{brandId}'))assert(operation.parameters.some(p=>p.in==='path' && p.name==='brandId' && p.required));
  }
  assert.equal(d.paths['/api/onboarding/session'].get['x-tenant-scope'],'authenticated-brand-session');
  assert.equal(d.paths['/api/onboarding/{brandId}'].get['x-tenant-scope'],'authenticated-brand-or-owner-workspace');
  assert(!d.info.description.includes('All POST mutations require 24-hour idempotency keys.'));
});

test('public invitation previews are minimal/uncredentialed and acceptance establishes only a brand session',()=>{
  const d=doc();
  for(const path of ['/api/onboarding/invites/{token}','/api/invites/{token}']){
    const operation=d.paths[path].get,preview=result(operation);
    assert.deepEqual(operation.security,[]);assert.deepEqual(operation.tags,['public']);assert.equal(operation['x-browser-session-required'],undefined);
    assert(!operation.parameters.some(p=>p.name==='x-csrf-token'));
    assert.equal(preview.additionalProperties,false);assert.deepEqual(Object.keys(preview.properties).sort(),['brand','expiresAt','sandbox']);
    assert.equal(preview.properties.brand.additionalProperties,false);assert.deepEqual(Object.keys(preview.properties.brand.properties).sort(),['id','name']);
    assert.equal(preview.properties.sandbox.const,true);assert.equal(preview.properties.expiresAt.format,'date-time');
    assert.match(operation.description,/no session|No cookie\/session/);
  }
  const accept=d.paths['/api/invites/{token}/accept'].post;
  assert.deepEqual(accept.security,[]);assert.equal(body(accept).properties.acceptedSandboxTerms.const,true);
  assert.deepEqual(body(accept).required,['acceptedSandboxTerms']);
  assert.equal(result(accept).properties.role.const,'brand');assert.equal(result(accept).properties.sandbox.const,true);
  assert.equal(result(accept).additionalProperties,false);assert(!Object.hasOwn(result(accept).properties,'owner'));
  assert.match(accept.description,/single|one active/);assert.match(accept.description,/No provider authorization/);
});

test('new onboarding request schemas match strict route fields and reject caller-controlled authority',()=>{
  const d=doc(),base='/api/onboarding/{brandId}';
  for(const [method,path] of onboardingRoutes.filter(([method])=>method!=='get'))assert.equal(body(d.paths[path][method]).additionalProperties,false,path);
  const detect=body(d.paths[`${base}/detect`].post);assert.deepEqual(detect.required,['storeUrl']);assert.equal(detect.properties.storeUrl.maxLength,2048);
  const connect=body(d.paths[`${base}/connect`].post);assert.deepEqual(connect.required,['platform']);assert.deepEqual(connect.properties.platform.enum,['shopify','woocommerce','bigcommerce','csv']);
  assert.deepEqual(Object.keys(connect.properties).sort(),['credentials','platform']);assert.equal(connect.properties.credentials.additionalProperties.type,'string');
  assert.equal(connect.properties.credentials.additionalProperties.maxLength,2000);
  const csv=body(d.paths[`${base}/catalog`].post);assert.deepEqual(csv.required,['csv']);assert.equal(csv.properties.csv.maxLength,3_000_000);
  const profile=body(d.paths[`${base}/profile`].patch);assert.deepEqual(Object.keys(profile.properties).sort(),['logoUrl','name','returnPolicy','supportEmail']);
  assert.equal(profile.properties.name.maxLength,160);assert.equal(profile.properties.logoUrl.maxLength,2048);assert.equal(profile.properties.supportEmail.maxLength,254);assert.equal(profile.properties.returnPolicy.maxLength,12_000);
  for(const suffix of ['sync','refresh','payouts/skip','payouts/start','shopify/authorize']){
    const operation=d.paths[`${base}/${suffix}`].post;assert.equal(operation.requestBody.required,false,suffix);
    assert.deepEqual(body(operation).properties,{});assert.equal(body(operation).additionalProperties,false);
  }
});

test('curation documents exact strict query filters, bounded atomic fingerprint decisions and explicit initial-only policy',()=>{
  const d=doc(),queue=d.paths['/api/admin/curation'].get;
  assert.equal(queue['x-strict-query'],true);
  const query=Object.fromEntries(queue.parameters.filter(p=>p.in==='query').map(p=>[p.name,p]));
  assert.deepEqual(Object.keys(query).sort(),['brandId','collection','ids','productType','sinceReview','status','tag']);
  assert(Object.values(query).every(p=>p.required===false));
  assert.equal(query.ids.schema.maxLength,10_000);assert.match(query.ids.schema.description,/500/);
  assert.deepEqual(query.status.schema.enum,['draft','in_review','approved','rejected']);assert.deepEqual(query.sinceReview.schema.enum,['new','changed','new_or_changed']);
  assert.equal(query.brandId.schema.maxLength,100);for(const field of ['collection','productType','tag'])assert.equal(query[field].schema.maxLength,200);
  const operation=d.paths['/api/admin/curation/bulk'].post,bulk=body(operation);
  assert.equal(bulk.additionalProperties,false);assert.deepEqual(bulk.required,['operationId','reason','action']);assert.deepEqual(bulk.properties.action.enum,['approved','rejected']);
  assert.equal(bulk.properties.products.minItems,1);assert.equal(bulk.properties.products.maxItems,500);
  const selected=bulk.properties.products.items;assert.equal(selected.additionalProperties,false);assert.deepEqual(selected.required,['id','fingerprint']);
  assert.equal(selected.properties.id.maxLength,100);assert.equal(selected.properties.fingerprint.pattern,'^[a-f0-9]{64}$');assert.equal(selected.properties.overrideReason.minLength,10);
  assert.equal(bulk.properties.filter.additionalProperties,false);assert.deepEqual(Object.keys(bulk.properties.filter.properties).sort(),Object.keys(query).filter(k=>k!=='ids').sort());
  assert.deepEqual(bulk.anyOf.map(v=>v.required),[['products'],['filter']]);assert.equal(operation['x-idempotency-body-field'],'operationId');
  const policy=d.paths['/api/admin/curation/brands/{brandId}/auto-approve'].put;
  assert.equal(body(policy).additionalProperties,false);assert.deepEqual(body(policy).required,['enabled','reason']);assert.equal(body(policy).properties.enabled.type,'boolean');
  assert.match(policy.description,/initial catalog/);assert.match(policy.description,/disabled by default/);assert.match(policy.description,/Does not approve flagged/);
});

test('invite create/resend use body-bound operations and strict optional recipient; lists and revoke never promise fake delivery',()=>{
  const d=doc(),base='/api/admin/onboarding/{brandId}/invites';
  for(const path of [base,`${base}/{inviteId}/resend`]){
    const operation=d.paths[path].post,schema=body(operation);
    assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['operationId']);assert.deepEqual(Object.keys(schema.properties).sort(),['email','operationId']);
    assert.equal(schema.properties.operationId.pattern,'^[A-Za-z0-9_-]{8,100}$');assert.equal(schema.properties.email.format,'email');assert.equal(schema.properties.email.maxLength,254);
    assert.equal(operation['x-idempotency-body-field'],'operationId');assert(!operation.parameters.some(p=>p.name==='Idempotency-Key'));
    const response=result(operation);assert.equal(response.additionalProperties,false);assert.equal(response.properties.token.maxLength,100);
    assert.equal(response.properties.delivery.properties.delivered.const,false);assert.equal(response.properties.delivery.properties.simulated.type,'boolean');
    assert.match(response.properties.delivery.properties.providerAccepted.description,/not proof of inbox/);
    assert.match(operation.description,/Unknown outcomes remain reserved/);assert.match(operation.description,/Email needs an explicitly configured/);
  }
  assert.match(d.paths[base].get.description,/never returns tokens, token hashes, recipient addresses or email bodies/);
  const revoke=d.paths[`${base}/{inviteId}/revoke`].post;assert.equal(revoke.requestBody.required,false);assert.equal(body(revoke).additionalProperties,false);
  assert.deepEqual(body(revoke).properties,{});assert.match(revoke.description,/does not revoke an already-established brand session/);
});

test('discovery and payout documentation distinguish hints/configuration/links from verified provider outcomes',()=>{
  const d=doc(),base='/api/onboarding/{brandId}',detected=result(d.paths[`${base}/detect`].post);
  assert.equal(detected.properties.verified.const,false);assert.equal(detected.properties.advisory.const,true);assert.equal(detected.properties.capability.properties.configured.const,false);
  assert(detected.properties.probeStatus.enum.includes('disabled_local_only'));assert(detected.properties.probeStatus.enum.includes('ambiguous'));
  assert.match(d.paths[`${base}/detect`].post.description,/never installs an app or grants permissions/);
  assert.match(d.paths[`${base}/connect`].post.description,/authorizationRequired:true, configured:false/);
  assert.match(d.paths[`${base}/payouts/start`].post.description,/providerVerified:false/);assert.match(d.paths[`${base}/payouts/start`].post.description,/never completes KYC/);
  assert.match(d.paths[`${base}/payouts/skip`].post.description,/payables remain held/);
  assert.match(d.paths[`${base}/shopify/authorize`].post.description,/merchant approval and verified callback/);
  assert.equal(new Set(PLATFORM_PATHS.map(([, ,id])=>id)).size,PLATFORM_PATHS.length,'unique operation IDs');
});
