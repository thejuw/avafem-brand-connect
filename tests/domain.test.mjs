import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createDomain } from '../server/domain.mjs';
import { seedDatabase } from '../server/seed.mjs';

async function fixture(t) {
  const db=await createDatabase({connectionString:null}); await db.migrate();
  t.after(()=>db.close());
  let instant=new Date('2026-10-18T12:00:00.000Z');
  const domain=createDomain(db,{clock:()=>instant});
  await seedDatabase(db,domain);
  return {db,domain,clock:()=>instant,advance:days=>{instant=new Date(instant.getTime()+days*86_400_000);}};
}
const balanced = async domain => {
  const entries=await domain.listLedger();
  const grouped=Map.groupBy(entries,entry=>entry.journalId);
  for (const [journal,lines] of grouped) assert.equal(lines.reduce((sum,line)=>sum+line.debitCents-line.creditCents,0),0,journal);
  assert.ok((await domain.dashboard()).summary.ledgerBalanced);
};

test('sandbox fixture is idempotent, integer-cent sample math and balanced journals',async t=>{
  const {db,domain}=await fixture(t);
  await seedDatabase(db,domain);
  assert.equal((await domain.listBrands()).length,3);
  const bags=await domain.listBags();
  assert.equal(bags.length,3);
  assert.equal(bags.reduce((sum,bag)=>sum+bag.totalCents,0),10629);
  assert.equal(bags.reduce((sum,bag)=>sum+bag.transferCents,0),8563);
  assert.deepEqual(bags.map(bag=>bag.transferCents).sort((a,b)=>a-b),[2552,2791,3220]);
  assert.equal((await domain.listCredits()).reduce((sum,c)=>sum+c.amountCents,0),445);
  assert.ok((await domain.listEvents()).every(event=>event.sandbox===true));
  await balanced(domain);
});

test('brand scope denies cross-brand records and strips private shopper fields',async t=>{
  const {domain}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_bloom'}))[0];
  await assert.rejects(domain.getBag(bag.id,'brand_lunelle'),error=>error.statusCode===404);
  await assert.rejects(domain.recordShipment(bag.id,{carrier:'USPS',trackingNumber:'x'},'brand_lunelle'),error=>error.statusCode===404);
  await assert.rejects(domain.requestRefund(bag.id,{reason:'other tenant'},'brand_lunelle'),error=>error.statusCode===404);
  const product=(await domain.listProducts({brandId:'brand_bloom'}))[0];
  await assert.rejects(domain.reviewProduct(product.id,{status:'rejected'},'brand_lunelle'),error=>error.statusCode===404);
  const order=await domain.createSandboxOrder({items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16',qty:1}],customerEmail:'private@example.com',healthNotes:'private health information',
    shipTo:{name:'Test Shopper',line1:'1 Test Lane',city:'Austin',region:'TX',postal:'78701',country:'US',email:'private@example.com',cycleDay:12,healthNotes:'private'}});
  const event=(await domain.listEvents()).find(event=>event.type==='bag.created' && event.aggregateId===order.bags[0].id);
  assert.equal(order.bags[0].shipTo.email,undefined);
  assert.equal(order.bags[0].shipTo.cycleDay,undefined);
  assert.ok(!JSON.stringify(event.payload).includes('private'));
  assert.ok(!JSON.stringify(order.bags[0]).includes('private@example.com'));
});

test('approved claim edits reset review while price and stock edits retain approval',async t=>{
  const {domain}=await fixture(t);
  let product=(await domain.listProducts({brandId:'brand_bloom'})).find(p=>p.sku==='BLOOM-COTTON-16');
  product=await domain.upsertProduct(product.brandId,product.sku,{priceCents:3500,inventoryQty:55});
  assert.equal(product.status,'approved');
  product=await domain.upsertProduct(product.brandId,product.sku,{evidence:{...product.evidence,claims:[{text:'A claim requiring review',source_url:'https://example.com/evidence',type:'health'}]}});
  assert.equal(product.status,'in_review');
  await assert.rejects(domain.createSandboxOrder({items:[{brandId:product.brandId,sku:product.sku,qty:1}],shipTo:{name:'A',line1:'B',city:'C',region:'TX',postal:'78701',country:'US'}}),error=>error.code==='PRODUCT_UNAVAILABLE');
  product=await domain.reviewProduct(product.id,{status:'approved',note:'Sandbox human approval'});
  assert.equal(product.status,'approved');
  const draft=(await domain.listProducts()).find(p=>p.sku==='HEARTH-TEA-20');
  await assert.rejects(domain.reviewProduct(draft.id,{status:'approved'}),error=>error.code==='CATALOG_INVALID');
});

