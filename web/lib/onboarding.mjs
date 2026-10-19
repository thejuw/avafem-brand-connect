export const PLATFORM_NAMES={shopify:'Shopify',woocommerce:'WooCommerce',bigcommerce:'BigCommerce',csv:'CSV catalog'};
export const labelOf=(value,fallback='')=>typeof value==='string'?value:typeof value?.name==='string'?value.name:typeof value?.title==='string'?value.title:fallback;
export function createOnboardingTransport(fetchImpl=globalThis.fetch){
  let csrfToken='';
  return {setSession(value){csrfToken=typeof value?.csrfToken==='string'?value.csrfToken:'';},async request(path,options={}){
    const method=options.method || 'GET';
    const response=await fetchImpl(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(method!=='GET' && csrfToken?{'x-csrf-token':csrfToken}:{}),...options.headers},body:options.body?JSON.stringify(options.body):undefined});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(labelOf(value.error?.message || value.message,`This request could not be completed (${response.status}).`)),{status:response.status});
    return value.data ?? value;
  }};
}
export function normalizeStoreUrl(value){
  const text=typeof value==='string'?value.trim():'';
  if(!text)throw new Error('Enter your store address.');
  let url;try{url=new URL(/^https?:\/\//i.test(text)?text:`https://${text}`);}catch{throw new Error('Enter a valid HTTPS store address.');}
  if(url.protocol!=='https:' || url.username || url.password || url.hash || !url.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname))throw new Error('Use a public HTTPS store address without credentials or fragments.');
  return url.href;
}
export function capabilityLabel(capability={}){
  if(capability.simulated || capability.mode==='simulated')return 'Simulated—not provider verified';
  if(capability.configured!==true)return 'Not configured';
  if(capability.mode==='test')return 'Provider test mode';
  if(capability.mode==='live' || capability.mode==='real')return 'Real provider mode—not a connection proof';
  return capability.configured===true?'Configured—verification still required':'Not configured';
}
export function manualPlatformChoice(value){return ['woocommerce','bigcommerce'].includes(value)?value:'';}
export function connectionNotice(result={},hasApprovalLink=false){
  if(result.connected===true || result.status==='connected' || result.connection?.connected===true || result.connection?.status==='connected')
    return result.simulated===true || result.connection?.simulated===true?'Simulated store connection ready—not provider acceptance. Product curation remains separate.':'Store connection verified. Product curation remains separate.';
  return labelOf(result.message || result.reason,hasApprovalLink?'Continue with provider approval, then refresh this page.':'Connection approval is not configured. You can use a CSV catalog instead.');
}
export function normalizeOnboarding(value={}){
  const brand=value.brand || {},profile={...brand,...(value.profile || {})};
  const connection=value.connection || value.store || {},catalog=value.catalog || {},payouts=value.payouts || value.steps?.payouts || {};
  let logoUrl='';try{const url=new URL(labelOf(profile.logoUrl));if(url.protocol==='https:' && !url.username && !url.password)logoUrl=url.href;}catch{}
  return {...value,brand,profile:{...profile,name:labelOf(profile.name,labelOf(brand.name)),logoUrl,supportEmail:labelOf(profile.supportEmail || profile.contactEmail),returnPolicy:labelOf(profile.returnPolicy,labelOf(profile.returnPolicy?.text || profile.returnPolicy?.summary || profile.returnPolicy?.url))},
    connection,catalog,payouts,capabilities:value.capabilities || {},
    storeComplete:typeof value.steps?.store?.complete==='boolean'?value.steps.store.complete:connection.connected===true || connection.status==='connected',
    payoutDeferred:payouts.deferred===true || ['deferred','skipped'].includes(payouts.status),
    pendingCuration:Number.isSafeInteger(catalog.pendingCuration)?catalog.pendingCuration:Number.isSafeInteger(catalog.pending)?catalog.pending:null};
}
export function safeApprovalUrl(value,{platform,storeUrl,kind='store'}={}){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:' || url.username || url.password || url.port)return null;
    if(kind==='payout'){
      if(/acct_sandbox_|(?:^|[\/_-])simulated(?:[\/_-]|$)/i.test(url.pathname))return null;
      return (url.hostname==='connect.stripe.com' && url.pathname.startsWith('/setup/')) || (url.hostname==='accounts.stripe.com' && /^\/r\/acct_[A-Za-z0-9]{8,}\/?$/.test(url.pathname))?url.href:null;
    }
    if(platform==='shopify' && (url.hostname==='admin.shopify.com' || /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(url.hostname)))return url.href;
    if(platform==='bigcommerce' && url.hostname==='login.bigcommerce.com')return url.href;
    if(platform==='woocommerce' && storeUrl && url.origin===new URL(storeUrl).origin && url.pathname.startsWith('/wc-auth/'))return url.href;
  }catch{}
  return null;
}
export function payoutApprovalUrl(result={}){
  if(result.simulated===true || result.mode==='simulated')return null;
  return safeApprovalUrl(result.url || result.onboardingUrl,{kind:'payout'});
}
export function credentialsFromForm(form,platform,storeUrl){
  const read=name=>String(form?.elements?.namedItem(name)?.value || '').trim();
  if(platform==='woocommerce')return {storeUrl:normalizeStoreUrl(storeUrl),consumerKey:read('consumerKey'),consumerSecret:read('consumerSecret')};
  if(platform==='bigcommerce')return {storeHash:read('storeHash'),accessToken:read('accessToken')};
  return undefined;
}
export function clearCredentialForm(form){
  for(const name of ['consumerKey','consumerSecret','storeHash','accessToken']){const field=form?.elements?.namedItem(name);if(field)field.value='';}
}
export function profilePatch(values={}){
  const patch={};for(const key of ['name','logoUrl','supportEmail','returnPolicy'])if(typeof values[key]==='string')patch[key]=values[key].trim();
  if(patch.logoUrl){try{const url=new URL(patch.logoUrl);if(url.protocol!=='https:' || url.username || url.password)throw 0;patch.logoUrl=url.href;}catch{throw new Error('Logo URL must be HTTPS.');}}
  return patch;
}
export function safeInvitePath(value){
  const path=typeof value?.path==='string'?value.path:typeof value?.token==='string'?`/onboard/${value.token}`:'';
  return /^\/onboard\/[A-Za-z0-9._~-]{20,2048}$/.test(path)?path:null;
}
export function inviteDeliveryLabel(delivery={},capabilities={}){
  const state=delivery.status || delivery.state;
  if(delivery.simulated===true || capabilities.simulated===true)return 'Simulated receipt—not external delivery';
  if(state==='accepted' || delivery.providerAccepted===true)return 'Provider accepted—not delivery confirmation';
  if(state==='uncertain' || state==='pending')return 'Outcome uncertain—review before resending';
  if(state==='not_configured' || capabilities.configured!==true)return 'Email provider not configured';
  return 'No delivery confirmation';
}
