import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {first,rows,id,int,text,DAY} from '../platform/util.mjs';
import {allocateCommercialCart,splitCents,rateCents} from './allocations.mjs';

const fail=(message,code='COMMERCE_INVALID',statusCode=422)=>{throw Object.assign(new Error(message),{statusCode,code});};
const stable=value=>Array.isArray(value)?value.map(stable):value && typeof value==='object'
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const json=JSON.stringify;
const operation=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(value))fail('Provide a stable operationId.');return value;};
const note=value=>{if(typeof value!=='string'||value.trim().length<3||value.length>1000)fail('Provide a reason of 3–1000 characters.');return value.trim();};
const only=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Only documented fields are accepted.');};
function address(input) {
  only(input,['name','line1','line2','city','region','postal','country']);
  const value={};for(const k of ['name','line1','line2','city','region','postal','country'])if(input[k]!==undefined){
    if(typeof input[k]!=='string'||input[k].length>250)fail('Provide a valid shipping address.');value[k]=input[k].trim();}
  if(['name','line1','city','region','postal','country'].some(k=>!value[k])||value.country!=='US'
    ||!/^[A-Z]{2}$/.test(value.region)||!/^\d{5}(?:-\d{4})?$/.test(value.postal))fail('A complete US shipping address is required.');
  return value;
}

/** Catalog-driven local hybrid-commerce exercise. Its payment, external stock,
 * tax, shipping notices and payouts are explicitly simulated. The real provider
 * acceptance harness is separate and cannot consume these Bags. No request can
 * turn this service into a live/provider payment path. */
