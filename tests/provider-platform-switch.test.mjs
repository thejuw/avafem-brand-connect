import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db.mjs';
import { createAuth } from '../server/auth.mjs';
import { createUnifiedCheckout } from '../server/unified-checkout.mjs';
import { createProviderMoney } from '../server/provider-money.mjs';
import { createProviderPlatformSwitch, APPROVED_TEST_PLATFORM_SWITCH } from '../server/provider-platform-switch.mjs';
import { TEST_STORES } from '../server/test-stores.mjs';

const RUN = 'uco_8889de980cd044e0a0500cb719bc2034', OTHER_RUN = `uco_${'c'.repeat(32)}`;
const FROM = APPROVED_TEST_PLATFORM_SWITCH.fromAccountId, TO = APPROVED_TEST_PLATFORM_SWITCH.toAccountId;
async function setup(t) {
  const db = await createDatabase({ connectionString: null }); await db.migrate(); t.after(() => db.close());
  const auth = await createAuth(db, { sessionSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') });
  let target = TO, mode = 'test', verified = true; const calls = [];
  const stripe = { preflight: async () => { calls.push('preflight'); return { accountId: target, mode, verified }; } };
  for (const method of ['createCheckoutSession', 'createPaymentIntent', 'createExpressAccount', 'createRefund', 'createTransfer'])
    stripe[method] = async () => { calls.push(`FORBIDDEN_${method}`); throw new Error('No provider writes allowed.'); };
  const stores = { row: async shop => (await db.query('SELECT * FROM provider_test_stores WHERE shop=$1', [shop])).rows[0] };
  const unified = await createUnifiedCheckout(db, auth, { stores, getStripe: () => stripe });
  await createProviderMoney(db, auth, { runtime: unified.runtime, stores, getStripe: () => stripe });
  await db.query(`CREATE TABLE provider_test_stores(shop TEXT PRIMARY KEY,brand_id TEXT NOT NULL,connected_account_id TEXT,
    connected_account_created_in_test BOOLEAN NOT NULL DEFAULT false,connected_account_verified BOOLEAN NOT NULL DEFAULT false)`);
  const snapshot = { id: RUN, currency: 'USD', bags: TEST_STORES.map((store, index) => ({ id: `bag_${String(index).repeat(32)}`,
    shop: store.shop, brandId: `brand_switch_${index}`, items: [{ reference: `bag_${index}:0`, sku: `TEST-${index}`, qty: 2, unitPriceCents: 100 }] })) };
  const details = { accountId: FROM, bags: {}, paymentVerified: false, canonicalCommitted: false,
    sessionStartedAt: new Date().toISOString(), privateFixture: 'PRIVATE_FROZEN_DATA' };
  for (const bag of snapshot.bags) {
    await db.query('INSERT INTO brands(id,name,slug,commission_bps) VALUES($1,$1,$1,1500)', [bag.brandId]);
    await db.query('INSERT INTO provider_test_stores(shop,brand_id) VALUES($1,$2)', [bag.shop, bag.brandId]);
  }
  await db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted,last_error)
    VALUES($1,'switch-request','switch-cart','checkout_needs_review',$2,$3,$4)`, [RUN, auth.encrypt(snapshot), auth.encrypt(details),
    JSON.stringify({ code: 'PROVIDER_OPERATION_UNVERIFIED', message: 'Known local validation failure; operator reviewed no Session POST.' })]);
  await db.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at,last_error)
    VALUES($1,$2,$3,'uncertain',now(),$4)`, [TEST_STORES[0].shop, snapshot.bags[0].brandId, FROM,
    JSON.stringify({ code: 'PROVIDER_MONEY_UNCERTAIN', message: 'PRIVATE_OLD_ERROR' })]);
  const service = await createProviderPlatformSwitch(db, auth, { unifiedCheckout: unified, stores, getStripe: () => stripe });
  const input = { ...APPROVED_TEST_PLATFORM_SWITCH, retireRunIds: [RUN], operatorVerifiedNoProviderObjects: true };
  const row = async () => (await db.query('SELECT * FROM unified_checkout_runs WHERE id=$1', [RUN])).rows[0];
  const alterDetails = async change => { const current = auth.decrypt((await row()).details_encrypted); change(current);
    await db.query('UPDATE unified_checkout_runs SET details_encrypted=$2 WHERE id=$1', [RUN, auth.encrypt(current)]); };
  return { db, auth, stripe, stores, unified, service, input, snapshot, details, calls, row, alterDetails,
    setTarget: value => { target = value; }, setMode: value => { mode = value; }, setVerified: value => { verified = value; } };
}
async function untouched(fx) {
  assert.equal((await fx.row()).state, 'checkout_needs_review');
  assert.equal((await fx.db.query('SELECT id FROM provider_platform_switch_audits')).rows.length, 0);
  assert.equal((await fx.db.query('SELECT id FROM provider_recipient_attempt_history')).rows.length, 0);
  assert.equal((await fx.db.query('SELECT shop FROM provider_recipient_attempts WHERE platform_account_id=$1', [FROM])).rows.length, 1);
}

