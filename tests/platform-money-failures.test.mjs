import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';

const shopper = f => f.platform.crm.upsertShopper({email:'money-regression@example.invalid',consent:{email:true}});

test('overlapping credit expiry and refund reversal each book exactly one transition', {timeout:60_000}, async t => {
  const f=await platformFixture(t),s=await shopper(f);
  const lot=await f.platform.bank.grantGoodwill(s.id,{amountCents:100,reason:'Expiry regression'});
  f.advance(366);
  assert.equal((await Promise.all([f.platform.bank.expire(),f.platform.bank.expire()])).reduce((a,b)=>a+b,0),1);
  const expired=(await f.db.query("SELECT * FROM bank_events WHERE lot_id=$1 AND kind='expired'",[lot.id])).rows;
  assert.equal(expired.length,1); assert.equal(expired[0].amount_cents,100);
  let report=await f.platform.bank.liabilityReport();
  assert.equal(report.expiredBreakageCents,100); assert.equal(report.balanced,true);
  const orderId=await f.seedOrder(); await f.platform.crm.linkOrder(s.id,orderId);
  await f.platform.bank.earnForOrder(s.id,orderId);
  const bag=await f.bagFor(orderId,'brand_bloom');
  const refund=await f.domain.requestRefund(bag.id,{reason:'Regression refund'});
  await f.domain.approveSandboxRefund(refund.id);
  assert.equal((await Promise.all([f.platform.bank.reverseRefunded(bag.id),f.platform.bank.reverseRefunded(bag.id)])).reduce((a,b)=>a+b,0),1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM bank_events WHERE kind='reversed' AND ref=$1",[bag.id])).rows[0].n,1);
  report=await f.platform.bank.liabilityReport(); assert.equal(report.balanced,true);
});

test('credit transition rolls back if its accounting event cannot be persisted', {timeout:60_000}, async t => {
  const f=await platformFixture(t),s=await shopper(f);
  const lot=await f.platform.bank.grantGoodwill(s.id,{amountCents:100,reason:'Atomic expiry'});
  f.advance(366);
  const original=f.db.transaction.bind(f.db);
  const mock=t.mock.method(f.db,'transaction',fn=>original(tx=>fn({query:(sql,params)=>{
    if (sql.startsWith('INSERT INTO bank_events')) throw new Error('synthetic event failure');
    return tx.query(sql,params);
  }})));
  await assert.rejects(f.platform.bank.expire(),/synthetic event failure/);
  mock.mock.restore();
  const current=(await f.platform.bank.lots(s.id)).find(l=>l.id===lot.id);
  assert.equal(current.state,'VAULT'); assert.equal(current.remainingCents,100);
  assert.equal(await f.platform.bank.expire(),1);
  assert.equal((await f.platform.bank.liabilityReport()).balanced,true);
});

test('credit maturity honors current and monotonically extended canonical return holds', {timeout:60_000}, async t => {
  const f=await platformFixture(t),s=await shopper(f),orderId=await f.seedOrder();
  await f.platform.crm.linkOrder(s.id,orderId); await f.platform.bank.earnForOrder(s.id,orderId);
  const bag=await f.bagFor(orderId,'brand_hearth');
  await f.domain.updateBrand('brand_hearth',{returnWindowDays:60});
  f.advance(31); assert.equal(await f.platform.bank.mature(),0);
  assert.equal((await f.platform.bank.lots(s.id)).find(l=>l.bagId===bag.id).state,'LAB');
  // Shortening the current policy must not shorten an already-promised hold.
  await f.domain.updateBrand('brand_hearth',{returnWindowDays:30});
  assert.equal(await f.platform.bank.mature(),0);
  f.advance(30); assert.equal(await f.platform.bank.mature(),1);
  assert.equal((await f.platform.bank.liabilityReport()).balanced,true);
});

test('winning a separate dispute and manual release cannot clear a lost-dispute recovery hold', {timeout:60_000}, async t => {
  const f=await platformFixture(t),bag=await f.bagFor(await f.seedOrder(),'brand_hearth');
  const lost=await f.platform.console.openDispute({externalId:'dp_regression_lost',bagId:bag.id});
  await f.platform.console.resolveDispute(lost.id,'lost');
  const other=await f.platform.console.openDispute({externalId:'dp_regression_won',bagId:bag.id});
  await f.platform.console.resolveDispute(other.id,'won');
  const transfer=(await f.db.query('SELECT * FROM transfers WHERE bag_id=$1',[bag.id])).rows[0];
  assert.equal(transfer.status,'held');
  assert.equal((await f.platform.console.holds()).find(h=>h.transferId===transfer.id).lostDisputes,1);
  await assert.rejects(f.platform.console.releaseHold(transfer.id),e=>e.code==='HOLD_BLOCKED');
  f.advance(90); await f.domain.runDueSandboxPayouts();
  assert.equal((await f.db.query('SELECT status FROM transfers WHERE id=$1',[transfer.id])).rows[0].status,'held');
});

test('proposed refunds and dispute recovery keep earned credit pending past the date threshold', {timeout:60_000}, async t => {
  const f=await platformFixture(t),s=await shopper(f),orderId=await f.seedOrder();
  await f.platform.crm.linkOrder(s.id,orderId); await f.platform.bank.earnForOrder(s.id,orderId);
  const bag=await f.bagFor(orderId,'brand_hearth');
  const refund=await f.domain.requestRefund(bag.id,{reason:'Hold earned credit while return is reviewed'});
  f.advance(31); assert.equal(await f.platform.bank.mature(),0);
  // The same protection applies even if some other workflow reschedules the
  // transfer: the unresolved refund itself is authoritative.
  await f.db.query("UPDATE transfers SET status='scheduled' WHERE bag_id=$1",[bag.id]);
  await f.db.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1",[bag.id]);
  assert.equal(await f.platform.bank.mature(),0);
  await f.db.query("UPDATE refunds SET status='rejected' WHERE id=$1",[refund.id]);
  const dispute=await f.platform.console.openDispute({externalId:'dp_credit_recovery',bagId:bag.id});
  await f.platform.console.resolveDispute(dispute.id,'lost');
  assert.equal(await f.platform.bank.mature(),0);
  assert.equal((await f.platform.bank.lots(s.id)).find(l=>l.bagId===bag.id).state,'LAB');
});

const persistPartial = async (f,bag,{known=true}={}) => {
  await f.db.query(`INSERT INTO refunds(id,bag_id,brand_id,amount_cents,reason,status,approved_at,created_at,subtotal_cents,shipping_cents,tax_cents,commission_cents)
    VALUES('refund_report_regression',$1,$2,1083,'Synthetic persisted native allocation','approved',NOW(),NOW(),$3,$4,$5,$6)`,
    [bag.id,bag.brand_id,known?1000:null,known?0:null,known?83:null,known?150:null]);
  await f.db.query('UPDATE bags SET refunded_cents=1083 WHERE id=$1',[bag.id]);
};

test('partial-refund reporting uses exact stored merchandise, shipping, tax and commission allocations', {timeout:60_000}, async t => {
  const f=await platformFixture(t),bag=await f.bagFor(await f.seedOrder(),'brand_bloom');
  const before=(await f.platform.reports.salesTax()).states.find(s=>s.state==='TX');
  await persistPartial(f,bag);
  assert.notEqual((await f.db.query('SELECT status FROM bags WHERE id=$1',[bag.id])).rows[0].status,'refunded');
  const after=(await f.platform.reports.salesTax()).states.find(s=>s.state==='TX');
  assert.equal(after.refundedCents,1083); assert.equal(after.taxRefundedCents,83); assert.equal(after.refundedSalesCents,1000);
  assert.equal(after.refundedShippingCents,0); assert.equal(after.netTaxCents,before.netTaxCents-83);
  assert.equal(after.netSalesCents,before.netSalesCents-1000); assert.equal(after.reconciliationRequired,false);
  const annual=(await f.platform.reports.brandAnnualPayouts(new Date(bag.created_at).getUTCFullYear(),bag.brand_id)).brands[0];
  assert.equal(annual.commissionCents,bag.commission_cents-150); assert.equal(annual.refundAllocationComplete,true);
});

test('legacy partial refunds without exact allocations flag reconciliation instead of publishing wrong net totals', {timeout:60_000}, async t => {
  const f=await platformFixture(t),bag=await f.bagFor(await f.seedOrder(),'brand_bloom');
  await persistPartial(f,bag,{known:false});
  const report=await f.platform.reports.salesTax(),row=report.states.find(s=>s.state==='TX');
  assert.equal(row.reconciliationRequired,true); assert.equal(row.unallocatedRefundCents,1083);
  assert.equal(row.netTaxCents,null); assert.equal(row.netSalesCents,null);
  assert.match(report.csv,/refundAllocationComplete,unallocatedRefundCents,reconciliationRequired/);
  const annual=(await f.platform.reports.brandAnnualPayouts(new Date(bag.created_at).getUTCFullYear(),bag.brand_id)).brands[0];
  assert.equal(annual.commissionCents,null); assert.equal(annual.reconciliationRequired,true);
});

test('canonical quotes are read-only, match creation, and reject price drift without paid side effects', {timeout:60_000}, async t => {
  const f=await platformFixture(t),bag=await f.domain.getBag((await f.bagFor(await f.seedOrder(),'brand_bloom')).id);
  const input={currency:'USD',shipTo:bag.shipTo,items:[{brandId:bag.brandId,sku:bag.items[0].sku,qty:1}]};
  const counts=async()=>({products:(await f.db.query('SELECT inventory_qty,variants FROM products ORDER BY id')).rows,
    orders:(await f.db.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n,
    events:(await f.db.query('SELECT COUNT(*)::int AS n FROM outbox_events')).rows[0].n,
    journals:(await f.db.query('SELECT COUNT(*)::int AS n FROM ledger_journals')).rows[0].n});
  const before=await counts(),quote=await f.domain.quoteSandboxOrder(input);
  assert.deepEqual(await counts(),before);
  await assert.rejects(f.domain.createSandboxOrder({...input,expectedTotalCents:quote.totalCents+1}),e=>e.code==='QUOTE_CHANGED');
  assert.deepEqual(await counts(),before);
  const created=await f.domain.createSandboxOrder({...input,externalId:'quote-regression',expectedTotalCents:quote.totalCents});
  assert.equal(created.totalCents,quote.totalCents);
  assert.equal((await f.domain.createSandboxOrder({...input,externalId:'quote-regression'})).id,created.id);
});