export async function createCommerceCheckout(db,{policies,inventory,auth,domain,clock=()=>new Date()}={}) {
  for(const sql of (await readFile(new URL('./schema.sql',import.meta.url),'utf8')).split(/;\s*\n/).filter(s=>s.trim()))await db.query(sql);
  const now=()=>new Date(clock()), iso=()=>now().toISOString();
  const emit=(tx,type,aggregateId,brandId,payload)=>tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload,created_at,available_at)
    VALUES($1,$2,$3,$4,$5,$6,$6)`,[id('evt'),`commerce.${type}`,aggregateId,brandId,json({...payload,sandbox:true,simulated:true}),iso()]);
  async function journal(tx,key,kind,bag,entries) {
    entries=entries.filter(e=>e.debit||e.credit);
    const total=entries.reduce((s,e)=>s+(e.debit||0),0);
    if(!total && !entries.length)return;
    if(!Number.isSafeInteger(total)||total<=0||total!==entries.reduce((s,e)=>s+(e.credit||0),0)
      ||entries.some(e=>!Number.isSafeInteger(e.debit||0)||!Number.isSafeInteger(e.credit||0)||(e.debit||0)<0||(e.credit||0)<0||Boolean(e.debit)===Boolean(e.credit)))
      fail('Commerce journal is unbalanced.','COMMERCE_LEDGER_INVALID',500);
    const jrnl=id('jrnl');
    const inserted=await tx.query(`INSERT INTO ledger_journals(id,business_key,kind,bag_id,brand_id,total_debit_cents,total_credit_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT(business_key) DO NOTHING RETURNING id`,[jrnl,key,kind,bag.id,bag.brandId,total,iso()]);
    if(!inserted.rows.length)return;
    for(const e of entries)await tx.query('INSERT INTO ledger_entries(id,journal_id,account,debit_cents,credit_cents) VALUES($1,$2,$3,$4,$5)',[id('entry'),jrnl,e.account,e.debit||0,e.credit||0]);
  }
  const d=(account,debit)=>({account,debit}), c=(account,credit)=>({account,credit});
  async function checkoutRow(tx,key) {const row=await first(tx,'SELECT * FROM commerce_checkouts WHERE id=$1 FOR UPDATE',[key]);if(!row)fail('Checkout not found.','COMMERCE_NOT_FOUND',404);return row;}
  const decode=row=>auth.decrypt(row.snapshotEncrypted);
  async function view(tx,row) {
    const snapshot=decode(row), {shipTo,...safe}=snapshot;
    return {...safe,id:row.id,state:row.state,expiresAt:row.expiresAt,orderId:row.orderId,
      mode:'simulation',providerBacked:false,stockReservation:{native:'atomic',external:'local_shadow_only'},
      warning:'Local simulation only. Tax, payment, partner stock holds, shipping and payouts are not provider evidence.'};
  }
  const get=key=>db.transaction(async tx=>view(tx,await checkoutRow(tx,key)));
  async function bagState(tx,bagId) {
    const bag=await first(tx,'SELECT * FROM bags WHERE id=$1 AND commerce_managed FOR UPDATE',[bagId]);
    if(!bag)fail('Commerce Bag not found.','COMMERCE_NOT_FOUND',404);
    const allocation=await first(tx,'SELECT * FROM commerce_bag_allocations WHERE bag_id=$1',[bagId]);
    const fulfillment=await first(tx,'SELECT * FROM commerce_fulfillment_orders WHERE bag_id=$1 FOR UPDATE',[bagId]);
    return {bag,allocation,fulfillment};
  }
  async function once(tx,input,kind,actor,perform) {
    const key=operation(input.operationId), fingerprint=hash({kind,input});
    const old=await first(tx,'SELECT * FROM commerce_operations WHERE operation_id=$1',[key]);
    if(old){if(old.requestHash!==fingerprint)fail('operationId belongs to another action.','COMMERCE_IDEMPOTENCY_CONFLICT',409);return {...old.result,replayed:true};}
    const result=await perform();
    await tx.query('INSERT INTO commerce_operations(operation_id,request_hash,kind,result,actor,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [key,fingerprint,kind,json(result),actor,text(input.reason,1000),iso()]);
    return result;
  }
  async function expireTx(tx) {
    const expired=await rows(tx,"SELECT * FROM commerce_checkouts WHERE state='reserved' AND expires_at<=$1 FOR UPDATE",[iso()]);
    for(const row of expired){if(decode(row).groups.some(g=>g.items.some(l=>l.variantId)))await inventory.release(row.id,tx);await tx.query("UPDATE commerce_external_holds SET state='expired' WHERE checkout_id=$1 AND state='reserved'",[row.id]);
      await tx.query("UPDATE commerce_checkouts SET state='expired',updated_at=$2 WHERE id=$1",[row.id,iso()]);}
    return expired.length;
  }
  async function quote(input) {
    only(input,['operationId','items','shipTo']);operation(input.operationId);
    const shipTo=address(input.shipTo);
    if(!Array.isArray(input.items)||input.items.length<1||input.items.length>100)fail('Provide 1–100 cart lines.');
    for(const line of input.items){only(line,['variantId','productId','variantSku','qty']);int(line.qty,'qty',1,100);
      if(Boolean(line.variantId)===Boolean(line.productId)||line.variantId&&line.variantSku)fail('Choose a native variant or a partner product variant.');
      if(['variantId','productId','variantSku'].some(k=>line[k]!==undefined&&(typeof line[k]!=='string'||!line[k]||line[k].length>200)))fail('Invalid catalog identity.');}
    const fingerprint=hash({...input,shipTo});
    return db.transaction(async tx=>{
      await expireTx(tx);
      const old=await first(tx,'SELECT * FROM commerce_checkouts WHERE operation_id=$1',[input.operationId]);
      if(old){if(old.requestHash!==fingerprint)fail('operationId belongs to a different cart.','COMMERCE_IDEMPOTENCY_CONFLICT',409);return view(tx,old);}
      const settings=await policies.get(tx);if(!settings.enabled)fail('Commerce checkout is paused.','COMMERCE_PAUSED',409);
      const checkoutId=id('cco'), groups=new Map(), seen=new Set();
      for(const line of input.items){
        const variant=line.variantId?await inventory.get(line.variantId,tx):null;
        const product=await first(tx,'SELECT * FROM products WHERE id=$1 FOR UPDATE',[variant?.productId||line.productId]);
        if(!product||product.status!=='approved'||product.sourceDeletedAt)fail('A cart product is unavailable or awaiting review.','COMMERCE_PRODUCT_UNAVAILABLE',409);
        const brand=await first(tx,'SELECT * FROM brands WHERE id=$1 FOR UPDATE',[product.brandId]);
        if(!['ready','live'].includes(brand.status))fail('A cart brand is not accepting orders.','COMMERCE_BRAND_UNAVAILABLE',409);
        const terms=await policies.getBrand(product.brandId,tx);
        if(Boolean(variant)!==(terms.model==='first_party'))fail('Use the inventory authority configured for this brand.','COMMERCE_AUTHORITY_MISMATCH',409);
        const variantKey=line.variantSku||'';
        let price=variant?.unitPriceCents, sku=variant?.sku, available=variant?.available;
        if(!variant){
          const variants=product.variants||[];
          if(variants.length && !variantKey)fail('Select an explicit variant; parent stock is not a second stock pool.','COMMERCE_VARIANT_REQUIRED',409);
          const external=variantKey?variants.find(v=>v.sku===variantKey):null;
          if(variantKey&&!external)fail('Partner variant not found.','COMMERCE_PRODUCT_UNAVAILABLE',409);
          if(external?.price?.currency!==undefined&&external.price.currency!=='USD')fail('Partner variant currency must match the USD checkout.','COMMERCE_CURRENCY_MISMATCH',409);
          price=external?.price?.amount??product.priceCents;sku=external?.sku??product.sku;
          available=external?.inventory?.qty??product.inventoryQty;
          const held=await first(tx,"SELECT COALESCE(SUM(qty),0)::int AS qty FROM commerce_external_holds WHERE product_id=$1 AND variant_key=$2 AND state IN ('reserved','committed')",[product.id,variantKey]);
          available-=held.qty;
        }
        const identity=variant?.id||`${product.id}:${variantKey}`;
        if(seen.has(identity))fail('Combine duplicate cart lines.');seen.add(identity);
        int(price,'Catalog unit price',1,100_000_000);int(available,'Catalog available stock',0,1_000_000);
        if(available<line.qty)fail('There is insufficient stock.','COMMERCE_OUT_OF_STOCK',409);
        if(!groups.has(brand.id))groups.set(brand.id,{id:id('bag'),brandId:brand.id,brandName:brand.name,terms,items:[]});
        groups.get(brand.id).items.push({reference:id('line'),productId:product.id,variantId:variant?.id||null,variantKey,
          sku,title:product.title,qty:line.qty,unitPriceCents:price,unitCostCents:variant?.unitCostCents??0,
          grossCents:price*line.qty,reviewFingerprint:product.reviewedFingerprint||product.reviewFingerprint||null,
          shippedQty:0,refundedQty:0,refundedUnshippedQty:0,refundedShippedQty:0});
      }
      const snapshot=allocateCommercialCart({id:checkoutId,settings,groups:[...groups.values()],shipTo,createdAt:iso(),taxMode:'fixed_8.25_percent_simulation'});
      const gross=snapshot.groups.reduce((s,g)=>s+g.subtotalCents,0);int(gross,'Cart merchandise',1,100_000_000);
      for(const g of snapshot.groups){
        // Explicit local fixture. A production/provider checkout must supply
        // authoritative product-level tax; this rate is never sent to a store.
        for(const line of g.items){line.taxCents=rateCents(line.netCents,825);
          const unitTaxes=splitCents(line.taxCents,line.units.map(u=>u.netCents));line.units.forEach((u,i)=>{u.taxCents=unitTaxes[i];});}
        g.shippingTaxCents=rateCents(g.shippingCents,825);
        g.taxCents=g.items.reduce((s,l)=>s+l.taxCents,0)+g.shippingTaxCents;
        g.totalCents=g.subtotalCents-g.discountCents+g.shippingCents+g.taxCents;
      }
      snapshot.amounts=Object.fromEntries(['subtotalCents','discountCents','shippingCents','taxCents','totalCents'].map(k=>[k,snapshot.groups.reduce((s,g)=>s+g[k],0)]));
      int(snapshot.amounts.totalCents,'Cart total',0,200_000_000);
      const expiresAt=new Date(now().getTime()+settings.reservationMinutes*60_000).toISOString();
      await tx.query(`INSERT INTO commerce_checkouts(id,operation_id,request_hash,state,brand_ids,policy_version,snapshot_encrypted,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$8)`,[checkoutId,input.operationId,fingerprint,json([...groups.keys()]),settings.version,auth.encrypt(snapshot),expiresAt,iso()]);
      const nativeItems=snapshot.groups.flatMap(g=>g.items).filter(l=>l.variantId).map(l=>({variantId:l.variantId,qty:l.qty}));
      if(nativeItems.length){const reserved=await inventory.reserve({checkoutId,items:nativeItems,expiresAt},tx);
        for(const frozen of reserved.items){const line=snapshot.groups.flatMap(g=>g.items).find(l=>l.variantId===frozen.variantId);
          if(!line||line.qty!==frozen.qty||line.unitPriceCents!==frozen.unitPriceCents||line.unitCostCents!==frozen.unitCostCents)
            fail('Native reservation differs from the quoted cart.','COMMERCE_RESERVATION_MISMATCH',409);}}
      for(const g of snapshot.groups)for(const l of g.items)if(!l.variantId)await tx.query(`INSERT INTO commerce_external_holds(checkout_id,reference,product_id,variant_key,qty,state)
        VALUES($1,$2,$3,$4,$5,'reserved')`,[checkoutId,l.reference,l.productId,l.variantKey,l.qty]);
      return view(tx,await checkoutRow(tx,checkoutId));
    });
  }
  async function cancel(key) {return db.transaction(async tx=>{
    const row=await checkoutRow(tx,key);if(row.state==='paid')fail('Use refunds for a paid checkout.','COMMERCE_ALREADY_PAID',409);
    if(row.state==='reserved'){if(decode(row).groups.some(g=>g.items.some(l=>l.variantId)))await inventory.release(key,tx);await tx.query("UPDATE commerce_external_holds SET state='released' WHERE checkout_id=$1",[key]);
      await tx.query("UPDATE commerce_checkouts SET state='cancelled',updated_at=$2 WHERE id=$1",[key,iso()]);}
    return view(tx,await checkoutRow(tx,key));
  });}
  async function simulatePayment(key) {const outcome=await db.transaction(async tx=>{
    await expireTx(tx);const row=await checkoutRow(tx,key);if(row.state==='paid')return view(tx,row);
    // Commit expiry/release before returning the closed-state error to the caller.
    if(row.state!=='reserved')return {closed:true};
    if(!(await policies.get(tx)).enabled)fail('Commerce checkout is paused.','COMMERCE_PAUSED',409);
    const snapshot=decode(row);
    for(const g of snapshot.groups){const brand=await first(tx,'SELECT * FROM brands WHERE id=$1 FOR UPDATE',[g.brandId]);
      if(!['ready','live'].includes(brand.status))fail('A cart brand is not accepting orders.','COMMERCE_BRAND_UNAVAILABLE',409);
      for(const line of g.items){const p=await first(tx,'SELECT * FROM products WHERE id=$1',[line.productId]);
        if(p.status!=='approved'||p.sourceDeletedAt||(p.reviewedFingerprint||p.reviewFingerprint||null)!==line.reviewFingerprint)
          fail('A cart product changed or needs review.','COMMERCE_PRODUCT_UNAVAILABLE',409);
        if(!line.variantId){const variant=line.variantKey?(p.variants||[]).find(v=>v.sku===line.variantKey):null;
          if(line.variantKey&&!variant||(p.variants||[]).length&&!line.variantKey)fail('A partner variant changed.','COMMERCE_PRODUCT_UNAVAILABLE',409);
          if(variant?.price?.currency!==undefined&&variant.price.currency!=='USD')fail('Partner variant currency no longer matches the USD quote.','COMMERCE_CURRENCY_MISMATCH',409);
          const qty=variant?.inventory?.qty??p.inventoryQty;
          const held=await first(tx,"SELECT COALESCE(SUM(qty),0)::int AS qty FROM commerce_external_holds WHERE product_id=$1 AND variant_key=$2 AND state IN ('reserved','committed')",[p.id,line.variantKey]);
          if(!Number.isSafeInteger(qty)||qty<held.qty)fail('Partner shadow availability fell below the reserved cart.','COMMERCE_OUT_OF_STOCK',409);
        }}
    }
    const native=snapshot.groups.flatMap(g=>g.items).filter(l=>l.variantId);if(native.length)await inventory.commit(key,tx);
    const orderId=id('ord'), a=snapshot.amounts;
    await tx.query(`INSERT INTO orders(id,order_ref,subtotal_cents,discount_cents,shipping_cents,tax_cents,total_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[orderId,`SIM-${key}`,a.subtotalCents,a.discountCents,a.shippingCents,a.taxCents,a.totalCents,iso()]);
    for(const g of snapshot.groups){
      const partner=g.terms.model==='partner', subsidy=partner?g.platformDiscountCents+g.platformShippingSubsidyCents:0;
      await tx.query(`INSERT INTO bags(id,order_id,brand_id,items,ship_to,subtotal_cents,discount_cents,shipping_cents,tax_cents,commission_cents,
        transfer_cents,total_cents,ship_by,return_window_days,settlement_model,settlement_subsidy_cents,commerce_managed,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$17)`,
      [g.id,orderId,g.brandId,json(g.items),json({encryptedShipping:auth.encrypt(snapshot.shipTo)}),g.subtotalCents,g.discountCents,g.shippingCents,g.taxCents,
        g.commissionCents,g.transferCents,g.totalCents,new Date(now().getTime()+3*DAY).toISOString(),snapshot.settings.returnWindowDays,g.terms.settlementModel,subsidy,iso()]);
      await tx.query('INSERT INTO commerce_bag_allocations(bag_id,checkout_id,brand_id,model,terms,allocation) VALUES($1,$2,$3,$4,$5,$6)',
        [g.id,key,g.brandId,g.terms.model,json({...g.terms,platform:snapshot.settings}),json(g)]);
      await tx.query(`INSERT INTO commerce_fulfillment_orders(id,bag_id,brand_id,fulfiller,state,items,created_at,updated_at)
        VALUES($1,$2,$3,$4,'open',$5,$6,$6)`,[id('cfo'),g.id,g.brandId,g.terms.fulfiller,json(g.items),iso()]);
      if(partner)await tx.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status,created_at) VALUES($1,$2,$3,$4,'held',$5)",[id('tr'),g.id,g.brandId,g.transferCents,iso()]);
      const credit=rateCents(g.subtotalCents-g.discountCents,snapshot.settings.loyaltyBps??500);
      await tx.query("INSERT INTO credits(id,bag_id,brand_id,amount_cents,status,created_at) VALUES($1,$2,$3,$4,'pending',$5)",[id('credit'),g.id,g.brandId,credit,iso()]);
      const bag={id:g.id,brandId:g.brandId};
      await journal(tx,`commerce:payment:${g.id}`,'commerce_simulated_payment',bag,[d('sandbox_clearing',g.totalCents),
        d('promotion_expense',g.platformDiscountCents),d('shipping_subsidy_expense',g.platformShippingSubsidyCents),
        ...(partner?[c('brand_payable',g.transferCents),c('commission_revenue',g.commissionCents)]
          :[c('retail_revenue',g.subtotalCents),c('retail_shipping_revenue',g.shippingCents)]),c('tax_payable',g.taxCents)]);
      await journal(tx,`commerce:credit:${g.id}`,'commerce_credit_pending',bag,[d('loyalty_expense',credit),c('credit_pending',credit)]);
      await emit(tx,'bag.created',g.id,g.brandId,{bagId:g.id,orderId,fulfiller:g.terms.fulfiller,settlementModel:g.terms.settlementModel});
    }
    await tx.query("UPDATE commerce_external_holds SET state='committed' WHERE checkout_id=$1",[key]);
    await tx.query("UPDATE commerce_checkouts SET state='paid',order_id=$2,updated_at=$3 WHERE id=$1",[key,orderId,iso()]);
    return view(tx,await checkoutRow(tx,key));
  });if(outcome.closed)fail('Checkout reservation has expired or closed.','COMMERCE_RESERVATION_CLOSED',409);return outcome;}
  async function ship(fulfillmentId,input,actor='owner') {
    only(input,['operationId','carrier','trackingNumber','trackingUrl','items']);
    if(!text(input.carrier,80)||!text(input.trackingNumber,200))fail('Carrier and tracking number are required.');
    if(input.trackingUrl){let u;try{u=new URL(input.trackingUrl);}catch{fail('Tracking URL must use HTTPS.');}if(u.protocol!=='https:'||u.username||u.password)fail('Tracking URL must use HTTPS.');}
    if(!Array.isArray(input.items)||!input.items.length)fail('Provide shipment items.');
    return db.transaction(tx=>once(tx,{...input,fulfillmentId},'ship',actor,async()=>{
      const f=await first(tx,'SELECT * FROM commerce_fulfillment_orders WHERE id=$1',[fulfillmentId]);if(!f)fail('Fulfillment not found.','COMMERCE_NOT_FOUND',404);
      const {bag,allocation,fulfillment}=await bagState(tx,f.bagId), group=allocation.allocation;
      if(['cancelled','delivered'].includes(fulfillment.state))fail('Fulfillment is closed.','COMMERCE_FULFILLMENT_CLOSED',409);
      if(await first(tx,'SELECT id FROM shipments WHERE bag_id=$1 AND carrier=$2 AND tracking_number=$3',[bag.id,text(input.carrier,80),text(input.trackingNumber,200)]))
        fail('This tracking reference already has a shipment; replay its original operation.','COMMERCE_SHIPMENT_EXISTS',409);
      const seen=new Set();let cost=0;
      for(const item of input.items){only(item,['reference','qty']);int(item.qty,'qty',1,100);
        const line=group.items.find(l=>l.reference===item.reference);
        if(!line||seen.has(item.reference)||line.shippedQty+line.refundedUnshippedQty+item.qty>line.qty)fail('Shipment exceeds unshipped, unrefunded quantities.');
        seen.add(item.reference);line.units.filter(u=>!u.shipped&&!u.refunded).slice(0,item.qty).forEach(u=>{u.shipped=true;});
        line.shippedQty+=item.qty;if(line.variantId)cost+=item.qty*line.unitCostCents;}
      const done=group.items.every(l=>l.shippedQty+l.refundedUnshippedQty===l.qty), shipmentId=id('ship');
      await tx.query(`INSERT INTO shipments(id,bag_id,brand_id,carrier,tracking_number,tracking_url,items,shipped_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[shipmentId,bag.id,bag.brandId,text(input.carrier,80),text(input.trackingNumber,200),input.trackingUrl||null,json(input.items),iso()]);
      await tx.query('UPDATE commerce_bag_allocations SET allocation=$2 WHERE bag_id=$1',[bag.id,json(group)]);
      await tx.query('UPDATE commerce_fulfillment_orders SET state=$2,items=$3,updated_at=$4 WHERE id=$1',[f.id,done?'shipped':'partially_shipped',json(group.items),iso()]);
      await tx.query("UPDATE bags SET status=$2,updated_at=$3 WHERE id=$1",[bag.id,done?'shipped':'awaiting_shipment',iso()]);
      await journal(tx,`commerce:cogs:${shipmentId}`,'commerce_cogs',bag,[d('cost_of_goods_sold',cost),c('inventory_asset',cost)]);
      await emit(tx,'shipment.simulated_notice',shipmentId,bag.brandId,{bagId:bag.id,shipmentId,items:input.items});
      return {fulfillmentId:f.id,shipmentId,state:done?'shipped':'partially_shipped',simulated:true};
    }));
  }
  async function deliver(fulfillmentId,input,actor='owner') {
    only(input,['operationId']);return db.transaction(tx=>once(tx,{...input,fulfillmentId},'deliver',actor,async()=>{
      const f=await first(tx,'SELECT * FROM commerce_fulfillment_orders WHERE id=$1',[fulfillmentId]);if(!f)fail('Fulfillment not found.','COMMERCE_NOT_FOUND',404);
      const {bag,fulfillment}=await bagState(tx,f.bagId);
      if(fulfillment.state!=='shipped'&&fulfillment.state!=='delivered')fail('Ship all active items before delivery.','COMMERCE_NOT_SHIPPED',409);
      if(fulfillment.state!=='delivered'){
        const current=await policies.get(tx),brand=await first(tx,'SELECT return_window_days FROM brands WHERE id=$1',[bag.brandId]);
        const due=new Date(now().getTime()+Math.max(7,bag.returnWindowDays,current.returnWindowDays,brand.returnWindowDays)*DAY).toISOString();
        await tx.query("UPDATE bags SET status='delivered',delivered_at=$2,payout_due_at=$3,updated_at=$2 WHERE id=$1",[bag.id,iso(),due]);
        await tx.query("UPDATE commerce_fulfillment_orders SET state='delivered',updated_at=$2 WHERE id=$1",[f.id,iso()]);
        await tx.query('UPDATE transfers SET due_at=$2 WHERE bag_id=$1',[bag.id,due]);
        await emit(tx,'delivery.simulated',f.id,bag.brandId,{bagId:bag.id});
      }
      return {fulfillmentId:f.id,state:'delivered',simulated:true};
    }));
  }
  async function refund(bagId,input,actor='owner') {
    only(input,['operationId','reason','items','refundShipping']);note(input.reason);
    if(!Array.isArray(input.items)||!input.items.length&&!input.refundShipping||input.items.length>100||input.refundShipping!==undefined&&typeof input.refundShipping!=='boolean')fail('Provide refund quantities or an explicit shipping refund.');
    return db.transaction(tx=>once(tx,{...input,bagId},'refund',actor,async()=>{
      const {bag,allocation,fulfillment}=await bagState(tx,bagId),g=allocation.allocation, partner=allocation.model==='partner';
      const seen=new Set();let gross=0,discount=0,partnerDiscount=0,commission=0,tax=0;
      for(const item of input.items){only(item,['reference','qty']);int(item.qty,'qty',1,100);const l=g.items.find(l=>l.reference===item.reference);
        if(!l||seen.has(item.reference)||l.refundedQty+item.qty>l.qty)fail('Refund exceeds unrefunded quantities.');seen.add(item.reference);
        const units=[...l.units.filter(u=>!u.refunded&&!u.shipped),...l.units.filter(u=>!u.refunded&&u.shipped)].slice(0,item.qty);
        for(const u of units){gross+=u.grossCents;discount+=u.discountCents;partnerDiscount+=u.partnerDiscountCents;commission+=u.commissionCents;tax+=u.taxCents;
          u.refunded=true;if(u.shipped)l.refundedShippedQty++;else l.refundedUnshippedQty++;l.refundedQty++;}
      }
      let shipping=0,shippingSubsidy=0;
      if(input.refundShipping&&!g.shippingRefunded){shipping=g.shippingCents;tax+=g.shippingTaxCents;shippingSubsidy=g.platformShippingSubsidyCents;g.shippingRefunded=true;}
      const amount=gross-discount+shipping+tax, recovery=partner?gross-partnerDiscount-commission+shipping+shippingSubsidy:0;
      const refundId=id('refund');
      if(amount)await tx.query(`INSERT INTO refunds(id,bag_id,brand_id,amount_cents,reason,status,approved_at,subtotal_cents,shipping_cents,tax_cents,commission_cents,discount_cents,created_at)
        VALUES($1,$2,$3,$4,$5,'approved',$6,$7,$8,$9,$10,$11,$6)`,[refundId,bag.id,bag.brandId,amount,note(input.reason),iso(),gross,shipping,tax,commission,discount]);
      const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
      const settled=Boolean(transfer?.paidAt)||['paid','reversed'].includes(transfer?.status);
      if(partner && settled && recovery){
        await journal(tx,`commerce:reversal:${refundId}`,'commerce_simulated_reversal',bag,[d('sandbox_clearing',recovery),c('brand_payable',recovery)]);
        await tx.query("UPDATE transfers SET reversed_cents=reversed_cents+$2,status=CASE WHEN reversed_cents+$2=amount_cents THEN 'reversed' ELSE status END WHERE id=$1",[transfer.id,recovery]);
      }
      await journal(tx,`commerce:refund:${refundId}`,'commerce_simulated_refund',bag,[
        ...(partner?[d('brand_payable',recovery),d('commission_revenue',commission)]:[d('retail_revenue',gross),d('retail_shipping_revenue',shipping)]),
        d('tax_payable',tax),c('sandbox_clearing',amount),c('promotion_expense',discount-partnerDiscount),c('shipping_subsidy_expense',shippingSubsidy)]);
      g.refundedTransferCents=(g.refundedTransferCents||0)+recovery;
      if(partner && transfer && !settled)await tx.query("UPDATE transfers SET amount_cents=$2,status=$3 WHERE id=$1",[transfer.id,g.transferCents-g.refundedTransferCents,g.transferCents===g.refundedTransferCents?'cancelled':'held']);
      const allRefunded=g.items.every(l=>l.refundedQty===l.qty);
      await tx.query("UPDATE bags SET refunded_cents=refunded_cents+$2,status=CASE WHEN refunded_cents+$2=total_cents AND $4 THEN 'refunded' ELSE status END,updated_at=$3 WHERE id=$1",[bag.id,amount,iso(),allRefunded]);
      await tx.query("UPDATE orders SET refunded_cents=refunded_cents+$2,status=CASE WHEN refunded_cents+$2=total_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=$1",[bag.orderId,amount]);
      await tx.query('UPDATE commerce_bag_allocations SET allocation=$2 WHERE bag_id=$1',[bag.id,json(g)]);
      const allShipped=g.items.every(l=>l.shippedQty+l.refundedUnshippedQty===l.qty);
      await tx.query('UPDATE commerce_fulfillment_orders SET items=$2,state=$3,updated_at=$4 WHERE id=$1',[fulfillment.id,json(g.items),allRefunded?'cancelled':fulfillment.state==='delivered'?'delivered':allShipped?'shipped':g.items.some(l=>l.shippedQty)?'partially_shipped':'open',iso()]);
      if(!allRefunded && allShipped && bag.status==='awaiting_shipment')await tx.query("UPDATE bags SET status='shipped' WHERE id=$1",[bag.id]);
      // Recompute cumulative credit entitlement from frozen item discounts. This
      // avoids refund-fragment rounding drift and does not require Connect setup.
      const oldCredit=await first(tx,'SELECT * FROM credits WHERE bag_id=$1',[bag.id]);
      const remainingNet=g.items.reduce((s,l)=>s+l.units.filter(u=>!u.refunded).reduce((a,u)=>a+u.netCents,0),0);
      const earned=rateCents(remainingNet,allocation.terms.platform.loyaltyBps??500),voided=oldCredit.amountCents-earned;
      if(voided>0)await journal(tx,`commerce:credit-refund:${refundId}`,'commerce_credit_reversal',bag,[d(oldCredit.status==='released'?'credit_vault':'credit_pending',voided),c('loyalty_expense',voided)]);
      await tx.query("UPDATE credits SET amount_cents=$2,status=CASE WHEN $2=0 THEN 'voided' ELSE status END,voided_at=CASE WHEN $2=0 THEN $3 ELSE voided_at END WHERE bag_id=$1",[bag.id,earned,iso()]);
      await emit(tx,'refund.simulated',refundId,bag.brandId,{bagId,amountCents:amount,recoveryCents:recovery});
      return {refundId,bagId,amountCents:amount,recoveryCents:recovery,simulated:true,restocked:false};
    }));
  }
  async function inspect(input,actor='owner') {
    only(input,['operationId','bagId','reference','qty','disposition','reason','origin']);note(input.reason);int(input.qty,'qty',1,100);
    if(input.origin!==undefined&&!['shipped','unshipped'].includes(input.origin))fail('Return origin must be shipped or unshipped.');
    if(!['restock','quarantine'].includes(input.disposition))fail('Choose restock or quarantine.');
    return db.transaction(tx=>once(tx,input,'return_inspection',actor,async()=>{
      const {bag,allocation}=await bagState(tx,input.bagId),g=allocation.allocation,l=g.items.find(l=>l.reference===input.reference);
      if(!l?.variantId)fail('Native return inspection requires an Avafem-owned line.');
      const remaining=l.units.filter(u=>u.refunded&&!u.inspection), origins=new Set(remaining.map(u=>u.shipped?'shipped':'unshipped'));
      if(!input.origin&&origins.size>1)fail('Choose shipped return or unshipped cancellation for this inspection.');
      const origin=input.origin||[...origins][0], units=remaining.filter(u=>(u.shipped?'shipped':'unshipped')===origin).slice(0,input.qty);
      if(units.length!==input.qty)fail('Inspection exceeds the uninspected refunded quantities for this origin.');
      const inspectionId=id('inspection');
      await tx.query(`INSERT INTO commerce_return_inspections(id,operation_id,bag_id,reference,qty,disposition,unit_cost_cents,actor,reason,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[inspectionId,input.operationId,bag.id,l.reference,input.qty,input.disposition,l.unitCostCents,actor,note(input.reason),iso()]);
      if(input.disposition==='restock'){
        await inventory.restock({variantId:l.variantId,qty:input.qty,inspectionId,operationId:`return_${input.operationId}`,reason:input.reason},actor,tx);
        const cost=units.filter(u=>u.shipped).length*l.unitCostCents;
        await journal(tx,`commerce:return-cost:${inspectionId}`,'commerce_return_cogs',bag,[d('inventory_asset',cost),c('cost_of_goods_sold',cost)]);
      }
      units.forEach(u=>{u.inspection={id:inspectionId,disposition:input.disposition};});
      await tx.query('UPDATE commerce_bag_allocations SET allocation=$2 WHERE bag_id=$1',[bag.id,json(g)]);
      return {inspectionId,bagId:bag.id,qty:input.qty,disposition:input.disposition,simulated:true};
    }));
  }
  async function run() {return db.transaction(async tx=>{
    const expired=await expireTx(tx);let payouts=0,credits=0;
    const candidates=await rows(tx,"SELECT * FROM bags WHERE commerce_managed AND status='delivered' FOR UPDATE");
    for(const bag of candidates){
      const brand=await first(tx,'SELECT * FROM brands WHERE id=$1 FOR UPDATE',[bag.brandId]);
      const settings=await policies.get(tx);
      const days=Math.max(7,bag.returnWindowDays,brand.returnWindowDays,settings.returnWindowDays);
      const due=new Date(Math.max(Date.parse(bag.deliveredAt)+days*DAY,Date.parse(bag.payoutDueAt)||0));
      await tx.query('UPDATE bags SET payout_due_at=$2 WHERE id=$1',[bag.id,due.toISOString()]);
      if(due>now()||['paused','disconnected'].includes(brand.status))continue;
      const blocked=await first(tx,`SELECT COUNT(*)::int AS count FROM disputes WHERE bag_id=$1 AND status IN ('needs_response','under_review','lost')`,[bag.id]);
      if(blocked.count)continue;
      const pending=await first(tx,"SELECT COUNT(*)::int AS count FROM refunds WHERE bag_id=$1 AND status='proposed'",[bag.id]);if(pending.count)continue;
      if(bag.settlementModel==='commission'){
        const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
        // Native settlement never bypasses existing two-step payout proof.
        const twoStep=brand.onboardingMode==='two_step'||Boolean(brand.onboardingState?.platform||brand.onboardingState?.source||brand.onboardingState?.connected);
        const ready=brand.connectionHealthy&&['ready','live'].includes(brand.status)&&brand.chargesEnabled&&brand.payoutsEnabled&&brand.stripeAccountId
          &&(!twoStep||await domain.twoStepPayoutReady(brand.id,{tx}));
        if(!ready)continue;
        if(transfer && transfer.status==='held'){
          await journal(tx,`commerce:payout:${bag.id}`,'commerce_simulated_payout',bag,[d('brand_payable',transfer.amountCents),c('sandbox_clearing',transfer.amountCents)]);
          await tx.query("UPDATE transfers SET status='paid',paid_at=$2,due_at=$3 WHERE id=$1",[transfer.id,iso(),due.toISOString()]);payouts++;
        }
      }
      const credit=await first(tx,'SELECT * FROM credits WHERE bag_id=$1',[bag.id]);
      if(credit?.status==='pending'){
        await journal(tx,`commerce:credit-release:${bag.id}`,'commerce_credit_released',bag,[d('credit_pending',credit.amountCents),c('credit_vault',credit.amountCents)]);
        await tx.query("UPDATE credits SET status='released',released_at=$2 WHERE id=$1",[credit.id,iso()]);credits++;
      }
    }
    return {expired,payouts,credits,simulated:true};
  });}
  async function reconciliation() {return db.transaction(async tx=>{
    const entries=await rows(tx,`SELECT j.id,j.kind,j.total_debit_cents,j.total_credit_cents,
      COALESCE(SUM(e.debit_cents),0)::bigint AS actual_debit,COALESCE(SUM(e.credit_cents),0)::bigint AS actual_credit
      FROM ledger_journals j JOIN bags b ON b.id=j.bag_id LEFT JOIN ledger_entries e ON e.journal_id=j.id
      WHERE b.commerce_managed GROUP BY j.id,j.kind,j.total_debit_cents,j.total_credit_cents`);
    const errors=entries.filter(e=>Number(e.actualDebit)!==e.totalDebitCents||Number(e.actualCredit)!==e.totalCreditCents||Number(e.actualDebit)!==Number(e.actualCredit)).map(e=>({journalId:e.id,code:'UNBALANCED_JOURNAL'}));
    const unexpected=await rows(tx,"SELECT t.id FROM transfers t JOIN bags b ON b.id=t.bag_id WHERE b.commerce_managed AND b.settlement_model='retail'");
    errors.push(...unexpected.map(t=>({transferId:t.id,code:'FIRST_PARTY_TRANSFER'})));
    const orders=await rows(tx,`SELECT o.id,o.total_cents,SUM(b.total_cents)::bigint AS allocated FROM orders o JOIN bags b ON b.order_id=o.id
      WHERE b.commerce_managed GROUP BY o.id,o.total_cents`);
    errors.push(...orders.filter(o=>o.totalCents!==Number(o.allocated)).map(o=>({orderId:o.id,code:'ORDER_ALLOCATION_MISMATCH'})));
    const bags=await rows(tx,`SELECT b.*,a.allocation,a.terms FROM bags b JOIN commerce_bag_allocations a ON a.bag_id=b.id WHERE b.commerce_managed`);
    for(const bag of bags){
      const g=bag.allocation;
      for(const field of ['subtotalCents','discountCents','shippingCents','taxCents','commissionCents','transferCents','totalCents'])
        if(bag[field]!==g[field])errors.push({bagId:bag.id,field,code:'BAG_SNAPSHOT_MISMATCH'});
      const refunded=g.items.flatMap(l=>l.units).filter(u=>u.refunded).reduce((s,u)=>s+u.netCents+u.taxCents,0)
        +(g.shippingRefunded?g.shippingCents+g.shippingTaxCents:0);
      if(refunded!==bag.refundedCents)errors.push({bagId:bag.id,code:'REFUND_ALLOCATION_MISMATCH'});
      const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
      const sums=await rows(tx,`SELECT e.account,SUM(e.credit_cents-e.debit_cents)::bigint AS balance FROM ledger_entries e
        JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 GROUP BY e.account`,[bag.id]);
      const balance=account=>Number(sums.find(s=>s.account===account)?.balance||0);
      if(g.terms.model==='partner'){
        if(!transfer||transfer.amountCents-transfer.reversedCents!==g.transferCents-(g.refundedTransferCents||0))errors.push({bagId:bag.id,code:'PARTNER_TRANSFER_MISMATCH'});
        const outstanding=transfer?.paidAt?0:g.transferCents-(g.refundedTransferCents||0);
        if(balance('brand_payable')!==outstanding)errors.push({bagId:bag.id,code:'PARTNER_PAYABLE_MISMATCH'});
      }else if(balance('brand_payable'))errors.push({bagId:bag.id,code:'FIRST_PARTY_PAYABLE'});
      const credit=await first(tx,'SELECT * FROM credits WHERE bag_id=$1',[bag.id]);
      const net=g.items.flatMap(l=>l.units).filter(u=>!u.refunded).reduce((s,u)=>s+u.netCents,0), expected=rateCents(net,bag.terms.platform.loyaltyBps??500);
      if(!credit||credit.amountCents!==expected||balance('credit_pending')+balance('credit_vault')!==(credit.status==='voided'?0:expected))errors.push({bagId:bag.id,code:'CREDIT_ALLOCATION_MISMATCH'});
    }
    const stock=await rows(tx,`SELECT v.id,v.on_hand,v.reserved,COALESCE(SUM(i.qty) FILTER(WHERE r.state='reserved'),0)::bigint AS held
      FROM commerce_native_variants v LEFT JOIN commerce_native_reservation_items i ON i.variant_id=v.id
      LEFT JOIN commerce_native_reservations r ON r.checkout_id=i.checkout_id GROUP BY v.id,v.on_hand,v.reserved`);
    errors.push(...stock.filter(v=>v.onHand<v.reserved||v.reserved!==Number(v.held)).map(v=>({variantId:v.id,code:'NATIVE_RESERVATION_MISMATCH'})));
    return {ok:!errors.length,errors,journals:entries.length,orders:orders.length,scope:'local_ledger_only',providerReconciled:false,simulated:true};
  });}
  return {quote,get,cancel,simulatePayment,ship,deliver,refund,inspect,run,reconciliation,
    list:()=>db.transaction(async tx=>{const all=await rows(tx,'SELECT * FROM commerce_checkouts ORDER BY created_at DESC LIMIT 100');return Promise.all(all.map(row=>view(tx,row)));}),
    fulfillment:()=>rows(db,'SELECT * FROM commerce_fulfillment_orders ORDER BY created_at DESC LIMIT 200')};
}
