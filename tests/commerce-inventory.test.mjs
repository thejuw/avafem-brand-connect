import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase} from '../server/db.mjs';
import {createDomain} from '../server/domain.mjs';
import {createNativeInventory} from '../server/commerce/inventory.mjs';

const actor='native-inventory-fixture-owner';
const code=expected=>error=>error.code===expected;
async function fixture(t) {
  const db=await createDatabase({connectionString:null});await db.migrate();t.after(()=>db.close());
  let instant=new Date('2026-10-25T12:00:00.000Z');
  const clock=()=>instant,domain=createDomain(db,{clock});
  const brand=await domain.createBrand({name:'Native inventory fixture',slug:'native-inventory-fixture'});
  const configs=new Map();
  const config={version:1,brandId:brand.id,model:'first_party',inventoryAuthority:'native',inventoryOwner:'avafem',fulfiller:'avafem',settlementModel:'retail'};
  configs.set(brand.id,config);
  const policies={getBrand:async(brandId,tx)=>{assert.ok(tx?.query,'policy reads must use the caller transaction');return configs.get(brandId)||{brandId,model:'partner',inventoryAuthority:'external'};}};
  const inventory=await createNativeInventory(db,{clock,policies});
  let number=0;
  const product=async()=>domain.upsertProduct(brand.id,`NATIVE-PARENT-${++number}`,{title:'Native fixture',priceCents:125,inventoryQty:999});
  const variant=async(extra={})=>inventory.createVariant({productId:(await product()).id,sku:`NATIVE-VARIANT-${number}`,unitCostCents:40,...extra},actor);
  const stock=async(v,qty,op='fixture_stock_001')=>inventory.adjust({variantId:v.id,delta:qty,operationId:op,reason:'Synthetic physical opening count.'},actor);
  const expiry=()=>new Date(clock().getTime()+900_000).toISOString();
  const reserve=(checkoutId,v,qty=1)=>({checkoutId,items:[{variantId:v.id,qty}],expiresAt:expiry()});
  return {db,domain,brand,config,configs,policies,clock,inventory,product,variant,stock,expiry,reserve,advance:ms=>{instant=new Date(instant.getTime()+ms);}};
}

test('native inventory requires an explicit first-party native policy; parent quantity is never adopted',async t=>{
  const f=await fixture(t),p=await f.product();
  f.configs.delete(f.brand.id);
  await assert.rejects(f.inventory.createVariant({productId:p.id,sku:'SINGLE',unitCostCents:40},actor),code('NATIVE_INVENTORY_POLICY'));
  assert.equal((await f.inventory.list()).length,0);
  assert.equal((await f.domain.getProduct(p.id)).sourceProvider,null,'NULL source does not establish a native authority');
  f.configs.set(f.brand.id,f.config);
  const v=await f.inventory.createVariant({productId:p.id,sku:'SINGLE',unitCostCents:40},actor);
  assert.match(v.id,/^nvar_[a-f0-9]{32}$/);assert.equal(v.isDefault,true);
  assert.equal(v.onHand,0);assert.equal(v.reserved,0);assert.equal(v.available,0);assert.equal(v.unitPriceCents,125);assert.equal(v.unitCostCents,40);
  assert.equal((await f.domain.getProduct(p.id)).inventoryQty,999);
  await f.domain.upsertProduct(f.brand.id,p.sku,{inventoryQty:500_000,priceCents:900});
  assert.equal((await f.inventory.get(v.id)).onHand,0);assert.equal((await f.inventory.get(v.id)).unitPriceCents,125);
  for(const change of [{model:'partner'},{inventoryAuthority:'external'},{inventoryOwner:'partner'},{fulfiller:'partner'},{settlementModel:'commission'}]) {
    f.configs.set(f.brand.id,{...f.config,...change});
    await assert.rejects(f.stock(v,1),code('NATIVE_INVENTORY_POLICY'));
  }
});

