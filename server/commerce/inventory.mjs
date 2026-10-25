import {createHash,randomUUID} from 'node:crypto';

const MAX=1_000_000;
const id=prefix=>`${prefix}_${randomUUID().replaceAll('-','')}`;
const fail=(code,message,statusCode=409)=>{throw Object.assign(new Error(message),{code,statusCode});};
const integer=(value,name,min=0,max=MAX)=>{
  if(!Number.isSafeInteger(value)||value<min||value>max)fail('NATIVE_INVENTORY_INPUT',`${name} must be an integer between ${min} and ${max}.`,422);
  return value;
};
const text=(value,name,max=160)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('NATIVE_INVENTORY_INPUT',`A bounded ${name} is required.`,422);
  return value.trim();
};
const operation=value=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/.test(value))fail('NATIVE_INVENTORY_INPUT','A stable operation ID of 8–160 safe characters is required.',422);
  return value;
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorName=actor=>text(typeof actor==='string'?actor:actor?.memberId?`member:${actor.memberId}`:actor?.credentialId||actor?.actor||(actor?.owner===true?'owner-workspace':null),'actor',200);
const view=row=>({id:row.id,productId:row.product_id,brandId:row.brand_id,sku:row.sku,label:row.label,isDefault:row.is_default,
  unitPriceCents:row.unit_price_cents,unitCostCents:row.unit_cost_cents,onHand:row.on_hand,reserved:row.reserved,
  available:row.on_hand-row.reserved,version:row.version});

/** Native inventory is a separate authority, never inferred from a NULL source
 * or the editable parent product quantity. Callers enforce owner permissions.
 * All writes are transactional; reserve/commit/release/expire accept the caller's
 * tx and never open a nested transaction. Reservations freeze unit price/cost.
 * Refunds do NOT call this module: an inspected return uses explicit restock.
 */
