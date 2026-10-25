import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
const addr={name:'Synthetic Checkout',line1:'123 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'};
async function owned(f) {
  const brand=await f.domain.createBrand({name:'Avafem',slug:'avafem-owned'});
  await f.commerce.policies.saveBrand(brand.id,{expectedVersion:0,reason:'Create explicit owned stock authority',model:'first_party',inventoryAuthority:'native',inventoryOwner:'avafem',fulfiller:'avafem',settlementModel:'retail',commissionBps:0});
  const p=await f.domain.upsertProduct(brand.id,'OWNED-TEST',{title:'Owned test',description:'Synthetic owned product',category:'body-care',priceCents:1000,inventoryQty:777,
    images:['https://example.com/image.jpg'],evidence:{ingredients_inci:['Cotton'],claims:[],certifications:[],contraindications:'Follow directions.'},taxCode:'txcd_99999999',shippingProfile:'standard'});
  await f.domain.reviewProduct(p.id,{status:'approved'});
  const v=await f.ok(f.owner({method:'POST',url:'/api/admin/commerce/variants',payload:{productId:p.id,sku:'OWNED-TEST',unitPriceCents:1200,unitCostCents:400}}));
  await f.ok(f.owner({method:'POST',url:'/api/admin/commerce/inventory/adjust',payload:{variantId:v.id,delta:3,operationId:'http_stock_receipt_1',reason:'Receive three synthetic units'}}));
  await f.domain.updateBrand(brand.id,{shipFromAddress:{name:'Synthetic warehouse',line1:'100 Test Warehouse',city:'Austin',region:'TX',postal:'78701',country:'US'},supportEmail:'test@example.com',status:'ready'});
  return {brand,p,v};
}
test('commerce admin configuration requires operations session and CSRF, never brand keys or invitations',async t=>{
  const f=await platformFixture(t);const read='/api/admin/commerce';
  assert.equal((await f.request({method:'GET',url:read})).statusCode,401);
  const key=await f.credential('brand_bloom',['catalog:read','catalog:write']);assert.equal((await f.bearer(key,{method:'GET',url:read})).statusCode,403);
  await f.ok(f.owner({method:'POST',url:'/api/session/brand',payload:{brandId:'brand_bloom'}}));
  assert.equal((await f.owner({method:'GET',url:read})).statusCode,403);
  assert.equal((await f.owner({method:'PUT',url:'/api/admin/commerce/settings',payload:{expectedVersion:0,reason:'Attempt other authority',enabled:false}})).statusCode,403);
});
test('versioned backend configuration saves only supported fields and cannot turn on live payments',async t=>{
  const f=await platformFixture(t);const original=await f.ok(f.owner({method:'GET',url:'/api/admin/commerce'}));assert.equal(original.settings.discountFunding,'avafem');
  const payload={expectedVersion:0,discountBps:500,reason:'Configure a funded test campaign'};
  assert.equal((await f.owner({method:'PUT',url:'/api/admin/commerce/settings',headers:{'x-csrf-token':'wrong'},payload})).statusCode,403);
  const saved=await f.ok(f.owner({method:'PUT',url:'/api/admin/commerce/settings',payload}));assert.equal(saved.version,1);
  assert.equal((await f.owner({method:'PUT',url:'/api/admin/commerce/settings',payload})).statusCode,409);
  assert.equal((await f.owner({method:'PUT',url:'/api/admin/commerce/settings',payload:{expectedVersion:1,reason:'Reject unsupported live option',mode:'live'}})).statusCode,422);
  assert.equal((await f.commerce.policies.get()).version,1);
});
test('shared catalog reads use native variant availability and price, omit unit cost, and fence legacy inventory writes',async t=>{
  const f=await platformFixture(t);const {brand,p,v}=await owned(f);
  const q=await f.ok(f.owner({method:'POST',url:'/api/admin/commerce/checkouts',payload:{operationId:'http_catalog_reserve',items:[{variantId:v.id,qty:1}],shipTo:addr}}));
  const admin=await f.ok(f.owner({method:'GET',url:`/api/products?brandId=${brand.id}`}));assert.equal(admin[0].inventoryQty,2);assert.equal(admin[0].priceCents,1200);
  const key=await f.credential(brand.id,['catalog:read','catalog:write']);
  const products=await f.ok(f.bearer(key,{method:'GET',url:'/v1/products'}));assert.equal(products[0].variants[0].variantId,v.id);assert.equal(products[0].variants[0].inventory.qty,2);
  assert.equal(JSON.stringify(products).includes('unitCostCents'),false);
  assert.equal((await f.bearer(key,{method:'PATCH',url:`/v1/inventory/${p.sku}`,headers:{'idempotency-key':'native_legacy_stock_1'},payload:{qty:99}})).statusCode,409);
  await f.ok(f.owner({method:'POST',url:`/api/admin/commerce/checkouts/${q.id}/cancel`,payload:{}}));assert.equal((await f.commerce.inventory.get(v.id)).available,3);
});
test('HTTP simulation preserves one order, partial fulfillment, refund and inventory inspection evidence',async t=>{
  const f=await platformFixture(t);const {v}=await owned(f);
  const q=await f.ok(f.owner({method:'POST',url:'/api/admin/commerce/checkouts',payload:{operationId:'http_checkout_001',items:[{variantId:v.id,qty:2}],shipTo:addr}}));
  const paid=await f.ok(f.owner({method:'POST',url:`/api/admin/commerce/checkouts/${q.id}/simulate-payment`,payload:{}}));assert.equal(paid.providerBacked,false);
  const fOrder=(await f.ok(f.owner({method:'GET',url:'/api/admin/commerce/fulfillment'}))).find(o=>o.bagId===q.groups[0].id), ref=q.groups[0].items[0].reference;
  await f.ok(f.owner({method:'POST',url:`/api/admin/commerce/fulfillment/${fOrder.id}/ship`,payload:{operationId:'http_ship_001',carrier:'TEST',trackingNumber:'DO-NOT-SHIP-HTTP',items:[{reference:ref,qty:1}]}}));
  const r=await f.ok(f.owner({method:'POST',url:`/api/admin/commerce/bags/${q.groups[0].id}/refunds`,payload:{operationId:'http_refund_001',reason:'Cancel the unshipped synthetic unit',items:[{reference:ref,qty:1}]}}));assert.equal(r.restocked,false);
  await f.ok(f.owner({method:'POST',url:'/api/admin/commerce/returns/inspect',payload:{operationId:'http_inspect_001',bagId:q.groups[0].id,reference:ref,qty:1,origin:'unshipped',disposition:'restock',reason:'Inspect the cancelled warehouse unit'}}));
  assert.equal((await f.commerce.inventory.get(v.id)).onHand,2);
  const replay=await f.ok(f.owner({method:'POST',url:`/api/admin/commerce/checkouts/${q.id}/simulate-payment`,payload:{}}));assert.equal(replay.orderId,paid.orderId);
  const report=await f.ok(f.owner({method:'GET',url:'/api/admin/commerce/reconciliation'}));assert.equal(report.ok,true);assert.equal(report.providerReconciled,false);
});
