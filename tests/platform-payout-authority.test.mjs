import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {createDomain} from '../server/domain.mjs';
import {createBeautyBank} from '../server/platform/money.mjs';

const fakeFlags=async(f,brandId,account='acct_sandbox_spoofed')=>f.db.query(`UPDATE brands SET onboarding_mode='two_step',payout_setup='complete',stripe_account_id=$2,
  charges_enabled=TRUE,payouts_enabled=TRUE,status='live',connection_healthy=TRUE WHERE id=$1`,[brandId,account]);

test('entering two-step onboarding discards legacy simulation authority and holds existing pending money atomically',async t=>{
  const f=await platformFixture(t),brandId='brand_hearth',bag=await f.bagFor(await f.seedOrder(),brandId);
  assert.equal((await f.domain.getBrand(brandId)).payoutsEnabled,true,'untouched legacy fixture retains its simulation');
  const first=await f.domain.enterTwoStepOnboarding(brandId,{actor:'test_owner'});
  assert.equal(first.onboardingMode,'two_step');assert.equal(first.status,'onboarding');assert.equal(first.payoutSetup,'deferred');
  assert.equal(first.stripeAccountId,null);assert.equal(first.chargesEnabled,false);assert.equal(first.payoutsEnabled,false);
  assert.equal((await f.domain.listTransfers({brandId}))[0].status,'held');assert.equal((await f.domain.listJobs({brandId}))[0].status,'held');
  await f.domain.enterTwoStepOnboarding(brandId,{actor:'test_owner'});
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM curation_audit WHERE brand_id=$1 AND action='two_step_entered'",[brandId])).rows[0].n,1);
  await assert.rejects(f.domain.updateBrand(brandId,{stripeAccountId:'acct_sandbox_reinjected',payoutsEnabled:true,chargesEnabled:true}),e=>e.code==='USE_ONBOARDING_PAYOUT_FLOW');
  f.advance(90);assert.equal((await f.domain.runDueSandboxPayouts()).processed,0);
  assert.equal((await f.domain.listCredits({brandId}))[0].status,'pending');assert.equal((await f.domain.getBag(bag.id)).status,'delivered');
});

test('raw fake account flags cannot create newflow completion claims, clear holds, release credits or pass payout checks',async t=>{
  const f=await platformFixture(t),brandId='brand_hearth',orderId=await f.seedOrder(),bag=await f.bagFor(orderId,brandId);
  const shopper=await f.platform.crm.upsertShopper({email:'payout-proof-fixture@example.invalid'});
  await f.platform.crm.linkOrder(shopper.id,orderId);await f.platform.bank.earnForOrder(shopper.id,orderId);
  await fakeFlags(f,brandId);f.advance(31);
  assert.equal(await f.domain.twoStepPayoutReady(brandId),false);
  const status=await f.platform.onboarding.status(brandId);assert.notEqual(status.steps.payouts.status,'complete');assert.equal(status.capabilities.payouts.providerVerified,false);assert.ok(status.payoutNotice);
  const risk=await f.platform.risk.brandPayoutCheck(brandId);assert.equal(risk.pass,false);assert.ok(risk.reasons.includes('PAYOUTS_NOT_ENABLED'));
  const dispute=await f.platform.console.openDispute({externalId:'dp_fake_payout_proof',bagId:bag.id});await f.platform.console.resolveDispute(dispute.id,'won');
  const transfer=(await f.domain.listTransfers({brandId}))[0];assert.equal(transfer.status,'held');assert.equal((await f.domain.listJobs({brandId}))[0].status,'held');
  await assert.rejects(f.platform.console.releaseHold(transfer.id,{idempotencyKey:'fake_payout_release',reason:'Attempted release using synthetic unverified flags.'},'test_owner'),e=>e.code==='HOLD_BLOCKED');
  await f.db.query("UPDATE transfers SET status='scheduled' WHERE bag_id=$1",[bag.id]);await f.db.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1",[bag.id]);
  const credit=(await f.domain.listCredits({brandId}))[0];
  await assert.rejects(f.platform.console.resolvePendingCredit(credit.id,{action:'release',idempotencyKey:'fake_credit_release',reason:'Attempted credit release with unverified payout flags.'},'test_owner'),e=>e.code==='CREDIT_RELEASE_BLOCKED');
  assert.equal(await f.platform.bank.mature(),0);
  const independent=createBeautyBank(f.db,{clock:f.clock});assert.equal(await independent.mature(),0,'missing domain verifier is fail closed for newflow');
  assert.equal((await f.platform.bank.lots(shopper.id)).find(l=>l.bagId===bag.id).state,'LAB');
  assert.equal((await f.domain.runDueSandboxPayouts()).processed,0);assert.equal((await f.domain.listTransfers({brandId}))[0].status,'held');
});

test('newflow requires exact server-owned test proof; simulated or malformed account IDs never qualify',async t=>{
  const f=await platformFixture(t),brandId='brand_hearth';let proofCalls=0;
  const callbackDomain=createDomain(f.db,{clock:f.clock,verifyTwoStepPayout:async input=>{proofCalls++;return {verified:true,provider:'stripe',mode:'test',...input,chargesEnabled:true,payoutsEnabled:true};}});
  for(const account of ['acct_sandbox_injected','not_a_stripe_account','acct_']) {
    await fakeFlags(f,brandId,account);assert.equal(await callbackDomain.twoStepPayoutReady(brandId),false);
  }
  assert.equal(proofCalls,0,'invalid/simulated identity is rejected before even a trusted verifier');
  await fakeFlags(f,brandId,'acct_fixtureRealShape123');assert.equal(await f.domain.twoStepPayoutReady(brandId),false,'raw plausible ID is not evidence');
  const wrong=createDomain(f.db,{clock:f.clock,verifyTwoStepPayout:async input=>({verified:true,provider:'stripe',mode:'test',...input,brandId:'brand_bloom',chargesEnabled:true,payoutsEnabled:true})});
  assert.equal(await wrong.twoStepPayoutReady(brandId),false);
  await f.db.query("UPDATE brands SET onboarding_state=$2 WHERE id=$1",[brandId,JSON.stringify({platform:'csv',connected:true,catalogImportComplete:true,profileVerified:true})]);
  await f.db.query("INSERT INTO brand_connectors(brand_id,platform,store_ref,created_at) VALUES($1,'csv','fixture',NOW())",[brandId]);
  const activated=await f.domain.activateConnectedBrand(brandId);
  assert.equal(activated.payoutSetup,'deferred');assert.equal(activated.stripeAccountId,null);assert.equal(activated.payoutsEnabled,false);
});
