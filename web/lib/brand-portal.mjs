/** Pure helpers for the brand portal UI (tested without a browser). */
export const PORTAL_NAV = [
  ['dashboard', 'Dashboard', null],
  ['products', 'Products', 'catalog:read'],
  ['payouts', 'Payouts', 'reports:read'],
  ['team', 'Team', 'members:manage'],
  ['settings', 'Settings', null],
];
export const visibleNav = (scopes = []) => PORTAL_NAV.filter(([, , scope]) => !scope || scopes.includes(scope));
export const money = cents => Number.isSafeInteger(cents)?new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',minimumFractionDigits:2,maximumFractionDigits:2 }).format(cents / 100):'—';
export const pct = rate => rate == null ? '—' : `${(Number(rate) * 100).toFixed(1)}%`;
export const greeting = (date = new Date()) => { const h = date.getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
export const STATUS_LABEL = { draft: 'Draft', in_review: 'In review', approved: 'Listed', rejected: 'Needs changes' };
/** Read a sign-in token from the URL fragment (never sent to servers or logs). */
export function linkFromHash(hash = '') {
  const m = /^#(token|invite)=([A-Za-z0-9_-]{43})$/.exec(String(hash));
  return m ? { kind: m[1], token: m[2] } : null;
}
export const monthOptions = (now = new Date(), count = 12) => Array.from({ length: count }, (_, i) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  return { value: d.toISOString().slice(0, 7), label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
});
export const reportUrl = (kind, value, format) => kind === 'statement'
  ? `/api/brand-portal/statements?month=${encodeURIComponent(value)}&format=${format}`
  : `/api/brand-portal/reports/annual?year=${encodeURIComponent(value)}&format=${format}`;
export const ROLE_HELP = { owner: 'Everything, including team and credentials', staff: 'Catalog, orders, shipping and support', finance: 'Payouts, statements and tax reports' };
export const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
export const API_SCOPES=Object.freeze(['catalog:read','catalog:write','orders:read','orders:fulfill','payouts:read','refunds:write']);
export const PLACEMENT_LABELS={featured_spot:'Featured spot',sponsored_swipe:'Sponsored swipe card',sampling_box:'Sampling box'};
export const canManageCredentials=me=>Boolean(me?.memberId && me.role==='owner' && me.scopes?.includes('credentials:manage'));
export const canManageTeam=me=>Boolean(me?.memberId && me.role==='owner' && me.scopes?.includes('members:manage'));
export const shortDate=value=>value && Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'Not scheduled';
export function safePortalError(error,fallback='This request could not be completed. Please try again.'){
  const text=typeof error?.message==='string'?error.message:'';
  return text.length>0 && text.length<=250 && !/[\u0000-\u001f]|https?:\/\/|avf_test_|(?:sk|rk|pk)_(?:test|live)_|whsec_|shpat_|shpss_|#(?:token|invite)=|client_secret|password[=:]/i.test(text)?text:fallback;
}
export function loginReceipt(result={}){
  return result.simulated===true?{title:'Request recorded in the sandbox',message:'If this email belongs to a brand team, a single-use sign-in link was recorded in the simulated local outbox. No email was delivered. Ask your workspace operator to access that test link; it expires in 15 minutes.'}:{title:'Sign-in request accepted',message:'If this email belongs to a brand team, follow the configured email delivery instructions. Provider acceptance is not proof of inbox delivery. A sign-in link expires in 15 minutes.'};
}
export function credentialRequest({operationId,label,scopes}){
  const title=String(label || '').trim();
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(operationId || ''))throw new Error('A stable operation ID is required.');
  if(!title || title.length>100)throw new Error('Give this key a label of 1–100 characters.');
  if(!Array.isArray(scopes) || !scopes.length || scopes.some(s=>!API_SCOPES.includes(s)))throw new Error('Select one or more supported integration scopes.');
  return {operationId,kind:'api_key',label:title,scopes:[...new Set(scopes)].sort()};
}
export function credentialMetadata(value){
  return (Array.isArray(value)?value:[]).filter(v=>v && v.kind==='api_key' && typeof v.id==='string').map(v=>({id:v.id,label:typeof v.label==='string'?v.label:'Integration key',active:v.active!==false,scopes:Array.isArray(v.scopes)?v.scopes.filter(s=>API_SCOPES.includes(s)):[],createdAt:v.createdAt,lastUsedAt:v.lastUsedAt}));
}
export function clearPortalSecrets(form){
  for(const name of ['password','currentPassword','newPassword','apiKey']){const field=form?.elements?.namedItem(name);if(field)field.value='';}
}
export function statementPreview(value,brandId){
  if(value?.sandbox!==true || value.currency!=='USD' || value.brandId!==brandId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month || '') || !Array.isArray(value.lines))throw new Error('This sandbox statement could not be verified for your brand.');
  const cents=value=>Number.isSafeInteger(value)?value:null;
  const fields=['merchandiseCents','commissionCents','refundedCents','transferCents','reversedCents','netCents'];
  return {month:value.month,lines:value.lines.map(line=>({transferId:typeof line.transferId==='string'?line.transferId:'Unavailable',bagId:typeof line.bagId==='string'?line.bagId:'Unavailable',status:typeof line.status==='string'?line.status:'unknown',createdAt:line.createdAt,dueAt:line.dueAt,paidAt:line.paidAt,...Object.fromEntries(fields.map(k=>[k,cents(line[k])]))})),totals:Object.fromEntries([...fields,'paidCents','heldOrScheduledCents'].map(k=>[k,cents(value.totals?.[k])])),note:'Sandbox statement of simulated transfers—not a bank receipt or tax form.'};
}
export function placementRequest(input,products,now=new Date()){
  if(!products?.some(p=>p.id===input.productId && p.status==='approved' && !p.sourceDeletedAt))throw new Error('Select one of your listed, approved products.');
  if(!Object.hasOwn(PLACEMENT_LABELS,input.kind))throw new Error('Choose a supported campaign format.');
  const days=Number(input.days),units=Number(input.units);
  if(!Number.isSafeInteger(days) || days<1 || days>90)throw new Error('Choose a campaign window of 1–90 days.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate || ''))throw new Error('Choose a valid start date (UTC).');
  const starts=new Date(`${input.startDate}T00:00:00Z`);
  if(!Number.isFinite(+starts) || starts.toISOString().slice(0,10)!==input.startDate || input.startDate<now.toISOString().slice(0,10))throw new Error('Choose today or a future valid start date (UTC).');
  if(input.kind==='sponsored_swipe' && (!Number.isSafeInteger(units) || units<1000 || units>10_000_000))throw new Error('Sponsored cards need 1,000–10,000,000 impressions.');
  if(input.kind==='sampling_box' && (!Number.isSafeInteger(units) || units<10 || units>100_000))throw new Error('Sampling requests need 10–100,000 units.');
  return {kind:input.kind,productId:input.productId,startsAt:starts.toISOString(),endsAt:new Date(+starts+days*86_400_000).toISOString(),...(input.kind!=='featured_spot'?{units}:{})};
}
export function placementEstimate(input,pricing={}){
  const days=Number(input.days),units=Number(input.units);
  if(input.kind==='featured_spot' && Number.isSafeInteger(days) && days>0 && Number.isSafeInteger(pricing.featuredSpotPerDayCents))return days*pricing.featuredSpotPerDayCents;
  if(input.kind==='sponsored_swipe' && Number.isSafeInteger(units) && units>=1000 && Number.isSafeInteger(pricing.sponsoredSwipePer1000Cents))return Math.ceil(units/1000)*pricing.sponsoredSwipePer1000Cents;
  if(input.kind==='sampling_box' && Number.isSafeInteger(units) && units>=10 && Number.isSafeInteger(pricing.samplingBoxPerUnitCents))return units*pricing.samplingBoxPerUnitCents;
  return null;
}
