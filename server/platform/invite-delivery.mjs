import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {first,rows,fail,id,maskEmail} from './util.mjs';
import {isPublicIp} from '../integrations/webhooks.mjs';

const email=value=>typeof value==='string' && value.length<=254 && /^[^@\s\r\n]+@[^@\s\r\n]+\.[^@\s\r\n]+$/.test(value);
const safeBase=value=>{
  let u;try{u=new URL(value);}catch{return null;}
  const host=u.hostname.replace(/^\[|\]$/g,'');
  return u.protocol==='https:' && !u.username && !u.password && !u.search && !u.hash && !u.port && u.pathname==='/'
    && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host) && host.includes('.') && (!isIP(host) || isPublicIp(host)) ? u.origin : null;
};

// Server-only opt-in; no SDK dependency or client-controlled endpoint/header.
// https://resend.com/docs/api-reference/emails/send-email
// https://resend.com/docs/dashboard/emails/idempotency-keys
export function createResendInviteAdapter({apiKey,from,fetch:transport=globalThis.fetch}={}) {
  if(typeof apiKey!=='string' || !apiKey.startsWith('re_') || !email(from))return null;
  return {provider:'resend',simulated:false,async send({to,subject,body,operationId}) {
    let response;
    try{response=await transport('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','Idempotency-Key':`avafem-invite:${operationId}`},
      body:JSON.stringify({from,to:[to],subject,text:body})});}
    catch{fail('The invite email outcome is unknown. Do not resend this operation automatically.',502,'INVITE_EMAIL_UNCERTAIN');}
    if(!response.ok)fail('The email provider did not accept this invitation. Review its delivery status.',502,'INVITE_EMAIL_UNCERTAIN');
    // Bound the response without exposing its body, recipient or secret.
    let raw;try{raw=await response.text();}catch{fail('The email response requires review.',502,'INVITE_EMAIL_UNCERTAIN');}
    if(raw.length>16_384)fail('The email response requires review.',502,'INVITE_EMAIL_UNCERTAIN');
    let result;try{result=JSON.parse(raw);}catch{fail('The email response requires review.',502,'INVITE_EMAIL_UNCERTAIN');}
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(result?.id || ''))fail('The email provider did not return a verified receipt.',502,'INVITE_EMAIL_UNCERTAIN');
    return {id:result.id,accepted:true};
  }};
}

export function createInviteDelivery(db,{auth,domain,secret,clock=()=>new Date(),publicBaseUrl,adapter=null,allowExternal=false}={}) {
  const base=safeBase(publicBaseUrl),configured=Boolean(adapter && base && (adapter.simulated===true || allowExternal));
  const digest=value=>createHmac('sha256',secret).update(JSON.stringify(value)).digest('hex');
  return {
    capabilities(){return {configured,provider:configured ? adapter.provider || 'injected_test_adapter' : null,simulated:configured && adapter.simulated===true,
      externalDeliveryAllowed:allowExternal,publicHttpsRequired:true,delivered:false};},
    async list(brandId){return rows(db,'SELECT id,invite_id,operation_id,state,provider_id,error_code,created_at,updated_at FROM brand_invite_deliveries WHERE brand_id=$1 ORDER BY created_at DESC LIMIT 100',[brandId]);},
    async send({brandId,invite,operationId,to}) {
      if(!/^[A-Za-z0-9_-]{8,100}$/.test(operationId || ''))fail('A stable invitation operation ID is required.');
      const b=await domain.getBrand(brandId),recipient=to || b.supportEmail;
      if(invite?.brandId!==brandId || !invite?.id || !invite?.token)fail('A server-created invitation for this brand is required.');
      const authoritative=await auth.lookupInvite(invite.token);
      if(authoritative.brandId!==brandId || authoritative.id!==invite.id)fail('This invitation does not belong to the selected brand.',409,'INVITE_BRAND_MISMATCH');
      if(!configured)return {status:'not_configured',providerAccepted:false,delivered:false,simulated:false,...(email(recipient)?{recipientHint:maskEmail(recipient)}:{})};
      if(!email(recipient))fail('A valid invitation recipient is required.');
      const hash=digest({brandId,inviteId:invite.id,token:invite.token,recipient}),deliveryId=id('invd');
      const prior=await db.transaction(async tx=>{
        const old=await first(tx,'SELECT * FROM brand_invite_deliveries WHERE operation_id=$1 FOR UPDATE',[operationId]);
        if(old){if(old.requestHash!==hash)fail('This operation ID belongs to another invitation.',409,'IDEMPOTENCY_CONFLICT');return old;}
        await tx.query("INSERT INTO brand_invite_deliveries(id,brand_id,invite_id,operation_id,request_hash,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$6)",[deliveryId,brandId,invite.id,operationId,hash,clock()]);return null;
      });
      if(prior)return {id:prior.id,status:prior.state,providerId:prior.providerId,providerAccepted:prior.state==='accepted',delivered:false,replayed:true,simulated:adapter.simulated===true};
      try {
        const link=`${base}/onboard/${encodeURIComponent(invite.token)}`;
        const receipt=await adapter.send({to:recipient,operationId,subject:'Connect your brand to Avafem',
          body:`You have been invited to connect your store to Avafem. Products remain subject to Avafem curation. Payout setup is optional at signup.\n\n${link}\n\nThis signed link expires at ${new Date(authoritative.expiresAt).toISOString()}. If this invitation was unexpected, ignore it.`});
        if(receipt?.accepted!==true || !/^[A-Za-z0-9_-]{1,100}$/.test(receipt?.id || ''))throw new Error('Unverified email receipt');
        await db.query("UPDATE brand_invite_deliveries SET state='accepted',provider_id=$2,updated_at=$3 WHERE id=$1 AND state='pending'",[deliveryId,receipt.id,clock()]);
        return {id:deliveryId,status:'accepted',providerId:receipt.id,providerAccepted:true,delivered:false,simulated:adapter.simulated===true};
      }catch{
        await db.query("UPDATE brand_invite_deliveries SET state='uncertain',error_code='INVITE_EMAIL_UNCERTAIN',updated_at=$2 WHERE id=$1 AND state='pending'",[deliveryId,clock()]);
        return {id:deliveryId,status:'uncertain',providerAccepted:false,delivered:false,requiresReview:true,simulated:adapter.simulated===true};
      }
    },
  };
}
