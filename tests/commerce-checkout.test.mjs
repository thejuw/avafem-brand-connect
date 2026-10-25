import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {exec} from '../server/platform/util.mjs';
import {createDatabase} from '../server/db.mjs';
import {createDomain} from '../server/domain.mjs';
import {createAuth} from '../server/auth.mjs';
import {seedDatabase} from '../server/seed.mjs';
import {createCommercePolicies} from '../server/commerce/policies.mjs';
import {createNativeInventory} from '../server/commerce/inventory.mjs';
import {createCommerceCheckout} from '../server/commerce/checkout.mjs';
import {splitCents} from '../server/commerce/allocations.mjs';
const shipTo={name:'Synthetic Test',line1:'123 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'};
async function fixture(t,{stock=8,price=5000,cost=1200}={}) {
  const db=await createDatabase({connectionString:null});await db.migrate();t.after(()=>db.close());
  let instant=new Date('2026-10-25T12:00:00Z');const clock=()=>new Date(instant);
  const auth=await createAuth(db,{sessionSecret:randomBytes(40).toString('hex'),encryptionKey:randomBytes(40).toString('hex'),issuer:'commerce-test'});
  const domain=createDomain(db,{clock,protectShipping:auth.encrypt,revealShipping:auth.decrypt});await seedDatabase(db,domain);
  await exec(db,await readFile(new URL('../server/platform/schema.sql',import.meta.url),'utf8'));
  const policies=await createCommercePolicies(db,{clock}),inventory=await createNativeInventory(db,{clock,policies});
  const checkout=await createCommerceCheckout(db,{clock,auth,domain,policies,inventory});
  const brand=await domain.createBrand({name:'Avafem Owned',slug:'avafem-owned'});
  await policies.saveBrand(brand.id,{expectedVersion:0,reason:'Explicitly create owned range',model:'first_party',inventoryAuthority:'native',inventoryOwner:'avafem',fulfiller:'avafem',settlementModel:'retail',commissionBps:0});
  const p=await domain.upsertProduct(brand.id,'AVA-ONE',{title:'Owned test item',description:'Synthetic product for stock and order verification.',category:'body-care',priceCents:price,inventoryQty:999,
    images:['https://example.com/owned.jpg'],evidence:{ingredients_inci:['Cotton'],claims:[],certifications:[],contraindications:'Follow directions.'},taxCode:'txcd_99999999',shippingProfile:'standard'});
  await domain.reviewProduct(p.id,{status:'approved'});
  const variant=await inventory.createVariant({productId:p.id,sku:'AVA-ONE',unitPriceCents:price,unitCostCents:cost},'owner');
  if(stock)await inventory.adjust({variantId:variant.id,delta:stock,operationId:'initial_stock_001',reason:'Initial physical receipt'},'owner');
  await domain.updateBrand(brand.id,{shipFromAddress:{name:'Avafem Test Warehouse',line1:'100 Test Warehouse',city:'Austin',region:'TX',postal:'78701',country:'US'},supportEmail:'test@example.com',status:'ready'});
  const partner=(await domain.listProducts({brandId:'brand_bloom'})).find(p=>p.sku==='BLOOM-COTTON-16');
  await domain.upsertProduct(partner.brandId,partner.sku,{priceCents:10000});
  const set=async changes=>policies.save({expectedVersion:(await policies.get()).version,reason:'Configure commerce test policy',...changes});
  const cart=(operationId,items=[{variantId:variant.id,qty:1},{productId:partner.id,qty:1}])=>checkout.quote({operationId,items,shipTo});
  const ledger=async()=>{
    const report=await checkout.reconciliation();assert.equal(report.ok,true,JSON.stringify(report));
    const totals=(await db.query('SELECT SUM(debit_cents)::bigint AS debit,SUM(credit_cents)::bigint AS credit FROM ledger_entries')).rows[0];assert.equal(totals.debit,totals.credit);
  };
  return {db,domain,auth,policies,inventory,checkout,brand,p,variant,partner,set,cart,ledger,advance:days=>{instant=new Date(+instant+days*86400_000);}};
}

test('exact largest-remainder arithmetic handles products beyond Number precision',()=>{
  const a=splitCents(99_999_999,[99_999_997,99_999_991,99_999_989]);assert.equal(a.reduce((s,n)=>s+n,0),99_999_999);
  assert.deepEqual(splitCents(2,[1,1,1]),[1,1,0]);assert.throws(()=>splitCents(1,[0]));
});

