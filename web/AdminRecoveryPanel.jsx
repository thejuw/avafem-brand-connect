import React,{useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw,ShieldCheck,LoaderCircle} from 'lucide-react';
import {RECOVERY_SECTIONS,recoveryId,recoveryActions,buildRecoveryRequest,safeRecoveryResult,recoveryAcknowledgement} from './lib/admin-recovery.mjs';
import {formatCell} from './lib/platform-panel.mjs';

export default function AdminRecoveryPanel({request}) {
  const [data,setData]=useState(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [kind,setKind]=useState('connectors'),[selected,setSelected]=useState(''),[actionId,setAction]=useState('');
  const [reason,setReason]=useState(''),[externalId,setExternalId]=useState(''),[reference,setReference]=useState(''),[ack,setAck]=useState(false),[result,setResult]=useState(null);
  const operation=useRef(null),sequence=useRef(0),mounted=useRef(true);
  const load=useCallback(async()=>{
    const serial=++sequence.current;setLoading(true);setError('');
    try{const next=await request('/api/admin/recovery');if(mounted.current && serial===sequence.current) setData(next);}
    catch(e){if(mounted.current && serial===sequence.current) setError(e.message);}
    finally{if(mounted.current && serial===sequence.current) setLoading(false);}
  },[request]);
  useEffect(()=>{mounted.current=true;load();return()=>{mounted.current=false;sequence.current++;};},[load]);
  const rows=Array.isArray(data?.[kind])?data[kind]:[];
  const row=rows.find(r=>recoveryId(kind,r)===selected),actions=recoveryActions(kind,row),action=actions.find(a=>a.id===actionId);
  const reset=()=>{setAction('');setReason('');setExternalId('');setReference('');setAck(false);setResult(null);operation.current=null;};
  function edit(setter,value){setter(value);setAck(false);operation.current=null;}
  async function submit(event){
    event.preventDefault();if(busy)return;
    setError('');setBusy(true);
    try{
      if(!operation.current) operation.current={id:crypto.randomUUID(),observedAt:new Date().toISOString()};
      const call=buildRecoveryRequest({kind,row,actionId,reason,externalId,recoveryReference:reference,acknowledged:ack,operationId:operation.current.id,observedAt:operation.current.observedAt});
      const outcome=await request(call.path,{method:'POST',body:call.body});
      setResult(safeRecoveryResult(outcome));operation.current=null;setAck(false);await load();
    }catch(e){setError(e.message); /* Keep the exact operation ID for a same-body retry. */}
    finally{setBusy(false);}
  }
  async function migrate(){
    setBusy(true);setError('');
    try{const outcome=await request('/api/admin/recovery/health-outbox/migrate',{method:'POST',body:{batchSize:500}});setResult(outcome);await load();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <section className="admin-recovery" aria-label="Admin recovery tools">
    <div className="card-heading"><div><span className="eyebrow">Sandbox operations</span><h2><ShieldCheck size={19}/> Recovery desk</h2></div>
      <button className="button small" onClick={load} disabled={loading || busy}>{loading?<LoaderCircle className="spin" size={14}/>:<RefreshCw size={14}/>}Refresh cases</button></div>
    <p className="subtle-note">Resolve stuck states without editing the database. Releases keep delivery, return-window, refund and dispute gates. No action here creates a Stripe payment or bank payout. A separate connector retry creates one remote order; use isolated test stores only.</p>
    <div className="recovery-tabs" role="tablist" aria-label="Recovery queues">{RECOVERY_SECTIONS.map(s=><button type="button" role="tab" aria-selected={kind===s.id} key={s.id} disabled={busy} className={`button small ${kind===s.id?'primary':''}`} onClick={()=>{setKind(s.id);setSelected('');reset();}}>{s.label}{Array.isArray(data?.[s.id])?` (${data[s.id].length})`:''}</button>)}</div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {result && <div className="recovery-result" role="status"><strong>Recorded outcome</strong><dl>{Object.entries(result).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{formatCell(k,v)}</dd></div>)}</dl></div>}
    {kind==='maintenance'?<div className="recovery-maintenance"><h3>Health-outbox protection migration</h3><p>Requires the original server encryption key. Old workers must be stopped before migrating. Unmigrated messages remain hidden, not displayed as plaintext.</p>
      <dl><div><dt>Pending messages</dt><dd>{data?.healthMigration?.pendingRows ?? '—'}</dd></div><div><dt>Protected so far</dt><dd>{data?.healthMigration?.processedTotal ?? '—'}</dd></div><div><dt>Complete</dt><dd>{String(data?.healthMigration?.complete ?? false)}</dd></div></dl>
      <button className="button primary" disabled={busy || loading} onClick={migrate}>Protect next batch (up to 500)</button></div>
      :kind==='history'?<div className="recovery-history">{rows.length?rows.map(h=><article key={h.id}><strong>{h.kind} · {h.action}</strong><p>{h.bagId} · {h.actor} · {h.createdAt}</p><p>{h.reason}</p></article>):<p className="muted">No financial recovery decisions recorded yet. Connector and renewal histories appear in their cases.</p>}</div>
      :<div className="recovery-grid"><div className="recovery-cases" aria-label="Recovery cases">{rows.length?rows.map(record=>{
        const id=recoveryId(kind,record);return <button type="button" className={`recovery-case ${id===selected?'selected':''}`} key={id} disabled={busy} onClick={()=>{setSelected(id);reset();}}>
          <strong>{id}</strong><span>{record.state || record.reviewState || record.status || record.kind || 'held'}</span><span>{record.brandId || ''}{Number.isSafeInteger(record.amountCents)?` · ${formatCell('amountCents',record.amountCents)}`:''}</span>
        </button>;
      }):<p className="muted">{loading?'Loading recovery cases…':'No records in this queue.'}</p>}</div>
      <div className="recovery-detail">{row?<>
        <h3>{selected}</h3>{row.lastError && <p>{row.lastError}</p>}{row.holdReasons?.length?<p className="form-error">Blocked by: {row.holdReasons.join(', ')}</p>:null}
        {(row.eligibleAt || row.dueAt) && <p className="subtle-note">Earliest release: {row.eligibleAt || row.dueAt}. Other gates still apply.</p>}
        {row.simulated && <p className="subtle-note">Simulated renewal. Operator attestations are not Stripe verification.</p>}
        {row.attempts?.some(a=>a.workerFenceRequired) && <p className="form-error">An attempt may still be running. Fence the worker before reviewing its outcome; this tool will not assume a timeout means failure.</p>}
        {actions.length?<form onSubmit={submit} className="form-fields">
          <label className="field"><span>Recovery action</span><select value={actionId} disabled={busy} required onChange={e=>edit(setAction,e.target.value)}><option value="">Choose an action</option>{actions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          {kind==='connectors' && actionId!=='retry' && <label className="field"><span>Remote order ID (verified by a fresh read)</span><input value={externalId} disabled={busy} required inputMode="numeric" onChange={e=>edit(setExternalId,e.target.value)}/></label>}
          {(actionId==='operator_verified_recovery' || /^reconcile_(declined|voided):/.test(actionId)) && <label className="field"><span>{kind==='subscriptions'?'Mock review reference (mockproof_…)':'Recovery evidence reference'}</span><input value={reference} disabled={busy} required onChange={e=>edit(setReference,e.target.value)}/></label>}
          {action?.attempt && <div className="recovery-evidence"><p className="subtle-note">This action never calls the charger. Review this exact attempt before attesting:</p><dl>{Object.entries({attemptId:action.attempt.id,status:action.attempt.status,amountCents:action.attempt.amountCents,chargeRef:action.attempt.chargeRef ?? 'No recorded simulated charge reference',orderId:action.attempt.orderId ?? 'No recorded order',attemptKey:action.attempt.proofRequirements?.attemptKey,requestFingerprint:action.attempt.proofRequirements?.requestFingerprint}).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{formatCell(k,v)}</dd></div>)}</dl></div>}
          {action?.pending && <p className="subtle-note">Saved operation {action.pending.operationId}, initiated by {action.pending.actor}. Its original reason and proof are retained server-side; continuing does not replace them.</p>}
          {!action?.pending && <label className="field"><span>Operator reason (no secrets, shopper details or health information)</span><textarea value={reason} disabled={busy} required minLength={10} maxLength={1000} onChange={e=>edit(setReason,e.target.value)}/></label>}
          <label className="checkbox-field"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/><span>{recoveryAcknowledgement(actionId)}</span></label>
          <button className="button primary" disabled={busy || !ack || !actionId || (!action?.pending && reason.trim().length<10)}>{busy?<LoaderCircle className="spin" size={14}/>:null}Record recovery decision</button>
        </form>:<p className="muted">No permitted transition. Review the recorded outcome; unresolved worker/provider evidence cannot be cleared by a reset.</p>}
        {row.history?.length?<details><summary>Case audit history ({row.history.length})</summary>{row.history.map((h,i)=><p key={h.operationId || i}>{h.action} · {h.status || h.state} · {h.actor} · {h.createdAt}</p>)}</details>:null}
      </>:<p className="muted">Select a record to inspect its permitted recovery actions.</p>}</div></div>}
  </section>;
}
