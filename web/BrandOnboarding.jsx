import React,{useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,CheckCircle2,ChevronDown,FileUp,Leaf,LoaderCircle,LockKeyhole,RefreshCw,ShieldCheck,Store,WalletCards} from 'lucide-react';
import {PLATFORM_NAMES,capabilityLabel,clearCredentialForm,connectionNotice,createOnboardingTransport,credentialsFromForm,labelOf,manualPlatformChoice,normalizeOnboarding,normalizeStoreUrl,payoutApprovalUrl,profilePatch,safeApprovalUrl} from './lib/onboarding.mjs';
import './onboarding.css';

/** Invitation routes own their session transport: never bootstrap an owner session. */
export default function BrandOnboarding({token,brandId:initialBrandId,request:workspaceRequest,session,onAccepted}){
  const transport=useRef(null);if(!transport.current)transport.current=createOnboardingTransport();
  const requester=useRef(workspaceRequest);requester.current=workspaceRequest;
  const [brandId,setBrandId]=useState(initialBrandId || session?.brandId || ''),[preview,setPreview]=useState(null),[data,setData]=useState(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [terms,setTerms]=useState(false),[storeUrl,setStoreUrl]=useState(''),[detected,setDetected]=useState(null),[manual,setManual]=useState(false),[csv,setCsv]=useState(''),[editing,setEditing]=useState(false);
  const [approval,setApproval]=useState(null),[payoutLink,setPayoutLink]=useState(null);
  const [manualPlatform,setManualPlatform]=useState('');
  const lock=useRef(false),generation=useRef(0),credentialForm=useRef(null);
  const call=useCallback((path,options)=>!token && requester.current?requester.current(path,options):transport.current.request(path,options),[token]);
  const load=useCallback(async id=>{
    const serial=++generation.current;setLoading(true);
    try{const next=normalizeOnboarding(await call(`/api/onboarding/${encodeURIComponent(id)}`));if(serial===generation.current){setData(next);setPreview(null);}}
    finally{if(serial===generation.current)setLoading(false);}
  },[call]);
  useEffect(()=>{
    let active=true;setError('');setLoading(true);
    if(token)call(`/api/onboarding/invites/${encodeURIComponent(token)}`).then(p=>{if(active){setPreview(p);setLoading(false);}}).catch(e=>{if(active){setError(e.message);setPreview(null);setLoading(false);}});
    else if(initialBrandId || session?.brandId)load(initialBrandId || session.brandId).catch(e=>{if(active)setError(e.message);});
    else {setError('Open the signed invitation from Avafem to start onboarding.');setLoading(false);}
    return()=>{active=false;generation.current++;clearCredentialForm(credentialForm.current);};
  },[token,initialBrandId,session?.brandId,call,load]);
  async function perform(key,fn){if(lock.current)return;lock.current=true;setBusy(key);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{lock.current=false;setBusy('');}}
  async function establish(value){
    transport.current.setSession(value);const id=value.brandId || value.brand?.id;
    if(!id)throw new Error('The accepted session did not include a brand. Ask Avafem operations to review this invitation.');
    setBrandId(id);setPreview(null);if(onAccepted)await onAccepted(value);await load(id);
  }
  const endpoint=action=>`/api/onboarding/${encodeURIComponent(brandId)}/${action}`;
  async function detect(event){event.preventDefault();await perform('detect',async()=>{const url=normalizeStoreUrl(storeUrl);setStoreUrl(url);setApproval(null);setManualPlatform('');clearCredentialForm(credentialForm.current);setDetected(await call(endpoint('detect'),{method:'POST',body:{storeUrl:url}}));});}
  async function connect(platform,credentials){
    let result=await call(endpoint('connect'),{method:'POST',body:{platform,...(credentials?{credentials}:{})}});
    // Only the known same-brand OAuth endpoint is allowed; never follow an
    // arbitrary path supplied by a discovery response.
    if(platform==='shopify' && result.authorizationRequired===true)result=await call(endpoint('shopify/authorize'),{method:'POST',body:{}});
    const link=safeApprovalUrl(result.approvalUrl || result.authorizationUrl || result.url,{platform,storeUrl});
    setApproval(link?{url:link,platform}:null);
    setNotice(connectionNotice(result,Boolean(link)));
    await load(brandId);
  }
  async function importCsv(event){event.preventDefault();await perform('catalog',async()=>{if(!csv.trim())throw new Error('Choose a CSV file or paste your catalog.');if(csv.length>3_000_000)throw new Error('Use a CSV catalog smaller than 3 MB.');await call(endpoint('catalog'),{method:'POST',body:{csv}});setCsv('');setNotice('Catalog import complete. Listing still requires a matching Avafem approval; check the review status below.');await load(brandId);});}
  function changeStoreUrl(value){clearCredentialForm(credentialForm.current);setStoreUrl(value);setDetected(null);setManualPlatform('');setManual(false);setApproval(null);}
  async function readCsv(event){const file=event.target.files?.[0];if(!file)return;if(file.size>3_000_000){setError('Use a CSV catalog smaller than 3 MB.');return;}setCsv(await file.text());}
  const platform=manualPlatform || detected?.platform || data?.connection?.platform;
  const capability=detected?.capability || data?.connection?.capability || data?.connection || {};
  const payoutCapability=data?.capabilities?.payouts || data?.payouts?.capability || {};
  const connected=data?.storeComplete===true;
  const disabled=Boolean(busy);
  const Root=workspaceRequest?'section':'main';
  return <Root className="brand-onboarding" aria-label="Brand onboarding">
    <header className="ob-header"><a className="ob-wordmark" href="/" aria-label="Avafem home"><Leaf size={26} strokeWidth={1.5}/>avafem<span>®</span></a><span className="ob-environment"><ShieldCheck size={14}/>Brand connection · {data?.sandbox===false?'Provider mode—check capabilities':'Sandbox'}</span></header>
    {loading && !data?<section className="ob-loading" aria-live="polite"><LoaderCircle className="spin"/><h1>Opening your brand workspace</h1><p>Checking your secure invitation…</p></section>:!data?<section className="ob-invite ob-card">
      <div className="ob-icon"><Leaf size={30}/></div><span className="ob-eyebrow">A thoughtful place for your brand</span><h1>{preview?`Welcome, ${labelOf(preview.brand,'brand partner')}.`:'Let’s reconnect.'}</h1>
      <p>{preview?'Connect your store, then choose when to set up payouts. Your products remain yours—Avafem curates what appears in the shop.':'This invitation may be expired, revoked or already accepted. Ask Avafem for a new link, or explicitly resume an existing brand session.'}</p>
      {error && <p className="ob-error" role="alert">{error}</p>}
      {preview?<form onSubmit={e=>{e.preventDefault();if(terms)perform('accept',async()=>establish(await call(`/api/invites/${encodeURIComponent(token)}/accept`,{method:'POST',body:{acceptedSandboxTerms:true}})));}}>
        <label className="ob-check"><input type="checkbox" checked={terms} onChange={e=>setTerms(e.target.checked)} disabled={disabled}/><span>I accept the sandbox draft terms for this test invitation.</span></label>
        <button className="ob-button primary" disabled={disabled || !terms}>{busy==='accept'?<LoaderCircle className="spin" size={16}/>:<ArrowRight size={16}/>}Accept invitation &amp; connect</button>
        {preview.expiresAt && <small>This signed invitation expires {new Date(preview.expiresAt).toLocaleString()}.</small>}
      </form>:token?<button className="ob-button" disabled={disabled} onClick={()=>perform('resume',async()=>establish(await call('/api/onboarding/session')))}>Resume an existing brand session</button>:null}
      <div className="ob-privacy"><LockKeyhole size={14}/>Invitation access does not open an operations account.</div>
    </section>:<>
      <section className="ob-intro"><span className="ob-eyebrow">Your brand, connected</span><h1>Two steps. A little less admin.</h1><p>We’ll use verified store details where available. Connect first; payout setup can wait.</p></section>
      <nav className="ob-steps" aria-label="Onboarding progress"><div className={connected?'complete':'current'}><span>{connected?<Check size={17}/>:1}</span><div><strong>Connect your store</strong><small>{connected?'Connection ready':'Catalog & brand details'}</small></div></div><div className={data.payoutDeferred?'complete':connected?'current':''}><span>{data.payoutDeferred?<Check size={17}/>:2}</span><div><strong>Get paid</strong><small>{data.payoutDeferred?'Deferred—payouts remain held':'Optional at signup'}</small></div></div></nav>
      {error && <div className="ob-error" role="alert">{error}</div>}{notice && <div className="ob-notice" role="status">{notice}</div>}
      <div className="ob-workspace"><section className="ob-card ob-store"><div className="ob-card-heading"><div className="ob-icon"><Store size={22}/></div><div><span className="ob-eyebrow">Step one</span><h2>Connect your store</h2></div>{connected && <span className="ob-badge positive"><CheckCircle2 size={13}/>{data.connection.simulated===true?'Simulated connection':'Connected'}</span>}</div>
        <form className="ob-url-form" onSubmit={detect}><label className="ob-field"><span>Your store address</span><input type="text" inputMode="url" value={storeUrl} onChange={e=>changeStoreUrl(e.target.value)} placeholder="https://your-store.com" disabled={disabled}/></label><button className="ob-button primary" disabled={disabled || !storeUrl.trim()}>{busy==='detect'?<LoaderCircle className="spin" size={15}/>:<ArrowRight size={15}/>}Find my platform</button></form>
        {detected && <div className="ob-detection"><strong>{PLATFORM_NAMES[platform] || 'CSV fallback available'}</strong><span className="ob-badge">{capabilityLabel(capability)}</span><p>{labelOf(detected.message || detected.reason,detected.advisory?'Detection is advisory until your store connection is verified.':'Review the provider capability before approving.')}</p>
          {platform==='shopify' && <button className="ob-button primary" disabled={disabled} onClick={()=>perform('connect',()=>connect(platform))}>Request Shopify approval<ArrowRight size={15}/></button>}
          {['unknown','csv'].includes(detected.platform) && <label className="ob-field"><span>Know your platform? Choose a manual connection</span><select value={manualPlatform} disabled={disabled} onChange={e=>{clearCredentialForm(credentialForm.current);setManualPlatform(manualPlatformChoice(e.target.value));setManual(false);setApproval(null);}}><option value="">Use CSV fallback</option><option value="woocommerce">WooCommerce—store-owned keys</option><option value="bigcommerce">BigCommerce—store-owned token</option></select></label>}
          {['woocommerce','bigcommerce'].includes(platform) && <p className="ob-small">One-click {PLATFORM_NAMES[platform]} approval is not implemented. Use the masked store-owned credential form below, or choose CSV.</p>}
          {approval && <a className="ob-button primary" href={approval.url} target="_blank" rel="noreferrer">Open {PLATFORM_NAMES[approval.platform]} approval<ArrowRight size={15}/></a>}
          <p className="ob-small">No configured approval? Import a CSV below. Avafem will not invent a store connection or provider success.</p>
        </div>}
        {['woocommerce','bigcommerce'].includes(platform) && <details key={platform} className="ob-manual" onToggle={e=>{setManual(e.currentTarget.open);if(!e.currentTarget.open)clearCredentialForm(credentialForm.current);}}><summary>Use store-owned credentials instead <ChevronDown size={14}/></summary>{manual && <form ref={credentialForm} onSubmit={e=>{e.preventDefault();const form=e.currentTarget;perform('credentials',async()=>{try{await connect(platform,credentialsFromForm(form,platform,storeUrl));}finally{clearCredentialForm(form);}});}}>
          <p>Only use credentials for a store you own and are authorized to connect. Secret values stay masked and are cleared after submission.</p>
          {(platform==='woocommerce'?[['consumerKey','WooCommerce consumer key','ck_…'],['consumerSecret','WooCommerce consumer secret','cs_…']]:[['storeHash','BigCommerce store hash','Store hash'],['accessToken','BigCommerce access token','Access token']]).map(([name,label,placeholder])=><label className="ob-field" key={name}><span>{label}</span><input name={name} type={name==='storeHash'?'text':'password'} placeholder={placeholder} required autoComplete="off" spellCheck={false} disabled={disabled}/></label>)}
          <button className="ob-button" disabled={disabled}>Verify store-owned credentials</button></form>}</details>}
        <details className="ob-csv" open={platform==='csv' || platform==='unknown'}><summary><FileUp size={16}/>Use a CSV catalog instead</summary><form onSubmit={importCsv}><p>Upload your product export. Products enter the Avafem curation queue, not the live shop.</p><label className="ob-field"><span>Catalog CSV</span><input type="file" accept=".csv,text/csv" onChange={readCsv} disabled={disabled}/></label><label className="ob-field"><span>Or paste CSV data</span><textarea value={csv} onChange={e=>setCsv(e.target.value)} rows={5} placeholder="sku,title,priceCents,inventoryQty" disabled={disabled}/></label><button className="ob-button" disabled={disabled || !csv.trim()}>{busy==='catalog'?<LoaderCircle className="spin" size={15}/>:<FileUp size={15}/>}Import for curation</button></form></details>
        {(platform==='shopify' || data.connection.status==='connected' && data.connection.platform!=='csv') && <div className="ob-button-row"><button className="ob-button" disabled={disabled} onClick={()=>perform('catalog-refresh',async()=>{await call(endpoint('refresh'),{method:'POST',body:{}});setNotice('Connected catalog refreshed. New and changed content still requires its own curation decision.');await load(brandId);})}><RefreshCw size={14}/>Refresh connected catalog</button><small className="ob-small">Requires saved provider approval. Explicitly reads the connected provider and imports a bounded catalog snapshot; it does not reinstall the connection.</small></div>}
      </section>
      <aside className="ob-side"><section className="ob-card ob-profile"><span className="ob-eyebrow">Your brand details</span><div className="ob-profile-title">{data.profile.logoUrl && <img src={data.profile.logoUrl} alt=""/>}<h2>{labelOf(data.profile.name,'Your brand')}</h2></div><p>{connected?'Store-supplied details are used only when verified. Review or edit your details below.':'Store details appear after a verified connection; missing fields are not guessed.'}</p>{data.connection.platform==='shopify' && <p className="ob-small">Approved Shopify access supplies store name and contact only. Logo and return-policy autofill are unavailable with these permissions; add reviewed details yourself.</p>}
        {!editing?<><dl><div><dt>Contact</dt><dd>{data.profile.supportEmail || 'Not supplied yet'}</dd></div><div><dt>Return policy</dt><dd>{data.profile.returnPolicy || 'Not supplied yet'}</dd></div></dl><button className="ob-text-button" onClick={()=>setEditing(true)} disabled={disabled}>Edit brand details</button></>:<form key={data.profile.name} onSubmit={e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));perform('profile',async()=>{await call(endpoint('profile'),{method:'PATCH',body:profilePatch(values)});setEditing(false);setNotice('Brand details saved.');await load(brandId);});}}>{[['name','Brand name'],['supportEmail','Contact email'],['logoUrl','Logo URL']].map(([name,label])=><label className="ob-field" key={name}><span>{label}</span><input name={name} defaultValue={data.profile[name] || ''} type={name==='supportEmail'?'email':name==='logoUrl'?'url':'text'} disabled={disabled}/></label>)}<label className="ob-field"><span>Return policy</span><textarea name="returnPolicy" defaultValue={data.profile.returnPolicy || ''} disabled={disabled}/></label><div className="ob-button-row"><button className="ob-button" disabled={disabled}>Save details</button><button className="ob-text-button" type="button" onClick={()=>setEditing(false)}>Cancel</button></div></form>}
      </section><section className="ob-card ob-curated"><ShieldCheck size={20}/><h3>Connected isn’t the same as listed.</h3><p>Connection is separate from listing approval. Products must pass Avafem curation before appearing in the shop.</p><strong>{data.pendingCuration===null?'Catalog review status will appear here':`${data.pendingCuration} product${data.pendingCuration===1?'':'s'} pending curation`}</strong></section></aside></div>
      <section className="ob-card ob-payouts"><div className="ob-card-heading"><div className="ob-icon"><WalletCards size={22}/></div><div><span className="ob-eyebrow">Step two · optional now</span><h2>Choose when to set up payouts</h2></div><span className="ob-badge">{capabilityLabel(payoutCapability)}</span></div><p>You can defer payout setup. Funds stay held until the required payout setup and release checks are complete; skipping is not payout approval.</p>
        {data.payoutDeferred && <div className="ob-notice">Payout setup deferred. Your payout hold is still in place.</div>}
        {payoutCapability.configured!==true && <p className="ob-small">{labelOf(payoutCapability.reason,'A real payout onboarding provider is not configured. No simulated Stripe link or successful payout will be shown.')}</p>}
        <div className="ob-button-row"><button className="ob-button primary" disabled={disabled || !connected || payoutCapability.configured!==true || payoutCapability.simulated===true || payoutCapability.mode==='simulated'} onClick={()=>perform('payouts',async()=>{const result=await call(endpoint('payouts/start'),{method:'POST',body:{}});const url=payoutApprovalUrl(result);if(!url)throw new Error(labelOf(result.reason || result.message,'Provider payout setup is unavailable. No setup success was recorded.'));setPayoutLink(url);})}>Set up payouts<ArrowRight size={15}/></button><button className="ob-button" disabled={disabled || !connected} onClick={()=>perform('skip',async()=>{await call(endpoint('payouts/skip'),{method:'POST',body:{}});await load(brandId);setNotice('Payout setup deferred. Payouts remain held.');})}>Skip for now</button>{payoutLink && <a className="ob-button primary" href={payoutLink} target="_blank" rel="noreferrer">Open provider payout setup</a>}<button className="ob-text-button" disabled={disabled} onClick={()=>perform('refresh',()=>load(brandId))}><RefreshCw size={14}/>Refresh connection status</button></div>
      </section><footer className="ob-footer"><LockKeyhole size={14}/>Provider status is explicit. Product curation, payout eligibility and provider activation are separate checks.</footer>
    </>}
  </Root>;
}