test('native variant identities and SKU aliases remain stable; commercial edits use optimistic versions',async t=>{
  const f=await fixture(t),p=await f.product();
  let v=await f.inventory.createVariant({productId:p.id,sku:'SHARED-SKU',unitCostCents:40},actor);
  await f.stock(v,5);
  const repeated=await f.inventory.createVariant({productId:p.id,sku:'SHARED-SKU',unitCostCents:40},actor);
  assert.equal(repeated.id,v.id);assert.equal(repeated.onHand,5);assert.equal(repeated.replayed,true);
  await assert.rejects(f.inventory.createVariant({productId:p.id,sku:'SHARED-SKU',unitCostCents:41},actor),code('NATIVE_VARIANT_EXISTS'));
  await assert.rejects(f.inventory.createVariant({productId:p.id,sku:'SOME',unitCostCents:40,id:'injected',onHand:99},actor),code('NATIVE_VARIANT_IDENTITY'));
  const second=await f.inventory.createVariant({productId:p.id,sku:'ANOTHER-SKU',label:'Large',unitPriceCents:200,unitCostCents:80},actor);
  assert.equal(second.isDefault,false);
  const elsewhere=await f.inventory.createVariant({productId:(await f.product()).id,sku:'SHARED-SKU',unitCostCents:40},actor);
  assert.notEqual(elsewhere.id,v.id,'a SKU is not a cross-product/brand identity');
  v=await f.inventory.get(v.id);
  const edited=await f.inventory.updateVariant(v.id,{expectedVersion:v.version,unitPriceCents:199,unitCostCents:60,label:'Small'},actor);
  assert.equal(edited.id,v.id);assert.equal(edited.sku,v.sku);assert.equal(edited.version,v.version+1);
  await assert.rejects(f.inventory.updateVariant(v.id,{expectedVersion:v.version,label:'stale'},actor),code('NATIVE_VARIANT_VERSION'));
  for(const forbidden of [{sku:'RESET'},{productId:elsewhere.productId},{onHand:999},{id:'replacement'}])
    await assert.rejects(f.inventory.updateVariant(v.id,{expectedVersion:edited.version,...forbidden},actor),code('NATIVE_VARIANT_IDENTITY'));
  assert.equal((await f.inventory.list({brandId:f.brand.id})).length,3);
  assert.equal((await f.inventory.list({brandId:'unrelated-brand'})).length,0);
});

test('stock adjustments are atomic, durable exact-payload operations and cannot consume reserved stock',async t=>{
  const f=await fixture(t),v=await f.variant(),first=await f.stock(v,10);
  const input=f.reserve('checkout_reserved_units',v,6);await f.inventory.reserve(input);
  await assert.rejects(f.inventory.adjust({variantId:v.id,delta:-5,operationId:'stock_below_reserved',reason:'Synthetic correction'},actor),code('NATIVE_STOCK_RESERVED'));
  let current=await f.inventory.get(v.id);assert.equal(current.onHand,10);assert.equal(current.reserved,6);
  current=await f.inventory.adjust({variantId:v.id,delta:-4,operationId:'stock_exact_reserved',reason:'Synthetic correction'},actor);
  assert.equal(current.onHand,6);assert.equal(current.available,0);
  const replay=await f.stock(v,10);
  assert.equal(replay.id,first.id);assert.equal(replay.onHand,10,'idempotency returns the original audit receipt');assert.equal(replay.replayed,true);
  assert.equal((await f.inventory.get(v.id)).onHand,6,'the replay never adjusts the counter again');
  await assert.rejects(f.stock(v,11),code('NATIVE_INVENTORY_IDEMPOTENCY'));
  await assert.rejects(f.inventory.adjust({variantId:v.id,delta:1_000_000,operationId:'stock_overflow_count',reason:'Synthetic correction'},actor),code('NATIVE_STOCK_RANGE'));
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM commerce_native_stock_movements WHERE operation_id='manual:fixture_stock_001'")).rows[0].n,1);
  f.configs.set(f.brand.id,{...f.config,inventoryAuthority:'external'});
  await f.inventory.release(input.checkoutId);
  assert.equal((await f.inventory.get(v.id)).reserved,0,'closed native authority must not strand releasable holds');
});

