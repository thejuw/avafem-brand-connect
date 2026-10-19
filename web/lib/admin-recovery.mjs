export const RECOVERY_SECTIONS=[
  {id:'connectors',label:'Connector orders'}, {id:'subscriptions',label:'Renewals'},
  {id:'disputes',label:'Lost disputes'}, {id:'holds',label:'Payout holds'},
  {id:'credits',label:'Pending credits'}, {id:'history',label:'Financial audit'}, {id:'maintenance',label:'Health migration'},
];
export const recoveryId=(kind,row)=>({connectors:row?.bagId,subscriptions:row?.subscriptionId,holds:row?.transferId,disputes:row?.id,credits:row?.id})[kind] || '';
export function recoveryActions(kind,row) {
  if (!row) return [];
  if(kind==='connectors') return row.state==='connector_retry_authorized'
    ? [{id:'retry',label:'Use the one authorized retry'}] : [{id:'confirm',label:'Confirm an existing remote order'},{id:'void',label:'Verify an already-cancelled remote order'}];
  if(kind==='subscriptions') return [
    ...(row.pendingActions || []).map(p=>({id:`continue:${p.operationId}`,label:`Continue saved ${p.action} · ${p.operationId}`,pending:p})),
    ...(row.attempts || []).flatMap(a=>(a.allowedActions || []).map(action=>({id:`${action}:${a.id}`,label:`${action.replace('reconcile_','Reconcile ')} · cycle ${a.cycle}, attempt ${a.attempt}`,attempt:a}))),
    ...(row.allowedActions || []).map(action=>({id:action,label:action==='resume'?'Resume future renewals (no immediate charge)':'Cancel future renewals (does not resolve money)'})),
  ];
  if(kind==='disputes') return row.recoveryResolution ? [] : [{id:'operator_verified_recovery',label:'Record operator recovery evidence (not a payout)'},{id:'writeoff',label:'Waive the whole Bag payable (noncash)'}];
  if(kind==='holds') return [{id:'release',label:'Release payout hold after all gates pass'}];
  if(kind==='credits') return [{id:'release',label:'Release earned credit after all gates pass'},{id:'writeoff',label:'Write off this pending credit (noncash)'}];
  return [];
}
const requireText=(value,label,min=1,max=1000)=>{
  const text=typeof value==='string'?value.trim():'';
  if(text.length<min || text.length>max) throw new Error(`${label} must contain ${min}–${max} characters.`);
  return text;
};
export function buildRecoveryRequest({kind,row,actionId,reason,operationId,externalId,recoveryReference,acknowledged=false,observedAt=new Date().toISOString()}) {
  const action=recoveryActions(kind,row).find(a=>a.id===actionId);
  if(!action) throw new Error('Choose a currently permitted recovery action.');
  if(!acknowledged) throw new Error('Review and acknowledge this action before submitting.');
  if(action.pending) return {path:`/api/admin/recovery/subscriptions/${encodeURIComponent(row.subscriptionId)}/continue`,body:{operationId:action.pending.operationId}};
  const key=requireText(operationId,'Operation ID',8,100);
  if(!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid operation ID.');
  const body={operationId:key,reason:requireText(reason,'Operator reason',10)};
  const id=encodeURIComponent(recoveryId(kind,row));
  if(!id) throw new Error('Select a recovery record.');
  if(kind==='connectors') {
    if(actionId==='retry') return {path:`/api/admin/recovery/connectors/${id}/retry`,body};
    const remote=requireText(externalId,'Remote order ID',1,30);
    if(!/^[1-9][0-9]*$/.test(remote)) throw new Error('Remote order ID must be a positive numeric identifier.');
    return {path:`/api/admin/recovery/connectors/${id}/resolve`,body:{...body,action:actionId,externalId:remote}};
  }
  if(kind==='subscriptions') {
    if(!action.attempt) return {path:`/api/admin/recovery/subscriptions/${id}/${actionId}`,body};
    const resolution=actionId.split(':')[0].replace('reconcile_',''),attempt=action.attempt;
    Object.assign(body,{attemptId:attempt.id,resolution});
    if(resolution!=='paid') {
      const requirements=attempt.proofRequirements || {};
      const reference=requireText(recoveryReference,'Mock review reference',18,110);
      if(!/^mockproof_[A-Za-z0-9_-]{8,100}$/.test(reference)) throw new Error('Use mockproof_ followed by 8–100 letters, digits, underscores or hyphens.');
      body.proof={source:'operator_mock_review',reference,observedAt,attemptKey:requirements.attemptKey,requestFingerprint:requirements.requestFingerprint,
        chargeRef:requirements.chargeRef ?? null,acknowledgement:resolution==='declined'?'I_VERIFIED_THIS_SIMULATED_ATTEMPT_IS_DECLINED':'I_VERIFIED_THIS_SIMULATED_CHARGE_IS_VOIDED'};
    }
    return {path:`/api/admin/recovery/subscriptions/${id}/reconcile`,body};
  }
  if(kind==='disputes') return {path:`/api/admin/recovery/disputes/${id}/resolve`,body:{...body,resolution:actionId,
    ...(actionId==='operator_verified_recovery'?{recoveryReference:requireText(recoveryReference,'Recovery reference',1,120)}:{})}};
  if(kind==='holds') return {path:`/api/admin/recovery/holds/${id}/release`,body};
  return {path:`/api/admin/recovery/credits/${id}/resolve`,body:{...body,action:actionId}};
}

export function safeRecoveryResult(result) {
  // Render only operator-safe decision fields, never nested provider evidence,
  // encrypted snapshots, address fields or echoed request/credential objects.
  const safe=Object.fromEntries(['status','replayed','operationId','resolutionId','bagId','subscriptionId','transferId','creditId','recoveryResolution',
    'blockedReason','requiresReview','paymentResolved','cashRecoveredCents','payableWrittenOffCents','providerWrites','proofSource','scope','eligibleAt'].filter(k=>result?.[k]!==undefined).map(k=>[k,result[k]]));
  if(typeof result?.error?.code==='string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.error.code)) safe.errorCode=result.error.code;
  if(typeof result?.externalId==='string' && /^[1-9][0-9]{0,29}$/.test(result.externalId)) {
    safe.externalId=result.externalId;if(!safe.status) safe.status='confirmed_remote_receipt';
  }
  if(['woocommerce','bigcommerce'].includes(result?.platform)) safe.platform=result.platform;
  return safe;
}
export function recoveryAcknowledgement(actionId) {
  if(actionId.startsWith('reconcile_declined:')) return 'I verified that this exact simulated attempt was declined and no payment exists. I_VERIFIED_THIS_SIMULATED_ATTEMPT_IS_DECLINED';
  if(actionId.startsWith('reconcile_voided:')) return 'I verified that this exact simulated charge is voided, and any corresponding order is fully refunded. I_VERIFIED_THIS_SIMULATED_CHARGE_IS_VOIDED';
  if(actionId.startsWith('continue:')) return 'Continue this saved action using its original operation ID, recorded operator reason and encrypted evidence. Do not create a new payment or charge.';
  return 'I reviewed the selected record and evidence. Writeoffs are noncash adjustments, not shopper refunds or recovered money. Any connector retry is limited to an isolated test store.';
}
