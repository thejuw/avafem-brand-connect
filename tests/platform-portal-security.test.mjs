import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrandPortal} from '../server/platform/brand-portal.mjs';
import {platformFixture} from './helpers/platform-fixture.mjs';

const operator={owner:true,role:'admin'};
const password='Synthetic strong password 123!';
async function member(f,email,role='owner',brandId='brand_bloom') {
  const invited=await f.platform.portal.addMember(brandId,{email,role},operator);
  const mail=(await f.platform.portal.outbox({memberId:invited.id}))[0];
  const token=/#invite=([A-Za-z0-9_-]{43})/.exec(mail.body)[1];
  const active=await f.platform.portal.consumeLink(token);
  return {...active,ctx:{memberId:active.id,brandId,memberRole:role,role:'brand'},token};
}
const denied=code=>e=>e.code===code;

test('portal security: single-use links, supersession, removal and stale session issuance fail closed',async t=>{
  const f=await platformFixture(t),m=await member(f,'single@example.invalid','staff');
  await f.platform.portal.requestLogin(m.email);
  let mail=(await f.platform.portal.outbox({memberId:m.id}))[0],raw=/#token=([A-Za-z0-9_-]{43})/.exec(mail.body)[1];
  const results=await Promise.allSettled([f.platform.portal.consumeLink(raw),f.platform.portal.consumeLink(raw)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'LOGIN_LINK_INVALID');
  await f.platform.portal.requestLogin(m.email);
  await assert.rejects(f.platform.portal.consumeLink(raw),denied('LOGIN_LINK_INVALID'));
  mail=(await f.platform.portal.outbox({memberId:m.id}))[0];raw=/#token=([A-Za-z0-9_-]{43})/.exec(mail.body)[1];
  await f.platform.portal.removeMember(m.brandId,m.id,operator);
  await assert.rejects(f.platform.portal.consumeLink(raw),denied('LOGIN_LINK_INVALID'));
  await assert.rejects(f.auth.createSession({brandId:m.brandId,memberId:m.id,memberVersion:m.sessionVersion}),denied('SESSION_INVALID'));
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM auth_sessions WHERE member_id=$1',[m.id])).rows[0].n,0);
});

test('portal security: concurrent failures lock once; a success from a stale hash cannot undo a new lock',async t=>{
  const f=await platformFixture(t),m=await member(f,'lock@example.invalid');
  await f.platform.portal.setPassword(m.ctx,{newPassword:password});
  const failures=await Promise.allSettled(Array.from({length:8},()=>f.platform.portal.passwordLogin({email:m.email,password:'wrong password'})));
  assert.ok(failures.every(r=>r.status==='rejected' && r.reason.code==='INVALID_LOGIN'));
  const locked=(await f.db.query('SELECT failed_logins,locked_until FROM brand_members WHERE id=$1',[m.id])).rows[0];
  assert.ok(new Date(locked.locked_until)>f.clock());assert.equal(locked.failed_logins,0);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE action='brand_auth.locked' AND resource_id=$1",[m.id])).rows[0].n,1);
  f.advance(16/(24*60));
  // Force the fifth failure immediately after the password candidate read but
  // before its success transaction; success must re-read the lock, not clear it.
  let injected=false;
  const db={query:f.db.query,transaction:async fn=>{
    if(!injected){injected=true;await f.db.query('UPDATE brand_members SET locked_until=$2 WHERE id=$1',[m.id,new Date(f.clock().getTime()+900_000)]);}
    return f.db.transaction(fn);
  }};
  const stale=createBrandPortal(db,{auth:f.auth,domain:f.domain,brands:f.platform.brands,reports:f.platform.reports,secret:f.config.encryptionKey,clock:f.clock});
  await assert.rejects(stale.passwordLogin({email:m.email,password}),denied('INVALID_LOGIN'));
  assert.ok(new Date((await f.db.query('SELECT locked_until FROM brand_members WHERE id=$1',[m.id])).rows[0].locked_until)>f.clock());
});

test('portal security: concurrent link requests honor the per-member window and concurrent password changes commit once',async t=>{
  const f=await platformFixture(t),m=await member(f,'rotation-race@example.invalid','staff');
  await Promise.all(Array.from({length:6},()=>f.platform.portal.requestLogin(m.email)));
  const tokens=(await f.db.query('SELECT consumed_at FROM brand_login_tokens WHERE member_id=$1',[m.id])).rows;
  assert.equal(tokens.length,3);assert.equal(tokens.filter(t=>!t.consumed_at).length,1);
  await f.platform.portal.setPassword(m.ctx,{newPassword:password});
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM brand_login_tokens WHERE member_id=$1 AND consumed_at IS NULL',[m.id])).rows[0].n,0);
  const oldProof=await f.platform.portal.passwordLogin({email:m.email,password});
  const choices=['Synthetic concurrent password A!','Synthetic concurrent password B!'];
  const rotations=await Promise.allSettled(choices.map(newPassword=>f.platform.portal.setPassword(m.ctx,{currentPassword:password,newPassword})));
  assert.equal(rotations.filter(r=>r.status==='fulfilled').length,1);
  assert.ok(['PASSWORD_CHANGED','INVALID_PASSWORD'].includes(rotations.find(r=>r.status==='rejected').reason.code));
  await assert.rejects(f.auth.createSession({brandId:m.brandId,memberId:m.id,memberVersion:oldProof.sessionVersion}),denied('SESSION_INVALID'));
  const winner=choices[rotations.findIndex(r=>r.status==='fulfilled')];
  assert.equal((await f.platform.portal.passwordLogin({email:m.email,password:winner})).id,m.id);
});

test('portal security: password removal, rotation and corrupt/ambiguous credentials never mint a stale session',async t=>{
  const f=await platformFixture(t),m=await member(f,'shared@example.invalid','staff');
  await f.platform.portal.setPassword(m.ctx,{newPassword:password});
  const proof=await f.platform.portal.passwordLogin({email:m.email,password});
  await f.platform.portal.setPassword(m.ctx,{currentPassword:password,newPassword:'Different synthetic password 456!'});
  await assert.rejects(f.auth.createSession({brandId:m.brandId,memberId:m.id,memberVersion:proof.sessionVersion}),denied('SESSION_INVALID'));
  const second=await member(f,m.email,'staff','brand_lunelle');
  await f.platform.portal.setPassword(second.ctx,{newPassword:password});
  await assert.rejects(f.platform.portal.passwordLogin({email:m.email,password}),denied('INVALID_LOGIN'));
  assert.equal((await f.platform.portal.passwordLogin({email:m.email,password,brandId:'brand_lunelle'})).id,second.id);
  await f.db.query("UPDATE brand_members SET password_hash='scrypt$1073741824$8$1$corrupt$corrupt' WHERE id=$1",[second.id]);
  await assert.rejects(f.platform.portal.passwordLogin({email:m.email,password,brandId:'brand_lunelle'}),denied('INVALID_LOGIN'));
  let removed=false;
  const db={query:f.db.query,transaction:async fn=>{
    if(!removed){removed=true;await f.platform.portal.removeMember(m.brandId,m.id,operator);}
    return f.db.transaction(fn);
  }};
  const stale=createBrandPortal(db,{auth:f.auth,domain:f.domain,brands:f.platform.brands,reports:f.platform.reports,secret:f.config.encryptionKey,clock:f.clock});
  await assert.rejects(stale.passwordLogin({email:m.email,password:'Different synthetic password 456!',brandId:m.brandId}),denied('INVALID_LOGIN'));
});

test('portal security: concurrent owner demotions retain an active owner, and stale owners cannot invite',async t=>{
  const f=await platformFixture(t),a=await member(f,'owner-a@example.invalid'),b=await member(f,'owner-b@example.invalid');
  const outcomes=await Promise.allSettled([f.platform.portal.changeRole(a.brandId,a.id,'staff',a.ctx),f.platform.portal.changeRole(b.brandId,b.id,'staff',b.ctx)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM brand_members WHERE brand_id=$1 AND role='owner' AND status='active'",[a.brandId])).rows[0].n,1);
  const stale=(await f.db.query('SELECT role FROM brand_members WHERE id=$1',[a.id])).rows[0].role==='staff'?a:b;
  await assert.rejects(f.platform.portal.addMember(a.brandId,{email:'injected@example.invalid',role:'owner'},stale.ctx),denied('IDENTIFIED_OWNER_REQUIRED'));
  await assert.rejects(f.platform.portal.addMember(a.brandId,{email:'capability@example.invalid',role:'owner'},{brandId:a.brandId,role:'brand',memberRole:'owner'}),denied('IDENTIFIED_OWNER_REQUIRED'));
  // An unaccepted owner invitation is not an available last owner.
  const active=a===stale?b:a;
  await f.platform.portal.addMember(a.brandId,{email:'pending-owner@example.invalid',role:'owner'},operator);
  await assert.rejects(f.platform.portal.removeMember(a.brandId,active.id,operator),denied('LAST_OWNER'));
});

test('managed API keys: active-owner authority, concurrent secret-once replay, hash-only storage and tenant-safe revocation',async t=>{
  const f=await platformFixture(t),owner=await member(f,'key-owner@example.invalid');
  const input={operationId:'managed_api_key_once',scopes:['orders:read','catalog:read'],label:'Fixture key'};
  const results=await Promise.all([f.auth.createManagedApiKey(owner.brandId,input,owner.ctx),f.auth.createManagedApiKey(owner.brandId,input,owner.ctx)]);
  const first=results.find(r=>r.apiKey),replay=results.find(r=>r.replayed);
  assert.ok(first.apiKey);assert.equal(replay.apiKey,undefined);assert.equal(replay.secretAvailable,false);assert.equal(first.id,replay.id);
  assert.equal((await f.auth.resolveBearer(first.apiKey)).brandId,owner.brandId);
  const raw=JSON.stringify((await f.db.query('SELECT * FROM api_credentials')).rows)+JSON.stringify((await f.db.query('SELECT * FROM member_api_key_operations')).rows)+JSON.stringify((await f.db.query('SELECT * FROM audit_log')).rows);
  assert.ok(!raw.includes(first.apiKey));
  await assert.rejects(f.auth.createManagedApiKey(owner.brandId,{...input,scopes:['payouts:read']},owner.ctx),denied('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.auth.createManagedApiKey(owner.brandId,{...input,operationId:'bad_privileged_scope',scopes:['members:manage']},owner.ctx),denied('INVALID_SCOPES'));
  await assert.rejects(f.auth.revokeManagedApiKey('brand_lunelle',first.id,operator),denied('NOT_FOUND'));
  assert.equal((await f.auth.revokeManagedApiKey(owner.brandId,first.id,owner.ctx)).replayed,false);
  assert.equal((await f.auth.revokeManagedApiKey(owner.brandId,first.id,owner.ctx)).replayed,true);
  assert.equal(await f.auth.resolveBearer(first.apiKey),null);
  const oauth=await f.auth.createCredential(owner.brandId,{kind:'oauth_client',scopes:['orders:read']});
  await assert.rejects(f.auth.revokeManagedApiKey(owner.brandId,oauth.id,owner.ctx),denied('NOT_FOUND'));
  await f.platform.portal.addMember(owner.brandId,{email:'second-owner@example.invalid',role:'owner'},operator);
  await member(f,'actual-owner@example.invalid');
  await f.platform.portal.changeRole(owner.brandId,owner.id,'staff',operator);
  await assert.rejects(f.auth.createManagedApiKey(owner.brandId,{...input,operationId:'demoted_owner_denied'},owner.ctx),denied('IDENTIFIED_OWNER_REQUIRED'));
});
