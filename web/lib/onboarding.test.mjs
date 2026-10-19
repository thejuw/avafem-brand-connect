import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityLabel,clearCredentialForm,connectionNotice,createOnboardingTransport,credentialsFromForm,inviteDeliveryLabel,labelOf,manualPlatformChoice,normalizeOnboarding,normalizeStoreUrl,payoutApprovalUrl,profilePatch,safeApprovalUrl,safeInvitePath} from './onboarding.mjs';

test('invite transport performs no bootstrap and switches to its accepted brand CSRF only explicitly',async()=>{
  const calls=[];
  const transport=createOnboardingTransport(async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>({data:path.endsWith('/accept')?{brandId:'brand_test',csrfToken:'accepted-brand-csrf'}:{status:'ok'}})};});
  assert.equal(calls.length,0);
  await transport.request('/api/onboarding/invites/synthetic-token');
  const accepted=await transport.request('/api/invites/synthetic-token/accept',{method:'POST',body:{acceptedSandboxTerms:true}});
  transport.setSession(accepted);
  await transport.request('/api/onboarding/brand_test/profile',{method:'PATCH',body:{name:'Synthetic'}});
  assert.ok(calls.every(c=>c.path!=='/api/session'));
  assert.equal(calls[1].options.headers['x-csrf-token'],undefined);
  assert.equal(calls[2].options.headers['x-csrf-token'],'accepted-brand-csrf');
  assert.equal(calls[2].options.credentials,'same-origin');
  assert.equal(calls[2].options.body,JSON.stringify({name:'Synthetic'}));
});

test('existing-session resume is a deliberate session-only call, not transport construction',async()=>{
  let calls=0;const transport=createOnboardingTransport(async path=>{calls++;assert.equal(path,'/api/onboarding/session');return {ok:true,json:async()=>({data:{brandId:'brand_test',csrfToken:'brand'}})};});
  assert.equal(calls,0);await transport.request('/api/onboarding/session');assert.equal(calls,1);
});

test('store URL normalization rejects credential/private/non-HTTPS addresses without any discovery calls',()=>{
  assert.equal(normalizeStoreUrl('shop.example.com'),'https://shop.example.com/');
  for(const value of ['http://shop.example.com','https://user:pass@shop.example.com','https://127.0.0.1','https://192.168.1.1','https://localhost','https://shop.example.com/#token'])assert.throws(()=>normalizeStoreUrl(value));
});

test('provider approval URLs must be HTTPS provider/store-bound and never simulated or arbitrary links',()=>{
  assert.ok(safeApprovalUrl('https://test-shop.myshopify.com/admin/oauth/authorize?client_id=public',{platform:'shopify'}));
  assert.ok(safeApprovalUrl('https://admin.shopify.com/store/test-shop/oauth/authorize',{platform:'shopify'}));
  assert.ok(safeApprovalUrl('https://login.bigcommerce.com/oauth2/authorize',{platform:'bigcommerce'}));
  assert.ok(safeApprovalUrl('https://shop.example.com/wc-auth/v1/authorize',{platform:'woocommerce',storeUrl:'https://shop.example.com'}));
  assert.equal(safeApprovalUrl('https://elsewhere.example.com/wc-auth/v1/authorize',{platform:'woocommerce',storeUrl:'https://shop.example.com'}),null);
  assert.equal(safeApprovalUrl('javascript:alert(1)',{platform:'shopify'}),null);
  assert.equal(safeApprovalUrl('https://admin.shopify.com.evil.test/',{platform:'shopify'}),null);
  assert.equal(safeApprovalUrl('https://user:secret@admin.shopify.com/',{platform:'shopify'}),null);
  assert.equal(safeApprovalUrl('https://accounts.stripe.com:8443/r/acct_12345678',{kind:'payout'}),null);
  assert.ok(safeApprovalUrl('https://accounts.stripe.com/r/acct_12345678#test_capability',{kind:'payout'}));
  assert.ok(safeApprovalUrl('https://connect.stripe.com/setup/s/official-test-link',{kind:'payout'}));
  assert.equal(safeApprovalUrl('https://connect.stripe.com/setup/e/acct_sandbox_fake/simulated',{kind:'payout'}),null,'simulated Express URLs must never become a provider link');
  assert.equal(payoutApprovalUrl({url:'https://connect.stripe.com/setup/s/looks-official',simulated:true}),null);
  assert.equal(payoutApprovalUrl({url:'https://connect.stripe.com/setup/s/looks-official',mode:'simulated'}),null);
  assert.equal(safeApprovalUrl('https://accounts.stripe.com/r/acct_12345678/arbitrary-path',{kind:'payout'}),null);
});

