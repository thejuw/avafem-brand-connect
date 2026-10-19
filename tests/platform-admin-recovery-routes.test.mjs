import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {buildRecoveryRequest} from '../web/lib/admin-recovery.mjs';

const reason='Synthetic owner reviewed this exact recovery outcome';
test('recovery reads/mutations require the owner browser workspace and CSRF; actor cannot be spoofed',{timeout:60_000},async t=>{
  const f=await platformFixture(t),key=await f.credential('brand_bloom',['catalog:write','orders:read','payouts:read']);
  const paths=['/api/admin/recovery','/api/admin/recovery/connectors','/api/admin/recovery/subscriptions','/api/admin/recovery/credits','/api/admin/recovery/history','/api/admin/recovery/health-outbox'];
  for(const url of paths){
    assert.ok([401,403].includes((await f.request({method:'GET',url})).statusCode));
    assert.equal((await f.bearer(key,{method:'GET',url})).statusCode,403);
    assert.equal((await f.owner({method:'GET',url})).statusCode,200);
  }
  const data=await f.ok(f.owner({method:'GET',url:'/api/admin/recovery'}));
  assert.ok(['connectors','subscriptions','holds','disputes','credits','history'].every(k=>Array.isArray(data[k])));
  const mutation={method:'POST',url:'/api/admin/recovery/health-outbox/migrate',payload:{batchSize:10}};
  assert.equal((await f.owner({...mutation,headers:{'x-csrf-token':'wrong'}})).statusCode,403);
  assert.equal((await f.bearer(key,mutation)).statusCode,403);
  assert.equal((await f.owner({...mutation,payload:{batchSize:501}})).statusCode,422);
  assert.equal((await f.owner(mutation)).statusCode,200);
  const bag=await f.bagFor(await f.seedOrder(),'brand_hearth'),d=await f.platform.console.openDispute({externalId:'dp_http_actor',bagId:bag.id});
  await f.platform.console.resolveDispute(d.id,'lost');
  const result=await f.ok(f.owner({method:'POST',url:`/api/admin/recovery/disputes/${d.id}/resolve`,payload:{operationId:'actor-recovery-0001',reason,resolution:'operator_verified_recovery',recoveryReference:'mock_recovery_http_001',actor:'forged_actor'}}));
  assert.equal(result.cashRecoveredCents,0);
  const row=(await f.db.query('SELECT actor,reason_enc FROM financial_resolutions WHERE id=$1',[result.resolutionId])).rows[0];
  assert.equal(row.actor,'owner');assert.ok(!row.reason_enc.includes(reason));
  let continued;
  f.platform.subscriptions.continueReview=async input=>{continued=input;return {status:'review',operationId:input.operationId};};
  const continuation={method:'POST',url:'/api/admin/recovery/subscriptions/sub_synthetic/continue',payload:{operationId:'saved-review-action-001',actor:'forged_actor',reason:'Do not replace stored reason'}};
  assert.equal((await f.bearer(key,continuation)).statusCode,403);
  assert.equal((await f.owner({...continuation,headers:{'x-csrf-token':'wrong'}})).statusCode,403);
  assert.equal((await f.owner(continuation)).statusCode,200);
  assert.deepEqual(continued,{operationId:'saved-review-action-001',subscriptionId:'sub_synthetic',actor:'owner'});
});

test('connector retry HTTP requires a verified grant and idempotently caches the same explicit operation',{timeout:60_000},async t=>{
  const f=await platformFixture(t),bag=await f.bagFor(await f.seedOrder(),'brand_bloom');
  const url=`/api/admin/recovery/connectors/${bag.id}/retry`,payload={operationId:'no-grant-operation-01',reason};
  assert.equal((await f.owner({method:'POST',url,payload})).statusCode,409);
  let calls=0;
  f.platform.brands.listRecovery=async()=>[{bagId:bag.id,state:'connector_retry_authorized'}];
  f.platform.brands.pushOrder=async()=>{calls++;return {bagId:bag.id,externalId:'12345'};};
  const allowed={...payload,operationId:'verified-grant-operation-01'};
  const first=await f.owner({method:'POST',url,payload:allowed}),again=await f.owner({method:'POST',url,payload:allowed});
  assert.equal(first.statusCode,200,first.body);assert.equal(again.statusCode,200,again.body);assert.equal(calls,1);
  assert.equal(again.headers['idempotent-replayed'],'true');
  assert.equal((await f.owner({method:'POST',url,payload:{...allowed,reason:`${reason} changed`}})).statusCode,422);
  assert.equal(calls,1);
});

