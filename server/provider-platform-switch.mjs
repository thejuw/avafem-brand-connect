import { createHash } from 'node:crypto';
import { TEST_STORES } from './test-stores.mjs';

export const APPROVED_TEST_PLATFORM_SWITCH = Object.freeze({
  fromAccountId: 'acct_1U74iIK2dD4gO5zD',
  toAccountId: 'acct_1U74iQGgawRtH2qe',
  providerRejectedRequestId: 'req_sXbtKiQwUqATgM',
});
const runId = value => typeof value === 'string' && /^uco_[a-f0-9]{32}$/.test(value);
const accountId = value => typeof value === 'string' && /^acct_[A-Za-z0-9]{8,}$/.test(value);
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode, unifiedSafe: true }); };
const safeResult = (row, replayed = false) => ({ switchId: row.id, fromAccountId: row.from_account_id, toAccountId: row.to_account_id,
  retiredRunIds: row.retired_run_ids, archivedRecipientAttempts: row.archived_attempts, test: true, replayed,
  verification: 'explicit_operator_attestation_not_automatic_discovery', providerObjectsCreated: 0 });

/** One explicitly authorized platform correction, not a payment/account migration.
 * No provider write exists in this module. Operator attestation is REQUIRED and
 * is not relabelled as an automated discovery that provider objects do not exist.
 * Frozen old run ciphertext/account identity stays unchanged and recoverable.
 */
