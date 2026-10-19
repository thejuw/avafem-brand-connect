import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Check,Copy,Link,LoaderCircle,Mail,RefreshCw,ShieldCheck,X} from 'lucide-react';
import {inviteDeliveryLabel,safeInvitePath} from './lib/onboarding.mjs';
import './onboarding.css';

const date=value=>value && Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString():'Not supplied';
const stateLabel=value=>typeof value==='string'?value.replaceAll('_',' '):'Unknown';

/** Operations-only link issuing; opening an invite would replace this browser's role. */
export default function AdminInvitesPanel({request}){
  const [brands,setBrands]=useState([]),[brandId,setBrandId]=useState(''),[data,setData]=useState({invites:[],deliveries:[],capabilities:{}});
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [email,setEmail]=useState(''),[privateLink,setPrivateLink]=useState(null),[confirmRevoke,setConfirmRevoke]=useState(null);
  const requester=useRef(request);requester.current=request;
  const mounted=useRef(true),generation=useRef(0),lock=useRef(false),operation=useRef(null);
  const base=id=>`/api/admin/onboarding/${encodeURIComponent(id)}/invites`;
  function changeBrand(id){generation.current++;setPrivateLink(null);setConfirmRevoke(null);setData({invites:[],deliveries:[],capabilities:{}});setEmail('');operation.current=null;setBrandId(id);}
  const load=useCallback(async id=>{
    if(!id)return;const serial=++generation.current;setLoading(true);
    try{const result=await requester.current(base(id));if(mounted.current && serial===generation.current)setData({invites:Array.isArray(result.invites)?result.invites:[],deliveries:Array.isArray(result.deliveries)?result.deliveries:[],capabilities:result.capabilities || {}});}
    catch{if(mounted.current && serial===generation.current)setError('Invitation status could not be loaded. No link or delivery outcome is assumed.');}
    finally{if(mounted.current && serial===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{
    mounted.current=true;requester.current('/api/brands').then(result=>{if(mounted.current)setBrands(Array.isArray(result)?result:Array.isArray(result.brands)?result.brands:[]);}).catch(()=>{if(mounted.current)setError('Brand choices could not be loaded.');});
    return()=>{mounted.current=false;generation.current++;operation.current=null;};
  },[]);
  useEffect(()=>{setPrivateLink(null);setEmail('');setNotice('');setError('');setConfirmRevoke(null);operation.current=null;setData({invites:[],deliveries:[],capabilities:{}});if(brandId)load(brandId);return()=>{generation.current++;};},[brandId,load]);
  async function perform(key,fn){if(lock.current)return;lock.current=true;setBusy(key);setError('');setNotice('');try{await fn();}catch{setError('The request did not return a confirmed outcome. Refresh status before another action. An explicit retry of the same request keeps its operation ID.');}finally{lock.current=false;if(mounted.current)setBusy('');}}
  async function issue(inviteId){
    await perform(inviteId || 'create',async()=>{
      const recipient=email.trim(),intent=JSON.stringify({brandId,inviteId:inviteId || null,email:recipient});
      if(operation.current?.intent!==intent)operation.current={intent,id:crypto.randomUUID()};
      const result=await requester.current(`${base(brandId)}${inviteId?`/${encodeURIComponent(inviteId)}/resend`:''}`,{method:'POST',body:{operationId:operation.current.id,...(recipient?{email:recipient}:{})}});
      const path=safeInvitePath(result);
      setPrivateLink(path?{path,expiresAt:result.expiresAt}:null);
      operation.current=null;setNotice(`${inviteId?'Replacement invitation created; the old link is revoked.':'Invitation created.'} ${inviteDeliveryLabel(result.delivery,data.capabilities)}.`);
      if(!path)setError('The invitation returned no safe local link. Refresh its status; do not reconstruct or open a remote link.');
      await load(brandId);
    });
  }
  const selectedBrand=brands.find(b=>b.id===brandId),disabled=Boolean(busy);
  return <section className="admin-invites curation-panel" aria-label="Brand invitations">
    <header className="cur-heading"><div><span className="ob-eyebrow">A secure start for each partner</span><h2>Brand invitations</h2><p>Issue expiring, one-use access to the two-step brand onboarding flow.</p></div><ShieldCheck size={24}/></header>
    <div className="ob-notice"><ShieldCheck size={15}/>Admin tooling only. Do not open a brand invitation in this operations browser: accepting it replaces the current session with that brand’s session.</div>
    <section className="ob-card"><label className="ob-field"><span>Brand</span><select value={brandId} disabled={disabled} onChange={e=>changeBrand(e.target.value)}><option value="">Choose a brand</option>{brands.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label>
      {brandId && <><form onSubmit={e=>{e.preventDefault();issue();}}><label className="ob-field"><span>Recipient email (optional; otherwise use the brand’s contact)</span><input type="email" value={email} autoComplete="off" maxLength={254} disabled={disabled} onChange={e=>{setEmail(e.target.value);operation.current=null;}} placeholder="Leave blank to use the brand’s saved contact"/></label><div className="ob-button-row"><button className="ob-button primary" disabled={disabled || loading}>{busy==='create'?<LoaderCircle className="spin" size={15}/>:<Mail size={15}/>}Create invitation</button><button className="ob-button" type="button" disabled={disabled || loading} onClick={()=>load(brandId)}><RefreshCw size={15}/>Refresh status</button></div></form><p className="ob-small">{inviteDeliveryLabel({},data.capabilities)}. Creating or resending sends an email only when the server’s delivery capability is configured; provider acceptance is not proof of inbox delivery.</p></>}
    </section>
    {error && <p className="ob-error" role="alert">{error}</p>}{notice && <p className="ob-notice" role="status">{notice}</p>}
    {privateLink && <section className="ob-card invite-private"><div className="ob-card-heading"><Link size={18}/><h3>Private invitation path</h3><button className="ob-text-button" onClick={()=>setPrivateLink(null)}><X size={13}/>Hide</button></div><p>Copy this local path for {selectedBrand?.name || 'the selected brand'} into the trusted invitation workflow. It is a one-use access capability, not an admin navigation link.</p><label className="ob-field"><span>Private local invitation path</span><input value={privateLink.path} readOnly autoComplete="off" spellCheck={false}/></label><div className="ob-button-row"><button className="ob-button" onClick={()=>perform('copy',async()=>{await navigator.clipboard.writeText(privateLink.path);setNotice('Private local path copied. Share it only with the intended brand contact.');})}><Copy size={14}/>Copy path</button><small>Expires {date(privateLink.expiresAt)}</small></div></section>}
    {brandId && <section className="cur-table-card ob-card"><div className="cur-table-top"><h3>Invitations for {selectedBrand?.name || 'this brand'}</h3><small>Re-send replaces and revokes the old link. No automatic retries.</small></div>{loading && !data.invites.length?<p className="cur-empty" role="status"><LoaderCircle className="spin" size={18}/>Loading invitations…</p>:!data.invites.length?<p className="cur-empty">No invitations have been issued for this brand.</p>:<div className="cur-table-wrap"><table><thead><tr><th>Invitation</th><th>Status &amp; expiry</th><th>Email outcome</th><th>Actions</th></tr></thead><tbody>{data.invites.map(invite=>{
      const deliveries=data.deliveries.filter(d=>(d.inviteId || d.invite_id)===invite.id),delivery=deliveries[0] || {},active=invite.status==='active' || invite.status==='pending';
      return <tr key={invite.id}><td><strong>{invite.id}</strong><small>Signed, single-use brand access</small></td><td><span className="ob-badge">{stateLabel(invite.status)}</span><small>{date(invite.expiresAt)}</small></td><td>{inviteDeliveryLabel(delivery,data.capabilities)}{delivery.updatedAt && <small>{date(delivery.updatedAt)}</small>}</td><td><div className="ob-button-row"><button className="ob-text-button" disabled={disabled || !active} onClick={()=>issue(invite.id)}>Replace &amp; re-send</button><button className="ob-text-button" disabled={disabled || !active} onClick={()=>setConfirmRevoke(invite.id)}>Revoke</button></div>{confirmRevoke===invite.id && <div className="invite-revoke"><p>Revoke this unaccepted invitation? This cannot be used to accept brand access afterwards.</p><button className="ob-button danger" disabled={disabled} onClick={()=>perform('revoke',async()=>{await requester.current(`${base(brandId)}/${encodeURIComponent(invite.id)}/revoke`,{method:'POST',body:{}});setPrivateLink(null);setConfirmRevoke(null);setNotice('Invitation revoked.');await load(brandId);})}><Check size={13}/>Confirm revoke</button><button className="ob-text-button" disabled={disabled} onClick={()=>setConfirmRevoke(null)}>Cancel</button></div>}</td></tr>;
    })}</tbody></table></div>}</section>}
  </section>;
}