test('new subscription UI payloads reconcile exact mock evidence and resume/cancel without charging',{timeout:60_000},async t=>{
  const f=await platformFixture(t),s=await f.platform.crm.upsertShopper({email:'http-renewal@example.invalid'});
  let charges=0;f.platform.subscriptions.charge=async()=>{charges++;throw new Error('Synthetic unknown charge outcome');};
  const sub=await f.platform.subscriptions.create(s.id,{items:[{brandId:'brand_bloom',sku:'BLOOM-COTTON-16'}],shipTo:{name:'Synthetic',line1:'1 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'}});
  await f.platform.subscriptions.runDue();assert.equal(charges,1);
  const [row]=await f.ok(f.owner({method:'GET',url:`/api/admin/recovery/subscriptions?subscriptionId=${sub.id}`}));
  const attempt=row.attempts[0];
  const call=buildRecoveryRequest({kind:'subscriptions',row,actionId:`reconcile_declined:${attempt.id}`,operationId:'ui-declined-operation-01',reason,
    recoveryReference:'mockproof_http_declined_001',acknowledged:true,observedAt:f.clock().toISOString()});
  const result=await f.ok(f.owner({method:'POST',url:call.path,payload:call.body}));assert.equal(result.status,'resolved_declined');
  const resumed=await f.ok(f.owner({method:'POST',url:`/api/admin/recovery/subscriptions/${sub.id}/resume`,payload:{operationId:'ui-resume-operation-01',reason}}));
  assert.equal(resumed.status,'active');assert.equal(charges,1);assert.deepEqual(await f.platform.subscriptions.runDue(),[]);
  const cancelled=await f.ok(f.owner({method:'POST',url:`/api/admin/recovery/subscriptions/${sub.id}/cancel`,payload:{operationId:'ui-cancel-operation-01',reason}}));
  assert.equal(cancelled.status,'cancelled');assert.equal(charges,1);
});

test('an operator noncash payable waiver does not deny or double-book a later shopper refund',{timeout:60_000},async t=>{
  const f=await platformFixture(t),s=await f.platform.crm.upsertShopper({email:'writeoff-refund@example.invalid'}),orderId=await f.seedOrder();
  await f.platform.crm.linkOrder(s.id,orderId);await f.platform.bank.earnForOrder(s.id,orderId);
  const bag=await f.bagFor(orderId,'brand_hearth'),d=await f.platform.console.openDispute({externalId:'dp_writeoff_refund',bagId:bag.id});
  await f.platform.console.resolveDispute(d.id,'lost');
  const waived=await f.ok(f.owner({method:'POST',url:`/api/admin/recovery/disputes/${d.id}/resolve`,payload:{operationId:'http-waiver-0001',reason,resolution:'writeoff'}}));
  assert.equal(waived.shopperRefunded,false);assert.equal(waived.providerWrites,false);
  const refund=await f.domain.requestRefund(bag.id,{reason:'Synthetic shopper return after payable waiver'});
  await f.domain.approveSandboxRefund(refund.id);await f.platform.bank.reverseRefunded(bag.id);
  const balances=(await f.db.query(`SELECT e.account,SUM(e.credit_cents-e.debit_cents)::int AS balance FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 GROUP BY e.account`,[bag.id])).rows;
  assert.equal(balances.find(x=>x.account==='brand_payable').balance,0);
  assert.equal(balances.find(x=>x.account==='sandbox_payable_writeoff_adjustment').balance,0);
  assert.equal((await f.domain.dashboard()).summary.ledgerBalanced,true);assert.equal((await f.platform.bank.liabilityReport()).balanced,true);
  assert.equal((await f.domain.getBag(bag.id)).refundedCents,bag.total_cents);
});