export async function createProviderPlatformSwitch(db, auth, { unifiedCheckout, stores, getStripe } = {}) {
  if (!db?.transaction || !auth?.encrypt || !auth?.decrypt || !unifiedCheckout?.runtime?.decode || !stores?.row || typeof getStripe !== 'function')
    fail('PLATFORM_SWITCH_SETUP_REQUIRED', 'An encrypted unified runtime, registry and verified Stripe test adapter are required.', 503);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_platform_switch_audits (
    id TEXT PRIMARY KEY,from_account_id TEXT NOT NULL,to_account_id TEXT NOT NULL,
    retired_run_ids JSONB NOT NULL,archived_attempts INTEGER NOT NULL,
    proof_encrypted TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS provider_recipient_attempt_history (
    id TEXT PRIMARY KEY,switch_id TEXT NOT NULL REFERENCES provider_platform_switch_audits(id),
    shop TEXT NOT NULL,platform_account_id TEXT NOT NULL,record_encrypted TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(switch_id,shop)
  )`);

  async function switchPlatform({ fromAccountId, toAccountId, retireRunIds, operatorVerifiedNoProviderObjects, providerRejectedRequestId } = {}) {
    const approved = APPROVED_TEST_PLATFORM_SWITCH;
    if (fromAccountId !== approved.fromAccountId || toAccountId !== approved.toAccountId
      || providerRejectedRequestId !== approved.providerRejectedRequestId || operatorVerifiedNoProviderObjects !== true)
      fail('PLATFORM_SWITCH_APPROVAL_REQUIRED', 'Only the explicitly approved old/new test accounts and observed rejection proof are permitted.', 422);
    if (!Array.isArray(retireRunIds) || !retireRunIds.length || retireRunIds.length > 20 || retireRunIds.some(value => !runId(value))
      || new Set(retireRunIds).size !== retireRunIds.length)
      fail('PLATFORM_SWITCH_RUNS_INVALID', 'Specify the exact unique known unpaid unified run IDs.', 422);
    const selectedIds = [...retireRunIds].sort();
    let checked;
    try { checked = await getStripe().preflight(); }
    catch { fail('PLATFORM_SWITCH_TARGET_UNVERIFIED', 'Fresh verification of the approved target Stripe test account is required.'); }
    if (checked?.verified !== true || checked.mode !== 'test' || checked.accountId !== toAccountId)
      fail('PLATFORM_SWITCH_TARGET_UNVERIFIED', 'Fresh verification must identify the approved target account in test mode.');
    const switchId = `platform_switch_${createHash('sha256').update(JSON.stringify({ fromAccountId, toAccountId, selectedIds, providerRejectedRequestId })).digest('hex').slice(0, 32)}`;
    const wall = new Date();
    return db.transaction(async tx => {
      // Rows are locked together so a bind/checkout claim cannot race retirement.
      const registry = (await tx.query('SELECT * FROM provider_test_stores WHERE shop=ANY($1) ORDER BY shop FOR UPDATE', [TEST_STORES.map(store => store.shop)])).rows;
      if (registry.length !== TEST_STORES.length || registry.some(row => !row.brand_id || row.connected_account_id !== null
        || row.connected_account_created_in_test === true || row.connected_account_verified === true))
        fail('PLATFORM_SWITCH_RECIPIENT_BOUND', 'All three exact registry stores must remain unbound; linked or inconsistent recipients require manual review.');
      const prior = (await tx.query('SELECT * FROM provider_platform_switch_audits WHERE id=$1 FOR UPDATE', [switchId])).rows[0];
      const rows = (await tx.query('SELECT * FROM unified_checkout_runs ORDER BY id FOR UPDATE')).rows;
      const decoded = [];
      for (const row of rows) {
        let data;
        try { data = unifiedCheckout.runtime.decode(row); }
        catch { fail('PLATFORM_SWITCH_RUN_REVIEW', 'An encrypted run identity cannot be verified; no platform records were changed.'); }
        if (!accountId(data?.details?.accountId)) fail('PLATFORM_SWITCH_RUN_REVIEW', 'An unknown unified run account requires operator review before switching.');
        if (data.details.accountId === fromAccountId) decoded.push({ row, ...data });
      }
      if (decoded.length !== selectedIds.length || decoded.some(({ row }) => !selectedIds.includes(row.id)))
        fail('PLATFORM_SWITCH_RUN_SELECTION_REQUIRED', 'The selected IDs must cover exactly all known runs on the old platform; unlisted runs require review.');
      const snapshotBagIds = [];
      for (const { row, snapshot, details } of decoded) {
        if (snapshot?.id !== row.id || !Array.isArray(snapshot.bags) || snapshot.bags.length !== TEST_STORES.length)
          fail('PLATFORM_SWITCH_RUN_REVIEW', 'Frozen run/store identities do not verify.');
        if (row.lock_token !== null || (row.lease_until && new Date(row.lease_until) > wall))
          fail('PLATFORM_SWITCH_RUN_BUSY', 'An active or unresolved run lease must finish before switching.');
        if (row.checkout_session_id !== null || row.payment_intent_id !== null || row.charge_id !== null
          || [details.sessionId, details.paymentIntentId, details.chargeId].some(value => value !== undefined && value !== null)
          || ![undefined, false].includes(details.paymentVerified) || ![undefined, false].includes(details.canonicalCommitted))
          fail('PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT', 'Existing or unknown Session/payment/charge/canonical evidence cannot be retired or moved.');
        if (!['checkout_creating', 'checkout_needs_review'].includes(row.state)
          && !(prior && row.state === 'abandoned_platform_switch' && row.checkout_dispatch_complete === true))
          fail('PLATFORM_SWITCH_RUN_REVIEW', 'Only known pre-payment failed runs may be explicitly retired.');
        if (details.sessionUrl || details.captureStartedAt || details.captureVerifiedAt || details.authorizationCancelled)
          fail('PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT', 'Provider-dispatch or authorization evidence requires separate reconciliation.');
        for (const bag of snapshot.bags) {
          const bound = registry.find(value => value.shop === bag.shop);
          if (!bound || bound.brand_id !== bag.brandId || typeof bag.id !== 'string' || !bag.id)
            fail('PLATFORM_SWITCH_RUN_REVIEW', 'Frozen Bag/store bindings must remain exact.');
          snapshotBagIds.push(bag.id);
        }
        if (new Set(snapshot.bags.map(bag => bag.shop)).size !== TEST_STORES.length)
          fail('PLATFORM_SWITCH_RUN_REVIEW', 'Every old checkout must contain the three exact unique stores.');
        for (const bag of Object.values(details.bags ?? {})) if (bag && (bag.verified === true || bag.orderId || bag.dispatchStartedAt
          || bag.transferId || bag.transferOp || bag.payoutId || bag.payoutOp || bag.cancelOp || Object.keys(bag.refundOps ?? {}).length))
          fail('PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT', 'Existing or unknown Shopify/money operations require review; no replacement was authorized.');
      }
      const canonical = (await tx.query('SELECT id FROM orders WHERE id=ANY($1)', [selectedIds])).rows;
      if (canonical.length || (await tx.query('SELECT id FROM bags WHERE order_id=ANY($1)', [selectedIds])).rows.length)
        fail('PLATFORM_SWITCH_CANONICAL_PRESENT', 'Canonical paid-order data cannot be moved or retired by this operation.');
      for (const table of ['external_orders', 'provider_money_bookings']) {
        const exists = (await tx.query('SELECT to_regclass($1) AS name', [`public.${table}`])).rows[0]?.name;
        if (!exists) continue;
        const any = table === 'external_orders'
          ? (await tx.query('SELECT bag_id FROM external_orders WHERE bag_id=ANY($1) LIMIT 1', [snapshotBagIds])).rows.length
          : (await tx.query('SELECT business_key FROM provider_money_bookings WHERE run_id=ANY($1) LIMIT 1', [selectedIds])).rows.length;
        if (any) fail('PLATFORM_SWITCH_PROVIDER_OBJECTS_PRESENT', 'Canonical provider dispatch/money records require separate reconciliation.');
      }
      const attempts = (await tx.query('SELECT * FROM provider_recipient_attempts WHERE platform_account_id=$1 ORDER BY shop FOR UPDATE', [fromAccountId])).rows;
      for (const attempt of attempts) {
        const bound = registry.find(value => value.shop === attempt.shop);
        if (!bound || bound.brand_id !== attempt.brand_id || attempt.account_id !== null || attempt.state !== 'uncertain'
          || attempt.retry_requested_at != null)
          fail('PLATFORM_SWITCH_ATTEMPT_REVIEW', 'Only exact unbound old attempts covered by the observed initial rejection may be archived; active/retried/linked attempts require review.');
      }
      if (prior) {
        if (attempts.length) fail('PLATFORM_SWITCH_NEW_ATTEMPT', 'New old-platform attempts appeared after the audited switch; they require separate review.');
        return safeResult(prior, true);
      }
      const proof = { operatorVerifiedNoProviderObjects: true, providerRejectedRequestId,
        verification: 'explicit_operator_attestation_not_automatic_discovery', fromAccountId, toAccountId,
        freshTargetTestPreflight: { accountId: checked.accountId, mode: checked.mode, verified: checked.verified },
        retiredRunIds: selectedIds, originalRunStates: decoded.map(({ row }) => ({ id: row.id, state: row.state })),
        archivedShops: attempts.map(attempt => attempt.shop), recordedAt: wall.toISOString(), providerObjectsCreatedByThisFunction: 0 };
      const audit = (await tx.query(`INSERT INTO provider_platform_switch_audits(id,from_account_id,to_account_id,retired_run_ids,archived_attempts,proof_encrypted)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [switchId, fromAccountId, toAccountId, JSON.stringify(selectedIds), attempts.length, auth.encrypt(proof)])).rows[0];
      for (const attempt of attempts) {
        const historyId = `recipient_history_${createHash('sha256').update(`${switchId}:${attempt.shop}`).digest('hex').slice(0, 32)}`;
        await tx.query(`INSERT INTO provider_recipient_attempt_history(id,switch_id,shop,platform_account_id,record_encrypted)
          VALUES($1,$2,$3,$4,$5)`, [historyId, switchId, attempt.shop, fromAccountId, auth.encrypt(attempt)]);
      }
      if (attempts.length) {
        const removed = await tx.query(`DELETE FROM provider_recipient_attempts WHERE shop=ANY($1) AND platform_account_id=$2 AND account_id IS NULL RETURNING shop`,
          [attempts.map(attempt => attempt.shop), fromAccountId]);
        if (removed.rows.length !== attempts.length) fail('PLATFORM_SWITCH_ATOMIC_GUARD', 'Recipient attempt identity changed; the entire switch was rolled back.');
      }
      const retired = await tx.query(`UPDATE unified_checkout_runs SET state='abandoned_platform_switch',checkout_dispatch_complete=true,
        updated_at=$2 WHERE id=ANY($1) AND checkout_session_id IS NULL AND payment_intent_id IS NULL AND charge_id IS NULL RETURNING id`, [selectedIds, wall]);
      if (retired.rows.length !== selectedIds.length) fail('PLATFORM_SWITCH_ATOMIC_GUARD', 'Run identities changed; the entire switch was rolled back.');
      await unifiedCheckout.runtime.emit(tx, 'provider.platform_switch_recorded', switchId, null,
        { switchId, fromAccountId, toAccountId, retiredRunIds: selectedIds, archivedRecipientAttempts: attempts.length,
          verification: 'explicit_operator_attestation_not_automatic_discovery', sandbox: true });
      return safeResult(audit);
    });
  }
  return { switchPlatform };
}