test('last-unit reservation races and duplicate/reordered payloads never oversell or reserve twice',async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,1);
  const first=f.reserve('checkout_last_unit_a',v),second=f.reserve('checkout_last_unit_b',v);
  const race=await Promise.allSettled([f.inventory.reserve(first),f.inventory.reserve(second)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.code,'NATIVE_STOCK_UNAVAILABLE');
  const winning=race.findIndex(r=>r.status==='fulfilled')===0?first:second;
  const replay=await f.inventory.reserve(winning);assert.equal(replay.replayed,true);assert.equal(replay.items[0].qty,1);
  assert.equal((await f.inventory.get(v.id)).reserved,1);
  await assert.rejects(f.inventory.reserve({...winning,items:[{variantId:v.id,qty:2}]}),code('NATIVE_RESERVATION_IDEMPOTENCY'));
  await assert.rejects(f.inventory.reserve({...winning,expiresAt:new Date(f.clock().getTime()+1_000).toISOString()}),code('NATIVE_RESERVATION_IDEMPOTENCY'));
  await assert.rejects(f.inventory.reserve({...f.reserve('duplicate_line_ids',v),items:[{variantId:v.id,qty:1},{variantId:v.id,qty:1}]}),code('NATIVE_INVENTORY_INPUT'));
  const empty=await f.variant();
  await f.inventory.release(winning.checkoutId);
  await assert.rejects(f.inventory.reserve({checkoutId:'multi_item_rollback',expiresAt:f.expiry(),items:[{variantId:v.id,qty:1},{variantId:empty.id,qty:1}]}),code('NATIVE_STOCK_UNAVAILABLE'));
  assert.equal((await f.inventory.get(v.id)).reserved,0);assert.equal((await f.inventory.get(empty.id)).reserved,0);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM commerce_native_reservations WHERE checkout_id='multi_item_rollback'")).rows[0].n,0);
});

test('commit, explicit release and expiry preserve exact counters and committed reservations never expire',async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,5);
  const committed=f.reserve('checkout_committed',v,2),released=f.reserve('checkout_released',v),expired=f.reserve('checkout_expired',v);
  await f.inventory.reserve(committed);assert.equal((await f.inventory.commit(committed.checkoutId)).state,'committed');
  assert.equal((await f.inventory.commit(committed.checkoutId)).replayed,true);
  await assert.rejects(f.inventory.release(committed.checkoutId),code('NATIVE_RESERVATION_CLOSED'));
  await f.inventory.reserve(released);assert.equal((await f.inventory.release(released.checkoutId)).state,'released');
  assert.equal((await f.inventory.release(released.checkoutId)).replayed,true);
  await assert.rejects(f.inventory.reserve(released),code('NATIVE_RESERVATION_CLOSED'));
  await f.inventory.reserve(expired);f.advance(900_000);
  await assert.rejects(f.inventory.commit(expired.checkoutId),code('NATIVE_RESERVATION_EXPIRED'));
  assert.equal((await f.inventory.get(v.id)).reserved,1);
  assert.deepEqual(await f.inventory.expire(),{count:1,expired:[expired.checkoutId],batchFull:false});
  assert.equal((await f.inventory.release(expired.checkoutId)).state,'expired');
  assert.equal((await f.inventory.get(v.id)).onHand,3);assert.equal((await f.inventory.get(v.id)).reserved,0);
  await assert.rejects(f.inventory.reserve(expired),code('NATIVE_RESERVATION_CLOSED'));
  assert.equal((await f.inventory.expire()).count,0);
});

