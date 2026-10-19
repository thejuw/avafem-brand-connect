import { createHmac, randomBytes } from 'node:crypto';
import { id, sha, first, rows, fail, text, int, keyring, DAY } from './util.mjs';
import { cyclePhase } from './health.mjs';

/** Cross-brand subscriptions / auto-replenish. One subscription can hold items from several
 * brands; each run creates one canonical sandbox order (split into per-brand Bags by the core)
 * and a mocked charge, never a real Stripe integration. Known declines retry each day;
 * unknown outcomes stay paused for operator review and are never charged again automatically. */
export function createSubscriptions(db, { clock, domain, crm, health, bank, secret, charge }) {
  const now = () => clock();
  const pii = keyring(secret, 'shopper-pii');
  const reviewSecrets = keyring(secret, 'subscription-review');
  const defaultCharge = async ({ amountCents, paymentRef, idempotencyKey }) => paymentRef.endsWith('_fail') ? { ok: false, error: 'card_declined' } : { ok: true, ref: `pi_sim_${sha(idempotencyKey).slice(0, 24)}`, amountCents };
  const safeCode = (value, fallback) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value || '') ? value : fallback;
  const chargeRef = value => typeof value === 'string' && /^pi_sim_[A-Za-z0-9_]{1,100}$/.test(value) ? value : null;
  const blockedStatuses = ['claimed', 'charge_started', 'order_created', 'uncertain', 'review_pending', 'paid'];
  const unresolvedStatuses = ['claimed', 'charge_started', 'order_created', 'uncertain', 'review_pending'];
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  const attemptKey = (s, a) => `sub:${s.id}:${a.cycle}:attempt:${a.attempt}`;
  const orderKey = (s, a) => `SUB-${s.id}-${a.cycle}-A${a.attempt}`;
  const requestFingerprint = (s, a, amountCents) => createHmac('sha256', secret).update(JSON.stringify(canonical({ subscriptionId: s.id, shopperId: s.shopperId, cycle: a.cycle, attempt: a.attempt, currency: 'USD', items: s.items, shipTo: pii.decrypt(s.shipToEnc), amountCents }))).digest('hex');
  const acknowledgements = { declined: 'I_VERIFIED_THIS_SIMULATED_ATTEMPT_IS_DECLINED', voided: 'I_VERIFIED_THIS_SIMULATED_CHARGE_IS_VOIDED' };
  const readEvidence = a => { try { return a.chargeEvidenceEnc ? reviewSecrets.decrypt(a.chargeEvidenceEnc) : null; } catch { fail('Stored simulated charge evidence could not be verified.', 409, 'SUBSCRIPTION_EVIDENCE_INVALID'); } };
  const paidEvidence = (s, a) => {
    const e = readEvidence(a);
    return Boolean(e && e.source === 'validated_simulated_charge' && e.outcome === 'paid' && e.currency === 'USD'
      && chargeRef(e.ref) && e.ref === a.chargeRef && e.amountCents === a.amountCents && Number.isSafeInteger(e.amountCents) && e.amountCents > 0
      && e.attemptKey === attemptKey(s, a) && a.requestFingerprint && e.requestFingerprint === a.requestFingerprint);
  };
  const reviewMeta = (input, action) => {
    if (!/^[A-Za-z0-9_:-]{8,160}$/.test(input.operationId || '')) fail('A stable operationId is required.');
    if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 1000) fail('Give a review reason of 10–1000 characters.');
    if (!/^[A-Za-z0-9_:-]{1,120}$/.test(input.actor || '')) fail('An authenticated operator actor is required.');
    const reason = input.reason.trim();
    const requestHash = createHmac('sha256', secret).update(JSON.stringify(canonical({ action, subscriptionId: input.subscriptionId,
      attemptId: input.attemptId || null, operationId: input.operationId, actor: input.actor, reason, proof: input.proof || null }))).digest('hex');
    return { ...input, action, reason, requestHash };
  };
  const safeResult = (s, input, extra = {}) => ({ subscriptionId: s.id, operationId: input.operationId, action: input.action,
    simulated: true, providerVerified: false, reasonRecorded: true, ...extra });
  async function validateAttestation(tx, s, a, input) {
    const p = input.proof;
    const allowed = ['source', 'reference', 'observedAt', 'attemptKey', 'requestFingerprint', 'chargeRef', 'acknowledgement'];
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(key => !allowed.includes(key))
      || p.source !== 'operator_mock_review' || !/^mockproof_[A-Za-z0-9_-]{8,100}$/.test(p.reference || '')
      || p.attemptKey !== attemptKey(s, a) || p.requestFingerprint !== (a.requestFingerprint || 'legacy_unavailable')
      || p.acknowledgement !== acknowledgements[input.resolution] || (p.chargeRef ?? null) !== (a.chargeRef ?? null))
      fail('Explicit, exact simulated-attempt attestation is required.', 422, 'SUBSCRIPTION_PROOF_REQUIRED');
    const observed = typeof p.observedAt === 'string' ? Date.parse(p.observedAt) : NaN;
    if (!Number.isFinite(observed) || observed < Date.parse(a.createdAt) || observed > now().getTime() + 60_000 || observed < now().getTime() - DAY)
      fail('Attestation must be freshly observed for this attempt.', 422, 'SUBSCRIPTION_PROOF_REQUIRED');
    if (a.chargeRef && !chargeRef(a.chargeRef)) fail('Non-simulated charge references cannot be resolved here.', 409, 'SUBSCRIPTION_NOT_SIMULATED');
    if (input.resolution === 'declined' && (a.chargeRef || paidEvidence(s, a))) fail('A known simulated payment cannot be dismissed as declined.', 409, 'SUBSCRIPTION_PAID_EVIDENCE');
    const order = await first(tx, 'SELECT * FROM orders WHERE order_ref=$1', [`SANDBOX-${orderKey(s, a)}`]);
    if (a.orderId && order?.id !== a.orderId) fail('The stored order identity needs review.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
    if (order) {
      const bags = await rows(tx, 'SELECT * FROM bags WHERE order_id=$1', [order.id]);
      if (input.resolution !== 'voided' || !order.sandbox || order.refundedCents !== order.totalCents || !bags.length
        || bags.some(b => b.providerBound || !b.sandbox || b.refundedCents !== b.totalCents || !['refunded', 'cancelled'].includes(b.status)))
        fail('An existing order must be fully refunded before a simulated void can be recorded.', 409, 'SUBSCRIPTION_ORDER_STILL_PAYABLE');
    }
  }
  async function reserveReview(input, action) {
    const p = reviewMeta(input, action);
    return db.transaction(async tx => {
      const previous = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 FOR UPDATE', [p.operationId]);
      if (previous && previous.requestHash !== p.requestHash) fail('Operation ID was used for a different review.', 409, 'IDEMPOTENCY_CONFLICT');
      if (previous && previous.state !== 'pending') return { p, replay: { ...previous.response, replayed: true } };
      const s = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [p.subscriptionId]);
      if (!s) fail('Subscription not found.', 404, 'NOT_FOUND');
      if (action !== 'cancel' && await first(tx, "SELECT operation_id FROM subscription_review_actions WHERE subscription_id=$1 AND state='pending' AND operation_id<>$2", [s.id, p.operationId]))
        fail('Another review action is in progress.', 409, 'SUBSCRIPTION_REVIEW_BUSY');
      if (action === 'resume' && !['paused', 'past_due'].includes(s.status)) fail('Only a paused subscription can be resumed.', 409, 'SUBSCRIPTION_NOT_PAUSED');
      let a = null;
      if (action.startsWith('reconcile_')) {
        if (!/^sub_sim_[A-Za-z0-9_]+$/.test(s.providerRef || '')) fail('Only simulated subscriptions can be resolved here.', 409, 'SUBSCRIPTION_NOT_SIMULATED');
        a = await first(tx, 'SELECT * FROM subscription_attempts WHERE id=$1 AND subscription_id=$2 FOR UPDATE', [p.attemptId, s.id]);
        if (!a) fail('Subscription attempt not found.', 404, 'NOT_FOUND');
        if ((!previous && a.status !== 'uncertain') || (previous && a.status !== 'review_pending'))
          fail('Only a finished, uncertain worker attempt can be reconciled. Active claims need a worker fence.', 409, 'SUBSCRIPTION_WORKER_FENCE_REQUIRED');
        if (await first(tx, 'SELECT id FROM subscription_attempts WHERE subscription_id=$1 AND id<>$2 AND status=ANY($3::text[])', [s.id, a.id, unresolvedStatuses]))
          fail('Resolve other active claims before reconciling.', 409, 'SUBSCRIPTION_REVIEW_BUSY');
        if (p.resolution === 'paid') {
          const shopper = await first(tx, 'SELECT deleted_at FROM shoppers WHERE id=$1 FOR UPDATE', [s.shopperId]);
          if (s.status === 'cancelled' || !s.shipToEnc || !shopper || shopper.deletedAt) fail('Cancelled or erased subscriptions cannot create orders.', 409, 'SUBSCRIPTION_INACTIVE');
          if (p.proof || !paidEvidence(s, a) || requestFingerprint(s, a, a.amountCents) !== a.requestFingerprint)
            fail('Exact persisted simulated-payment evidence is required.', 409, 'SUBSCRIPTION_PAID_PROOF_REQUIRED');
          if (a.cycle > s.cycleCount + 1) fail('The paid cycle sequence needs review.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
          if (a.cycle <= s.cycleCount) {
            const paidRun = await first(tx, "SELECT * FROM subscription_runs WHERE subscription_id=$1 AND cycle=$2 AND status='paid'", [s.id, a.cycle]);
            if (!a.orderId || paidRun?.orderId !== a.orderId || paidRun.chargeRef !== a.chargeRef || paidRun.amountCents !== a.amountCents)
              fail('An advanced cycle requires its exact existing paid run.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
          }
          if (a.orderId) {
            const originalOrder = await first(tx, 'SELECT * FROM orders WHERE id=$1', [a.orderId]);
            if (!originalOrder?.sandbox || originalOrder.currency !== 'USD' || originalOrder.orderRef !== `SANDBOX-${orderKey(s, a)}` || originalOrder.totalCents !== a.amountCents)
              fail('The stored canonical order identity needs review.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
          }
        } else await validateAttestation(tx, s, a, p);
      }
      if (!previous) await tx.query(`INSERT INTO subscription_review_actions(operation_id,subscription_id,attempt_id,action,state,request_hash,actor,reason_enc,proof_enc,created_at,updated_at)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$9)`, [p.operationId, s.id, a?.id || null, action, p.requestHash, p.actor,
        reviewSecrets.encrypt(p.reason), p.proof ? reviewSecrets.encrypt(p.proof) : null, now()]);
      if (a) {
        await tx.query("UPDATE subscription_attempts SET status='review_pending',updated_at=$2 WHERE id=$1", [a.id, now()]);
        await tx.query("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'paused' END,last_error='SUBSCRIPTION_REVIEW_REQUIRED',updated_at=$2 WHERE id=$1", [s.id, now()]);
      }
      return { p, s, a };
    });
  }
  async function finishReview(tx, p, response, state = 'completed') {
    await tx.query('UPDATE subscription_review_actions SET state=$2,response=$3,updated_at=$4,completed_at=$4 WHERE operation_id=$1', [p.operationId, state, JSON.stringify(response), now()]);
    return response;
  }
  const subs = {
    charge: charge || defaultCharge,
    async create(shopperId, input = {}) {
      await crm.summary(shopperId);
      const items = (Array.isArray(input.items) ? input.items : []).slice(0, 20).map(i => ({ brandId: text(i.brandId, 100), sku: text(i.sku, 120), qty: int(i.qty ?? 1, 'qty', 1, 20) }));
      if (!items.length) fail('A subscription needs at least one item.');
      for (const i of items) if (!await first(db, "SELECT id FROM products WHERE brand_id=$1 AND sku=$2 AND status='approved'", [i.brandId, i.sku])) fail(`Approved product ${i.sku} not found.`, 409, 'PRODUCT_UNAVAILABLE');
      const interval = int(input.intervalDays ?? 28, 'intervalDays', 7, 180);
      const shipTo = input.shipTo || fail('shipTo is required.');
      for (const k of ['name', 'line1', 'city', 'region', 'postal', 'country']) if (!text(shipTo[k])) fail(`shipTo.${k} is required.`);
      const paymentRef = text(input.paymentMethod, 100) || 'pm_card_visa';
      if (!/^pm_[A-Za-z0-9_]+$/.test(paymentRef)) fail('paymentMethod must be a Stripe test PaymentMethod id (pm_…).');
      const first_ = input.startAt ? new Date(input.startAt) : now();
      if (!Number.isFinite(first_.getTime())) fail('startAt must be a valid date.');
      const sub = await first(db, `INSERT INTO subscriptions(id,shopper_id,status,interval_days,align_to_cycle,items,ship_to_enc,payment_ref,provider_ref,next_run_at,created_at,updated_at)
        VALUES($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [id('sub'), shopperId, interval, input.alignToCycle === true, JSON.stringify(items), pii.encrypt(shipTo), paymentRef, `sub_sim_${randomBytes(6).toString('hex')}`, first_, now()]);
      return subs.view(sub);
    },
    view(s) { const { shipToEnc, ...rest } = s; return { ...rest, shipToCity: shipToEnc ? pii.decrypt(shipToEnc).city : null }; },
    async list(shopperId) { return (await rows(db, `SELECT * FROM subscriptions${shopperId ? ' WHERE shopper_id=$1' : ''} ORDER BY created_at`, shopperId ? [shopperId] : [])).map(subs.view); },
    async setStatus(subId, status) {
      if (!['active', 'paused', 'cancelled'].includes(status)) fail('status must be active, paused or cancelled.');
      return db.transaction(async tx => {
        const s = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [subId]); if (!s) fail('Subscription not found.', 404, 'NOT_FOUND');
        if (s.status === 'cancelled') fail('Subscription is cancelled.', 409, 'SUBSCRIPTION_CANCELLED');
        if (status === 'active') {
          // Recovery is a permanent audit boundary, not a mutable last_error flag.
          // Later successful cycles clear last_error; a subsequent pause must still
          // use the reasoned, idempotent resume action and its minimum delay.
          const history = await first(tx, `SELECT (
            EXISTS(SELECT 1 FROM subscription_review_actions WHERE subscription_id=$1)
            OR EXISTS(SELECT 1 FROM subscription_runs WHERE subscription_id=$1 AND status LIKE 'review_%')
            OR EXISTS(SELECT 1 FROM subscription_attempts WHERE subscription_id=$1 AND status IN ('uncertain','review_pending','resolved_declined','resolved_voided'))
            ) AS reviewed`, [subId]);
          if (history.reviewed || s.lastError === 'SUBSCRIPTION_REVIEW_REQUIRED'
            || await first(tx, 'SELECT id FROM subscription_attempts WHERE subscription_id=$1 AND cycle=$2 AND status=ANY($3::text[])', [subId, s.cycleCount + 1, blockedStatuses]))
            fail('Use the audited recovery resume action for this subscription.', 409, 'SUBSCRIPTION_REVIEW_REQUIRED');
        }
        return subs.view(await first(tx, 'UPDATE subscriptions SET status=$2,failures=CASE WHEN $2=\'active\' THEN 0 ELSE failures END,updated_at=$3 WHERE id=$1 RETURNING *', [subId, status, now()]));
      });
    },
    async nextRun(s, from) {
      let next = new Date(from.getTime() + s.intervalDays * DAY);
      if (s.alignToCycle) {
        const h = await health.read(s.shopperId, { actor: `subscription:${s.id}`, purpose: 'campaign' });
        const c = h ? cyclePhase(h.cycle, from) : null;
        if (c) { const aligned = new Date(Date.parse(c.nextPeriodStart) - 3 * DAY); if (aligned > from) next = aligned; }
      }
      return next;
    },
    async runDue() {
      const due = await rows(db, "SELECT id FROM subscriptions WHERE status='active' AND next_run_at<=$1 ORDER BY next_run_at", [now()]);
      const results = [];
      for (const candidate of due) {
        // A committed claim survives worker overlap and process failure. There is no lease
        // takeover: a crashed/unknown charge must be reviewed, not silently retried.
        const claim = await db.transaction(async tx => {
          const s = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [candidate.id]);
          if (!s || s.status !== 'active' || Date.parse(s.nextRunAt) > now().getTime()) return null;
          const cycle = s.cycleCount + 1;
          // A legacy crash may have recorded the paid run before advancing the cycle.
          if (await first(tx, "SELECT id FROM subscription_runs WHERE subscription_id=$1 AND cycle=$2 AND status='paid'", [s.id, cycle])) return null;
          const prior = await rows(tx, 'SELECT * FROM subscription_attempts WHERE subscription_id=$1 AND cycle=$2 ORDER BY attempt DESC', [s.id, cycle]);
          if (prior.some(a => blockedStatuses.includes(a.status))) return null;
          const attempt = (prior[0]?.attempt || 0) + 1;
          const a = await first(tx, `INSERT INTO subscription_attempts(id,subscription_id,cycle,attempt,status,created_at,updated_at)
            VALUES($1,$2,$3,$4,'claimed',$5,$5) RETURNING *`, [id('subattempt'), s.id, cycle, attempt, now()]);
          return { s, a, cycle };
        });
        if (!claim) continue;
        const { s, a, cycle } = claim;
        const input = { currency: 'USD', items: s.items };
        let quote;
        try { input.shipTo = pii.decrypt(s.shipToEnc); quote = await domain.quoteSandboxOrder(input); int(quote.totalCents, 'totalCents', 1); }
        catch (error) {
          const code = safeCode(error.code, 'ORDER_FAILED');
          await subs.failure(s, cycle, code, null, a.id, 'failed'); results.push({ subscriptionId: s.id, cycle, status: 'failed', error: code }); continue;
        }
        const started = await db.transaction(async tx => {
          const current = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
          const shopper = await first(tx, 'SELECT deleted_at FROM shoppers WHERE id=$1', [s.shopperId]);
          if (current.status !== 'active' || !current.shipToEnc || !shopper || shopper.deletedAt) {
            await tx.query("UPDATE subscription_attempts SET status='cancelled',error='SUBSCRIPTION_INACTIVE',updated_at=$2 WHERE id=$1", [a.id, now()]); return false;
          }
          a.requestFingerprint = requestFingerprint(s, a, quote.totalCents);
          await tx.query("UPDATE subscription_attempts SET status='charge_started',amount_cents=$2,request_fingerprint=$3,updated_at=$4 WHERE id=$1 AND status='claimed'", [a.id, quote.totalCents, a.requestFingerprint, now()]); return true;
        });
        if (!started) continue;
        let paid;
        try { paid = await subs.charge({ amountCents: quote.totalCents, paymentRef: s.paymentRef, subscriptionId: s.id, cycle, idempotencyKey: `sub:${s.id}:${cycle}:attempt:${a.attempt}`, simulated: true }); }
        catch {
          await subs.review(s, a, 'CHARGE_OUTCOME_UNKNOWN'); results.push({ subscriptionId: s.id, cycle, status: 'review', error: 'CHARGE_OUTCOME_UNKNOWN' }); continue;
        }
        if (paid?.ok === false && ['card_declined', 'insufficient_funds', 'expired_card', 'incorrect_cvc', 'payment_declined'].includes(paid.error)) {
          const code = safeCode(paid.error, 'charge_declined');
          await subs.failure(s, cycle, code, null, a.id, 'declined'); results.push({ subscriptionId: s.id, cycle, status: 'failed', error: code }); continue;
        }
        if (paid?.ok !== true || paid.amountCents !== quote.totalCents || !chargeRef(paid.ref)) {
          await subs.review(s, a, 'CHARGE_RESULT_MISMATCH', { ref: paid?.ref }); results.push({ subscriptionId: s.id, cycle, status: 'review', error: 'CHARGE_RESULT_MISMATCH' }); continue;
        }
        // Freeze the validated mock outcome before any canonical order work. Recovery
        // never trusts a caller's success boolean or invokes the charge callback.
        await db.query('UPDATE subscription_attempts SET charge_evidence_enc=$2,charge_ref=$3,updated_at=$4 WHERE id=$1', [a.id,
          reviewSecrets.encrypt({ source: 'validated_simulated_charge', outcome: 'paid', currency: 'USD', amountCents: paid.amountCents, ref: paid.ref, attemptKey: attemptKey(s, a), requestFingerprint: a.requestFingerprint, observedAt: now().toISOString() }), paid.ref, now()]);
        let order = null;
        try {
          const active = await first(db, 'SELECT s.status,u.deleted_at FROM subscriptions s JOIN shoppers u ON u.id=s.shopper_id WHERE s.id=$1', [s.id]);
          if (active.status !== 'active' || active.deletedAt) fail('Subscription changed during its mocked charge.', 409, 'SUBSCRIPTION_INACTIVE');
          // Do not publish a paid Bag/outbox event for a decline or unknown charge. Each
          // known-declined retry has a fresh, durably reserved order identity.
          order = await domain.createSandboxOrder({ ...input, externalId: `SUB-${s.id}-${cycle}-A${a.attempt}`, expectedTotalCents: quote.totalCents }, {
            beforeCreate: async tx => {
              const current = await first(tx, `SELECT s.status,s.ship_to_enc,u.deleted_at FROM subscriptions s
                JOIN shoppers u ON u.id=s.shopper_id WHERE s.id=$1 FOR UPDATE OF s,u`, [s.id]);
              if (current?.status !== 'active' || !current.shipToEnc || current.deletedAt)
                fail('Subscription changed before order creation.', 409, 'SUBSCRIPTION_INACTIVE');
            },
          });
          await db.query("UPDATE subscription_attempts SET status='order_created',order_id=$2,charge_ref=$3,updated_at=$4 WHERE id=$1", [a.id, order.id, paid.ref, now()]);
          if (order.totalCents !== quote.totalCents) fail('Canonical order changed after its mocked quote.', 409, 'ORDER_AMOUNT_CHANGED');
          await crm.linkOrder(s.shopperId, order.id);
          if (bank) await bank.earnForOrder(s.shopperId, order.id);
          const next = await subs.nextRun(s, now());
          await db.transaction(async tx => {
            await first(tx, 'SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
            await tx.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,charge_ref,amount_cents,created_at) VALUES($1,$2,$3,'paid',$4,$5,$6,$7)", [id('subrun'), s.id, cycle, order.id, paid.ref, order.totalCents, now()]);
            await tx.query("UPDATE subscription_attempts SET status='paid',updated_at=$2 WHERE id=$1", [a.id, now()]);
            await tx.query("UPDATE subscriptions SET cycle_count=$2,failures=0,last_error=NULL,next_run_at=$3,updated_at=$4 WHERE id=$1", [s.id, cycle, next, now()]);
          });
          results.push({ subscriptionId: s.id, cycle, status: 'paid', orderId: order.id, bags: order.bags.length, amountCents: order.totalCents, simulated: true });
        } catch {
          await subs.review(s, a, 'PAID_ORDER_REVIEW', { orderId: order?.id, ref: paid.ref });
          results.push({ subscriptionId: s.id, cycle, status: 'review', error: 'PAID_ORDER_REVIEW' });
        }
      }
      return results;
    },
    async failure(s, cycle, error, orderId, attemptId, status) {
      const pastDue = await db.transaction(async tx => {
        const current = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
        const attempt = await first(tx, 'SELECT * FROM subscription_attempts WHERE id=$1 FOR UPDATE', [attemptId]);
        if (!attempt || !['claimed', 'charge_started'].includes(attempt.status)) return false;
        const failures = current.failures + 1;
        await tx.query('UPDATE subscription_attempts SET status=$2,error=$3,updated_at=$4 WHERE id=$1', [attemptId, status, error, now()]);
        await tx.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,error,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [id('subrun'), s.id, cycle, `failed_attempt_${attempt.attempt}`, orderId, error, now()]);
        const nextStatus = ['cancelled', 'paused'].includes(current.status) ? current.status : failures >= 3 ? 'past_due' : 'active';
        await tx.query('UPDATE subscriptions SET failures=$2,last_error=$3,status=$4,next_run_at=$5,updated_at=$6 WHERE id=$1', [s.id, failures, error, nextStatus, new Date(now().getTime() + DAY), now()]);
        return nextStatus === 'past_due';
      });
      if (pastDue) await crm.sendTransactional(s.shopperId, { subject: 'Your Avafem subscription needs attention', body: 'We could not process your auto-replenish order. Update your payment method to resume.', dedupeKey: `sub-past-due:${s.id}:${cycle}` });
    },
    async review(s, a, code, { orderId = null, ref = null } = {}) {
      await db.transaction(async tx => {
        await first(tx, 'SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
        await tx.query("UPDATE subscription_attempts SET status='uncertain',error=$2,order_id=COALESCE($3,order_id),charge_ref=COALESCE($4,charge_ref),updated_at=$5 WHERE id=$1", [a.id, code, orderId, chargeRef(ref), now()]);
        await tx.query("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'paused' END,last_error=$2,updated_at=$3 WHERE id=$1", [s.id, code, now()]);
        await tx.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,charge_ref,error,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [id('subrun'), s.id, a.cycle, `review_${a.attempt}`, orderId, chargeRef(ref), code, now()]);
      });
    },
    /** Admin-only recovery projections: no address, payment method, raw evidence or reason. */
    async listReviews({ subscriptionId } = {}) {
      const subscriptions = await rows(db, `SELECT s.* FROM subscriptions s WHERE ${subscriptionId ? 's.id=$1 AND ' : ''}
        (s.status='paused' OR EXISTS(SELECT 1 FROM subscription_attempts a WHERE a.subscription_id=s.id AND
          (a.status=ANY(${subscriptionId ? '$2' : '$1'}::text[]) OR (a.status='paid' AND a.cycle>s.cycle_count)))
         OR EXISTS(SELECT 1 FROM subscription_review_actions r WHERE r.subscription_id=s.id)) ORDER BY s.updated_at DESC LIMIT 200`, subscriptionId ? [subscriptionId, unresolvedStatuses] : [unresolvedStatuses]);
      const out = [];
      for (const s of subscriptions) {
        const shopper = await first(db, 'SELECT deleted_at FROM shoppers WHERE id=$1', [s.shopperId]);
        const attempts = await rows(db, 'SELECT * FROM subscription_attempts WHERE subscription_id=$1 ORDER BY cycle,attempt', [s.id]);
        const history = await rows(db, 'SELECT operation_id,attempt_id,action,state,actor,created_at,completed_at FROM subscription_review_actions WHERE subscription_id=$1 ORDER BY created_at,operation_id', [s.id]);
        const pending = history.some(h => h.state === 'pending');
        const unresolved = attempts.some(a => unresolvedStatuses.includes(a.status) || (a.status === 'paid' && a.cycle > s.cycleCount));
        const alive = Boolean(shopper && !shopper.deletedAt && s.shipToEnc && s.status !== 'cancelled');
        out.push({ subscriptionId: s.id, status: s.status, cycleCount: s.cycleCount, lastError: s.lastError ? safeCode(s.lastError, 'REVIEW_REQUIRED') : null, nextRunAt: s.nextRunAt,
          simulated: true, providerVerified: false, requiresReview: unresolved, reviewState: pending ? 'action_pending' : unresolved ? 'unresolved' : 'concluded',
          allowedActions: ['cancel', ...(!pending && alive && !unresolved && ['paused', 'past_due'].includes(s.status) ? ['resume'] : [])],
          pendingActions: history.filter(h => h.state === 'pending').map(h => ({ operationId: h.operationId, action: h.action, attemptId: h.attemptId, createdAt: h.createdAt, actor: h.actor })),
          requiredAcknowledgements: acknowledgements,
          attempts: attempts.map(a => {
            let knownPaid = false; try { knownPaid = paidEvidence(s, a); } catch { /* malformed evidence stays held */ }
            const allowed = !pending && a.status === 'uncertain' && /^sub_sim_[A-Za-z0-9_]+$/.test(s.providerRef || '') && (!a.chargeRef || Boolean(chargeRef(a.chargeRef)));
            return { id: a.id, cycle: a.cycle, attempt: a.attempt, status: a.status, amountCents: a.amountCents,
              orderId: a.orderId, chargeRef: chargeRef(a.chargeRef), error: a.error ? safeCode(a.error, 'REVIEW_REQUIRED') : null, knownPaidSimulated: knownPaid,
              workerFenceRequired: ['claimed', 'charge_started', 'order_created'].includes(a.status),
              allowedActions: allowed ? [...(alive && knownPaid && a.requestFingerprint ? ['reconcile_paid'] : []), ...(!a.chargeRef && !knownPaid ? ['reconcile_declined'] : []), 'reconcile_voided'] : [],
              proofRequirements: { source: 'operator_mock_review', attemptKey: attemptKey(s, a), requestFingerprint: a.requestFingerprint || 'legacy_unavailable',
                chargeRef: chargeRef(a.chargeRef), referencePattern: 'mockproof_<8..100 alphanumeric, underscore or hyphen characters>', observedWithinHours: 24, requiredAcknowledgements: acknowledgements } };
          }), history: history.map(h => ({ ...h, reasonRecorded: true })) });
      }
      return out;
    },
    /** Admin continuation replays only the server's encrypted immutable request.
     * The HTTP layer audits the current caller before dispatch; the original
     * actor/reason/proof remain the idempotency identity and are never replaced. */
    async continueReview(input = {}) {
      if (Object.keys(input).some(key => !['subscriptionId', 'operationId', 'actor'].includes(key))
        || !/^[A-Za-z0-9_:-]{8,160}$/.test(input.operationId || '') || !/^[A-Za-z0-9_:-]{1,120}$/.test(input.actor || ''))
        fail('Continue a saved operation by ID with an authenticated actor only.');
      const saved = await db.transaction(async tx => {
        const action = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 AND subscription_id=$2 FOR UPDATE', [input.operationId, input.subscriptionId]);
        const subscription = await first(tx, 'SELECT id FROM subscriptions WHERE id=$1 FOR UPDATE', [input.subscriptionId]);
        if (!action || !subscription) fail('Saved subscription review not found.', 404, 'NOT_FOUND');
        if (!['reconcile_paid', 'reconcile_declined', 'reconcile_voided', 'resume', 'cancel'].includes(action.action) || !['pending', 'completed', 'review'].includes(action.state))
          fail('The saved action cannot be continued safely.', 409, 'SUBSCRIPTION_REVIEW_EVIDENCE_INVALID');
        let request;
        try {
          request = { subscriptionId: action.subscriptionId, operationId: action.operationId, actor: action.actor,
            reason: reviewSecrets.decrypt(action.reasonEnc), ...(action.attemptId ? { attemptId: action.attemptId } : {}),
            ...(action.proofEnc ? { proof: reviewSecrets.decrypt(action.proofEnc) } : {}),
            ...(action.action.startsWith('reconcile_') ? { resolution: action.action.slice('reconcile_'.length) } : {}) };
          if (reviewMeta(request, action.action).requestHash !== action.requestHash) throw new Error('request digest mismatch');
        } catch { fail('The saved review request could not be verified.', 409, 'SUBSCRIPTION_REVIEW_EVIDENCE_INVALID'); }
        if (action.state !== 'pending') {
          if (!action.response || typeof action.response !== 'object' || Array.isArray(action.response)) fail('The saved outcome needs review.', 409, 'SUBSCRIPTION_REVIEW_EVIDENCE_INVALID');
          return { replay: { ...action.response, replayed: true }, originalActor: action.actor };
        }
        if (action.attemptId && !await first(tx, 'SELECT id FROM subscription_attempts WHERE id=$1 AND subscription_id=$2', [action.attemptId, action.subscriptionId]))
          fail('The saved attempt identity needs review.', 409, 'SUBSCRIPTION_REVIEW_EVIDENCE_INVALID');
        return { request, action: action.action, originalActor: action.actor };
      });
      if (saved.replay) return { ...saved.replay, continued: true, originalActor: saved.originalActor };
      const result = saved.action.startsWith('reconcile_') ? await subs.reconcileReview(saved.request)
        : saved.action === 'resume' ? await subs.resumeReview(saved.request) : await subs.cancelReview(saved.request);
      return { ...result, continued: true, originalActor: saved.originalActor };
    },
    async reconcileReview(input = {}) {
      if (!['paid', 'declined', 'voided'].includes(input.resolution)) fail('Choose paid, declined or voided reconciliation.');
      const context = await reserveReview(input, `reconcile_${input.resolution}`);
      if (context.replay) return context.replay;
      const { p, s, a } = context;
      try {
        let order;
        let next;
        if (p.resolution === 'paid') {
          order = await domain.createSandboxOrder({ currency: 'USD', shipTo: pii.decrypt(s.shipToEnc), items: s.items,
            externalId: orderKey(s, a), expectedTotalCents: a.amountCents }, {
            beforeCreate: async tx => {
              const current = await first(tx, `SELECT s.*,u.deleted_at FROM subscriptions s JOIN shoppers u ON u.id=s.shopper_id WHERE s.id=$1 FOR UPDATE OF s,u`, [s.id]);
              const action = await first(tx, "SELECT state FROM subscription_review_actions WHERE operation_id=$1 AND subscription_id=$2 AND attempt_id=$3", [p.operationId, s.id, a.id]);
              const attempt = await first(tx, 'SELECT * FROM subscription_attempts WHERE id=$1 FOR UPDATE', [a.id]);
              if (!current || current.status !== 'paused' || !current.shipToEnc || current.deletedAt || action?.state !== 'pending' || attempt?.status !== 'review_pending'
                || !paidEvidence(current, attempt) || requestFingerprint(current, attempt, attempt.amountCents) !== attempt.requestFingerprint)
                fail('Subscription changed before recovery order creation.', 409, 'SUBSCRIPTION_INACTIVE');
            },
          });
          if (order.id !== (a.orderId || order.id) || order.orderRef !== `SANDBOX-${orderKey(s, a)}` || order.currency !== 'USD'
            || !order.sandbox || order.status !== 'paid' || order.totalCents !== a.amountCents || order.refundedCents !== 0
            || !order.bags.length || order.bags.some(b => b.providerBound || !b.sandbox || b.refundedCents || ['refunded', 'cancelled'].includes(b.status)))
            fail('The canonical order does not match the simulated payment.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
          await crm.linkOrder(s.shopperId, order.id);
          if (bank) await bank.earnForOrder(s.shopperId, order.id);
          next = await subs.nextRun(s, now());
        }
        return await db.transaction(async tx => {
          const action = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 FOR UPDATE', [p.operationId]);
          if (action.state !== 'pending') return { ...action.response, replayed: true };
          const current = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
          const attempt = await first(tx, 'SELECT * FROM subscription_attempts WHERE id=$1 FOR UPDATE', [a.id]);
          if (attempt.status !== 'review_pending') fail('The attempt changed during review.', 409, 'SUBSCRIPTION_REVIEW_CHANGED');
          if (p.resolution === 'paid') {
            if (!paidEvidence(current, attempt) || current.cycleCount < a.cycle - 1) fail('The paid cycle identity changed.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
            const prior = await first(tx, "SELECT * FROM subscription_runs WHERE subscription_id=$1 AND cycle=$2 AND status='paid'", [s.id, a.cycle]);
            if (prior && (prior.orderId !== order.id || prior.chargeRef !== a.chargeRef || prior.amountCents !== a.amountCents)) fail('Another paid cycle record needs review.', 409, 'SUBSCRIPTION_ORDER_MISMATCH');
            if (!prior) await tx.query("INSERT INTO subscription_runs(id,subscription_id,cycle,status,order_id,charge_ref,amount_cents,created_at) VALUES($1,$2,$3,'paid',$4,$5,$6,$7)", [id('subrun'), s.id, a.cycle, order.id, a.chargeRef, a.amountCents, now()]);
            await tx.query("UPDATE subscription_attempts SET status='paid',order_id=$2,error=NULL,updated_at=$3 WHERE id=$1", [a.id, order.id, now()]);
            await tx.query('UPDATE subscriptions SET cycle_count=GREATEST(cycle_count,$2),failures=0,next_run_at=$3 WHERE id=$1', [s.id, a.cycle, next]);
          } else {
            await validateAttestation(tx, current, attempt, p);
            await tx.query('UPDATE subscription_attempts SET status=$2,error=NULL,updated_at=$3 WHERE id=$1', [a.id, `resolved_${p.resolution}`, now()]);
          }
          await tx.query("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'paused' END,last_error=CASE WHEN status='cancelled' THEN NULL ELSE 'SUBSCRIPTION_REVIEW_REQUIRED' END,updated_at=$2 WHERE id=$1", [s.id, now()]);
          const response = safeResult(current, p, { attemptId: a.id, status: `resolved_${p.resolution}`, requiresReview: false,
            subscriptionStatus: current.status === 'cancelled' ? 'cancelled' : 'paused', canResume: current.status !== 'cancelled',
            proofSource: p.resolution === 'paid' ? 'validated_simulated_charge' : 'operator_attestation_not_provider_verified',
            orderId: order?.id || a.orderId || null, chargeRef: chargeRef(a.chargeRef), amountCents: a.amountCents });
          return finishReview(tx, p, response);
        });
      } catch (error) {
        return db.transaction(async tx => {
          const action = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 FOR UPDATE', [p.operationId]);
          if (action.state !== 'pending') return { ...action.response, replayed: true };
          await tx.query("UPDATE subscription_attempts SET status='uncertain',updated_at=$2 WHERE id=$1 AND status='review_pending'", [a.id, now()]);
          const response = safeResult(s, p, { attemptId: a.id, status: 'review', requiresReview: true,
            error: { code: safeCode(error.code, 'SUBSCRIPTION_RECONCILIATION_FAILED') } });
          return finishReview(tx, p, response, 'review');
        });
      }
    },
    async resumeReview(input = {}) {
      const context = await reserveReview(input, 'resume');
      if (context.replay) return context.replay;
      const { p, s } = context;
      return db.transaction(async tx => {
        const action = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 FOR UPDATE', [p.operationId]);
        if (action.state !== 'pending') return { ...action.response, replayed: true };
        const current = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
        const shopper = await first(tx, 'SELECT deleted_at FROM shoppers WHERE id=$1 FOR UPDATE', [s.shopperId]);
        const held = await first(tx, "SELECT id FROM subscription_attempts WHERE subscription_id=$1 AND (status=ANY($2::text[]) OR (status='paid' AND cycle>$3))", [s.id, unresolvedStatuses, current.cycleCount]);
        if (current.status === 'cancelled' || !current.shipToEnc || !shopper || shopper.deletedAt || held) {
          return finishReview(tx, p, safeResult(current, p, { status: 'review', requiresReview: true, error: { code: 'SUBSCRIPTION_REVIEW_REQUIRED' } }), 'review');
        }
        const next = new Date(Math.max(Date.parse(current.nextRunAt), now().getTime() + DAY));
        await tx.query("UPDATE subscriptions SET status='active',failures=0,last_error=NULL,next_run_at=$2,updated_at=$3 WHERE id=$1", [s.id, next, now()]);
        return finishReview(tx, p, safeResult(current, p, { status: 'active', requiresReview: false, nextRunAt: next.toISOString(), chargeAttempted: false }));
      });
    },
    async cancelReview(input = {}) {
      const context = await reserveReview(input, 'cancel');
      if (context.replay) return context.replay;
      const { p, s } = context;
      return db.transaction(async tx => {
        const action = await first(tx, 'SELECT * FROM subscription_review_actions WHERE operation_id=$1 FOR UPDATE', [p.operationId]);
        if (action.state !== 'pending') return { ...action.response, replayed: true };
        const current = await first(tx, 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [s.id]);
        const interrupted = await rows(tx, "SELECT * FROM subscription_review_actions WHERE subscription_id=$1 AND state='pending' AND operation_id<>$2 FOR UPDATE", [s.id, p.operationId]);
        for (const other of interrupted) {
          await finishReview(tx, { ...p, operationId: other.operationId }, safeResult(current, { ...p, operationId: other.operationId, action: other.action },
            { status: 'review', requiresReview: true, error: { code: 'SUBSCRIPTION_CANCELLED_DURING_REVIEW' } }), 'review');
        }
        await tx.query("UPDATE subscription_attempts SET status='uncertain',updated_at=$2 WHERE subscription_id=$1 AND status='review_pending'", [s.id, now()]);
        const held = await first(tx, "SELECT id FROM subscription_attempts WHERE subscription_id=$1 AND (status=ANY($2::text[]) OR (status='paid' AND cycle>$3))", [s.id, unresolvedStatuses, current.cycleCount]);
        await tx.query("UPDATE subscriptions SET status='cancelled',last_error=$2,updated_at=$3 WHERE id=$1", [s.id, held ? 'CANCELLED_REVIEW_PENDING' : null, now()]);
        return finishReview(tx, p, safeResult(current, p, { status: 'cancelled', requiresReview: Boolean(held), cancelledFutureRenewalsOnly: true,
          paymentResolved: !held, chargeAttempted: false, refundAttempted: false }));
      });
    },
    async runs(subId) { return rows(db, 'SELECT * FROM subscription_runs WHERE subscription_id=$1 ORDER BY created_at', [subId]); },
  };
  return subs;
}

/** Free-shipping policy simulation only. Quotes and subsidy planning do not
 * discount a real charge or book a general-ledger subsidy. Checkout integration
 * must be implemented before this policy can promise shopper free shipping. */
export function createShipping(db, { clock }) {
  const now = () => clock();
  const ship = {
    async rule() { return await first(db, "SELECT * FROM shipping_rules WHERE id='default'") || { id: 'default', freeThresholdCents: 5000, enabled: true, updatedAt: null }; },
    async setRule(input = {}) {
      const threshold = int(input.freeThresholdCents, 'freeThresholdCents', 0, 1_000_000);
      return first(db, `INSERT INTO shipping_rules(id,free_threshold_cents,enabled,updated_at) VALUES('default',$1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET free_threshold_cents=EXCLUDED.free_threshold_cents,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at RETURNING *`, [threshold, input.enabled !== false, now()]);
    },
    async quote(items = []) {
      if (!Array.isArray(items) || !items.length) fail('Provide cart items.');
      const rule = await ship.rule(); const groups = new Map();
      for (const line of items.slice(0, 100)) {
        const p = await first(db, "SELECT p.price_cents,p.title,b.commission_bps,b.shipping_table,b.id AS brand_id FROM products p JOIN brands b ON b.id=p.brand_id WHERE p.brand_id=$1 AND p.sku=$2 AND p.status='approved'", [line.brandId, line.sku]);
        if (!p) fail(`Approved product ${line.sku} not found.`, 409, 'PRODUCT_UNAVAILABLE');
        const qty = int(line.qty ?? 1, 'qty', 1, 1000);
        const g = groups.get(p.brandId) || { brandId: p.brandId, subtotalCents: 0, commissionBps: p.commissionBps, shippingCents: (p.shippingTable?.find(r => r.method === 'standard') || p.shippingTable?.[0] || {}).priceCents ?? 0 };
        g.subtotalCents += p.priceCents * qty; groups.set(p.brandId, g);
      }
      const bags = [...groups.values()].map(g => ({ ...g, commissionCents: Math.round(g.subtotalCents * g.commissionBps / 10_000) }));
      const subtotal = bags.reduce((s, b) => s + b.subtotalCents, 0); const shipping = bags.reduce((s, b) => s + b.shippingCents, 0);
      const free = rule.enabled && subtotal >= rule.freeThresholdCents;
      for (const b of bags) { const funded = free ? Math.min(b.shippingCents, b.commissionCents) : 0; Object.assign(b, { shopperShippingCents: free ? 0 : b.shippingCents, fundedFromCommissionCents: funded, absorbedCents: free ? b.shippingCents - funded : 0, netCommissionCents: b.commissionCents - funded }); }
      return { quoteOnly: true, appliedToCharge: false, freeShipping: free, thresholdCents: rule.freeThresholdCents, remainingForFreeShippingCents: free ? 0 : Math.max(0, rule.freeThresholdCents - subtotal), subtotalCents: subtotal,
        shippingCents: shipping, shopperShippingCents: free ? 0 : shipping, bags };
    },
    /** Save a simulated subsidy plan (idempotent per Bag), not an accounting booking. */
    async applyToOrder(orderId) {
      const bags = await rows(db, 'SELECT * FROM bags WHERE order_id=$1', [orderId]); if (!bags.length) fail('Order not found.', 404, 'NOT_FOUND');
      const rule = await ship.rule(); const subtotal = bags.reduce((s, b) => s + b.subtotalCents, 0);
      if (!rule.enabled || subtotal < rule.freeThresholdCents) return { orderId, simulated: true, appliedToCharge: false, ledgerBooked: false, freeShipping: false, subsidies: [] };
      for (const b of bags) {
        const funded = Math.min(b.shippingCents, b.commissionCents);
        await db.query('INSERT INTO shipping_subsidies(bag_id,order_id,brand_id,shipping_cents,funded_from_commission_cents,absorbed_cents,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [b.id, orderId, b.brandId, b.shippingCents, funded, b.shippingCents - funded, now()]);
      }
      return { orderId, simulated: true, appliedToCharge: false, ledgerBooked: false, freeShipping: true, subsidies: await rows(db, 'SELECT * FROM shipping_subsidies WHERE order_id=$1 ORDER BY bag_id', [orderId]) };
    },
    async subsidyReport() {
      return first(db, 'SELECT COUNT(*)::int AS bags, COALESCE(SUM(shipping_cents),0)::int AS shipping_cents, COALESCE(SUM(funded_from_commission_cents),0)::int AS funded_from_commission_cents, COALESCE(SUM(absorbed_cents),0)::int AS absorbed_cents FROM shipping_subsidies');
    },
  };
  return ship;
}

/** DSAR: export everything held about a shopper, or erase personal/health data while keeping
 * de-identified financial records required for tax and accounting. Every step is audited. */
export function createPrivacy(db, { clock, crm, health, bank, secret }) {
  const now = () => clock();
  const pii = keyring(secret, 'shopper-pii');
  return {
    async export(shopperId, actor) {
      await crm.summary(shopperId);
      const profile = await crm.profile(shopperId, { actor });
      const healthData = await health.read(shopperId, { actor, purpose: 'dsar_export', bypassConsent: true });
      const out = { generatedAt: now().toISOString(), profile: { ...profile, phone: (pii.decrypt((await first(db, 'SELECT profile_enc FROM shoppers WHERE id=$1', [shopperId])).profileEnc) || {}).phone || null },
        health: healthData, healthAccessLog: await health.accessLog(shopperId),
        reviews: await rows(db, 'SELECT id,bag_id,product_id,rating,body,photo_url,created_at FROM reviews WHERE shopper_id=$1', [shopperId]),
        tickets: await rows(db, 'SELECT id,subject,status,messages,created_at FROM support_tickets WHERE shopper_id=$1', [shopperId]),
        messages: await crm.outbox({ shopperId, actor, purpose: 'dsar_export', bypassConsent: true, limit: null }), beautyBank: { lots: await bank.lots(shopperId), history: await bank.history(shopperId) },
        subscriptions: (await rows(db, 'SELECT id,status,interval_days,items,cycle_count,created_at FROM subscriptions WHERE shopper_id=$1', [shopperId])) };
      const req = await first(db, "INSERT INTO privacy_requests(id,shopper_id,kind,status,result,requested_by,created_at,completed_at) VALUES($1,$2,'export','completed',$3,$4,$5,$5) RETURNING id", [id('dsar'), shopperId, JSON.stringify({ sections: Object.keys(out) }), actor, now()]);
      return { requestId: req.id, ...out };
    },
    async erase(shopperId, actor, { confirm } = {}) {
      if (confirm !== 'DELETE') fail('Confirm erasure with confirm: "DELETE".', 422, 'CONFIRMATION_REQUIRED');
      await crm.summary(shopperId);
      const counts = {};
      await db.transaction(async tx => {
        counts.health = (await tx.query('DELETE FROM health_records WHERE shopper_id=$1', [shopperId])).rowCount;
        counts.swipes = (await tx.query('DELETE FROM swipe_likes WHERE shopper_id=$1', [shopperId])).rowCount;
        counts.reviews = (await tx.query("UPDATE reviews SET body='',photo_url=NULL,status='hidden' WHERE shopper_id=$1", [shopperId])).rowCount;
        await tx.query("DELETE FROM brand_sync_feed WHERE kind='review' AND resource_id IN (SELECT id FROM reviews WHERE shopper_id=$1)", [shopperId]);
        counts.tickets = (await tx.query(`UPDATE support_tickets SET subject='[erased]',messages=(SELECT COALESCE(jsonb_agg(jsonb_set(m,'{body}','"[erased]"')),'[]'::jsonb) FROM jsonb_array_elements(messages) m) WHERE shopper_id=$1`, [shopperId])).rowCount;
        counts.messages = (await tx.query("UPDATE message_outbox SET subject='[erased]',recipient_enc='erased',recipient_hint='erased',body='[erased]',body_enc=NULL WHERE shopper_id=$1", [shopperId])).rowCount;
        counts.subscriptions = (await tx.query("UPDATE subscriptions SET status='cancelled',ship_to_enc=NULL,updated_at=$2 WHERE shopper_id=$1", [shopperId, now()])).rowCount;
        const open = (await tx.query("SELECT id,state,remaining_cents FROM bank_lots WHERE shopper_id=$1 AND state IN ('LAB','VAULT') FOR UPDATE", [shopperId])).rows;
        for (const lot of open) {
          await tx.query("UPDATE bank_lots SET state='EXPIRED',remaining_cents=0,note='Forfeited on erasure request',updated_at=$2 WHERE id=$1", [lot.id, now()]);
          await tx.query("INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at) VALUES($1,$2,'expired',$3,'EXPIRED',$4,'dsar_delete',$5)", [lot.id, shopperId, lot.state, lot.remaining_cents, now()]);
        }
        counts.creditsForfeited = open.length;
        await tx.query(`UPDATE shoppers SET email_hash=NULL,email_enc=NULL,profile_enc=NULL,consent='{"email":false,"sms":false,"marketing":false,"health":false}',deleted_at=$2,updated_at=$2 WHERE id=$1`, [shopperId, now()]);
        await tx.query('INSERT INTO health_access_log(shopper_id,actor,purpose,action,created_at) VALUES($1,$2,$3,$4,$5)', [shopperId, actor, 'dsar_delete', 'erase', now()]);
      });
      const req = await first(db, "INSERT INTO privacy_requests(id,shopper_id,kind,status,result,requested_by,created_at,completed_at) VALUES($1,$2,'delete','completed',$3,$4,$5,$5) RETURNING id", [id('dsar'), shopperId, JSON.stringify({ ...counts, retained: ['orders and Bags (tax/accounting, address encrypted)', 'health access log (no health content)', 'Beauty Bank ledger amounts'] }), actor, now()]);
      return { requestId: req.id, shopperId, erased: true, counts };
    },
    async list(shopperId) { return rows(db, `SELECT * FROM privacy_requests${shopperId ? ' WHERE shopper_id=$1' : ''} ORDER BY created_at`, shopperId ? [shopperId] : []); },
  };
}