test('default payout waits the full thirty-day return window and duplicate workers release once',async t=>{
  const {db,domain,advance}=await fixture(t);
  assert.equal((await domain.runDueSandboxPayouts()).processed,0);
  advance(29);
  assert.equal((await domain.runDueSandboxPayouts()).processed,0);
  advance(1);
  const results=await Promise.all([domain.runDueSandboxPayouts(),domain.runDueSandboxPayouts(),domain.runDueSandboxPayouts()]);
  assert.equal(results.reduce((sum,result)=>sum+result.processed,0),1);
  const transfer=(await domain.listTransfers({brandId:'brand_hearth'}))[0];
  assert.equal(transfer.status,'paid');
  assert.equal((await domain.listCredits({brandId:'brand_hearth'}))[0].status,'released');
  const journals=await db.query("SELECT * FROM ledger_journals WHERE kind='sandbox_payout'");
  assert.equal(journals.rows.length,1);
  await balanced(domain);
});

test('refund proposal holds payout; approval cancels before payout and voids credits',async t=>{
  const {domain,advance}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_hearth'}))[0];
  const proposal=await domain.requestRefund(bag.id,{reason:'Sandbox return requested'},bag.brandId);
  assert.equal(proposal.amountCents,3526);
  assert.equal(proposal.status,'proposed'); assert.equal(proposal.requiresApproval,true);
  assert.equal((await domain.listTransfers({brandId:bag.brandId}))[0].status,'held');
  advance(31); assert.equal((await domain.runDueSandboxPayouts()).processed,0);
  await domain.approveSandboxRefund(proposal.id);
  await domain.approveSandboxRefund(proposal.id);
  assert.equal((await domain.getBag(bag.id)).status,'refunded');
  assert.equal((await domain.listTransfers({brandId:bag.brandId}))[0].status,'cancelled');
  assert.equal((await domain.listCredits({brandId:bag.brandId}))[0].status,'voided');
  await balanced(domain);
});

test('payout racing refund serializes; after payout refund reverses exactly once',async t=>{
  const {db,domain,advance}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_hearth'}))[0];
  advance(31);
  const [,proposal]=await Promise.all([domain.runDueSandboxPayouts(),domain.requestRefund(bag.id,{reason:'Sandbox return after delivery'})]);
  await Promise.all([domain.approveSandboxRefund(proposal.id),domain.approveSandboxRefund(proposal.id),domain.runDueSandboxPayouts()]);
  const transfer=(await domain.listTransfers({brandId:bag.brandId}))[0];
  assert.equal(transfer.status,'reversed'); assert.equal(transfer.reversedCents,2791);
  assert.equal((await domain.listCredits({brandId:bag.brandId}))[0].status,'voided');
  assert.equal((await db.query("SELECT id FROM ledger_journals WHERE kind='sandbox_transfer_reversal'")).rows.length,1);
  assert.equal((await db.query("SELECT id FROM ledger_journals WHERE kind='sandbox_refund'")).rows.length,1);
  await balanced(domain);
});

test('failed checkout rolls back inventory, ledger and outbox atomically',async t=>{
  const {domain}=await fixture(t);
  const before=(await domain.listProducts({brandId:'brand_bloom'})).find(p=>p.sku==='BLOOM-COTTON-16');
  const eventsBefore=(await domain.listEvents()).length;
  await assert.rejects(domain.createSandboxOrder({items:[{brandId:'brand_bloom',sku:before.sku,qty:1},{brandId:'brand_lunelle',sku:'missing',qty:1}],
    shipTo:{name:'A',line1:'B',city:'C',region:'TX',postal:'78701',country:'US'}}));
  const after=await domain.getProduct(before.id);
  assert.equal(after.inventoryQty,before.inventoryQty);
  assert.equal((await domain.listEvents()).length,eventsBefore);
  assert.equal((await domain.listBags()).length,3);
});

