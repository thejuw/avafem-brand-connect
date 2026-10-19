import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';

const VARIANT='gid://shopify/ProductVariant/123456789';
const SHOP='i4vd1u-s8.myshopify.com';
const data=response=>response.json().data;
const status=(response,expected)=>assert.equal(response.statusCode,expected,response.body);

async function fixture(t) {
  const calls={payment:0,shopify:0}; let payment;
  const stripe={status:async()=>({mode:'test',available:true}),
    preflight:async()=>({verified:true,mode:'test',accountId:'acct_fixture123'}),
    createTaxCalculation:async input=>({id:'taxcalc_fixture123',livemode:false,currency:'usd',amount_total:100,tax_amount_exclusive:0,tax_amount_inclusive:0,
      expires_at:Math.floor(Date.now()/1000)+3600,tax_breakdown:[],line_items:{has_more:false,data:[{reference:input.orderId,amount:100,quantity:1,
        tax_code:'txcd_99999999',tax_behavior:'exclusive',amount_tax:0}]}}),
    createPaymentIntent:async input=>{calls.payment++; payment={id:'pi_fixture123',livemode:false,status:'requires_action',currency:'usd',amount:100,amount_received:0,
      transfer_group:`ORD_${input.orderId}`,metadata:{order_id:input.orderId,integration:'avafem'},client_secret:'fixture_client_secret'};return payment;},
    getPaymentIntent:async()=>payment,
  };
  const shopify={shop:SHOP,status:async()=>({shop:SHOP,available:true}),
    preflight:async()=>({shop:{myshopifyDomain:SHOP,currencyCode:'USD'},grantedScopes:[...SHOPIFY_ALLOWED_SCOPES],missingScopes:[],unexpectedScopes:[]}),
    listProducts:async()=>({products:[],pageInfo:{hasNextPage:false}}),
    getVariant:async()=>({id:VARIANT,sku:'FIXTURE-100',title:'Default',productTitle:'Fixture',productStatus:'ACTIVE',priceCents:100,currency:'USD',inventoryQty:5,tracked:true,requiresShipping:true}),
    createOrder:async()=>{calls.shopify++;throw new Error('No Shopify order is permitted for an unconfirmed fixture payment.');},
  };
  const app=await createApp({worker:false,seed:false,connectionString:null,shopifyOAuth:{env:{}},
    integrations:{shopify,stripe,serverEnv:{}},testCheckout:{getStripe:()=>stripe,shopify}});
  t.after(()=>app.close()); await app.ready();
  const request=options=>app.inject({...options,headers:{host:'localhost:4317',...options.headers}});
  const session=await request({method:'GET',url:'/api/session'});status(session,200);
  const cookie=String(session.headers['set-cookie']).split(';')[0],csrf=data(session).csrfToken;
  const owner=options=>request({...options,headers:{cookie,'x-csrf-token':csrf,...options.headers}});
  return {app,request,owner,cookie,calls,...app.avafem};
}

test('test checkout routes require the local owner workspace for reads and mutations',async t=>{
  const {app,request,owner,auth,calls}=await fixture(t);
  status(await request({method:'GET',url:'/api/test-checkout/options'}),401);
  const brand=await auth.createSession({brandId:'brand_fixture'});
  status(await request({method:'GET',url:'/api/test-checkout',headers:{cookie:`avf_session=${brand.token}`}}),403);
  status(await owner({method:'GET',url:'/api/test-checkout/options',remoteAddress:'198.51.100.8'}),403);
  status(await owner({method:'GET',url:'/api/test-checkout/options',headers:{host:'public.example'}}),403);
  status(await owner({method:'GET',url:'/api/test-checkout/options',headers:{origin:'https://public.example'}}),403);
  status(await owner({method:'GET',url:'/api/test-checkout/options'}),200);
  const list=await owner({method:'GET',url:'/api/test-checkout'});status(list,200);assert.deepEqual(data(list),[]);
  assert.equal(calls.payment,0);assert.equal(calls.shopify,0);
  assert.equal(app.avafem.config.mode,'sandbox');
});

test('test quotes require CSRF and reject caller-provided price, address or payment overrides',async t=>{
  const {request,owner,cookie,calls}=await fixture(t);
  status(await request({method:'POST',url:'/api/test-checkout/quote',headers:{cookie},payload:{variantId:VARIANT}}),403);
  for (const payload of [{variantId:'invalid'},{variantId:VARIANT,amountCents:1},{variantId:VARIANT,shipTo:{name:'Arbitrary address'}},{variantId:VARIANT,paymentMethodId:'pm_other'}])
    status(await owner({method:'POST',url:'/api/test-checkout/quote',payload}),422);
  const quote=await owner({method:'POST',url:'/api/test-checkout/quote',payload:{variantId:VARIANT}});status(quote,200);
  assert.equal(data(quote).state,'quoted');assert.equal(data(quote).amounts.totalCents,100);
  assert.equal(calls.payment,0);assert.equal(calls.shopify,0);
});

test('pay needs explicit confirmation and a failed payment cannot dispatch Shopify or leak its client secret',async t=>{
  const {request,owner,cookie,calls}=await fixture(t);
  const quoted=await owner({method:'POST',url:'/api/test-checkout/quote',payload:{variantId:VARIANT}});status(quoted,200);
  const url=`/api/test-checkout/${data(quoted).id}`;
  status(await owner({method:'POST',url:`${url}/pay`,payload:{confirmTest:false}}),422);
  status(await owner({method:'POST',url:`${url}/pay`,payload:{confirmTest:true,amountCents:1}}),422);
  status(await request({method:'POST',url:`${url}/pay`,headers:{cookie},payload:{confirmTest:true}}),403);
  assert.equal(calls.payment,0);
  const paid=await owner({method:'POST',url:`${url}/pay`,payload:{confirmTest:true}});status(paid,200);
  assert.notEqual(data(paid).state,'complete');assert.equal(calls.payment,1);assert.equal(calls.shopify,0);
  assert.ok(!paid.body.includes('fixture_client_secret'));assert.ok(!paid.body.includes('client_secret'));
  status(await owner({method:'POST',url:`${url}/reconcile`,payload:{retryPayment:true}}),422);
  const reconciled=await owner({method:'POST',url:`${url}/reconcile`,payload:{}});status(reconciled,200);
  assert.equal(calls.payment,1);assert.equal(calls.shopify,0);
  const readback=await owner({method:'GET',url});status(readback,200);assert.ok(!readback.body.includes('fixture_client_secret'));
});
