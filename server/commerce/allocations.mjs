// Amounts are bounded integer USD cents. BigInt keeps largest-remainder splits
// exact even when total * weight would exceed Number's integer precision.
const fail = message => { throw Object.assign(new Error(message), {statusCode:422,code:'COMMERCE_ALLOCATION_INVALID'}); };
export function splitCents(total, weights) {
  if (!Number.isSafeInteger(total) || total<0 || !Array.isArray(weights) || weights.some(n=>!Number.isSafeInteger(n)||n<0)) fail('Integer cents and weights are required.');
  const sum=weights.reduce((s,n)=>s+BigInt(n),0n);
  if (!sum) { if(total)fail('Nonzero cents need nonzero allocation weights.');return weights.map(()=>0); }
  const entries=weights.map((n,i)=>({i,n:Number(BigInt(total)*BigInt(n)/sum),r:BigInt(total)*BigInt(n)%sum}));
  let left=total-entries.reduce((s,e)=>s+e.n,0);
  for (const e of [...entries].sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1)) if(left){e.n++;left--;}
  return entries.map(e=>e.n);
}
export const rateCents=(amount,bps)=>Number((BigInt(amount)*BigInt(bps)+5000n)/10000n);

/** Mutates a freshly constructed snapshot only. A partner-funded policy requires
 * explicit consent on every affected partner; first-party always funds itself. */
export function allocateCommercialCart(snapshot) {
  const {settings,groups}=snapshot, lines=groups.flatMap(g=>g.items);
  const discounts=splitCents(rateCents(lines.reduce((s,l)=>s+l.grossCents,0),settings.discountBps),lines.map(l=>l.grossCents));
  lines.forEach((line,i)=>{line.discountCents=discounts[i];line.netCents=line.grossCents-line.discountCents;});
  const owned=groups.filter(g=>g.terms.model==='first_party');
  const ownedShipping=splitCents(owned.length?settings.ownedShippingCents:0,owned.map(g=>g.items.reduce((s,l)=>s+l.grossCents,0)));
  const net=lines.reduce((s,l)=>s+l.netCents,0);
  const free=settings.freeShippingThresholdCents!==null && net>=settings.freeShippingThresholdCents;
  for (const group of groups) {
    const partner=group.terms.model==='partner';
    group.subtotalCents=group.items.reduce((s,l)=>s+l.grossCents,0);
    group.discountCents=group.items.reduce((s,l)=>s+l.discountCents,0);
    group.nominalShippingCents=partner?group.terms.shippingCents:ownedShipping[owned.indexOf(group)];
    group.shippingCents=free?0:group.nominalShippingCents;
    const consent=Boolean(group.terms.partnerPromotionAgreement);
    if (partner && !consent && ((group.discountCents && settings.discountFunding==='partner')
      || (free && group.nominalShippingCents && settings.freeShippingFunding==='partner')
      || settings.returnShippingFunding==='partner'))
      throw Object.assign(new Error('Partner-funded costs require a recorded agreement for each affected brand.'),{statusCode:409,code:'PARTNER_FUNDING_AGREEMENT_REQUIRED'});
    group.partnerDiscountCents=partner && settings.discountFunding==='partner'?group.discountCents:0;
    group.platformDiscountCents=group.discountCents-group.partnerDiscountCents;
    group.platformShippingSubsidyCents=partner && free && settings.freeShippingFunding==='avafem'?group.nominalShippingCents:0;
    group.commissionCents=partner?rateCents(group.subtotalCents-group.partnerDiscountCents,group.terms.commissionBps):0;
    group.transferCents=partner?group.subtotalCents-group.partnerDiscountCents-group.commissionCents+group.shippingCents+group.platformShippingSubsidyCents:0;
    const commissions=splitCents(group.commissionCents,group.items.map(l=>l.grossCents-(settings.discountFunding==='partner'?l.discountCents:0)));
    const partnerDiscounts=splitCents(group.partnerDiscountCents,group.items.map(l=>l.discountCents));
    group.items.forEach((line,i)=>{
      line.commissionCents=commissions[i];line.partnerDiscountCents=partnerDiscounts[i];
      const discounts=splitCents(line.discountCents,Array(line.qty).fill(1));
      const partnerDiscount=discounts.map(amount=>partner && settings.discountFunding==='partner'?amount:0);
      const unitCommission=splitCents(line.commissionCents,partnerDiscount.map(amount=>line.unitPriceCents-amount));
      line.units=discounts.map((amount,index)=>({grossCents:line.unitPriceCents,discountCents:amount,
        netCents:line.unitPriceCents-amount,partnerDiscountCents:partnerDiscount[index],commissionCents:unitCommission[index],
        taxCents:0,shipped:false,refunded:false,inspection:null}));
    });
  }
  return snapshot;
}