test('one mixed simulated payment books retail and partner allocations once, with no first-party transfer',async t=>{
  const f=await fixture(t);await f.set({discountBps:1000,ownedShippingCents:600,freeShippingThresholdCents:10000});
  const q=await f.cart('mixed_quote_001');assert.equal(q.groups.length,2);assert.equal(q.mode,'simulation');assert.equal(q.providerBacked,false);
  const own=q.groups.find(g=>g.terms.model==='first_party'), partner=q.groups.find(g=>g.terms.model==='partner');
  assert.equal(partner.transferCents,9000); // 10000−1500 commission +500 Avafem-funded shipping.
  assert.equal(partner.commissionCents,1500);assert.equal(own.commissionCents,0);assert.equal(own.transferCents,0);
  assert.equal((await f.inventory.get(f.variant.id)).reserved,1);assert.equal((await f.inventory.get(f.variant.id)).onHand,8);
  const paid=await f.checkout.simulatePayment(q.id);const replay=await f.checkout.simulatePayment(q.id);assert.equal(paid.orderId,replay.orderId);
  const bags=await f.domain.listBags();const created=bags.filter(b=>b.orderId===paid.orderId);assert.equal(created.length,2);
  assert.equal(created.filter(b=>b.settlementModel==='retail')[0].transfer,undefined);
  assert.equal((await f.inventory.get(f.variant.id)).onHand,7);
  const encrypted=(await f.db.query('SELECT snapshot_encrypted FROM commerce_checkouts WHERE id=$1',[q.id])).rows[0].snapshot_encrypted;
  assert.ok(!encrypted.includes(shipTo.line1));assert.ok(!JSON.stringify(q).includes(shipTo.line1));
  await f.ledger();
});

test('platform changes affect future quotes, not frozen commissions, native prices or discount allocation',async t=>{
  const f=await fixture(t);const q=await f.cart('snapshot_quote_01');
  await f.set({discountBps:3000,ownedShippingCents:500});
  await f.policies.saveBrand(f.partner.brandId,{expectedVersion:0,commissionBps:2500,reason:'New agreement for future orders'});
  const current=await f.inventory.get(f.variant.id);await f.inventory.updateVariant(f.variant.id,{expectedVersion:current.version,unitPriceCents:7000,unitCostCents:3000},'owner');
  const paid=await f.checkout.simulatePayment(q.id);assert.deepEqual(paid.amounts,q.amounts);
  assert.equal(paid.groups.find(g=>g.terms.model==='partner').commissionCents,1500);
  assert.equal(paid.groups.find(g=>g.terms.model==='first_party').items[0].unitCostCents,1200);
  const next=await f.cart('snapshot_quote_02');assert.equal(next.groups.find(g=>g.terms.model==='partner').terms.commissionBps,2500);
  assert.equal(next.groups.find(g=>g.terms.model==='first_party').items[0].unitPriceCents,7000);await f.ledger();
});

test('partner-funded promotion is blocked without agreement and never silently changes partner terms',async t=>{
  const f=await fixture(t);await f.set({discountBps:1000,discountFunding:'partner'});
  await assert.rejects(f.cart('consent_quote_001'),e=>e.code==='PARTNER_FUNDING_AGREEMENT_REQUIRED');
  assert.equal((await f.inventory.get(f.variant.id)).reserved,0);
  await f.policies.saveBrand(f.partner.brandId,{expectedVersion:0,reason:'Record signed campaign terms',partnerPromotionAgreement:'agreement_campaign_2026_01'});
  const q=await f.cart('consent_quote_002');const partner=q.groups.find(g=>g.terms.model==='partner');
  assert.equal(partner.partnerDiscountCents,1000);assert.equal(partner.commissionCents,1350);assert.equal(partner.transferCents,8150);
  await f.checkout.simulatePayment(q.id);await f.ledger();
});