test('explicit fixed test-platform switch archives old unbound attempt recoverably and retires unpaid run without changing frozen ciphertext/account', async t => {
  const fx = await setup(t), original = await fx.row();
  await fx.db.query(`INSERT INTO provider_recipient_attempts(shop,brand_id,platform_account_id,state,started_at)
    VALUES($1,$2,'acct_otherPlatform123','uncertain',now())`, [TEST_STORES[2].shop, fx.snapshot.bags[2].brandId]);
  const result = await fx.service.switchPlatform(fx.input), retired = await fx.row();
  assert.equal(result.archivedRecipientAttempts, 1); assert.deepEqual(result.retiredRunIds, [RUN]);
  assert.equal(result.verification, 'explicit_operator_attestation_not_automatic_discovery'); assert.equal(result.providerObjectsCreated, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|encrypted|secret/i);
  assert.equal(retired.state, 'abandoned_platform_switch'); assert.equal(retired.checkout_dispatch_complete, true);
  assert.equal(retired.snapshot_encrypted, original.snapshot_encrypted); assert.equal(retired.details_encrypted, original.details_encrypted);
  assert.equal(fx.auth.decrypt(retired.details_encrypted).accountId, FROM); assert.deepEqual(retired.last_error, original.last_error);
  const history = (await fx.db.query('SELECT * FROM provider_recipient_attempt_history')).rows[0];
  assert.doesNotMatch(history.record_encrypted, /PRIVATE_|platform_account_id/);
  const recovered = fx.auth.decrypt(history.record_encrypted); assert.equal(recovered.platform_account_id, FROM);
  assert.equal(recovered.account_id, null); assert.equal(recovered.last_error.message, 'PRIVATE_OLD_ERROR');
  const audit = (await fx.db.query('SELECT * FROM provider_platform_switch_audits')).rows[0];
  const proof = fx.auth.decrypt(audit.proof_encrypted); assert.equal(proof.operatorVerifiedNoProviderObjects, true);
  assert.equal(proof.providerRejectedRequestId, APPROVED_TEST_PLATFORM_SWITCH.providerRejectedRequestId);
  assert.equal((await fx.db.query('SELECT shop FROM provider_recipient_attempts WHERE platform_account_id=$1', [FROM])).rows.length, 0);
  assert.equal((await fx.db.query("SELECT shop FROM provider_recipient_attempts WHERE platform_account_id='acct_otherPlatform123'")).rows.length, 1);
  assert.deepEqual(fx.calls, ['preflight']);
});

test('operator evidence and exact approved old/new accounts/request are mandatory before fresh provider reads', async t => {
  const fx = await setup(t);
  for (const patch of [{ operatorVerifiedNoProviderObjects: false }, { fromAccountId: TO }, { toAccountId: FROM },
    { providerRejectedRequestId: 'req_otherProof123' }, { retireRunIds: [] }, { retireRunIds: [RUN, RUN] }, { retireRunIds: ['uco_unknown'] }])
    await assert.rejects(fx.service.switchPlatform({ ...fx.input, ...patch }));
  assert.equal(fx.calls.length, 0); await untouched(fx);
});