test('external order references cannot replay another brand or a different checkout',async t=>{
  const {domain}=await fixture(t);
  const input={externalId:'tenant-retry',items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16',qty:1}],
    shipTo:{name:'A',line1:'B',city:'C',region:'TX',postal:'78701',country:'US'}};
  const original=await domain.createSandboxOrder(input);
  const replay=await domain.createSandboxOrder(input);
  assert.equal(replay.id,original.id);
  await assert.rejects(domain.createSandboxOrder({...input,items:[{brandId:'brand_lunelle',sku:'LUNELLE-CUP',qty:1}]}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(domain.createSandboxOrder({...input,shipTo:{...input.shipTo,line1:'Different address'}}),error=>error.code==='IDEMPOTENCY_CONFLICT');
  assert.equal((await domain.listBags()).length,4);
});

test('local PostgreSQL-compatible database persists to disk across reopen',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'avafem-domain-'));
  let db=await createDatabase({dataDir:join(directory,'data'),connectionString:null});
  t.after(async()=>{ await db.close(); await rm(directory,{recursive:true,force:true}); });
  await db.migrate();
  const brand=await createDomain(db).createBrand({name:'Disk Sandbox Brand',commissionBps:1500});
  await db.close();
  db=await createDatabase({dataDir:join(directory,'data'),connectionString:null});
  await db.migrate();
  assert.equal((await createDomain(db).getBrand(brand.id)).name,'Disk Sandbox Brand');
});

test('custom fourteen-day return windows are snapshotted and cannot be shortened after checkout',async t=>{
  const {domain,advance}=await fixture(t);
  assert.equal((await domain.createBrand({name:'Default Window Brand'})).returnWindowDays,30);
  assert.equal((await domain.createBrand({name:'Custom Window Brand',returnWindowDays:14})).returnWindowDays,14);
  await domain.updateBrand('brand_bloom',{returnWindowDays:14});
  const order=await domain.createSandboxOrder({items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16',qty:1}],
    shipTo:{name:'Window Test',line1:'1 Test Lane',city:'Austin',region:'TX',postal:'78701',country:'US'}});
  const bag=order.bags[0]; assert.equal(bag.returnWindowDays,14);
  await domain.updateBrand('brand_bloom',{returnWindowDays:3});
  await domain.recordShipment(bag.id,{carrier:'USPS',trackingNumber:'FOURTEEN-DAY-WINDOW'});
  const delivered=await domain.markDelivered(bag.id);
  assert.equal(delivered.returnWindowDays,14);
  assert.equal(new Date(delivered.payoutDueAt)-new Date(delivered.deliveredAt),14*86_400_000);
  advance(13); assert.equal((await domain.runDueSandboxPayouts()).processed,0);
  advance(1); assert.equal((await domain.runDueSandboxPayouts()).processed,1);
});

test('later policy increases extend scheduled payouts and later reductions never shorten that hold',async t=>{
  const {domain,advance}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_hearth'}))[0];
  assert.equal(bag.returnWindowDays,30);
  await domain.updateBrand('brand_hearth',{returnWindowDays:45});
  let current=await domain.getBag(bag.id);
  assert.equal(current.returnWindowDays,30,'Checkout snapshot remains immutable.');
  assert.equal(new Date(current.payoutDueAt)-new Date(current.deliveredAt),45*86_400_000);
  await domain.updateBrand('brand_hearth',{returnWindowDays:14});
  current=await domain.getBag(bag.id);
  assert.equal(new Date(current.payoutDueAt)-new Date(current.deliveredAt),45*86_400_000);
  advance(44); assert.equal((await domain.runDueSandboxPayouts()).processed,0);
  advance(1); assert.equal((await domain.runDueSandboxPayouts()).processed,1);
});