test('last native unit cannot be reserved by concurrent different carts; cancellation makes it available once',async t=>{
  const f=await fixture(t,{stock:1});const items=[{variantId:f.variant.id,qty:1}];
  const results=await Promise.allSettled([f.cart('last_unit_quote_a',items),f.cart('last_unit_quote_b',items)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const q=results.find(r=>r.status==='fulfilled').value;await f.checkout.cancel(q.id);await f.checkout.cancel(q.id);
  assert.equal((await f.inventory.get(f.variant.id)).reserved,0);assert.equal((await f.inventory.get(f.variant.id)).onHand,1);
  await assert.rejects(f.checkout.simulatePayment(q.id),e=>e.code==='COMMERCE_RESERVATION_CLOSED');
});

test('expired native and partner reservations release; late payment cannot book an order',async t=>{
  const f=await fixture(t);const q=await f.cart('expiry_quote_001');f.advance(1);
  await f.checkout.run();await assert.rejects(f.checkout.simulatePayment(q.id),e=>e.code==='COMMERCE_RESERVATION_CLOSED');
  assert.equal((await f.inventory.get(f.variant.id)).reserved,0);assert.equal((await f.checkout.get(q.id)).state,'expired');
  const holds=(await f.db.query('SELECT state FROM commerce_external_holds WHERE checkout_id=$1',[q.id])).rows;assert.equal(holds[0].state,'expired');
});

test('partner-only checkout can cancel and expire without a native reservation',async t=>{
  const f=await fixture(t);const items=[{productId:f.partner.id,qty:1}];
  const q=await f.cart('partner_cancel_01',items);await f.checkout.cancel(q.id);
  const later=await f.cart('partner_expire_01',items);f.advance(1);await f.checkout.run();assert.equal((await f.checkout.get(later.id)).state,'expired');
});

test('partial native shipments, refunds, inspected return, and credit release never require a connected account',async t=>{
  const f=await fixture(t);const q=await f.cart('owned_lifecycle_1',[{variantId:f.variant.id,qty:3}]);await f.checkout.simulatePayment(q.id);
  const group=q.groups[0],line=group.items[0],fulfillment=(await f.checkout.fulfillment()).find(o=>o.bagId===group.id);
  const first={operationId:'ship_partial_001',carrier:'TEST',trackingNumber:'DO-NOT-SHIP-1',items:[{reference:line.reference,qty:1}]};
  assert.equal((await f.checkout.ship(fulfillment.id,first)).state,'partially_shipped');
  assert.equal((await f.checkout.ship(fulfillment.id,first)).replayed,true);
  await assert.rejects(f.checkout.deliver(fulfillment.id,{operationId:'deliver_early_001'}),e=>e.code==='COMMERCE_NOT_SHIPPED');
  await f.checkout.ship(fulfillment.id,{...first,operationId:'ship_partial_002',trackingNumber:'DO-NOT-SHIP-2',items:[{reference:line.reference,qty:2}]});
  await f.checkout.deliver(fulfillment.id,{operationId:'deliver_owned_01'});
  const refund=await f.checkout.refund(group.id,{operationId:'refund_owned_001',reason:'Synthetic partial return',items:[{reference:line.reference,qty:1}]});
  assert.equal(refund.restocked,false);assert.equal((await f.inventory.get(f.variant.id)).onHand,5);
  const inspection={operationId:'inspect_owned_01',bagId:group.id,reference:line.reference,qty:1,disposition:'restock',reason:'Received and inspected synthetic unit'};
  await f.checkout.inspect(inspection);await f.checkout.inspect(inspection);assert.equal((await f.inventory.get(f.variant.id)).onHand,6);
  await assert.rejects(f.checkout.inspect({...inspection,operationId:'inspect_owned_02'}));
  f.advance(31);const matured=await f.checkout.run();assert.equal(matured.payouts,0);assert.equal(matured.credits,1);
  const credit=(await f.db.query('SELECT * FROM credits WHERE bag_id=$1',[group.id])).rows[0];assert.equal(credit.status,'released');assert.equal(credit.amount_cents,500);
  assert.equal((await f.db.query('SELECT * FROM transfers WHERE bag_id=$1',[group.id])).rows.length,0);await f.ledger();
});

test('partial refunds before and after simulated partner payout reverse exact original subsidy and allocations',async t=>{
  const f=await fixture(t);await f.set({discountBps:333,freeShippingThresholdCents:0});
  const q=await f.cart('partner_life_001',[{productId:f.partner.id,qty:3}]);await f.checkout.simulatePayment(q.id);
  const group=q.groups[0],line=group.items[0],fulfillment=(await f.checkout.fulfillment()).find(o=>o.bagId===group.id);
  const r1=await f.checkout.refund(group.id,{operationId:'refund_partner_1',reason:'Cancel one synthetic unit',items:[{reference:line.reference,qty:1}]});
  await f.checkout.ship(fulfillment.id,{operationId:'ship_partner_001',carrier:'TEST',trackingNumber:'DO-NOT-SHIP-P',items:[{reference:line.reference,qty:2}]});
  await f.checkout.deliver(fulfillment.id,{operationId:'deliver_partner_1'});f.advance(31);assert.equal((await f.checkout.run()).payouts,1);
  const r2=await f.checkout.refund(group.id,{operationId:'refund_partner_2',reason:'Return remaining synthetic units',items:[{reference:line.reference,qty:2}],refundShipping:true});
  assert.equal(r1.amountCents+r2.amountCents,group.totalCents);
  const tr=(await f.db.query('SELECT * FROM transfers WHERE bag_id=$1',[group.id])).rows[0];assert.equal(tr.status,'reversed');assert.equal(tr.amount_cents,tr.reversed_cents);
  assert.equal((await f.checkout.refund(group.id,{operationId:'refund_partner_2',reason:'Return remaining synthetic units',items:[{reference:line.reference,qty:2}],refundShipping:true})).replayed,true);
  await f.ledger();
});

test('fragmented quantity refunds conserve every discount, tax, commission and credit cent',async t=>{
  const f=await fixture(t,{price:101,cost:12});await f.set({discountBps:3333});
  const q=await f.cart('rounding_quote_1',[{variantId:f.variant.id,qty:3},{productId:f.partner.id,qty:3}]);await f.checkout.simulatePayment(q.id);
  for(const g of q.groups){let refunded=0;for(let i=0;i<3;i++){
    const r=await f.checkout.refund(g.id,{operationId:`round_ref_${g.id}_${i}`,reason:'Synthetic rounding conservation',items:[{reference:g.items[0].reference,qty:1}],refundShipping:i===2});refunded+=r.amountCents;
  }assert.equal(refunded,g.totalCents);}
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM credits WHERE bag_id=ANY($1::text[]) AND status<>'voided'",[q.groups.map(g=>g.id)])).rows[0].n,0);await f.ledger();
});

test('product curation and brand availability are rechecked before simulated payment',async t=>{
  const f=await fixture(t);const q=await f.cart('curation_quote_1');await f.domain.upsertProduct(f.brand.id,f.p.sku,{description:'Changed content needs review'});
  await assert.rejects(f.checkout.simulatePayment(q.id),e=>e.code==='COMMERCE_PRODUCT_UNAVAILABLE');
  assert.equal((await f.inventory.get(f.variant.id)).onHand,8);
  await f.domain.reviewProduct(f.p.id,{status:'approved'});await f.domain.updateBrand(f.partner.brandId,{status:'paused'});
  await assert.rejects(f.checkout.simulatePayment(q.id),e=>['COMMERCE_PRODUCT_UNAVAILABLE','COMMERCE_BRAND_UNAVAILABLE'].includes(e.code));
});

test('legacy workflow cannot double-sell native counters or mutate commerce Bags',async t=>{
  const f=await fixture(t);await assert.rejects(f.domain.createSandboxOrder({items:[{brandId:f.brand.id,sku:f.p.sku,qty:1}],shipTo}),e=>e.code==='COMMERCE_WORKFLOW_REQUIRED');
  const q=await f.cart('legacy_fence_001',[{variantId:f.variant.id,qty:1}]);await f.checkout.simulatePayment(q.id);
  await assert.rejects(f.domain.recordShipment(q.groups[0].id,{carrier:'TEST',trackingNumber:'x'}),e=>e.code==='COMMERCE_WORKFLOW_REQUIRED');
  await assert.rejects(f.domain.requestRefund(q.groups[0].id,{reason:'Legacy attempt'}),e=>e.code==='COMMERCE_WORKFLOW_REQUIRED');
  await assert.rejects(f.domain.markDelivered(q.groups[0].id),e=>e.code==='COMMERCE_WORKFLOW_REQUIRED');
});

test('additive migration preserves historical records and hybrid discount/retail records across rerun',async t=>{
  const f=await fixture(t);await f.set({discountBps:1000});const q=await f.cart('migration_quote_1');await f.checkout.simulatePayment(q.id);
  const before=(await f.db.query('SELECT id,total_cents,transfer_cents,settlement_model,discount_cents FROM bags ORDER BY id')).rows;
  await f.db.migrate();const after=(await f.db.query('SELECT id,total_cents,transfer_cents,settlement_model,discount_cents FROM bags ORDER BY id')).rows;
  assert.deepEqual(after,before);await f.ledger();
});

test('one-cent partner unit refunds cannot allocate more commission than the unit net base',async t=>{
  const f=await fixture(t);await f.domain.upsertProduct(f.partner.brandId,f.partner.sku,{priceCents:1});
  await f.set({discountBps:5000,discountFunding:'partner'});
  await f.policies.saveBrand(f.partner.brandId,{expectedVersion:0,reason:'Signed synthetic partner campaign',partnerPromotionAgreement:'test_signed_campaign'});
  const q=await f.cart('cent_units_quote',[{productId:f.partner.id,qty:10}]);await f.checkout.simulatePayment(q.id);
  const g=q.groups[0];let refunded=0;
  for(let i=0;i<10;i++){const result=await f.checkout.refund(g.id,{operationId:`cent_unit_refund_${i}`,reason:'Exact synthetic per-unit rounding',items:[{reference:g.items[0].reference,qty:1}],refundShipping:i===9});refunded+=result.amountCents;assert.ok(result.recoveryCents>=0);}
  assert.equal(refunded,g.totalCents);await f.ledger();
});

test('shipping can be refunded separately after every merchandise unit was already refunded',async t=>{
  const f=await fixture(t);await f.set({ownedShippingCents:100});const q=await f.cart('shipping_only_quote',[{variantId:f.variant.id,qty:1}]);await f.checkout.simulatePayment(q.id);
  const g=q.groups[0],first=await f.checkout.refund(g.id,{operationId:'shipping_item_refund',reason:'Synthetic item return first',items:[{reference:g.items[0].reference,qty:1}]});
  const second=await f.checkout.refund(g.id,{operationId:'shipping_fee_refund',reason:'Refund original shipping separately',items:[],refundShipping:true});
  assert.equal(first.amountCents+second.amountCents,g.totalCents);
  const noMore=await f.checkout.refund(g.id,{operationId:'shipping_fee_again',reason:'No repeated shipping amount',items:[],refundShipping:true});assert.equal(noMore.amountCents,0);await f.ledger();
});

test('inspections distinguish cancelled warehouse units from shipped returns and reverse COGS exactly',async t=>{
  const f=await fixture(t,{price:1000,cost:100});const q=await f.cart('inspection_origin_q',[{variantId:f.variant.id,qty:2}]);await f.checkout.simulatePayment(q.id);
  const g=q.groups[0],ref=g.items[0].reference,fulfillment=(await f.checkout.fulfillment()).find(o=>o.bagId===g.id);
  await f.checkout.ship(fulfillment.id,{operationId:'origin_ship_one',carrier:'TEST',trackingNumber:'ORIGIN-TEST',items:[{reference:ref,qty:1}]});
  await f.checkout.refund(g.id,{operationId:'origin_refund_both',reason:'Synthetic mixed shipped and cancelled return',items:[{reference:ref,qty:2}]});
  const body={bagId:g.id,reference:ref,qty:1,disposition:'restock',reason:'Inspected synthetic units by origin'};
  await assert.rejects(f.checkout.inspect({...body,operationId:'origin_ambiguous'}));
  await f.checkout.inspect({...body,operationId:'origin_warehouse',origin:'unshipped'});
  let amount=(await f.db.query("SELECT COALESCE(SUM(e.debit_cents-e.credit_cents),0)::int AS c FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 AND e.account='cost_of_goods_sold'",[g.id])).rows[0].c;assert.equal(amount,100);
  await f.checkout.inspect({...body,operationId:'origin_returned',origin:'shipped'});
  amount=(await f.db.query("SELECT COALESCE(SUM(e.debit_cents-e.credit_cents),0)::int AS c FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 AND e.account='cost_of_goods_sold'",[g.id])).rows[0].c;assert.equal(amount,0);await f.ledger();
});

test('a final commission-only refund does not rewrite the principal of an already reversed transfer',async t=>{
  const f=await fixture(t);await f.policies.saveBrand(f.partner.brandId,{expectedVersion:0,reason:'Explicit shipping for cent allocation',shippingCents:0});
  const products=[];
  for(let i=0;i<4;i++){const p=await f.domain.upsertProduct(f.partner.brandId,`CENT-${i}`,{...f.partner,id:undefined,sku:undefined,title:`Cent item ${i}`,priceCents:1,inventoryQty:10});await f.domain.reviewProduct(p.id,{status:'approved'});products.push(p);}
  const q=await f.cart('reverse_principal_q',products.map(p=>({productId:p.id,qty:1})));await f.checkout.simulatePayment(q.id);const g=q.groups[0];
  const fulfillment=(await f.checkout.fulfillment()).find(o=>o.bagId===g.id);
  await f.checkout.ship(fulfillment.id,{operationId:'reverse_ship_all',carrier:'TEST',trackingNumber:'REVERSE-TEST',items:g.items.map(l=>({reference:l.reference,qty:1}))});await f.checkout.deliver(fulfillment.id,{operationId:'reverse_delivered'});
  f.advance(31);await f.checkout.run();
  const commission=g.items.find(l=>l.commissionCents),others=g.items.filter(l=>!l.commissionCents);
  await f.checkout.refund(g.id,{operationId:'reverse_payable_all',reason:'Refund all partner-payable unit allocations',items:others.map(l=>({reference:l.reference,qty:1}))});
  await f.checkout.refund(g.id,{operationId:'reverse_commission',reason:'Refund the remaining commission unit',items:[{reference:commission.reference,qty:1}]});
  const tr=(await f.db.query('SELECT * FROM transfers WHERE bag_id=$1',[g.id])).rows[0];assert.equal(tr.status,'reversed');assert.equal(tr.amount_cents,3);assert.equal(tr.reversed_cents,3);await f.ledger();
});

test('late payment commits expiry cleanup and partner stock changes block booking before inventory commit',async t=>{
  const f=await fixture(t);const q=await f.cart('late_pay_expiry_q');f.advance(1);
  await assert.rejects(f.checkout.simulatePayment(q.id),e=>e.code==='COMMERCE_RESERVATION_CLOSED');
  assert.equal((await f.checkout.get(q.id)).state,'expired');assert.equal((await f.inventory.get(f.variant.id)).reserved,0);
  const next=await f.cart('partner_stock_drop_q');await f.domain.upsertProduct(f.partner.brandId,f.partner.sku,{inventoryQty:0});
  await assert.rejects(f.checkout.simulatePayment(next.id),e=>e.code==='COMMERCE_OUT_OF_STOCK');assert.equal((await f.inventory.get(f.variant.id)).onHand,8);
});

test('a fully Avafem-funded zero-cash cart still fulfills and refunds exact retail/partner allocations',async t=>{
  const f=await fixture(t);await f.set({discountBps:10000,freeShippingThresholdCents:0});const q=await f.cart('free_cart_quote_1');assert.equal(q.amounts.totalCents,0);
  await f.checkout.simulatePayment(q.id);
  for(const g of q.groups)await f.checkout.refund(g.id,{operationId:`free_cart_ref_${g.id}`,reason:'Refund a zero-cash funded synthetic allocation',items:g.items.map(l=>({reference:l.reference,qty:l.qty})),refundShipping:true});
  await f.ledger();
});

test('explicit non-USD partner variant currency is rejected at quote and rechecked before payment',async t=>{
  const f=await fixture(t),sku='PARTNER-CURRENCY';
  const variants=currency=>[{id:'stable_currency_variant',sku,price:{amount:1000,currency},inventory:{qty:5}}];
  await f.domain.upsertProduct(f.partner.brandId,f.partner.sku,{variants:variants('CAD')});await f.domain.reviewProduct(f.partner.id,{status:'approved'});
  const items=[{variantId:f.variant.id,qty:1},{productId:f.partner.id,variantSku:sku,qty:1}];
  await assert.rejects(f.cart('currency_bad_quote',items),e=>e.code==='COMMERCE_CURRENCY_MISMATCH');assert.equal((await f.inventory.get(f.variant.id)).reserved,0);
  await f.domain.upsertProduct(f.partner.brandId,f.partner.sku,{variants:variants('USD')});
  const q=await f.cart('currency_good_quote',items);
  await f.domain.upsertProduct(f.partner.brandId,f.partner.sku,{variants:variants('CAD')});
  await assert.rejects(f.checkout.simulatePayment(q.id),e=>e.code==='COMMERCE_CURRENCY_MISMATCH');assert.equal((await f.inventory.get(f.variant.id)).onHand,8);
});
