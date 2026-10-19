import test from 'node:test';
import assert from 'node:assert/strict';
import { clearStripeSecretForm, configureStripeTestCredentials, isLoopbackHost } from './stripe-test-entry.mjs';

function fixture(secret='sk_test_SYNTHETIC_UNIT_TEST_ONLY',webhook='') {
  const fields={stripeTestSecretKey:{value:secret},stripeWebhookSigningSecret:{value:webhook}};
  return {fields,form:{elements:{namedItem:name=>fields[name]},reset(){for(const field of Object.values(fields))field.value='';}}};
}
const publicResponse={configured:true,verified:true,mode:'test',accountId:'acct_123456',webhookConfigured:false,storage:'process-memory',clearedOnRestart:true};
test('Only exact loopback hosts can show local key entry', () => {
  for (const hostname of ['127.0.0.1','localhost','::1','[::1]']) assert.equal(isLoopbackHost(hostname),true);
  for (const hostname of ['localhost.example.com','127.0.0.1.example.com','avafem.com','0.0.0.0','']) assert.equal(isLoopbackHost(hostname),false);
});
test('A local owner sends secrets only in the POST body with CSRF and clears fields on success', async () => {
  const {form,fields}=fixture('sk_test_SYNTHETIC_UNIT_TEST_ONLY','whsec_SYNTHETIC_UNIT_TEST_ONLY');
  const result=await configureStripeTestCredentials({form,csrfToken:'csrf-fixture',hostname:'127.0.0.1',isOwner:true,fetchImpl:async(url,options)=>{
    assert.equal(url,'/api/local/stripe-test-credentials');
    assert.equal(options.method,'POST'); assert.equal(options.headers['x-csrf-token'],'csrf-fixture');
    assert.deepEqual(JSON.parse(options.body),{secretKey:'sk_test_SYNTHETIC_UNIT_TEST_ONLY',webhookSecret:'whsec_SYNTHETIC_UNIT_TEST_ONLY'});
    assert.equal(options.credentials,'same-origin'); assert.equal(options.cache,'no-store');
    return {ok:true,json:async()=>({data:{...publicResponse,secretKey:'MUST_NOT_ESCAPE_RESPONSE'}})};
  }});
  assert.equal(fields.stripeTestSecretKey.value,''); assert.equal(fields.stripeWebhookSigningSecret.value,'');
  assert.equal('secretKey' in result,false); assert.equal('webhookSecret' in result,false);
  assert.equal(result.verified,true);
});
test('Brand roles, external origins, and live keys never submit a request', async () => {
  let requests=0; const fetchImpl=async()=>{requests++;throw new Error('Must not call');};
  for (const config of [{hostname:'localhost',isOwner:false},{hostname:'example.com',isOwner:true}]) {
    await assert.rejects(()=>configureStripeTestCredentials({form:fixture().form,csrfToken:'csrf',fetchImpl,...config}),/local operations workspace/);
  }
  await assert.rejects(()=>configureStripeTestCredentials({form:fixture('sk_live_SYNTHETIC_UNIT_TEST_ONLY').form,csrfToken:'csrf',hostname:'localhost',isOwner:true,fetchImpl}),/Live keys are not accepted/);
  assert.equal(requests,0);
});
test('Server errors cannot echo submitted secrets into UI messages', async () => {
  const secret='sk_test_SYNTHETIC_UNIT_TEST_ONLY';
  await assert.rejects(()=>configureStripeTestCredentials({form:fixture(secret).form,csrfToken:'csrf',hostname:'localhost',isOwner:true,fetchImpl:async()=>({ok:false,json:async()=>({error:{message:`invalid ${secret}`}})})}),error=>!error.message.includes(secret) && /could not be verified/.test(error.message));
});
test('Closing key entry clears both DOM fields without retaining form values', () => {
  const {form,fields}=fixture('sk_test_SYNTHETIC_UNIT_TEST_ONLY','whsec_SYNTHETIC_UNIT_TEST_ONLY');
  clearStripeSecretForm(form);
  assert.equal(fields.stripeTestSecretKey.value,''); assert.equal(fields.stripeWebhookSigningSecret.value,'');
});