test('fresh test preflight must match the approved new account; old/live/unverified configuration cannot switch', async t => {
  const fx = await setup(t);
  fx.setTarget(FROM); await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_TARGET_UNVERIFIED' });
  fx.setTarget(TO); fx.setMode('live'); await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_TARGET_UNVERIFIED' });
  fx.setMode('test'); fx.setVerified(false); await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_TARGET_UNVERIFIED' });
  await untouched(fx);
});

test('any of three bound or inconsistent recipient registry rows blocks archive/retirement', async t => {
  const fx = await setup(t);
  for (const store of TEST_STORES) {
    await fx.db.query('UPDATE provider_test_stores SET connected_account_id=$2 WHERE shop=$1', [store.shop, 'acct_existingRecipient123']);
    await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RECIPIENT_BOUND' });
    await fx.db.query('UPDATE provider_test_stores SET connected_account_id=NULL WHERE shop=$1', [store.shop]);
  }
  await fx.db.query('UPDATE provider_test_stores SET connected_account_created_in_test=true WHERE shop=$1', [TEST_STORES[0].shop]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RECIPIENT_BOUND' }); await untouched(fx);
});

test('session/payment/charge flags and unknown Bag provider dispatch evidence cannot be retired, including mismatched plaintext/encrypted IDs', async t => {
  const fx = await setup(t);
  for (const [column, value] of [['checkout_session_id', 'cs_test_existing123'], ['payment_intent_id', 'pi_existing123'], ['charge_id', 'ch_existing123']]) {
    await fx.db.query(`UPDATE unified_checkout_runs SET ${column}=$2 WHERE id=$1`, [RUN, value]);
    await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT' });
    await fx.db.query(`UPDATE unified_checkout_runs SET ${column}=NULL WHERE id=$1`, [RUN]);
  }
  for (const patch of [{ sessionId: 'cs_test_unknown123' }, { paymentIntentId: 'pi_unknown123' }, { chargeId: 'ch_unknown123' },
    { paymentVerified: true }, { canonicalCommitted: true }, { captureStartedAt: new Date().toISOString() },
    { bags: { any: { dispatchStartedAt: new Date().toISOString() } } }, { bags: { any: { transferOp: { startedAt: 'unknown' } } } }]) {
    await fx.db.query('UPDATE unified_checkout_runs SET details_encrypted=$2 WHERE id=$1', [RUN, fx.auth.encrypt({ ...fx.details, ...patch })]);
    await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT' });
  }
  await untouched(fx);
});

test('canonical paid rows, active/unresolved leases, unknown state or incomplete old-run selection fail closed', async t => {
  const fx = await setup(t);
  await fx.db.query('UPDATE unified_checkout_runs SET lock_token=$2,lease_until=$3 WHERE id=$1', [RUN, 'active-fixture', new Date(Date.now() + 60000)]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RUN_BUSY' });
  await fx.db.query("UPDATE unified_checkout_runs SET lock_token=NULL,lease_until=NULL,state='unknown_provider_state' WHERE id=$1", [RUN]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RUN_REVIEW' });
  await fx.db.query("UPDATE unified_checkout_runs SET state='checkout_needs_review' WHERE id=$1", [RUN]);
  await assert.rejects(fx.service.switchPlatform({ ...fx.input, retireRunIds: [OTHER_RUN] }), { code: 'PLATFORM_SWITCH_RUN_SELECTION_REQUIRED' });
  await fx.db.query(`INSERT INTO orders(id,order_ref,subtotal_cents,shipping_cents,tax_cents,total_cents) VALUES($1,'CANONICAL-EXISTS',100,0,0,100)`, [RUN]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_CANONICAL_PRESENT' }); await untouched(fx);
});

test('unlisted old-account run and unknown account identity require review, while other-platform paid objects remain untouched', async t => {
  const fx = await setup(t), old = await fx.row();
  const insert = details => fx.db.query(`INSERT INTO unified_checkout_runs(id,request_hash,cart_hash,state,snapshot_encrypted,details_encrypted)
    VALUES($1,'other-switch-request','other-switch-cart','checkout_needs_review',$2,$3)`, [OTHER_RUN, fx.auth.encrypt({ ...fx.snapshot, id: OTHER_RUN }), fx.auth.encrypt(details)]);
  await insert({ ...fx.details });
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RUN_SELECTION_REQUIRED' });
  await fx.db.query('UPDATE unified_checkout_runs SET details_encrypted=$2 WHERE id=$1', [OTHER_RUN, fx.auth.encrypt({ bags: {} })]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_RUN_REVIEW' });
  const foreignDetails = fx.auth.encrypt({ accountId: TO, sessionId: 'cs_test_other123', paymentVerified: true, canonicalCommitted: true, bags: {} });
  await fx.db.query("UPDATE unified_checkout_runs SET state='paid',details_encrypted=$2,checkout_session_id='cs_test_other123' WHERE id=$1", [OTHER_RUN, foreignDetails]);
  await fx.service.switchPlatform(fx.input);
  const foreign = (await fx.db.query('SELECT * FROM unified_checkout_runs WHERE id=$1', [OTHER_RUN])).rows[0];
  assert.equal(foreign.state, 'paid'); assert.equal(foreign.details_encrypted, foreignDetails);
  assert.equal((await fx.row()).snapshot_encrypted, old.snapshot_encrypted);
});

test('old attempts with account IDs, active state or prior controlled retry cannot be silently removed', async t => {
  const fx = await setup(t), shop = TEST_STORES[0].shop;
  await fx.db.query('UPDATE provider_recipient_attempts SET account_id=$2 WHERE shop=$1', [shop, 'acct_unknownExisting123']);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_ATTEMPT_REVIEW' });
  await fx.db.query("UPDATE provider_recipient_attempts SET account_id=NULL,state='creating' WHERE shop=$1", [shop]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_ATTEMPT_REVIEW' });
  await fx.db.query("UPDATE provider_recipient_attempts SET state='uncertain',retry_requested_at=now() WHERE shop=$1", [shop]);
  await assert.rejects(fx.service.switchPlatform(fx.input), { code: 'PLATFORM_SWITCH_ATTEMPT_REVIEW' }); await untouched(fx);
});

test('replayed/concurrent exact switch requests keep one encrypted history/audit/event and do not retire or delete twice', async t => {
  const fx = await setup(t);
  const results = await Promise.all([fx.service.switchPlatform(fx.input), fx.service.switchPlatform(fx.input)]);
  assert.deepEqual(results.map(value => value.replayed).sort(), [false, true]);
  assert.equal(results[0].switchId, results[1].switchId);
  assert.equal((await fx.db.query('SELECT id FROM provider_platform_switch_audits')).rows.length, 1);
  assert.equal((await fx.db.query('SELECT id FROM provider_recipient_attempt_history')).rows.length, 1);
  assert.equal((await fx.db.query("SELECT id FROM outbox_events WHERE type='provider.platform_switch_recorded'")).rows.length, 1);
});

test('archive/delete/retirement are atomic: injected deletion failure rolls every history/audit/state change back', async t => {
  const fx = await setup(t);
  const failingDb = { query: (...args) => fx.db.query(...args), transaction: action => fx.db.transaction(tx => action({ query: (sql, params) => {
    if (/^DELETE FROM provider_recipient_attempts/.test(sql)) throw new Error('controlled fixture transaction failure');
    return tx.query(sql, params);
  } })) };
  const service = await createProviderPlatformSwitch(failingDb, fx.auth, { unifiedCheckout: fx.unified, stores: fx.stores, getStripe: () => fx.stripe });
  await assert.rejects(service.switchPlatform(fx.input)); await untouched(fx);
  assert.equal((await fx.service.switchPlatform(fx.input)).archivedRecipientAttempts, 1);
});