test('caller transactions reserve/commit together without nesting and roll back snapshots, counters and audit together',{timeout:30_000},async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,4);
  await assert.rejects(f.db.transaction(async tx=>{
    await f.inventory.reserve(f.reserve('outer_rollback_checkout',v,2),tx);
    await f.inventory.commit('outer_rollback_checkout',tx);
    throw new Error('Synthetic outer rollback');
  }),/Synthetic outer rollback/);
  assert.equal((await f.inventory.get(v.id)).onHand,4);assert.equal((await f.inventory.get(v.id)).reserved,0);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM commerce_native_stock_movements WHERE checkout_id='outer_rollback_checkout'")).rows[0].n,0);
  await f.db.transaction(async tx=>{
    const input=f.reserve('outer_commit_checkout',v,2),held=await f.inventory.reserve(input,tx);
    assert.equal(held.items[0].unitCostCents,40);
    assert.equal((await f.inventory.get(v.id,tx)).reserved,2);
    assert.equal((await f.inventory.list({brandId:f.brand.id},tx)).length,1);
    await f.inventory.commit(input.checkoutId,tx);
    assert.equal((await f.inventory.expire(tx)).count,0);
  });
  assert.equal((await f.inventory.get(v.id)).onHand,2);assert.equal((await f.inventory.get(v.id)).reserved,0);
});

test('reservation item price/cost snapshots survive commercial edits and source policy changes fail commit closed',async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,3);
  const input=f.reserve('checkout_frozen_values',v,2),hold=await f.inventory.reserve(input);
  const current=await f.inventory.get(v.id);
  await f.inventory.updateVariant(v.id,{expectedVersion:current.version,unitPriceCents:555,unitCostCents:333,label:'Updated label'},actor);
  const replay=await f.inventory.reserve(input);assert.deepEqual(replay.items,hold.items);
  assert.equal(replay.items[0].unitPriceCents,125);assert.equal(replay.items[0].unitCostCents,40);assert.equal(replay.items[0].label,'Default');
  f.configs.set(f.brand.id,{...f.config,model:'partner'});
  await assert.rejects(f.inventory.commit(input.checkoutId),code('NATIVE_INVENTORY_POLICY'));
  assert.equal((await f.inventory.get(v.id)).onHand,3);assert.equal((await f.inventory.get(v.id)).reserved,2);
  f.configs.set(f.brand.id,f.config);
  const done=await f.inventory.commit(input.checkoutId);assert.deepEqual(done.items,hold.items);
  assert.equal((await f.inventory.get(v.id)).unitPriceCents,555);
});

test('physical returns restock only by explicit inspection operation, exactly once, never by reservation release',async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,3);
  const input=f.reserve('checkout_inspected_return',v,2);await f.inventory.reserve(input);await f.inventory.commit(input.checkoutId);
  assert.equal((await f.inventory.get(v.id)).onHand,1);
  await assert.rejects(f.inventory.restock({variantId:v.id,qty:1,operationId:'return_without_proof',reason:'Inspection completed'},actor),code('NATIVE_INVENTORY_INPUT'));
  const inspect={variantId:v.id,qty:1,operationId:'return_inspection_once',reason:'Synthetic item inspected and accepted into stock.',inspectionId:'inspection_fixture_001'};
  const result=await f.inventory.restock(inspect,actor);assert.equal(result.onHand,2);
  assert.equal((await f.inventory.restock(inspect,actor)).replayed,true);assert.equal((await f.inventory.get(v.id)).onHand,2);
  await assert.rejects(f.inventory.restock({...inspect,operationId:'same_inspection_new_op'},actor),code('NATIVE_RETURN_INSPECTION_USED'));
  assert.equal((await f.inventory.get(v.id)).onHand,2);
  await assert.rejects(f.inventory.restock({...inspect,inspectionId:'other_inspection'},actor),code('NATIVE_INVENTORY_IDEMPOTENCY'));
  await assert.rejects(f.inventory.restock({...inspect,operationId:'negative_return_qty',qty:-1},actor),code('NATIVE_INVENTORY_INPUT'));
  const movement=(await f.db.query("SELECT kind,inspection_id,delta_on_hand FROM commerce_native_stock_movements WHERE operation_id='manual:return_inspection_once'")).rows[0];
  assert.deepEqual(movement,{kind:'restock',inspection_id:'inspection_fixture_001',delta_on_hand:1});
});

