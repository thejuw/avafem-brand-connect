export function normalizeCuration(value={}){
  return {products:Array.isArray(value.products)?value.products:[],brands:(Array.isArray(value.brands)?value.brands:[]).map(b=>({...b,autoApproveClean:b.autoApproveProducts===true || b.autoApproveClean===true})),limits:value.limits || {bulkMax:500}};
}
export function curationQuery(filters={}){
  const query=new URLSearchParams();
  for(const key of ['brandId','status','collection','productType','tag','sinceReview'])if(typeof filters[key]==='string' && filters[key].trim())query.set(key,filters[key].trim());
  const ids=Array.isArray(filters.ids)?filters.ids:String(filters.ids || '').split(/[\s,]+/);
  if(ids.filter(Boolean).length)query.set('ids',[...new Set(ids.filter(Boolean))].join(','));
  return `/api/admin/curation${query.size?`?${query}`:''}`;
}
export function isFlagged(product){
  const compliance=product?.compliance || {};
  if(!['pass','flagged','blocked'].includes(compliance.status) && typeof compliance.canGoLive!=='boolean')return true;
  return ['flagged','blocked'].includes(compliance.status) || (Array.isArray(compliance.flags) && compliance.flags.length>0) || compliance.canGoLive===false;
}
export function productChanged(product){return product?.isChanged===true || product?.changedSinceReview===true;}
export function curationReasons(product){
  const flags=Array.isArray(product?.compliance?.flags)?product.compliance.flags:[];
  const validation=Array.isArray(product?.validationIssues)?product.validationIssues:[];
  const text=(value,fallback)=>typeof value==='string'?value:fallback;
  return [...flags.map(f=>({code:text(f.code,text(f.severity,'Compliance')),message:text(f.message,text(f.reason,text(f.description,'Human review required.')))})),...validation.map(f=>({code:text(f.field,'Validation'),message:text(f.message,'Catalog details need attention.')}))];
}
export function bulkCurationRequest({operationId,reason,action,products,overrideReason='',limit=500}){
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(operationId || ''))throw new Error('A stable operation ID is required.');
  if(!['approved','rejected'].includes(action))throw new Error('Choose approve or reject.');
  const auditReason=String(reason || '').trim();if(auditReason.length<10 || auditReason.length>1000)throw new Error('Add an operator reason of 10–1,000 characters.');
  if(!Array.isArray(products) || !products.length || products.length>limit)throw new Error(`Select 1–${limit} products.`);
  if(new Set(products.map(p=>p.id)).size!==products.length)throw new Error('Duplicate product selection.');
  const override=String(overrideReason || '').trim();
  return {operationId,reason:auditReason,action,products:products.map(p=>{
    if(typeof p.id!=='string' || !p.id || typeof p.fingerprint!=='string' || !p.fingerprint)throw new Error('Refresh this queue before reviewing products without a fingerprint.');
    const requiresOverride=action==='approved' && isFlagged(p) && p.compliance?.overridden!==true;
    if(requiresOverride && (override.length<10 || override.length>1000))throw new Error('Flagged products require a separate explicit override reason of 10–1,000 characters.');
    return {id:p.id,fingerprint:p.fingerprint,...(requiresOverride?{overrideReason:override}:{})};
  })};
}
export function autoApproveRequest(enabled,reason){
  if(typeof enabled!=='boolean')throw new Error('Choose an explicit auto-approval setting.');
  const text=String(reason || '').trim();if(text.length<10 || text.length>1000)throw new Error('Add an operator reason of 10–1,000 characters.');
  return {enabled,reason:text};
}