test('missing capabilities/counts are not converted into verified setup or zero pending products',()=>{
  assert.equal(capabilityLabel({}),'Not configured');
  assert.match(capabilityLabel({configured:true,simulated:true}),/Simulated/);
  assert.equal(capabilityLabel({mode:'test'}),'Not configured');
  assert.equal(capabilityLabel({configured:true,mode:'test'}),'Provider test mode');
  const state=normalizeOnboarding({brand:{id:'brand_test',name:'Synthetic'},profile:{name:{name:'Store name'},returnPolicy:{text:'Store-provided policy'},logoUrl:'javascript:unsafe'},payouts:{status:'deferred'}});
  assert.equal(state.profile.name,'Store name');assert.equal(state.profile.returnPolicy,'Store-provided policy');assert.equal(state.profile.logoUrl,'');
  assert.equal(state.pendingCuration,null);assert.equal(state.storeComplete,false);assert.equal(state.payoutDeferred,true);
  assert.equal(normalizeOnboarding({steps:{store:{complete:false}},connection:{status:'connected'}}).storeComplete,false,'a connected store with an incomplete catalog does not finish step one');
  assert.equal(normalizeOnboarding({brand:{supportEmail:'synthetic@example.test'},profile:{provenance:'provider'}}).profile.supportEmail,'synthetic@example.test');
  assert.equal(labelOf({unexpected:'object'},'Unavailable'),'Unavailable');
});

test('custom-domain advisory detection permits only explicit supported manual credential choices',()=>{
  assert.equal(manualPlatformChoice('woocommerce'),'woocommerce');
  assert.equal(manualPlatformChoice('bigcommerce'),'bigcommerce');
  for(const value of ['unknown','csv','shopify','https://foreign.example',null])assert.equal(manualPlatformChoice(value),'');
});

test('actual nested connection results do not show an unconfigured error or certify simulated acceptance',()=>{
  assert.match(connectionNotice({connection:{status:'connected'}}),/^Store connection verified/);
  assert.match(connectionNotice({connection:{status:'connected',simulated:true}}),/not provider acceptance/);
  assert.match(connectionNotice({authorizationRequired:true},true),/Continue with provider approval/);
  assert.match(connectionNotice({}),/not configured/);
});

test('owner invitation output accepts local paths only and never claims email delivery',()=>{
  const path='/onboard/synthetic.private.capability.token';
  assert.equal(safeInvitePath({path}),path);
  assert.equal(safeInvitePath({token:'synthetic.private.capability.token'}),path);
  for(const unsafe of ['https://foreign.example/onboard/synthetic.private.capability.token','//foreign.example/onboard/synthetic.private.capability.token',`${path}?secret=bad`,`${path}#bad`,'/onboard/../../settings'])assert.equal(safeInvitePath({path:unsafe}),null);
  assert.match(inviteDeliveryLabel({providerAccepted:true},{configured:true}),/not delivery confirmation/);
  assert.match(inviteDeliveryLabel({status:'uncertain'},{configured:true}),/uncertain/);
  assert.match(inviteDeliveryLabel({state:'pending'},{configured:true}),/review/);
  assert.match(inviteDeliveryLabel({providerAccepted:true,simulated:true},{configured:true}),/not external delivery/);
  assert.match(inviteDeliveryLabel(),/not configured/);
});

test('manual credential inputs are read only for the selected platform and cleared without browser storage',()=>{
  const fields={consumerKey:{value:'ck_synthetic'},consumerSecret:{value:'cs_synthetic'},storeHash:{value:'synthetic'},accessToken:{value:'synthetic_token'}};
  const form={elements:{namedItem:name=>fields[name]}};
  assert.deepEqual(credentialsFromForm(form,'woocommerce','https://shop.example.com'),{storeUrl:'https://shop.example.com/',consumerKey:'ck_synthetic',consumerSecret:'cs_synthetic'});
  assert.deepEqual(credentialsFromForm(form,'bigcommerce'),{storeHash:'synthetic',accessToken:'synthetic_token'});
  assert.equal(credentialsFromForm(form,'shopify'),undefined);
  clearCredentialForm(form);assert.ok(Object.values(fields).every(f=>f.value===''));
});

test('editable profile patch allows supported fields and rejects unsafe logo URLs',()=>{
  assert.deepEqual(profilePatch({name:'  Synthetic  ',supportEmail:'help@example.test',unexpected:'ignored'}),{name:'Synthetic',supportEmail:'help@example.test'});
  assert.throws(()=>profilePatch({logoUrl:'http://insecure.example/logo.png'}));
});
