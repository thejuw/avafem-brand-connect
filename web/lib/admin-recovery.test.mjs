import test from 'node:test';
import assert from 'node:assert/strict';
import {RECOVERY_SECTIONS,recoveryActions,buildRecoveryRequest,safeRecoveryResult,recoveryAcknowledgement} from './admin-recovery.mjs';
const common={reason:'Synthetic operator reviewed this exact recovery',operationId:'recovery-operation-0001',acknowledged:true};
test('connector tools separate read-only confirmation/void proof from one explicit retry',()=>{
  const row={bagId:'bag_one',state:'connector_uncertain'};
  assert.deepEqual(recoveryActions('connectors',row).map(a=>a.id),['confirm','void']);
  const request=buildRecoveryRequest({...common,kind:'connectors',row,actionId:'void',externalId:'1234'});
  assert.equal(request.path,'/api/admin/recovery/connectors/bag_one/resolve');assert.equal(request.body.action,'void');
  assert.throws(()=>buildRecoveryRequest({...common,kind:'connectors',row,actionId:'retry'}),/permitted/);
  const retry=buildRecoveryRequest({...common,kind:'connectors',row:{...row,state:'connector_retry_authorized'},actionId:'retry'});
  assert.equal(retry.path,'/api/admin/recovery/connectors/bag_one/retry');assert.equal(retry.body.operationId,common.operationId);
});
test('renewal actions honor server permissions and bind attestation to exact immutable attempt metadata',()=>{
  const attempt={id:'attempt_1',cycle:1,attempt:1,allowedActions:['reconcile_voided'],proofRequirements:{attemptKey:'sub:sub1:1:attempt:1',requestFingerprint:'a'.repeat(64),chargeRef:null}};
  const row={subscriptionId:'sub1',allowedActions:['cancel'],attempts:[attempt]};
  assert.throws(()=>buildRecoveryRequest({...common,kind:'subscriptions',row,actionId:'resume'}),/permitted/);
  const call=buildRecoveryRequest({...common,kind:'subscriptions',row,actionId:'reconcile_voided:attempt_1',recoveryReference:'mockproof_review1234',observedAt:'2026-10-19T12:00:00Z'});
  assert.equal(call.body.proof.attemptKey,attempt.proofRequirements.attemptKey);assert.equal(call.body.proof.source,'operator_mock_review');
  assert.equal(call.body.proof.acknowledgement,'I_VERIFIED_THIS_SIMULATED_CHARGE_IS_VOIDED');assert.equal(call.body.attemptId,attempt.id);
  assert.ok(recoveryAcknowledgement('reconcile_voided:attempt_1').includes(call.body.proof.acknowledgement),'the strong attestation is visible before consent');
  assert.ok(!JSON.stringify(call).includes('charge:true'));
});
test('financial decisions require reason/acknowledgement and never expose a second decision for resolved disputes',()=>{
  const row={id:'dp1',recoveryResolution:'writeoff'};assert.deepEqual(recoveryActions('disputes',row),[]);
  assert.throws(()=>buildRecoveryRequest({...common,kind:'holds',row:{transferId:'tr1'},actionId:'release',acknowledged:false}),/acknowledge/);
  assert.throws(()=>buildRecoveryRequest({...common,kind:'holds',row:{transferId:'tr1'},actionId:'release',reason:'short'}),/reason/);
  const call=buildRecoveryRequest({...common,kind:'credits',row:{id:'lot1'},actionId:'writeoff'});assert.equal(call.body.action,'writeoff');
  assert.equal(call.path,'/api/admin/recovery/credits/lot1/resolve');
});
test('operator result renderer allowlists decisions, not nested evidence, credentials or shopper details',()=>{
  const result=safeRecoveryResult({status:'blocked',blockedReason:'MISMATCH',proof:{address:'PRIVATE'},snapshotEnc:'SECRET',token:'SECRET',shipTo:'PRIVATE',providerWrites:0});
  assert.deepEqual(result,{status:'blocked',blockedReason:'MISMATCH',providerWrites:0});
  assert.deepEqual(safeRecoveryResult({status:'review',error:{code:'QUOTE_CHANGED',message:'PRIVATE'}}),{status:'review',errorCode:'QUOTE_CHANGED'});
  assert.deepEqual(safeRecoveryResult({externalId:'9001',platform:'woocommerce'}),{externalId:'9001',status:'confirmed_remote_receipt',platform:'woocommerce'});
  assert.equal(new Set(RECOVERY_SECTIONS.map(s=>s.id)).size,RECOVERY_SECTIONS.length);
});
test('pending renewal actions survive reload using the original server-owned operation, not a new guessed payload',()=>{
  const row={subscriptionId:'sub1',allowedActions:['cancel'],pendingActions:[{operationId:'original-operation-1',action:'reconcile_paid',actor:'owner'}]};
  const call=buildRecoveryRequest({kind:'subscriptions',row,actionId:'continue:original-operation-1',operationId:'different-new-operation',acknowledged:true});
  assert.equal(call.path,'/api/admin/recovery/subscriptions/sub1/continue');assert.deepEqual(call.body,{operationId:'original-operation-1'});
  assert.throws(()=>buildRecoveryRequest({kind:'subscriptions',row,actionId:'continue:original-operation-1',acknowledged:false}),/acknowledge/);
});