test('concurrent stock operation replays and commit/release races never apply two physical changes',async t=>{
  const f=await fixture(t),v=await f.variant();
  const same=await Promise.all([f.stock(v,5),f.stock(v,5),f.stock(v,5)]);
  assert.equal(same.filter(r=>!r.replayed).length,1);assert.equal((await f.inventory.get(v.id)).onHand,5);
  await Promise.all(Array.from({length:4},(_,i)=>f.stock(v,1,`different_operation_${i}`)));
  assert.equal((await f.inventory.get(v.id)).onHand,9);
  const input=f.reserve('commit_release_race',v,2);await f.inventory.reserve(input);
  const result=await Promise.allSettled([f.inventory.commit(input.checkoutId),f.inventory.release(input.checkoutId)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.code,'NATIVE_RESERVATION_CLOSED');
  assert.equal((await f.inventory.get(v.id)).reserved,0);
  assert.equal((await f.inventory.get(v.id)).onHand,result[0].status==='fulfilled'?7:9);
});

test('expiry is rechecked after a delayed stock lock, rolling back reserve/commit and movement evidence together',async t=>{
  const f=await fixture(t),v=await f.variant();await f.stock(v,3);
  let delay=false;
  const db={query:f.db.query,transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,args)=>{
    const result=await tx.query(sql,args);
    if(delay&&sql==='SELECT * FROM commerce_native_variants WHERE id=$1 FOR UPDATE'){delay=false;f.advance(900_000);}
    return result;
  }}))};
  const inventory=await createNativeInventory(db,{clock:f.clock,policies:f.policies});
  delay=true;
  await assert.rejects(inventory.reserve(f.reserve('slow_stock_reserve',v)),code('NATIVE_RESERVATION_EXPIRED'));
  assert.equal((await f.inventory.get(v.id)).reserved,0);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM commerce_native_reservations WHERE checkout_id='slow_stock_reserve'")).rows[0].n,0);
  const input=f.reserve('slow_stock_commit',v);await f.inventory.reserve(input);delay=true;
  await assert.rejects(inventory.commit(input.checkoutId),code('NATIVE_RESERVATION_EXPIRED'));
  assert.equal((await f.inventory.get(v.id)).onHand,3);assert.equal((await f.inventory.get(v.id)).reserved,1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM commerce_native_stock_movements WHERE checkout_id='slow_stock_commit' AND kind='committed'")).rows[0].n,0);
  assert.equal((await inventory.expire()).count,1);
});

test('return restock accepts an existing inspection transaction and rolls back without nested work',async t=>{
  const f=await fixture(t),v=await f.variant();
  const input={variantId:v.id,qty:1,operationId:'atomic_return_inspection',inspectionId:'inspection_atomic_001',reason:'Synthetic physically inspected return.'};
  await assert.rejects(f.db.transaction(async tx=>{await f.inventory.restock(input,actor,tx);throw new Error('Inspection rollback');}),/Inspection rollback/);
  assert.equal((await f.inventory.get(v.id)).onHand,0);
  await f.db.transaction(async tx=>{
    assert.equal((await f.inventory.restock(input,actor,tx)).onHand,1);
    assert.equal((await f.inventory.restock(input,actor,tx)).replayed,true);
  });
  assert.equal((await f.inventory.get(v.id)).onHand,1);
});
