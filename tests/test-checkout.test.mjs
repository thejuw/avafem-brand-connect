import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTestCheckout } from '../server/test-checkout.mjs';
import { SHOPIFY_ALLOWED_SCOPES } from '../server/integrations/shopify-policy.mjs';
import { shopifyBagTag } from '../server/integrations/projection.mjs';
import { createStripeAdapter } from '../server/integrations/stripe.mjs';

const SHOP='i4vd1u-s8.myshopify.com';
const VARIANT='gid://shopify/ProductVariant/123456789';
const CLIENT_SECRET='fixture_client_secret_never_return';
const money=cents=>({shopMoney:{amount:(cents/100).toFixed(2),currencyCode:'USD'}});
const settle=async operation=>{try{return {value:await operation()};}catch(error){return {error};}};
const noSecrets=value=>{
  const serialized=JSON.stringify(value);
  for (const secret of [CLIENT_SECRET,'secret_key_fixture','access_token_fixture']) assert.ok(!serialized.includes(secret));
  for (const field of ['client_secret','encryptedSnapshot','shipTo','ship_to','receiptEmail']) assert.ok(!serialized.includes(`"${field}"`));
};

async function fixture(t) {
  const db=await createDatabase({connectionString:null}); await db.migrate(); t.after(()=>db.close());
  const auth=await createAuth(db,{sessionSecret:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')});
  const instant=new Date('2026-10-18T12:00:00.000Z');
  const calls={preflight:0,tax:0,payment:0,retrieve:0,taxTransaction:0,shopify:0,readback:0,find:0,transfer:0,refund:0};
  const state={shop:SHOP,currency:'USD',missingScopes:[],unexpectedScopes:[],variantPatch:{},piPatch:{},retrievePatch:{},taxPatch:{},readbackPatch:{},onPaymentCreated:null,
    taxError:null,shopifyError:null,paymentError:null,remote:null,bag:null,options:null,privateAddress:null};
  const intents=new Map();
  const variant=()=>({id:VARIANT,sku:'FIXTURE-100',title:'Default',productTitle:'One-store test fixture',productStatus:'ACTIVE',
    priceCents:100,currency:state.currency,inventoryQty:5,tracked:true,requiresShipping:true,...state.variantPatch});
  const stripe={
    preflight:async()=>({provider:'stripe',verified:true,available:true,connected:true,mode:'test',accountId:'acct_fixture123'}),
    createTaxCalculation:async input=>{
      calls.tax++; if (state.taxError) throw state.taxError;
      const reference=input.items[0].reference;
      const calculation={id:`taxcalc_fixture${calls.tax}`,livemode:false,currency:'usd',amount_total:108,tax_amount_exclusive:8,tax_amount_inclusive:0,
        expires_at:Math.floor(instant.getTime()/1000)+3600,line_items:{has_more:false,data:[{id:'tax_li_fixture123',reference,amount:100,quantity:1,
          tax_code:'txcd_99999999',tax_behavior:'exclusive',amount_tax:8}]},
        tax_breakdown:[{amount:8,inclusive:false,tax_rate_details:{percentage_decimal:'8.25',tax_type:'sales_tax',country:'US',state:'TX'}}]};
      return {...calculation,...(typeof state.taxPatch==='function'?state.taxPatch(calculation):state.taxPatch)};
    },
    createPaymentIntent:async input=>{
      calls.payment++; state.privateAddress=input.shipTo;
      if (state.paymentError) throw state.paymentError;
      await new Promise(resolve=>setTimeout(resolve,5));
      const intent={id:`pi_fixture${calls.payment}abc`,livemode:false,status:'succeeded',currency:'usd',amount:input.amountCents,amount_received:input.amountCents,
        transfer_group:`ORD_${input.orderId}`,metadata:{order_id:input.orderId,integration:'avafem'},latest_charge:`ch_fixture${calls.payment}abc`,
        shipping:{name:input.shipTo.name,address:{line1:input.shipTo.line1,city:input.shipTo.city,state:input.shipTo.region,postal_code:input.shipTo.postal,country:input.shipTo.country}},
        client_secret:CLIENT_SECRET,...state.piPatch};
      intents.set(intent.id,intent); state.onPaymentCreated?.(); return structuredClone(intent);
    },
    getPaymentIntent:async paymentIntentId=>{calls.retrieve++; return structuredClone({...intents.get(paymentIntentId),...state.retrievePatch});},
    recordTaxTransaction:async input=>{calls.taxTransaction++; return {id:`tax_fixture${calls.taxTransaction}abc`,livemode:false,currency:'usd',reference:input.orderId};},
    createTransfer:async()=>{calls.transfer++; throw new Error('No payout is authorized by this acceptance test.');},
    createRefund:async()=>{calls.refund++; throw new Error('No refund is authorized by this acceptance test.');},
  };
  const shopify={shop:SHOP,
    preflight:async()=>{calls.preflight++;return {shop:{myshopifyDomain:state.shop,currencyCode:state.currency},
      grantedScopes:[...SHOPIFY_ALLOWED_SCOPES.filter(scope=>!state.missingScopes.includes(scope)),...state.unexpectedScopes],
      missingScopes:state.missingScopes,unexpectedScopes:state.unexpectedScopes};},
    listProducts:async()=>({products:[{id:'gid://shopify/Product/123',sku:'FIXTURE-100',title:'One-store test fixture',currency:'USD',sourceStatus:'ACTIVE',
      variants:[{sku:'FIXTURE-100',shopifyVariantId:VARIANT,price:{amount:100,currency:'USD'},inventory:{qty:5,policy:'deny'}}]}],pageInfo:{hasNextPage:false,endCursor:null}}),
    getVariant:async()=>variant(),
    findOrder:async()=>{calls.find++;return state.remote?{...state.remote}:null;},
    createOrder:async(bag,options)=>{
      calls.shopify++; state.bag=structuredClone(bag); state.options=structuredClone(options);
      state.remote={id:`gid://shopify/Order/${987654320+calls.shopify}`,test:true,sourceIdentifier:bag.id||bag.bag_id};
      if (state.shopifyError) {if (!state.shopifyError.requiresReconciliation) state.remote=null; throw state.shopifyError;}
      return {order:{...state.remote},mapping:{bagId:bag.id||bag.bag_id,shop:SHOP,orderId:state.remote.id}};
    },
    getOrderDetails:async orderId=>{
      calls.readback++; const bag=state.bag;
      if (!bag) return null;
      const ship=bag.shipTo||bag.ship_to,items=bag.items;
      const subtotal=items.reduce((sum,item)=>sum+(item.unitPriceCents??item.unit_price)*item.qty,0);
      const tax=bag.taxCents??bag.tax??0,shipping=bag.shippingCents??bag.shipping_paid??0;
      const names=ship.name.split(' ');
      return {id:orderId,test:true,displayFinancialStatus:'PAID',sourceIdentifier:bag.id||bag.bag_id,
        tags:['avafem',shopifyBagTag(bag.id||bag.bag_id),'TEST_DO_NOT_SHIP'],
        email:state.options?.relayEmail||bag.relayEmail||bag.relay_email||`bag-${createHash('sha256').update(bag.id||bag.bag_id).digest('hex').slice(0,24)}@relay.avafem.com`,
        shippingAddress:{name:ship.name,firstName:names[0],lastName:names.slice(1).join(' '),address1:ship.line1,city:ship.city,
          provinceCode:ship.region,countryCodeV2:ship.country,zip:ship.postal},
        lineItems:{nodes:items.map(item=>({sku:item.sku,quantity:item.qty,requiresShipping:true,taxable:tax>0,variant:{id:item.shopifyVariantId||item.variant_id||VARIANT},
          originalUnitPriceSet:money(item.unitPriceCents??item.unit_price)}))},
        transactions:[{kind:'SALE',status:'SUCCESS',test:true,gateway:'manual',manualPaymentGateway:true,amountSet:money(subtotal+shipping+tax)}],
        totalPriceSet:money(subtotal+shipping+tax),subtotalPriceSet:money(subtotal),totalTaxSet:money(tax),totalShippingPriceSet:money(shipping),
        ...state.readbackPatch};
    },
  };
  const config={getStripe:()=>stripe,shopify,clock:()=>instant};
  const service=await createTestCheckout(db,auth,config);
  return {db,auth,service,config,state,calls,stripe,shopify,advance:milliseconds=>instant.setTime(instant.getTime()+milliseconds)};
}

async function noDomainMoney(db,calls) {
  for (const table of ['orders','bags','ledger_journals','ledger_entries','transfers','credits'])
    assert.equal((await db.query(`SELECT COUNT(*)::integer AS count FROM ${table}`)).rows[0].count,0,`Acceptance run must not fabricate ${table}.`);
  assert.equal(calls.transfer,0); assert.equal(calls.refund,0);
}

test('provider fixtures complete the checkout workflow with encrypted storage and no synthetic accounting',async t=>{
  const {service,state,calls,db}=await fixture(t);
  noSecrets(await service.options());
  const quote=await service.quote({variantId:VARIANT});
  assert.equal(quote.state,'quoted'); assert.deepEqual(quote.amounts,{subtotalCents:100,shippingCents:0,taxCents:8,totalCents:108});
  assert.equal(calls.payment,0); noSecrets(quote);
  const paid=await service.pay(quote.id);
  assert.equal(paid.state,'complete',JSON.stringify(paid)); assert.equal(paid.shopify.verified,true);
  assert.equal(calls.payment,1); assert.equal(calls.shopify,1); assert.equal(calls.taxTransaction,1);
  assert.equal(state.options.test,true); assert.equal(state.options.inventoryBehaviour,'BYPASS');
  assert.equal(state.options.taxLines.reduce((sum,line)=>sum+line.amountCents,0),8);
  noSecrets(paid); noSecrets(await service.get(quote.id)); noSecrets(await service.list());
  const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows;
  for (const {table_name:table} of tables) {
    const raw=JSON.stringify((await db.query(`SELECT to_jsonb(r) AS value FROM "${table.replaceAll('"','""')}" AS r`)).rows);
    assert.ok(!raw.includes(CLIENT_SECRET));
    if (state.privateAddress) for (const key of ['name','line1']) assert.ok(!raw.includes(state.privateAddress[key]));
  }
  await noDomainMoney(db,calls);
});

test('store, scope ceiling, currency, product, stock and price failures stop before payment',async t=>{
  const {service,state,calls}=await fixture(t);
  const cases=[
    {shop:'wrong-store.myshopify.com'},
    {missingScopes:['write_orders']},
    {unexpectedScopes:['write_discounts']},
    {currency:'CAD'},
    {variantPatch:{productStatus:'DRAFT'}},
    {variantPatch:{inventoryQty:0}},
    {variantPatch:{requiresShipping:false}},
    {variantPatch:{priceCents:0}},
    {variantPatch:{priceCents:100.5}},
  ];
  for (const patch of cases) {
    Object.assign(state,{shop:SHOP,currency:'USD',missingScopes:[],unexpectedScopes:[],variantPatch:{}},patch);
    const result=await settle(()=>service.quote({variantId:VARIANT}));
    assert.ok(result.error || result.value.state!=='quoted',JSON.stringify(patch));
    assert.equal(calls.payment,0); assert.equal(calls.shopify,0);
  }
});

test('Stripe Tax failures, live results and non-authoritative totals never fall back to a synthetic tax rate',async t=>{
  const {service,state,calls}=await fixture(t);
  const cases=[{taxError:Object.assign(new Error('Tax unavailable'),{code:'TAX_UNAVAILABLE'})},
    {taxPatch:{livemode:true}},{taxPatch:{currency:'cad'}},{taxPatch:{amount_total:999}},
    {taxPatch:base=>({line_items:{...base.line_items,has_more:true}})},
    {taxPatch:base=>({line_items:{...base.line_items,data:[{...base.line_items.data[0],tax_behavior:'inclusive'}]}})},
    {taxPatch:base=>({line_items:{...base.line_items,data:[{...base.line_items.data[0],amount_tax:9}]}})}];
  for (const patch of cases) {
    Object.assign(state,{taxError:null,taxPatch:{}},patch);
    const result=await settle(()=>service.quote({variantId:VARIANT}));
    assert.ok(result.error || result.value.state!=='quoted');
    assert.equal(calls.payment,0); assert.equal(calls.shopify,0);
  }
});

test('price and stock are rechecked immediately before payment',async t=>{
  const {service,state,calls}=await fixture(t);
  const priceQuote=await service.quote({variantId:VARIANT});
  state.variantPatch={priceCents:200};
  const priceResult=await service.pay(priceQuote.id); assert.notEqual(priceResult.state,'complete'); assert.equal(calls.payment,0);
  state.variantPatch={}; const stockQuote=await service.quote({variantId:VARIANT});
  state.variantPatch={inventoryQty:0};
  const stockResult=await service.pay(stockQuote.id); assert.notEqual(stockResult.state,'complete');
  assert.equal(calls.payment,0); assert.equal(calls.shopify,0);
});

test('unverified PaymentIntent mode, status, amount, currency, transfer group or metadata blocks Shopify',async t=>{
  const {service,state,calls,db}=await fixture(t);
  const cases=[{livemode:true},{status:'requires_action'},{amount:109},{amount_received:107},{currency:'cad'},
    {transfer_group:'ORD_other_run'},{metadata:{order_id:'other_run',integration:'avafem'}},
    {shipping:{name:'Wrong Person',address:{line1:'Wrong Address',city:'Austin',state:'TX',postal_code:'78701',country:'US'}}}];
  for (const patch of cases) {
    const quote=await service.quote({variantId:VARIANT}); state.piPatch=patch;
    const result=await service.pay(quote.id);
    assert.notEqual(result.state,'complete'); assert.equal(calls.shopify,0); noSecrets(result);
    state.piPatch={};
  }
  const quote=await service.quote({variantId:VARIANT}); state.retrievePatch={id:'pi_otherfixture123'};
  assert.notEqual((await service.pay(quote.id)).state,'complete'); assert.equal(calls.shopify,0);
  await noDomainMoney(db,calls);
});

test('a catalog change after payment preserves partial success and holds Shopify creation',async t=>{
  const {service,state,calls}=await fixture(t);
  const quote=await service.quote({variantId:VARIANT});
  state.onPaymentCreated=()=>{state.variantPatch={priceCents:200};};
  const result=await service.pay(quote.id);
  assert.ok(result.stripe.paymentIntentId); assert.notEqual(result.state,'complete');
  assert.equal(calls.payment,1); assert.equal(calls.shopify,0); noSecrets(result);
});

test('concurrent pay and persisted replay create only one payment and Shopify order',async t=>{
  const {service,calls,db,auth,config}=await fixture(t);
  const quote=await service.quote({variantId:VARIANT});
  const results=await Promise.allSettled([service.pay(quote.id),service.pay(quote.id)]);
  assert.ok(results.some(result=>result.status==='fulfilled' && result.value.state==='complete'));
  assert.equal(calls.payment,1); assert.equal(calls.shopify,1); assert.equal(calls.taxTransaction,1);
  const reopened=await createTestCheckout(db,auth,config);
  assert.equal((await reopened.pay(quote.id)).state,'complete');
  assert.equal(calls.payment,1); assert.equal(calls.shopify,1); await noDomainMoney(db,calls);
});

test('an ambiguous Shopify response is reconciled by its stable marker without another charge or order create',async t=>{
  const {service,state,calls,db,auth,config}=await fixture(t);
  const quote=await service.quote({variantId:VARIANT});
  state.shopifyError=Object.assign(new Error('An upstream response was lost.'),{code:'OUTCOME_UNCERTAIN',requiresReconciliation:true});
  const initial=await service.pay(quote.id);
  assert.equal(initial.state,'shopify_uncertain'); assert.ok(initial.stripe.paymentIntentId); assert.equal(calls.payment,1); assert.equal(calls.shopify,1);
  await service.pay(quote.id); assert.equal(calls.payment,1); assert.equal(calls.shopify,1);
  const reopened=await createTestCheckout(db,auth,config);
  const reconciled=await reopened.reconcile(quote.id); assert.equal(reconciled.state,'complete',JSON.stringify(reconciled));
  assert.equal(reconciled.shopify.verified,true); assert.equal(calls.payment,1); assert.equal(calls.shopify,1);
  await noDomainMoney(db,calls);
});

test('payment success remains durable when Shopify rejects the order and unsafe upstream details are redacted',async t=>{
  const {service,state,calls,db,auth,config}=await fixture(t);
  const quote=await service.quote({variantId:VARIANT});
  state.shopifyError=Object.assign(new Error(`Rejected ${CLIENT_SECRET}`),{code:'SHOPIFY_ORDER_REJECTED',statusCode:422});
  const result=await service.pay(quote.id);
  assert.notEqual(result.state,'complete'); assert.ok(result.stripe.paymentIntentId); assert.ok(result.lastError);
  assert.equal(calls.payment,1); assert.equal(calls.shopify,1); noSecrets(result);
  const reopened=await createTestCheckout(db,auth,config);
  const persisted=await reopened.get(quote.id); assert.equal(persisted.stripe.paymentIntentId,result.stripe.paymentIntentId);
  assert.notEqual(persisted.state,'complete'); noSecrets(persisted); await noDomainMoney(db,calls);
});

test('Shopify readback mismatches cannot be marked verified and reconciliation never recreates the order',async t=>{
  const {service,state,calls}=await fixture(t);
  const quote=await service.quote({variantId:VARIANT});
  state.readbackPatch={totalPriceSet:money(999)};
  const result=await service.pay(quote.id); assert.notEqual(result.state,'complete'); assert.notEqual(result.shopify.verified,true);
  assert.ok(result.shopify.orderId); assert.equal(calls.shopify,1);
  const stillBad=await service.reconcile(quote.id); assert.notEqual(stillBad.state,'complete'); assert.equal(calls.shopify,1);
  state.readbackPatch={};
  const corrected=await service.reconcile(quote.id); assert.equal(corrected.state,'complete',JSON.stringify(corrected));
  assert.equal(corrected.shopify.verified,true); assert.equal(calls.payment,1); assert.equal(calls.shopify,1);
});

test('the Stripe adapter permits only the official card fixture in test mode and rejects it with live configuration',async()=>{
  const calls=[];
  const client={paymentIntents:{create:async(params,options)=>{calls.push({params,options});return {id:'pi_fixture123',livemode:false,status:'succeeded'};}}};
  const input={orderId:'fixture_run',amountCents:100,currency:'usd',confirm:true,paymentMethodId:'pm_card_visa',
    shipTo:{name:'Alex Test',line1:'123 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'}};
  const testStripe=createStripeAdapter({secretKey:'sk_test_fixture1234567890',client,env:{}});
  await testStripe.createPaymentIntent(input);
  assert.equal(calls.length,1);assert.equal(calls[0].params.payment_method,'pm_card_visa');assert.equal(calls[0].params.confirm,true);
  assert.equal(calls[0].options.idempotencyKey,'payment:fixture_run:v1');
  await assert.rejects(testStripe.createPaymentIntent({...input,paymentMethodId:'pm_card_other'}));
  const liveStripe=createStripeAdapter({secretKey:'sk_live_fixture1234567890',allowLive:true,client,env:{}});
  await assert.rejects(liveStripe.createPaymentIntent(input));
  assert.equal(calls.length,1,'Rejected fixture values must never reach the SDK client.');
});

test('an unknown payment beyond the 23-hour reconciliation limit never creates a new charge',async t=>{
  const {service,state,calls,config,advance,db,auth}=await fixture(t);
  // Keep the provider quote valid longer than the payment retry boundary, so
  // this specifically exercises the 23-hour protection rather than tax expiry.
  state.taxPatch={expires_at:Math.floor(config.clock().getTime()/1000)+48*3600};
  const quote=await service.quote({variantId:VARIANT});
  state.paymentError=Object.assign(new Error('Fixture connection lost after submission.'),{code:'STRIPE_REQUEST_FAILED',details:{type:'StripeConnectionError'}});
  const initial=await service.pay(quote.id);
  assert.equal(initial.state,'payment_uncertain'); assert.equal(initial.stripe.paymentIntentId,null);
  assert.equal(calls.payment,1); assert.equal(calls.shopify,0);
  state.paymentError=null; advance(23*3600_000+1);
  const reopened=await createTestCheckout(db,auth,config);
  const reconciled=await reopened.reconcile(quote.id);
  assert.equal(reconciled.state,'needs_review'); assert.equal(reconciled.lastError.code,'PAYMENT_RECONCILIATION_REQUIRED');
  await reopened.pay(quote.id); await reopened.reconcile(quote.id);
  assert.equal(calls.payment,1); assert.equal(calls.shopify,0); assert.equal(calls.taxTransaction,0);
  noSecrets(reconciled); await noDomainMoney(db,calls);
});

test('the shared store five-per-minute budget holds the sixth attempt after payment without charging again',async t=>{
  const {service,calls,config,advance,db}=await fixture(t);
  for (let number=0;number<4;number++) await db.query('INSERT INTO shopify_order_attempts(id,shop,bag_id,created_at) VALUES($1,$2,$3,$4)',
    [`legacy_fixture_${number}`,SHOP,`legacy_fixture_bag_${number}`,config.clock()]);
  // Another store must not consume My Store 2's allowance.
  await db.query('INSERT INTO shopify_order_attempts(id,shop,bag_id,created_at) VALUES($1,$2,$3,$4)',
    ['other_store_fixture','other-fixture.myshopify.com','other_fixture_bag',config.clock()]);
  const fifth=await service.quote({variantId:VARIANT});
  assert.equal((await service.pay(fifth.id)).state,'complete');
  assert.equal(calls.payment,1); assert.equal(calls.shopify,1);
  const sixth=await service.quote({variantId:VARIANT});
  const held=await service.pay(sixth.id);
  assert.equal(held.state,'needs_review'); assert.equal(held.lastError.code,'SHOPIFY_DEV_ORDER_LIMIT');
  assert.ok(held.stripe.paymentIntentId); assert.equal(held.shopify.orderId,null);
  assert.equal(calls.payment,2); assert.equal(calls.shopify,1);
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM shopify_order_attempts WHERE shop=$1',[SHOP])).rows[0].count,5);
  await service.pay(sixth.id); assert.equal(calls.payment,2); assert.equal(calls.shopify,1);
  advance(60_001);
  const completed=await service.reconcile(sixth.id); assert.equal(completed.state,'complete',JSON.stringify(completed));
  assert.equal(calls.payment,2); assert.equal(calls.shopify,2); assert.equal(calls.taxTransaction,2);
  await noDomainMoney(db,calls);
});

test('provider diagnostics preserve safe codes and request IDs while filtering credential-like values and raw messages',async t=>{
  const {service,state,calls}=await fixture(t);
  const rawMessage=`Raw SDK diagnostic must not escape: ${CLIENT_SECRET}`;
  state.taxError=Object.assign(new Error(rawMessage),{code:'STRIPE_REQUEST_FAILED',details:{stripeCode:'account_invalid',requestId:'req_fixture123'}});
  const eligible=await service.quote({variantId:VARIANT});
  assert.equal(eligible.state,'quote_failed'); assert.equal(eligible.lastError.providerCode,'account_invalid');
  assert.equal(eligible.lastError.providerRequestId,'req_fixture123');
  assert.ok(!eligible.lastError.message.includes('Raw SDK')); noSecrets(eligible);
  const rejected=[`sk_test_${'A'.repeat(32)}`,`rk_live_${'B'.repeat(32)}`,`pk_test_${'C'.repeat(32)}`,`whsec_${'D'.repeat(32)}`,
    'account_invalid\nAuthorization', 'E'.repeat(81)];
  for (const stripeCode of rejected) {
    state.taxError=Object.assign(new Error(`${rawMessage} ${stripeCode}`),{code:'STRIPE_REQUEST_FAILED',details:{stripeCode,requestId:'req_sk_test_credential'}});
    const filtered=await service.quote({variantId:VARIANT});
    assert.equal(filtered.state,'quote_failed'); assert.equal(Object.hasOwn(filtered.lastError,'providerCode'),false);
    assert.equal(Object.hasOwn(filtered.lastError,'providerRequestId'),false);
    assert.ok(!JSON.stringify(filtered).includes(stripeCode)); assert.ok(!filtered.lastError.message.includes('Raw SDK')); noSecrets(filtered);
  }
  assert.equal(calls.payment,0); assert.equal(calls.shopify,0);
});