export async function createNativeInventory(db,{clock=()=>new Date(),policies}={}) {
  if(!db?.transaction||typeof policies?.getBrand!=='function')fail('NATIVE_INVENTORY_SETUP','A database and explicit commerce policies are required.',500);
  const now=()=>{
    const value=new Date(clock());
    if(!Number.isFinite(value.getTime()))fail('NATIVE_INVENTORY_CLOCK','Inventory clock is invalid.',500);
    return value;
  };
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_native_variants (
    id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),brand_id TEXT NOT NULL REFERENCES brands(id),
    sku TEXT NOT NULL,label TEXT NOT NULL,is_default BOOLEAN NOT NULL DEFAULT false,
    unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0),
    on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand BETWEEN 0 AND 1000000),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND on_hand),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(product_id,sku))`);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS commerce_native_default_variant ON commerce_native_variants(product_id) WHERE is_default');
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_native_reservations (
    checkout_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','committed','released','expired')),
    expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_native_reservation_items (
    checkout_id TEXT NOT NULL REFERENCES commerce_native_reservations(checkout_id),variant_id TEXT NOT NULL REFERENCES commerce_native_variants(id),
    product_id TEXT NOT NULL REFERENCES products(id),brand_id TEXT NOT NULL REFERENCES brands(id),sku TEXT NOT NULL,label TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 1000000),unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents>=0),
    unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0),PRIMARY KEY(checkout_id,variant_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_native_stock_movements (
    id TEXT PRIMARY KEY,operation_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,variant_id TEXT NOT NULL REFERENCES commerce_native_variants(id),
    checkout_id TEXT,kind TEXT NOT NULL,delta_on_hand INTEGER NOT NULL,delta_reserved INTEGER NOT NULL,
    actor TEXT NOT NULL,reason TEXT NOT NULL,inspection_id TEXT,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL)`);
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS commerce_native_restock_inspection ON commerce_native_stock_movements(inspection_id) WHERE kind='restock' AND inspection_id IS NOT NULL");
  const run=(tx,fn)=>tx&&tx!==db?fn(tx):db.transaction(fn);
  async function requireNative(brandId,tx) {
    // saveBrand uses this same lock before structural policy edits. A passed
    // transaction must have the same fence as normal db.transaction callers.
    if(!(await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId])).rows.length)
      fail('NATIVE_PRODUCT_NOT_FOUND','Brand not found.',404);
    const p=await policies.getBrand(brandId,tx);
    if(p?.brandId!==brandId||p.model!=='first_party'||p.inventoryAuthority!=='native'||p.inventoryOwner!=='avafem'||p.fulfiller!=='avafem'||p.settlementModel!=='retail')
      fail('NATIVE_INVENTORY_POLICY','Explicit first-party/native/Avafem-owned retail inventory is required.');
  }
  async function get(variantId,tx=db) {
    const row=(await tx.query('SELECT * FROM commerce_native_variants WHERE id=$1',[text(variantId,'variant ID')])).rows[0];
    if(!row)fail('NATIVE_VARIANT_NOT_FOUND','Native variant not found.',404);
    return view(row);
  }
  async function list({brandId}={},tx=db) {
    return (await tx.query(`SELECT * FROM commerce_native_variants${brandId?' WHERE brand_id=$1':''} ORDER BY product_id,created_at,id`,brandId?[text(brandId,'brand ID')]:[])).rows.map(view);
  }
  async function movement(tx,{operationId,requestHash,variant,checkoutId=null,kind,deltaOnHand=0,deltaReserved=0,actor,reason,inspectionId=null}) {
    await tx.query(`INSERT INTO commerce_native_stock_movements(id,operation_id,request_hash,variant_id,checkout_id,kind,delta_on_hand,delta_reserved,actor,reason,inspection_id,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id('nmov'),operationId,requestHash,variant.id,checkoutId,kind,deltaOnHand,deltaReserved,actor,reason,inspectionId,JSON.stringify(variant),now()]);
  }
  async function createVariant(input,actor) {
    const productId=text(input?.productId,'product ID'),sku=text(input?.sku,'SKU',120),who=actorName(actor);
    const cost=integer(input?.unitCostCents,'unitCostCents',0,2_000_000_000);
    if(Object.keys(input).some(key=>!['productId','sku','label','unitPriceCents','unitCostCents'].includes(key)))fail('NATIVE_VARIANT_IDENTITY','Variant identity and starting stock cannot be supplied or reset.',422);
    return db.transaction(async tx=>{
      const product=(await tx.query('SELECT id,brand_id,price_cents FROM products WHERE id=$1 FOR UPDATE',[productId])).rows[0];
      if(!product)fail('NATIVE_PRODUCT_NOT_FOUND','Product not found.',404);
      await requireNative(product.brand_id,tx);
      const existing=(await tx.query('SELECT * FROM commerce_native_variants WHERE product_id=$1 AND sku=$2 FOR UPDATE',[productId,sku])).rows[0];
      const label=input.label===undefined?(existing?.label||'Default'):text(input.label,'variant label',200);
      const price=integer(input.unitPriceCents??existing?.unit_price_cents??product.price_cents,'unitPriceCents',0,2_000_000_000);
      if(existing) {
        if(existing.label!==label||existing.unit_price_cents!==price||existing.unit_cost_cents!==cost)fail('NATIVE_VARIANT_EXISTS','This SKU already has a stable variant. Update its commercial fields using its version.');
        return {...view(existing),replayed:true};
      }
      const first=!(await tx.query('SELECT id FROM commerce_native_variants WHERE product_id=$1 LIMIT 1',[productId])).rows.length;
      const row=(await tx.query(`INSERT INTO commerce_native_variants(id,product_id,brand_id,sku,label,is_default,unit_price_cents,unit_cost_cents,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,[id('nvar'),productId,product.brand_id,sku,label,first,price,cost,now()])).rows[0];
      const result=view(row);
      await movement(tx,{operationId:`create:${row.id}`,requestHash:digest({productId,sku,label,price,cost}),variant:result,kind:'create',actor:who,reason:'Native variant created; starting stock is zero.'});
      return {...result,replayed:false};
    });
  }
  async function updateVariant(variantId,input,actor) {
    const key=text(variantId,'variant ID'),who=actorName(actor);
    const expected=integer(input?.expectedVersion,'expectedVersion',1,2_000_000_000);
    if(Object.keys(input).some(key=>!['expectedVersion','unitPriceCents','unitCostCents','label'].includes(key)))fail('NATIVE_VARIANT_IDENTITY','A stable variant cannot be renamed, reparented or reset.',422);
    if(Object.keys(input).length===1)fail('NATIVE_INVENTORY_INPUT','Provide a price, cost or label change.',422);
    return db.transaction(async tx=>{
      const hint=await get(key,tx);await requireNative(hint.brandId,tx);
      const row=(await tx.query('SELECT * FROM commerce_native_variants WHERE id=$1 FOR UPDATE',[key])).rows[0];
      if(row.version!==expected)fail('NATIVE_VARIANT_VERSION','The variant changed; refresh before editing.');
      const price=input.unitPriceCents===undefined?row.unit_price_cents:integer(input.unitPriceCents,'unitPriceCents',0,2_000_000_000);
      const cost=input.unitCostCents===undefined?row.unit_cost_cents:integer(input.unitCostCents,'unitCostCents',0,2_000_000_000);
      const label=input.label===undefined?row.label:text(input.label,'variant label',200);
      const updated=(await tx.query('UPDATE commerce_native_variants SET unit_price_cents=$2,unit_cost_cents=$3,label=$4,version=version+1,updated_at=$5 WHERE id=$1 RETURNING *',[key,price,cost,label,now()])).rows[0];
      const result=view(updated);
      await movement(tx,{operationId:`update:${key}:${updated.version}`,requestHash:digest({expected,price,cost,label}),variant:result,kind:'update',actor:who,reason:'Native variant commercial fields updated.'});
      return result;
    });
  }
  async function adjustStock(input,actor,kind,tx) {
    const variantId=text(input?.variantId,'variant ID'),op=operation(input?.operationId),reason=text(input?.reason,'reason',1000),who=actorName(actor);
    const delta=kind==='restock'?integer(input?.qty,'qty',1):integer(input?.delta,'delta',-MAX,MAX);
    if(!delta)fail('NATIVE_INVENTORY_INPUT','A stock adjustment must change the quantity.',422);
    const inspectionId=kind==='restock'?text(input?.inspectionId,'return inspection ID'):null;
    if(Object.keys(input).some(key=>!(kind==='restock'?['variantId','qty','operationId','reason','inspectionId']:['variantId','delta','operationId','reason']).includes(key)))
      fail('NATIVE_INVENTORY_INPUT','Only the explicit stock adjustment fields are accepted.',422);
    const requestHash=digest({kind,variantId,delta,reason,inspectionId}),operationId=`manual:${op}`;
    return run(tx,async tx=>{
      const hint=await get(variantId,tx);await requireNative(hint.brandId,tx);
      // Reserve the operation ID before touching counters. ON CONFLICT waits
      // for an independently pooled writer, then reads its committed receipt.
      // This new audit row is finalized inside this transaction, never exposed
      // as a mutable/pending receipt to other transactions.
      const claimed=(await tx.query(`INSERT INTO commerce_native_stock_movements(id,operation_id,request_hash,variant_id,kind,delta_on_hand,delta_reserved,actor,reason,inspection_id,result,created_at)
        VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,'{}',$10) ON CONFLICT DO NOTHING RETURNING id`,[id('nmov'),operationId,requestHash,variantId,kind,delta,who,reason,inspectionId,now()])).rows[0];
      if(!claimed) {
        const previous=(await tx.query('SELECT request_hash,result FROM commerce_native_stock_movements WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
        if(!previous)fail('NATIVE_RETURN_INSPECTION_USED','This physical return inspection was already posted to inventory.');
        if(previous.request_hash!==requestHash)fail('NATIVE_INVENTORY_IDEMPOTENCY','This operation ID was used with a different stock adjustment.');
        return {...previous.result,replayed:true};
      }
      if(kind==='restock'&&(await tx.query("SELECT to_regclass('commerce_return_inspections') AS relation")).rows[0]?.relation) {
        // The checkout inserts its immutable inspection before calling restock
        // in this same transaction. Standalone inventory fixtures have no
        // inspection service/table; no public route directly calls restock.
        const proof=(await tx.query(`SELECT i.qty,i.disposition,i.reference,a.allocation FROM commerce_return_inspections i
          JOIN commerce_bag_allocations a ON a.bag_id=i.bag_id WHERE i.id=$1 FOR UPDATE OF i`,[inspectionId])).rows[0];
        const line=proof?.allocation?.items?.find(item=>item.reference===proof.reference);
        if(!proof||proof.disposition!=='restock'||proof.qty!==delta||line?.variantId!==variantId)
          fail('NATIVE_RETURN_INSPECTION_REQUIRED','An exact server-created restock inspection for this variant and quantity is required.');
      }
      const row=(await tx.query('SELECT * FROM commerce_native_variants WHERE id=$1 FOR UPDATE',[variantId])).rows[0];
      const next=row.on_hand+delta;
      if(next<0||next>MAX)fail('NATIVE_STOCK_RANGE','Stock must remain between zero and one million units.');
      if(next<row.reserved)fail('NATIVE_STOCK_RESERVED','Stock cannot fall below existing reservations.');
      const updated=(await tx.query('UPDATE commerce_native_variants SET on_hand=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *',[variantId,next,now()])).rows[0];
      const result=view(updated);
      await tx.query('UPDATE commerce_native_stock_movements SET result=$2 WHERE id=$1',[claimed.id,JSON.stringify(result)]);
      return {...result,replayed:false};
    });
  }
  const adjust=(input,actor,tx)=>adjustStock(input,actor,'adjust',tx);
  const restock=(input,actor,tx)=>adjustStock(input,actor,'restock',tx);
  async function reservationView(tx,row,replayed=false) {
    const items=(await tx.query('SELECT * FROM commerce_native_reservation_items WHERE checkout_id=$1 ORDER BY variant_id',[row.checkout_id])).rows;
    return {checkoutId:row.checkout_id,state:row.state,expiresAt:new Date(row.expires_at).toISOString(),replayed,
      items:items.map(item=>({variantId:item.variant_id,productId:item.product_id,brandId:item.brand_id,sku:item.sku,label:item.label,
        qty:item.qty,unitPriceCents:item.unit_price_cents,unitCostCents:item.unit_cost_cents}))};
  }
  function reservationInput(input) {
    const checkoutId=text(input?.checkoutId,'checkout ID');
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>100)fail('NATIVE_INVENTORY_INPUT','Reserve 1–100 unique variants.',422);
    if(Object.keys(input).some(key=>!['checkoutId','items','expiresAt'].includes(key))||input.items.some(item=>!item||Object.keys(item).some(key=>!['variantId','qty'].includes(key))))
      fail('NATIVE_INVENTORY_INPUT','Only immutable variant IDs, quantities and expiry are accepted.',422);
    const items=input.items.map(item=>({variantId:text(item?.variantId,'variant ID'),qty:integer(item?.qty,'qty',1)})).sort((a,b)=>a.variantId.localeCompare(b.variantId));
    if(new Set(items.map(item=>item.variantId)).size!==items.length||items.reduce((n,item)=>n+item.qty,0)>MAX)fail('NATIVE_INVENTORY_INPUT','Reservation variants must be unique and total quantity at most one million.',422);
    const date=new Date(input.expiresAt);
    if(!Number.isFinite(date.getTime()))fail('NATIVE_INVENTORY_INPUT','A valid reservation expiry is required.',422);
    const expiresAt=date.toISOString();
    return {checkoutId,items,expiresAt,requestHash:digest({items,expiresAt})};
  }
  async function reserve(input,tx) {
    const {checkoutId,items,expiresAt,requestHash}=reservationInput(input);
    return run(tx,async q=>{
      let row=(await q.query('SELECT * FROM commerce_native_reservations WHERE checkout_id=$1 FOR UPDATE',[checkoutId])).rows[0];
      if(row) {
        if(row.request_hash!==requestHash)fail('NATIVE_RESERVATION_IDEMPOTENCY','This checkout already reserved a different immutable payload.');
        if(row.state==='reserved'&&new Date(row.expires_at)<=now())fail('NATIVE_RESERVATION_EXPIRED','The stock reservation expired.');
        if(!['reserved','committed'].includes(row.state))fail('NATIVE_RESERVATION_CLOSED','A released or expired checkout cannot acquire stock again.');
        return reservationView(q,row,true);
      }
      if(new Date(expiresAt)<=now()||new Date(expiresAt)>new Date(now().getTime()+86_400_000))fail('NATIVE_INVENTORY_INPUT','Reserve stock for a future time within 24 hours.',422);
      const inserted=(await q.query(`INSERT INTO commerce_native_reservations(checkout_id,request_hash,state,expires_at,created_at,updated_at)
        VALUES($1,$2,'reserved',$3,$4,$4) ON CONFLICT DO NOTHING RETURNING *`,[checkoutId,requestHash,expiresAt,now()])).rows[0];
      if(!inserted) {
        row=(await q.query('SELECT * FROM commerce_native_reservations WHERE checkout_id=$1 FOR UPDATE',[checkoutId])).rows[0];
        if(row.request_hash!==requestHash)fail('NATIVE_RESERVATION_IDEMPOTENCY','This checkout already reserved a different immutable payload.');
        if(row.state!=='reserved'||new Date(row.expires_at)<=now())fail('NATIVE_RESERVATION_CLOSED','This checkout reservation is closed.');
        return reservationView(q,row,true);
      }
      const hints=[];
      for(const item of items)hints.push(await get(item.variantId,q));
      for(const brandId of [...new Set(hints.map(hint=>hint.brandId))].sort())await requireNative(brandId,q);
      for(const item of items) {
        const variant=(await q.query('SELECT * FROM commerce_native_variants WHERE id=$1 FOR UPDATE',[item.variantId])).rows[0];
        if(variant.on_hand-variant.reserved<item.qty)fail('NATIVE_STOCK_UNAVAILABLE','Insufficient available native inventory.');
        const updated=(await q.query('UPDATE commerce_native_variants SET reserved=reserved+$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *',[item.variantId,item.qty,now()])).rows[0];
        await q.query(`INSERT INTO commerce_native_reservation_items(checkout_id,variant_id,product_id,brand_id,sku,label,qty,unit_price_cents,unit_cost_cents)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[checkoutId,variant.id,variant.product_id,variant.brand_id,variant.sku,variant.label,item.qty,variant.unit_price_cents,variant.unit_cost_cents]);
        await movement(q,{operationId:`reservation:reserve:${checkoutId}:${variant.id}`,requestHash,variant:view(updated),checkoutId,kind:'reserve',deltaReserved:item.qty,actor:'native-checkout',reason:'Stock reserved for checkout.'});
      }
      const result=await reservationView(q,inserted);
      if(new Date(expiresAt)<=now())fail('NATIVE_RESERVATION_EXPIRED','The reservation expired while waiting for stock locks.');
      return result;
    });
  }
  async function finish(q,checkoutId,target) {
    const row=(await q.query('SELECT * FROM commerce_native_reservations WHERE checkout_id=$1 FOR UPDATE',[checkoutId])).rows[0];
    if(!row)fail('NATIVE_RESERVATION_NOT_FOUND','Native reservation not found.',404);
    if(row.state===target||(target==='released'&&row.state==='expired'))return reservationView(q,row,true);
    if(row.state!=='reserved')fail('NATIVE_RESERVATION_CLOSED','This stock reservation is already closed.');
    if(target==='committed'&&new Date(row.expires_at)<=now())fail('NATIVE_RESERVATION_EXPIRED','Expired stock cannot be committed.');
    const items=(await q.query('SELECT * FROM commerce_native_reservation_items WHERE checkout_id=$1 ORDER BY variant_id',[checkoutId])).rows;
    if(!items.length)fail('NATIVE_RESERVATION_CORRUPT','This reservation has no immutable stock items.',500);
    if(target==='committed')for(const brandId of [...new Set(items.map(item=>item.brand_id))].sort())await requireNative(brandId,q);
    for(const item of items) {
      const variant=(await q.query('SELECT * FROM commerce_native_variants WHERE id=$1 FOR UPDATE',[item.variant_id])).rows[0];
      if(!variant||variant.product_id!==item.product_id||variant.brand_id!==item.brand_id||variant.sku!==item.sku||variant.reserved<item.qty||variant.on_hand<variant.reserved)
        fail('NATIVE_RESERVATION_CORRUPT','Reserved stock identity or counters require review.',500);
      const delta=target==='committed'?-item.qty:0;
      const updated=(await q.query('UPDATE commerce_native_variants SET on_hand=on_hand+$2,reserved=reserved-$3,version=version+1,updated_at=$4 WHERE id=$1 RETURNING *',[variant.id,delta,item.qty,now()])).rows[0];
      await movement(q,{operationId:`reservation:${target}:${checkoutId}:${variant.id}`,requestHash:row.request_hash,variant:view(updated),checkoutId,kind:target,deltaOnHand:delta,deltaReserved:-item.qty,actor:'native-checkout',reason:target==='committed'?'Reserved stock committed to paid checkout.':'Uncommitted stock reservation released.'});
    }
    if(target==='committed'&&new Date(row.expires_at)<=now())fail('NATIVE_RESERVATION_EXPIRED','The reservation expired while waiting for stock locks.');
    const updated=(await q.query('UPDATE commerce_native_reservations SET state=$2,updated_at=$3 WHERE checkout_id=$1 RETURNING *',[checkoutId,target,now()])).rows[0];
    const result=await reservationView(q,updated);
    if(target==='committed'&&new Date(row.expires_at)<=now())fail('NATIVE_RESERVATION_EXPIRED','The reservation expired before stock commit completed.');
    return result;
  }
  const commit=(checkoutId,tx)=>run(tx,q=>finish(q,text(checkoutId,'checkout ID'),'committed'));
  const release=(checkoutId,tx)=>run(tx,q=>finish(q,text(checkoutId,'checkout ID'),'released'));
  const expire=tx=>run(tx,async q=>{
    const expired=[];
    const candidates=(await q.query("SELECT checkout_id FROM commerce_native_reservations WHERE state='reserved' AND expires_at<=$1 ORDER BY checkout_id LIMIT 1000 FOR UPDATE",[now()])).rows;
    for(const row of candidates){await finish(q,row.checkout_id,'expired');expired.push(row.checkout_id);}
    return {expired,count:expired.length,batchFull:expired.length===1000};
  });
  return {list,get,createVariant,updateVariant,adjust,restock,reserve,commit,release,expire};
}