test('migration repairs legacy seven-day schedules while preserving any longer promised date',async t=>{
  const {db,domain}=await fixture(t);
  const bag=(await domain.listBags({brandId:'brand_hearth'}))[0];
  const seventh=new Date(new Date(bag.deliveredAt).getTime()+7*86_400_000).toISOString();
  await db.query('UPDATE bags SET payout_due_at=$2 WHERE id=$1',[bag.id,seventh]);
  await db.query('UPDATE transfers SET due_at=$2 WHERE bag_id=$1',[bag.id,seventh]);
  await db.query('UPDATE jobs SET due_at=$2 WHERE bag_id=$1',[bag.id,seventh]);
  await db.migrate();
  let corrected=await domain.getBag(bag.id);
  assert.equal(new Date(corrected.payoutDueAt)-new Date(corrected.deliveredAt),30*86_400_000);
  const promised=new Date(new Date(bag.deliveredAt).getTime()+50*86_400_000).toISOString();
  await db.query('UPDATE transfers SET due_at=$2 WHERE bag_id=$1',[bag.id,promised]);
  await db.migrate();
  corrected=await domain.getBag(bag.id);
  assert.equal(corrected.payoutDueAt,promised); assert.equal(corrected.transfer.dueAt,promised);
  assert.equal((await domain.listJobs({brandId:'brand_hearth'}))[0].dueAt,promised);
  assert.equal(corrected.returnWindowDays,30);
});

test('shipping protection encrypts new rows and backfills legacy rows without leaking address data',async t=>{
  const {db,domain,clock}=await fixture(t);
  const key=randomBytes(32);
  const protectShipping=value=>{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),ciphertext].map(buffer=>buffer.toString('base64url')).join('.');
  };
  const revealShipping=value=>{
    const [iv,tag,ciphertext]=value.split('.').map(part=>Buffer.from(part,'base64url'));
    const decipher=createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
  };
  const protectedDomain=createDomain(db,{clock,protectShipping,revealShipping});
  const backfill=await protectedDomain.encryptExistingShipping();
  assert.equal(backfill.encryptedBags,3); assert.equal(backfill.encryptedEvents,3);
  assert.deepEqual(await protectedDomain.encryptExistingShipping(),{enabled:true,encryptedBags:0,encryptedEvents:0,sandbox:true});
  const original=(await protectedDomain.listBags({brandId:'brand_bloom'}))[0];
  assert.equal(original.shipTo.name,'Alex Sandbox');
  await assert.rejects(domain.getBag(original.id),error=>error.code==='SHIPPING_KEY_REQUIRED');
  const input={externalId:'protected-order',items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16',qty:1}],
    shipTo:{name:'Private Shopper Name',line1:'999 Private Shipping Lane',city:'Austin',region:'TX',postal:'78701',country:'US'}};
  const order=await protectedDomain.createSandboxOrder(input);
  assert.equal(order.bags[0].shipTo.name,'Private Shopper Name');
  assert.equal((await protectedDomain.createSandboxOrder(input)).id,order.id,'Encrypted orders remain safely idempotent.');
  const stored=(await db.query('SELECT ship_to FROM bags WHERE id=$1',[order.bags[0].id])).rows[0].ship_to;
  assert.deepEqual(Object.keys(stored),['encryptedShipping']);
  const rawBags=JSON.stringify((await db.query('SELECT ship_to FROM bags')).rows);
  const rawEvents=JSON.stringify((await db.query('SELECT payload FROM outbox_events')).rows);
  for (const raw of [rawBags,rawEvents]) {
    assert.ok(!raw.includes('Private Shopper Name')); assert.ok(!raw.includes('999 Private Shipping Lane'));
    assert.ok(!raw.includes('Alex Sandbox')); assert.ok(!raw.includes('123 Test Street'));
  }
  const broken=createDomain(db,{clock,protectShipping,revealShipping:()=>{throw new Error('Wrong key');}});
  await assert.rejects(broken.getBag(order.bags[0].id),error=>error.code==='SHIPPING_KEY_REQUIRED');
});
