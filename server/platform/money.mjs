import { id, sha, keyring, first, rows, fail, text, int, DAY } from './util.mjs';

/** Beauty Bank closed-loop credits. Lots move LAB (pending) -> VAULT (spendable) once the
 * earning Bag is delivered and its return window has passed; REVERSED on refund; EXPIRED
 * after expiry. Redemptions consume VAULT lots soonest-to-expire first. Integer cents. */
export function createBeautyBank(db, { clock, earnBps = 300, expiryDays = 365 }) {
  const now = () => clock();
  const ev = (q, lot, kind, from, to, amount, ref = null) => q.query('INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [lot.id, lot.shopperId, kind, from, to, amount, ref, now()]);
  const bank = {
    async balance(shopperId) {
      const r = await first(db, `SELECT COALESCE(SUM(remaining_cents) FILTER (WHERE state='LAB'),0)::int AS lab, COALESCE(SUM(remaining_cents) FILTER (WHERE state='VAULT'),0)::int AS vault FROM bank_lots WHERE shopper_id=$1`, [shopperId]);
      return { labCents: r.lab, vaultCents: r.vault };
    },
    async lots(shopperId) { return rows(db, 'SELECT * FROM bank_lots WHERE shopper_id=$1 ORDER BY created_at,id', [shopperId]); },
    async history(shopperId) { return rows(db, 'SELECT * FROM bank_events WHERE shopper_id=$1 ORDER BY id', [shopperId]); },
    /** Credits earned on each linked Bag (earnBps of merchandise subtotal), pending in LAB. */
    async earnForOrder(shopperId, orderId) {
      return db.transaction(async tx => {
        const shopper = await first(tx, 'SELECT deleted_at FROM shoppers WHERE id=$1 FOR UPDATE', [shopperId]);
        if (!shopper || shopper.deletedAt) fail('Shopper not found.', 404, 'NOT_FOUND');
        const bags = await rows(tx, 'SELECT b.* FROM bags b JOIN shopper_orders so ON so.bag_id=b.id WHERE so.shopper_id=$1 AND b.order_id=$2 FOR UPDATE OF b', [shopperId, orderId]);
        if (!bags.length) fail('No linked Bags for this shopper and order.', 404, 'NOT_FOUND');
        const created = [];
        for (const bag of bags) {
          const amount = Math.floor(bag.subtotalCents * earnBps / 10_000);
          if (amount <= 0 || ['refunded', 'cancelled'].includes(bag.status)) continue;
          const terminal = await first(tx, `SELECT EXISTS(SELECT 1 FROM transfers WHERE bag_id=$1 AND status IN ('cancelled','reversed'))
            OR EXISTS(SELECT 1 FROM financial_resolutions WHERE bag_id=$1 AND kind='lost_dispute' AND action='writeoff') AS blocked`, [bag.id]);
          if (terminal.blocked) continue;
          const r = await first(tx, `INSERT INTO bank_lots(id,shopper_id,bag_id,source,state,amount_cents,remaining_cents,source_key,created_at,updated_at)
            VALUES($1,$2,$3,'purchase','LAB',$4,$4,$5,$6,$6) ON CONFLICT(source_key) DO NOTHING RETURNING *`, [id('lot'), shopperId, bag.id, amount, `earn:${bag.id}`, now()]);
          if (r) { await ev(tx, r, 'earned', null, 'LAB', amount, bag.id); created.push(r); }
        }
        return created;
      });
    },
    async grantGoodwill(shopperId, { amountCents, reason, ticketId }) {
      const amount = int(amountCents, 'amountCents', 1, 50_000);
      const key = ticketId ? `goodwill:${ticketId}` : `goodwill:${id('g')}`;
      const lot = await first(db, `INSERT INTO bank_lots(id,shopper_id,source,state,amount_cents,remaining_cents,expires_at,source_key,note,created_at,updated_at)
        VALUES($1,$2,'goodwill','VAULT',$3,$3,$4,$5,$6,$7,$7) ON CONFLICT(source_key) DO NOTHING RETURNING *`,
        [id('lot'), shopperId, amount, new Date(now().getTime() + expiryDays * DAY), key, text(reason, 300), now()]);
      if (!lot) return { ...(await first(db, 'SELECT * FROM bank_lots WHERE source_key=$1', [key])), replayed: true };
      await ev(db, lot, 'granted', null, 'VAULT', amount, ticketId || null);
      return { ...lot, status: lot.state };
    },
    async redeem(shopperId, { amountCents, idempotencyKey, orderRef }) {
      const amount = int(amountCents, 'amountCents', 1, 1_000_000);
      const key = text(idempotencyKey, 200) || fail('An idempotency key is required.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
      return db.transaction(async tx => {
        const prior = await first(tx, 'SELECT * FROM bank_redemptions WHERE idempotency_key=$1', [key]);
        if (prior) { if (prior.amountCents !== amount || prior.shopperId !== shopperId) fail('Key reused with a different redemption.', 422, 'IDEMPOTENCY_CONFLICT'); return { ...prior, replayed: true }; }
        const lots = await rows(tx, "SELECT * FROM bank_lots WHERE shopper_id=$1 AND state='VAULT' AND remaining_cents>0 AND (expires_at IS NULL OR expires_at>$2) ORDER BY expires_at NULLS LAST,created_at FOR UPDATE", [shopperId, now()]);
        if (lots.reduce((s, l) => s + l.remainingCents, 0) < amount) fail('Insufficient VAULT balance.', 409, 'INSUFFICIENT_CREDIT');
        let left = amount; const allocations = [];
        for (const lot of lots) {
          if (!left) break; const take = Math.min(left, lot.remainingCents); left -= take;
          await tx.query('UPDATE bank_lots SET remaining_cents=remaining_cents-$2,updated_at=$3 WHERE id=$1', [lot.id, take, now()]);
          await ev(tx, lot, 'redeemed', 'VAULT', 'VAULT', -take, key); allocations.push({ lotId: lot.id, amountCents: take });
        }
        return first(tx, 'INSERT INTO bank_redemptions(id,shopper_id,amount_cents,idempotency_key,allocations,order_ref,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [id('redeem'), shopperId, amount, key, JSON.stringify(allocations), text(orderRef, 100) || null, now()]);
      });
    },
    /** LAB -> VAULT when the Bag is delivered and its return window is over. */
    async mature() {
      return db.transaction(async tx => {
        const due = await rows(tx, `SELECT l.*, b.delivered_at, b.return_window_days, b.payout_due_at,
          br.return_window_days AS current_return_window_days,t.due_at AS transfer_due_at,j.due_at AS job_due_at
          FROM bank_lots l JOIN bags b ON b.id=l.bag_id JOIN brands br ON br.id=b.brand_id
          LEFT JOIN transfers t ON t.bag_id=b.id LEFT JOIN jobs j ON j.bag_id=b.id AND j.kind='sandbox_payout'
          WHERE l.state='LAB' AND b.status='delivered' AND b.delivered_at IS NOT NULL
          AND COALESCE(t.status,'')<>'held' AND COALESCE(j.status,'')<>'held'
          AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.bag_id=b.id AND r.status='proposed')
          AND NOT b.provider_bound AND br.status IN ('ready','live') AND br.connection_healthy AND br.payouts_enabled
          AND NOT EXISTS(SELECT 1 FROM disputes d WHERE d.bag_id=b.id AND (d.status IN ('needs_response','under_review')
            OR (d.status='lost' AND NOT EXISTS(SELECT 1 FROM financial_resolutions f WHERE f.dispute_id=d.id AND f.kind='lost_dispute' AND f.action='operator_verified_recovery'))))
          FOR UPDATE OF l`);
        let moved = 0;
        for (const lot of due) {
          const days = Math.max(7,lot.returnWindowDays ?? 30,lot.currentReturnWindowDays ?? 30);
          const matures = new Date(Math.max(Date.parse(lot.deliveredAt) + days * DAY,
            ...[lot.maturesAt,lot.payoutDueAt,lot.transferDueAt,lot.jobDueAt].filter(Boolean).map(Date.parse)));
          if (!Number.isFinite(matures.getTime()) || matures > now()) continue;
          const r = await tx.query("UPDATE bank_lots SET state='VAULT',matures_at=$2,expires_at=$3,updated_at=$4 WHERE id=$1 AND state='LAB' RETURNING id", [lot.id, matures, new Date(now().getTime() + expiryDays * DAY), now()]);
          if (r.rows.length) { await ev(tx, lot, 'matured', 'LAB', 'VAULT', lot.remainingCents); moved++; }
        }
        return moved;
      });
    },
    async expire() {
      return db.transaction(async tx => {
        const due = await rows(tx, "SELECT * FROM bank_lots WHERE state='VAULT' AND expires_at IS NOT NULL AND expires_at<=$1 FOR UPDATE", [now()]);
        let expired = 0;
        for (const lot of due) {
          const r = await tx.query("UPDATE bank_lots SET state='EXPIRED',remaining_cents=0,updated_at=$2 WHERE id=$1 AND state='VAULT' RETURNING id", [lot.id, now()]);
          if (r.rows.length) { await ev(tx, lot, 'expired', 'VAULT', 'EXPIRED', lot.remainingCents); expired++; }
        }
        return expired;
      });
    },
    /** Reverse unspent LAB/VAULT credit for refunded/cancelled Bags (idempotent). */
    async reverseRefunded(bagId) {
      return db.transaction(async tx => {
        const lots = await rows(tx, `SELECT l.* FROM bank_lots l JOIN bags b ON b.id=l.bag_id WHERE l.state IN ('LAB','VAULT') AND b.status IN ('refunded','cancelled')${bagId ? ' AND b.id=$1' : ''} FOR UPDATE OF l`, bagId ? [bagId] : []);
        let reversed = 0;
        for (const lot of lots) {
          const spent = lot.amountCents - lot.remainingCents;
          const r = await tx.query("UPDATE bank_lots SET state='REVERSED',remaining_cents=0,note=$2,updated_at=$3 WHERE id=$1 AND state IN ('LAB','VAULT') RETURNING id", [lot.id, spent ? `Refunded after ${spent} cents were redeemed; review clawback.` : 'Earning Bag refunded.', now()]);
          if (r.rows.length) { await ev(tx, lot, 'reversed', lot.state, 'REVERSED', lot.remainingCents, lot.bagId); reversed++; }
        }
        return reversed;
      });
    },
    async run() { return { reversed: await bank.reverseRefunded(), matured: await bank.mature(), expired: await bank.expire() }; },
    async liabilityReport() {
      const s = await first(db, `SELECT
        COALESCE(SUM(remaining_cents) FILTER (WHERE state='LAB'),0)::int AS lab,
        COALESCE(SUM(remaining_cents) FILTER (WHERE state='VAULT'),0)::int AS vault,
        COALESCE(SUM(amount_cents) FILTER (WHERE state='REVERSED'),0)::int AS reversed_issued,
        COALESCE(SUM(amount_cents),0)::int AS issued, COUNT(*)::int AS lots FROM bank_lots`);
      const ev2 = await first(db, `SELECT COALESCE(-SUM(amount_cents) FILTER (WHERE kind='redeemed'),0)::int AS redeemed,
        COALESCE(SUM(amount_cents) FILTER (WHERE kind='expired'),0)::int AS expired, COALESCE(SUM(amount_cents) FILTER (WHERE kind='reversed'),0)::int AS reversed,
        COALESCE(SUM(amount_cents) FILTER (WHERE kind='written_off'),0)::int AS written_off FROM bank_events`);
      const expiringSoon = (await first(db, "SELECT COALESCE(SUM(remaining_cents),0)::int AS c FROM bank_lots WHERE state='VAULT' AND expires_at<=$1", [new Date(now().getTime() + 30 * DAY)])).c;
      return { asOf: now().toISOString(), issuedCents: s.issued, pendingLabCents: s.lab, spendableVaultCents: s.vault,
        // Accounting view: VAULT is a current liability; LAB is contingent until the return window closes.
        liabilityCents: s.vault, contingentLiabilityCents: s.lab, redeemedCents: ev2.redeemed, expiredBreakageCents: ev2.expired, reversedCents: ev2.reversed,
        writtenOffCents: ev2.writtenOff, expiringWithin30DaysCents: expiringSoon, lots: s.lots,
        balanced: s.issued === s.lab + s.vault + ev2.redeemed + ev2.expired + ev2.reversed + ev2.writtenOff, sandbox: true };
    },
  };
  return bank;
}

/** Rule-based risk scoring for checkouts and pre-payout brand checks. */
export function createRisk(db, { clock }) {
  const now = () => clock();
  const save = (type, subject, score, signals) => {
    const decision = score >= 70 ? 'block' : score >= 40 ? 'review' : 'allow';
    return first(db, 'INSERT INTO risk_assessments(id,subject_type,subject_id,score,decision,signals,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [id('risk'), type, subject || null, Math.min(100, score), decision, JSON.stringify(signals), now()]);
  };
  return {
    async scoreCheckout(input = {}) {
      const signals = []; let score = 0;
      const add = (code, points) => { signals.push({ code, points }); score += points; };
      const amount = Number.isSafeInteger(input.amountCents) ? input.amountCents : 0;
      if (amount >= 50_000) add('HIGH_AMOUNT', 25); else if (amount >= 25_000) add('ELEVATED_AMOUNT', 10);
      if (input.billingCountry && input.shipCountry && input.billingCountry !== input.shipCountry) add('BILLING_SHIPPING_COUNTRY_MISMATCH', 25);
      if (input.ipCountry && input.shipCountry && input.ipCountry !== input.shipCountry) add('IP_COUNTRY_MISMATCH', 15);
      if (Number.isInteger(input.accountAgeDays) && input.accountAgeDays < 1) add('NEW_ACCOUNT', 10);
      if (Number.isInteger(input.attemptsLastHour) && input.attemptsLastHour >= 3) add('CARD_VELOCITY', 30);
      if (Number.isInteger(input.maxQtyPerSku) && input.maxQtyPerSku >= 10) add('BULK_QUANTITY', 15);
      if (/^[^@]+@(mailinator|tempmail|10minutemail)\./i.test(String(input.email || ''))) add('DISPOSABLE_EMAIL', 20);
      if (input.shopperId) {
        const prior = await first(db, "SELECT COUNT(*)::int AS c FROM shopper_orders so JOIN bags b ON b.id=so.bag_id WHERE so.shopper_id=$1 AND b.status='delivered'", [input.shopperId]);
        if (prior.c > 0) add('RETURNING_CUSTOMER', -15);
      }
      return save('checkout', input.reference || input.shopperId, Math.max(0, score), signals);
    },
    async brandPayoutCheck(brandId) {
      const brand = await first(db, 'SELECT * FROM brands WHERE id=$1', [brandId]); if (!brand) fail('Brand not found.', 404, 'NOT_FOUND');
      const stats = await first(db, `SELECT COUNT(*)::int AS bags, COUNT(*) FILTER (WHERE status='refunded')::int AS refunded,
        COUNT(*) FILTER (WHERE status='awaiting_shipment' AND ship_by<$2)::int AS late FROM bags WHERE brand_id=$1`, [brandId, now()]);
      const disputes = await first(db, "SELECT COUNT(*) FILTER (WHERE status IN ('needs_response','under_review'))::int AS open, COUNT(*) FILTER (WHERE status='lost')::int AS lost FROM disputes WHERE brand_id=$1", [brandId]);
      const reasons = [];
      if (!brand.payoutsEnabled || !brand.stripeAccountId) reasons.push('PAYOUTS_NOT_ENABLED');
      if (['paused', 'disconnected'].includes(brand.status)) reasons.push('BRAND_UNAVAILABLE');
      if (stats.bags >= 5 && stats.refunded / stats.bags > 0.2) reasons.push('HIGH_REFUND_RATE');
      if (disputes.open > 0) reasons.push('OPEN_DISPUTE');
      if (disputes.lost >= 2) reasons.push('REPEATED_LOST_DISPUTES');
      if (stats.late >= 3) reasons.push('LATE_SHIPMENTS');
      const score = reasons.length * 30;
      const saved = await save('brand_payout', brandId, score, reasons.map(code => ({ code })));
      return { brandId, pass: reasons.length === 0, reasons, stats: { ...stats, openDisputes: disputes.open, lostDisputes: disputes.lost }, assessmentId: saved.id };
    },
    async list(type) { return rows(db, `SELECT * FROM risk_assessments${type ? ' WHERE subject_type=$1' : ''} ORDER BY created_at DESC LIMIT 200`, type ? [type] : []); },
  };
}

/** Operator console: disputes, holds, stuck transfers, reconciliation alerts. */
export function createConsole(db, { clock, domain, risk, secret, creditExpiryDays = 365 }) {
  const now = () => clock();
  int(creditExpiryDays, 'creditExpiryDays', 1, 3650);
  const recovery = keyring(secret, 'financial-recovery');
  const alert = (kind, severity, resourceId, message, key) => db.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING`,
    [id('alert'), kind, severity, resourceId, message, key, now()]);
  const auditInput = (input, actor, target, kind, action) => {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    const key = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    const who = typeof actor === 'string' ? actor.trim() : '';
    if (reason.length < 10 || reason.length > 1000 || !/^[A-Za-z0-9][A-Za-z0-9:_-]{5,199}$/.test(key) || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(who))
      fail('Operator reason, actor and a bounded idempotency key are required.', 422, 'RESOLUTION_AUDIT_REQUIRED');
    const reference = input?.recoveryReference ?? null;
    if (reference !== null && (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(reference) || reference.includes('://') || /(?:sk|rk)_(?:live|test)_|whsec_|shpat_|shpss_/i.test(reference)))
      fail('recoveryReference must be a bounded non-secret evidence identifier.', 422, 'INVALID_RECOVERY_REFERENCE');
    const payloadHash = sha(JSON.stringify({ target, kind, action, actor: who, reason, recoveryReference: reference }));
    return { reason, key, actor: who, reference, payloadHash };
  };
  const replay = async (tx, audit) => {
    const prior = await first(tx, 'SELECT * FROM financial_resolutions WHERE idempotency_key=$1 FOR UPDATE', [audit.key]);
    if (!prior) return null;
    if (prior.payloadHash !== audit.payloadHash) fail('This idempotency key belongs to a different operator resolution.', 409, 'IDEMPOTENCY_CONFLICT');
    return { ...prior.result, resolutionId: prior.id, replayed: true };
  };
  async function recordResolution(tx, audit, { kind, action, bagId, transferId = null, disputeId = null, creditId = null }, result, resolutionId = id('fres')) {
    await tx.query(`INSERT INTO financial_resolutions(id,idempotency_key,payload_hash,kind,action,bag_id,transfer_id,dispute_id,credit_id,actor,reason_enc,recovery_reference,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [resolutionId, audit.key, audit.payloadHash, kind, action, bagId, transferId, disputeId, creditId, audit.actor, recovery.encrypt(audit.reason), audit.reference, JSON.stringify(result), now()]);
    return { ...result, resolutionId, replayed: false };
  }
  const emit = (tx, type, bag, payload) => tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload,created_at,available_at)
    VALUES($1,$2,$3,$4,$5,$6,$6)`, [id('evt'), type, bag.id, bag.brandId, JSON.stringify({ ...payload, sandbox: true }), now()]);
  async function journal(tx, key, kind, bag, debitAccount, creditAccount, amount) {
    if (!amount) return;
    int(amount, 'journal amount', 1);
    const j = await first(tx, `INSERT INTO ledger_journals(id,business_key,kind,bag_id,brand_id,total_debit_cents,total_credit_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT(business_key) DO NOTHING RETURNING id`, [id('jrnl'), key, kind, bag.id, bag.brandId, amount, now()]);
    if (!j) fail('An existing financial adjustment requires reconciliation.', 409, 'RESOLUTION_LEDGER_CONFLICT');
    await tx.query(`INSERT INTO ledger_entries(id,journal_id,account,debit_cents,credit_cents) VALUES($1,$2,$3,$4,0),($5,$2,$6,0,$4)`,
      [id('entry'), j.id, debitAccount, amount, id('entry'), creditAccount]);
  }
  async function state(tx, bagId) {
    const bag = await first(tx, 'SELECT * FROM bags WHERE id=$1 FOR UPDATE', [bagId]);
    if (!bag) fail('Bag not found.', 404, 'NOT_FOUND');
    const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1 FOR UPDATE', [bag.brandId]);
    const transfer = await first(tx, 'SELECT * FROM transfers WHERE bag_id=$1 FOR UPDATE', [bagId]);
    const job = await first(tx, "SELECT * FROM jobs WHERE bag_id=$1 AND kind='sandbox_payout' FOR UPDATE", [bagId]);
    const credit = await first(tx, 'SELECT * FROM credits WHERE bag_id=$1 FOR UPDATE', [bagId]);
    const disputes = await rows(tx, 'SELECT * FROM disputes WHERE bag_id=$1 ORDER BY id FOR UPDATE', [bagId]);
    const refunds = await rows(tx, 'SELECT * FROM refunds WHERE bag_id=$1 FOR UPDATE', [bagId]);
    const resolutions = await rows(tx, 'SELECT * FROM financial_resolutions WHERE bag_id=$1 FOR UPDATE', [bagId]);
    const lots = await rows(tx, "SELECT * FROM bank_lots WHERE bag_id=$1 AND state IN ('LAB','VAULT') ORDER BY id FOR UPDATE", [bagId]);
    return { bag, brand, transfer, job, credit, disputes, refunds, resolutions, lots };
  }
  function eligibility(s, { credit = false, lot = null } = {}) {
    const reasons = [];
    if (s.bag.providerBound || s.bag.sandbox !== true || s.brand?.sandbox !== true) reasons.push('PROVIDER_WORKFLOW_REQUIRED');
    if (s.bag.status !== 'delivered' || !s.bag.deliveredAt) reasons.push('DELIVERY_REQUIRED');
    if (s.bag.refundedCents > 0 || s.refunds.some(r => r.status === 'proposed' || r.status === 'approved')) reasons.push('REFUND_REVIEW_REQUIRED');
    if (s.disputes.some(d => ['needs_response', 'under_review'].includes(d.status) || (d.status === 'lost' && !s.resolutions.some(r => r.disputeId === d.id && r.kind === 'lost_dispute' && r.action === 'operator_verified_recovery')))) reasons.push('DISPUTE_RECOVERY_REQUIRED');
    if (!s.brand || !['ready', 'live'].includes(s.brand.status) || !s.brand.connectionHealthy || !s.brand.payoutsEnabled || !s.brand.stripeAccountId) reasons.push('BRAND_UNAVAILABLE');
    if (!s.transfer || ['cancelled', 'reversed'].includes(s.transfer.status) || s.resolutions.some(r => r.kind === 'lost_dispute' && r.action === 'writeoff')) reasons.push('PAYABLE_UNAVAILABLE');
    if (s.transfer && (s.transfer.amountCents !== s.bag.transferCents || s.transfer.reversedCents > 0 || (s.transfer.paidAt && s.transfer.status !== 'paid'))) reasons.push('PAYABLE_RECONCILIATION_REQUIRED');
    if (!credit && (!s.job || !['held', 'scheduled'].includes(s.job.status))) reasons.push('PAYOUT_JOB_REVIEW');
    if (credit && (s.transfer?.status === 'held' || ['held', 'failed', 'cancelled'].includes(s.job?.status))) reasons.push('PAYOUT_HOLD');
    let eligibleAt = null;
    if (s.bag.deliveredAt) {
      const times = [Date.parse(s.bag.deliveredAt) + Math.max(7, s.bag.returnWindowDays ?? 30, s.brand?.returnWindowDays ?? 30) * DAY,
        ...[s.bag.payoutDueAt, s.transfer?.dueAt, s.job?.dueAt, lot?.maturesAt].filter(Boolean).map(Date.parse)];
      if (times.every(Number.isFinite)) {
        eligibleAt = new Date(Math.max(...times)).toISOString();
        if (Date.parse(eligibleAt) > now().getTime()) reasons.push('RETURN_WINDOW_OPEN');
      } else reasons.push('RETURN_WINDOW_UNVERIFIED');
    }
    return { holdReasons: [...new Set(reasons)], eligibleAt };
  }
  async function voidCanonicalCredit(tx, s) {
    if (!s.credit || s.credit.status === 'voided') return 0;
    if (s.credit.status !== 'pending') fail('Released credit requires a separate reviewed clawback workflow.', 409, 'CREDIT_ALREADY_RELEASED');
    await verifyPendingCredit(tx, s.bag.id, s.credit.amountCents);
    await journal(tx, `credit-void:${s.bag.id}`, 'credit_voided', s.bag, 'credit_pending', 'loyalty_expense', s.credit.amountCents);
    await tx.query("UPDATE credits SET status='voided',voided_at=$2 WHERE id=$1", [s.credit.id, now()]);
    await emit(tx, 'credit.voided', s.bag, { bagId: s.bag.id, creditId: s.credit.id, amountCents: s.credit.amountCents, source: 'operator_writeoff' });
    return s.credit.amountCents;
  }
  async function verifyPendingCredit(tx, bagId, amount) {
    const balance = await first(tx, `SELECT COALESCE(SUM(e.credit_cents-e.debit_cents),0)::int AS amount FROM ledger_entries e
      JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 AND e.account='credit_pending'`, [bagId]);
    if (balance.amount !== amount) fail('Pending credit must reconcile before an operator adjustment.', 409, 'LEDGER_RECONCILIATION_REQUIRED');
  }
  async function forfeitLot(tx, lot, resolutionId) {
    if (lot.state !== 'LAB') fail('Only pending, unspent LAB credits can be written off.', 409, 'CREDIT_NOT_PENDING');
    if (lot.remainingCents !== lot.amountCents) fail('Partially consumed credits need a separate reviewed clawback.', 409, 'CREDIT_CLAWBACK_REQUIRED');
    await tx.query("UPDATE bank_lots SET state='EXPIRED',remaining_cents=0,note='Operator pending-credit writeoff.',updated_at=$2 WHERE id=$1", [lot.id, now()]);
    await tx.query(`INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at)
      VALUES($1,$2,'written_off','LAB','EXPIRED',$3,$4,$5)`, [lot.id, lot.shopperId, lot.remainingCents, resolutionId, now()]);
    return lot.remainingCents;
  }
  const con = {
    async resolutionHistory({ bagId, disputeId, transferId, creditId } = {}) {
      const values = []; const where = [];
      for (const [field, value] of [['bag_id', bagId], ['dispute_id', disputeId], ['transfer_id', transferId], ['credit_id', creditId]])
        if (value) { values.push(value); where.push(`${field}=$${values.length}`); }
      const list = await rows(db, `SELECT * FROM financial_resolutions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,id`, values);
      return list.map(({ reasonEnc, ...r }) => ({ ...r, reason: recovery.decrypt(reasonEnc), sandbox: true }));
    },
    async pendingCredits({ brandId, shopperId } = {}) {
      return db.transaction(async tx => {
        const entries = await rows(tx, `SELECT c.id,c.bag_id,c.brand_id,c.amount_cents,'canonical' AS kind,NULL::timestamptz AS matures_at FROM credits c WHERE c.status='pending'
          ${brandId ? ' AND c.brand_id=$1' : ''}${shopperId ? ` AND EXISTS(SELECT 1 FROM shopper_orders so WHERE so.bag_id=c.bag_id AND so.shopper_id=$${brandId ? 2 : 1})` : ''}
          UNION ALL SELECT l.id,l.bag_id,b.brand_id,l.remaining_cents AS amount_cents,'beauty_bank' AS kind,l.matures_at FROM bank_lots l JOIN bags b ON b.id=l.bag_id WHERE l.state='LAB'
          ${brandId ? ' AND b.brand_id=$1' : ''}${shopperId ? ` AND l.shopper_id=$${brandId ? 2 : 1}` : ''} ORDER BY bag_id,id`, [brandId, shopperId].filter(Boolean));
        const cache = new Map();
        const output = [];
        for (const entry of entries) {
          if (!cache.has(entry.bagId)) cache.set(entry.bagId, await state(tx, entry.bagId));
          const s = cache.get(entry.bagId);
          output.push({ ...entry, ...eligibility(s, { credit: true, lot: entry.kind === 'beauty_bank' ? entry : null }), history: s.resolutions.filter(r => r.creditId === entry.id).map(({ reasonEnc, ...r }) => ({ ...r, reason: recovery.decrypt(reasonEnc) })), sandbox: true });
        }
        return output;
      });
    },
    async resolveLostDispute(disputeId, input = {}, actor) {
      if (!['operator_verified_recovery', 'writeoff'].includes(input.resolution)) fail('resolution must be operator_verified_recovery or writeoff.');
      const audit = auditInput(input, actor, disputeId, 'lost_dispute', input.resolution);
      if (input.resolution === 'operator_verified_recovery' && !audit.reference) fail('A reviewed recovery evidence identifier is required.', 422, 'RECOVERY_EVIDENCE_REQUIRED');
      return db.transaction(async tx => {
        const prior = await replay(tx, audit); if (prior) return prior;
        const d = await first(tx, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [disputeId]);
        if (!d) fail('Dispute not found.', 404, 'NOT_FOUND');
        if (d.status !== 'lost') fail('Only a lost dispute has a recovery decision.', 409, 'DISPUTE_NOT_LOST');
        const s = await state(tx, d.bagId);
        if (s.bag.providerBound || s.bag.sandbox !== true || s.brand?.sandbox !== true) fail('Use the provider-backed dispute workflow.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        if (s.resolutions.some(r => r.kind === 'lost_dispute' && r.disputeId === d.id)) fail('This lost dispute already has an immutable recovery resolution.', 409, 'DISPUTE_RECOVERY_RESOLVED');
        const resolutionId = id('fres');
        const result = { disputeId, bagId: s.bag.id, transferId: s.transfer?.id ?? null, disputeStatus: 'lost', recoveryResolution: input.resolution,
          cashRecoveredCents: 0, shopperRefunded: false, providerWrites: false, sandbox: true };
        if (input.resolution === 'writeoff') {
          if (!s.transfer || !['held', 'scheduled'].includes(s.transfer.status) || s.transfer.paidAt || s.transfer.reversedCents > 0)
            fail('Only an outstanding, unpaid sandbox payable can be written off.', 409, 'PAYABLE_NOT_WRITABLE');
          if (s.bag.refundedCents || s.refunds.some(r => ['proposed', 'approved'].includes(r.status))) fail('Resolve refund accounting before a whole-Bag payable writeoff.', 409, 'REFUND_REVIEW_REQUIRED');
          if (s.credit?.status === 'released' || s.lots.some(l => l.state !== 'LAB' || l.remainingCents !== l.amountCents)) fail('Released or spent credits require a separate reviewed clawback.', 409, 'CREDIT_CLAWBACK_REQUIRED');
          const payable = await first(tx, `SELECT COALESCE(SUM(e.credit_cents-e.debit_cents),0)::int AS amount FROM ledger_entries e
            JOIN ledger_journals j ON j.id=e.journal_id WHERE j.bag_id=$1 AND e.account='brand_payable'`, [s.bag.id]);
          if (payable.amount !== s.transfer.amountCents) fail('The outstanding payable must reconcile before writeoff.', 409, 'LEDGER_RECONCILIATION_REQUIRED');
          await journal(tx, `admin-payable-writeoff:${s.bag.id}`, 'operator_payable_writeoff', s.bag, 'brand_payable', 'sandbox_payable_writeoff_adjustment', s.transfer.amountCents);
          await tx.query("UPDATE transfers SET status='cancelled' WHERE id=$1", [s.transfer.id]);
          await tx.query("UPDATE jobs SET status='cancelled',last_error='Operator noncash payable writeoff' WHERE bag_id=$1 AND kind='sandbox_payout' AND status IN ('scheduled','held','failed')", [s.bag.id]);
          result.canonicalCreditVoidedCents = await voidCanonicalCredit(tx, s);
          result.beautyBankWrittenOffCents = 0;
          for (const lot of s.lots) result.beautyBankWrittenOffCents += await forfeitLot(tx, lot, resolutionId);
          Object.assign(result, { payableStatus: 'cancelled', payableWrittenOffCents: s.transfer.amountCents, noncashAdjustment: true,
            ledgerCounteraccount: 'sandbox_payable_writeoff_adjustment', scope: 'whole_bag_payable_waiver_not_cash_recovery' });
          await emit(tx, 'transfer.cancelled', s.bag, { bagId: s.bag.id, transferId: s.transfer.id, amountCents: s.transfer.amountCents, source: 'operator_noncash_writeoff' });
        } else {
          // Recording an operator assertion is not a money movement or payout
          // release. Date/refund/brand/other-dispute gates still apply separately.
          result.payableStatus = s.transfer?.status ?? null;
          result.scope = 'operator_evidence_only_no_provider_recovery_verified';
        }
        await emit(tx, 'dispute.recovery_resolved', s.bag, { bagId: s.bag.id, disputeId, resolutionId, resolution: input.resolution, cashRecoveredCents: 0 });
        return recordResolution(tx, audit, { kind: 'lost_dispute', action: input.resolution, bagId: s.bag.id, transferId: s.transfer?.id, disputeId }, result, resolutionId);
      });
    },
    async resolvePendingCredit(creditId, input = {}, actor) {
      if (!['release', 'writeoff'].includes(input.action)) fail('action must be release or writeoff.');
      const audit = auditInput(input, actor, creditId, 'credit', input.action);
      return db.transaction(async tx => {
        const prior = await replay(tx, audit); if (prior) return prior;
        const credit = await first(tx, 'SELECT * FROM credits WHERE id=$1 FOR UPDATE', [creditId]);
        const lot = credit ? null : await first(tx, 'SELECT * FROM bank_lots WHERE id=$1 FOR UPDATE', [creditId]);
        if (!credit && !lot) fail('Pending credit not found.', 404, 'NOT_FOUND');
        if ((credit && credit.status !== 'pending') || (lot && (lot.state !== 'LAB' || !lot.bagId))) fail('Only pending Bag-earned credits can be resolved.', 409, 'CREDIT_NOT_PENDING');
        const s = await state(tx, credit?.bagId || lot.bagId);
        if (s.bag.providerBound || s.bag.sandbox !== true || s.brand?.sandbox !== true) fail('Use provider-backed credit accounting.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        const resolutionId = id('fres');
        const result = { creditId, bagId: s.bag.id, kind: credit ? 'canonical' : 'beauty_bank', action: input.action,
          amountCents: credit?.amountCents ?? lot.remainingCents, providerWrites: false, cashRecoveredCents: 0, sandbox: true };
        if (input.action === 'release') {
          const gate = eligibility(s, { credit: true, lot });
          if (gate.holdReasons.length) fail(`Credit release blocked: ${gate.holdReasons.join(', ')}.`, 409, 'CREDIT_RELEASE_BLOCKED');
          if (credit) {
            await verifyPendingCredit(tx, s.bag.id, credit.amountCents);
            await journal(tx, `credit-release:${s.bag.id}`, 'credit_released', s.bag, 'credit_pending', 'credit_vault', credit.amountCents);
            await tx.query("UPDATE credits SET status='released',released_at=$2 WHERE id=$1", [creditId, now()]);
            await emit(tx, 'credit.released', s.bag, { bagId: s.bag.id, creditId, amountCents: credit.amountCents, source: 'operator_resolution' });
            result.status = 'released';
          } else {
            const shopper = await first(tx, 'SELECT deleted_at FROM shoppers WHERE id=$1 FOR UPDATE', [lot.shopperId]);
            if (!shopper || shopper.deletedAt) fail('A deleted shopper cannot receive released credit.', 409, 'SHOPPER_UNAVAILABLE');
            await tx.query("UPDATE bank_lots SET state='VAULT',matures_at=$2,expires_at=$3,updated_at=$4 WHERE id=$1", [creditId, gate.eligibleAt, new Date(now().getTime() + creditExpiryDays * DAY), now()]);
            await tx.query(`INSERT INTO bank_events(lot_id,shopper_id,kind,from_state,to_state,amount_cents,ref,created_at) VALUES($1,$2,'matured','LAB','VAULT',$3,$4,$5)`, [creditId, lot.shopperId, lot.remainingCents, resolutionId, now()]);
            result.status = 'VAULT';
          }
        } else {
          if (credit) { await voidCanonicalCredit(tx, s); result.status = 'voided'; }
          else { await forfeitLot(tx, lot, resolutionId); result.status = 'EXPIRED'; }
          result.noncashAdjustment = true;
        }
        return recordResolution(tx, audit, { kind: 'credit', action: input.action, bagId: s.bag.id, transferId: s.transfer?.id, creditId }, result, resolutionId);
      });
    },
    async openDispute(input = {}) {
      const ext = text(input.externalId, 100) || fail('externalId is required (the simulated Stripe dispute id).');
      return db.transaction(async tx => {
        const existing = await first(tx, 'SELECT * FROM disputes WHERE external_id=$1 FOR UPDATE', [ext]);
        if (existing) { if (existing.bagId !== input.bagId) fail('Dispute identity belongs to another Bag.', 409, 'IDEMPOTENCY_CONFLICT'); return { ...existing, replayed: true }; }
        const bag = await first(tx, 'SELECT * FROM bags WHERE id=$1 FOR UPDATE', [input.bagId]); if (!bag) fail('Bag not found.', 404, 'NOT_FOUND');
        if (bag.providerBound || bag.sandbox !== true) fail('Use the provider-backed dispute workflow.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        const amount = int(input.amountCents ?? bag.totalCents, 'amountCents', 1, bag.totalCents);
        const d = await first(tx, `INSERT INTO disputes(id,external_id,bag_id,brand_id,amount_cents,reason,status,respond_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'needs_response',$7,$8,$8) RETURNING *`,
          [id('dp'), ext, bag.id, bag.brandId, amount, text(input.reason, 100) || 'general', new Date(now().getTime() + 7 * DAY), now()]);
        await tx.query("UPDATE transfers SET status='held' WHERE bag_id=$1 AND status='scheduled'", [bag.id]);
        await tx.query("UPDATE jobs SET status='held' WHERE bag_id=$1 AND status='scheduled' AND kind='sandbox_payout'", [bag.id]);
        await tx.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,'dispute','high',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id('alert'), d.id, `Dispute opened on Bag ${bag.id}; payout held.`, `dispute:${d.id}`, now()]);
        return d;
      });
    },
    async listDisputes(brandId) { return rows(db, `SELECT * FROM disputes${brandId ? ' WHERE brand_id=$1' : ''} ORDER BY created_at DESC`, brandId ? [brandId] : []); },
    async submitEvidence(disputeId, evidence = {}) {
      return db.transaction(async tx => {
        const d = await first(tx, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [disputeId]); if (!d) fail('Dispute not found.', 404, 'NOT_FOUND');
        if (!['needs_response', 'under_review'].includes(d.status)) fail('Dispute is closed.', 409, 'DISPUTE_CLOSED');
        const bag = await first(tx, 'SELECT delivered_at,provider_bound FROM bags WHERE id=$1', [d.bagId]);
        if (bag.providerBound) fail('Use the provider-backed dispute workflow.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        const shipments = await rows(tx, 'SELECT tracking_number FROM shipments WHERE bag_id=$1', [d.bagId]);
        const packet = { note: text(evidence.note, 4000), trackingNumbers: shipments.map(s => s.trackingNumber), deliveredAt: bag.deliveredAt || null, submittedAt: now().toISOString(), simulated: true };
        return first(tx, "UPDATE disputes SET evidence=$2,status='under_review',updated_at=$3 WHERE id=$1 RETURNING *", [disputeId, JSON.stringify(packet), now()]);
      });
    },
    async resolveDispute(disputeId, outcome) {
      if (!['won', 'lost'].includes(outcome)) fail('outcome must be won or lost.');
      return db.transaction(async tx => {
        const d = await first(tx, 'SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [disputeId]); if (!d) fail('Dispute not found.', 404, 'NOT_FOUND');
        if (['won', 'lost'].includes(d.status)) return d;
        const bag = await first(tx, 'SELECT provider_bound FROM bags WHERE id=$1', [d.bagId]);
        if (bag.providerBound) fail('Use the provider-backed dispute workflow.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        const r = await first(tx, "UPDATE disputes SET status=$2,updated_at=$3 WHERE id=$1 RETURNING *", [disputeId, outcome, now()]);
        // A separate won dispute never implicitly releases a Bag with a lost
        // history, even after recovery: that needs the explicit audited release.
        const blockers = await first(tx, "SELECT (SELECT COUNT(*) FROM refunds WHERE bag_id=$1 AND status='proposed')::int + (SELECT COUNT(*) FROM disputes WHERE bag_id=$1 AND status IN ('needs_response','under_review','lost'))::int AS c", [d.bagId]);
        const brand = await first(tx, 'SELECT status,connection_healthy,payouts_enabled,stripe_account_id FROM brands WHERE id=$1', [d.brandId]);
        if (outcome === 'won' && blockers.c === 0 && ['ready', 'live'].includes(brand?.status) && brand.connectionHealthy && brand.payoutsEnabled && brand.stripeAccountId) {
          await tx.query("UPDATE transfers SET status='scheduled' WHERE bag_id=$1 AND status='held'", [d.bagId]);
          await tx.query("UPDATE jobs SET status='scheduled' WHERE bag_id=$1 AND status='held' AND kind='sandbox_payout'", [d.bagId]);
        }
        if (outcome === 'lost') await tx.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at) VALUES($1,'dispute_lost','high',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [id('alert'), d.id, `Dispute lost (${d.amountCents} cents). Payout stays held; decide brand recovery via refund workflow.`, `dispute-lost:${d.id}`, now()]);
        return r;
      });
    },
    async holds() {
      const held = await rows(db, `SELECT t.id AS transfer_id,t.bag_id,t.brand_id,t.amount_cents,t.due_at,
        (SELECT COUNT(*) FROM refunds r WHERE r.bag_id=t.bag_id AND r.status='proposed')::int AS open_refunds,
        (SELECT COUNT(*) FROM disputes d WHERE d.bag_id=t.bag_id AND d.status IN ('needs_response','under_review'))::int AS open_disputes,
        (SELECT COUNT(*) FROM disputes d WHERE d.bag_id=t.bag_id AND d.status='lost')::int AS lost_disputes
        FROM transfers t WHERE t.status='held' ORDER BY t.due_at NULLS LAST`);
      return db.transaction(async tx => {
        const output = [];
        for (const h of held) {
          const s = await state(tx, h.bagId);
          output.push({ ...h, ...eligibility(s), unresolvedLostDisputes: s.disputes.filter(d => d.status === 'lost' && !s.resolutions.some(r => r.disputeId === d.id && r.action === 'operator_verified_recovery')).length,
            history: s.resolutions.map(({ reasonEnc, ...r }) => ({ ...r, reason: recovery.decrypt(reasonEnc) })), sandbox: true });
        }
        return output;
      });
    },
    async releaseHold(transferId, input, actor) {
      return db.transaction(async tx => {
        const audit = input ? auditInput(input, actor, transferId, 'hold', 'release') : null;
        if (audit) { const prior = await replay(tx, audit); if (prior) return prior; }
        const t = await first(tx, 'SELECT * FROM transfers WHERE id=$1 FOR UPDATE', [transferId]); if (!t) fail('Transfer not found.', 404, 'NOT_FOUND');
        const s = await state(tx, t.bagId);
        if (t.status !== 'held') fail('Transfer is not held.', 409, 'NOT_HELD');
        const gate = eligibility(s);
        if (gate.holdReasons.length) fail(`Hold release blocked: ${gate.holdReasons.join(', ')}.`, 409, 'HOLD_BLOCKED');
        const checked = audit || auditInput(input, actor, transferId, 'hold', 'release');
        await tx.query("UPDATE transfers SET status='scheduled' WHERE id=$1", [transferId]);
        await tx.query("UPDATE jobs SET status='scheduled',due_at=GREATEST(due_at,$2::timestamptz) WHERE bag_id=$1 AND status='held' AND kind='sandbox_payout'", [t.bagId, gate.eligibleAt]);
        await tx.query('UPDATE transfers SET due_at=GREATEST(due_at,$2::timestamptz) WHERE id=$1', [transferId, gate.eligibleAt]);
        await emit(tx, 'transfer.hold_released', s.bag, { bagId: t.bagId, transferId, dueAt: gate.eligibleAt, source: 'operator_resolution' });
        return recordResolution(tx, checked, { kind: 'hold', action: 'release', bagId: t.bagId, transferId }, { transferId, bagId: t.bagId, status: 'scheduled', eligibleAt: gate.eligibleAt, providerWrites: false, sandbox: true });
      });
    },
    async stuckTransfers() {
      const cutoff = new Date(now().getTime() - DAY);
      return rows(db, `SELECT t.id AS transfer_id,t.bag_id,t.brand_id,t.amount_cents,t.status,t.due_at,j.status AS job_status,j.attempts,j.last_error
        FROM transfers t LEFT JOIN jobs j ON j.bag_id=t.bag_id AND j.kind='sandbox_payout'
        WHERE (t.status='scheduled' AND t.due_at IS NOT NULL AND t.due_at<$1) OR j.status='failed' ORDER BY t.due_at`, [cutoff]);
    },
    async retryStuck(transferId) {
      const t = await first(db, 'SELECT * FROM transfers WHERE id=$1', [transferId]); if (!t) fail('Transfer not found.', 404, 'NOT_FOUND');
      const r = await db.query("UPDATE jobs SET status='scheduled',due_at=$2 WHERE bag_id=$1 AND kind='sandbox_payout' AND status='failed' RETURNING id", [t.bagId, now()]);
      return { transferId, requeued: r.rows.length };
    },
    async scan() {
      const dash = await domain.dashboard();
      if (!dash.summary.ledgerBalanced) await alert('reconciliation', 'critical', null, 'Ledger journals are not balanced.', `ledger:${now().toISOString().slice(0, 10)}`);
      const mismatches = await rows(db, 'SELECT b.id,b.transfer_cents,t.amount_cents FROM bags b JOIN transfers t ON t.bag_id=b.id WHERE b.transfer_cents<>t.amount_cents');
      for (const m of mismatches) await alert('reconciliation', 'high', m.id, `Bag transfer ${m.transferCents} ≠ transfer ${m.amountCents}.`, `transfer-mismatch:${m.id}`);
      for (const s of await con.stuckTransfers()) await alert('stuck_transfer', 'medium', s.transferId, `Transfer ${s.transferId} is overdue or its payout job failed.`, `stuck:${s.transferId}:${s.jobStatus || s.status}`);
      for (const d of await rows(db, "SELECT * FROM disputes WHERE status='needs_response' AND respond_by<$1", [new Date(now().getTime() + 2 * DAY)]))
        await alert('dispute_deadline', 'high', d.id, `Dispute ${d.id} evidence due by ${new Date(d.respondBy).toISOString()}.`, `dispute-due:${d.id}`);
      return con.alerts();
    },
    async alerts({ all = false } = {}) { return rows(db, `SELECT * FROM platform_alerts${all ? '' : ' WHERE acknowledged_at IS NULL'} ORDER BY created_at DESC`); },
    async acknowledge(alertId) { const r = await first(db, 'UPDATE platform_alerts SET acknowledged_at=$2 WHERE id=$1 RETURNING *', [alertId, now()]); if (!r) fail('Alert not found.', 404, 'NOT_FOUND'); return r; },
    async summary() {
      return { disputes: await con.listDisputes(), holds: await con.holds(), pendingCredits: await con.pendingCredits(), resolutionHistory: await con.resolutionHistory(), stuckTransfers: await con.stuckTransfers(), alerts: await con.alerts(),
        ledgerBalanced: (await domain.dashboard()).summary.ledgerBalanced, sandbox: true };
    },
    async payoutChecks({ enforce = false } = {}) {
      const out = [];
      for (const b of await rows(db, 'SELECT id FROM brands ORDER BY id')) {
        const check = await risk.brandPayoutCheck(b.id);
        if (enforce && !check.pass) {
          const held = await db.query("UPDATE transfers SET status='held' WHERE brand_id=$1 AND status='scheduled' AND NOT EXISTS (SELECT 1 FROM bags WHERE bags.id=transfers.bag_id AND bags.provider_bound) RETURNING id", [b.id]);
          await db.query("UPDATE jobs SET status='held' WHERE kind='sandbox_payout' AND status='scheduled' AND bag_id IN (SELECT bag_id FROM transfers WHERE brand_id=$1 AND status='held')", [b.id]);
          check.heldTransfers = held.rows.map(r => r.id);
          if (held.rows.length) await alert('payout_check', 'high', b.id, `Pre-payout check failed (${check.reasons.join(', ')}); ${held.rows.length} transfer(s) held.`, `payout-check:${b.id}:${now().toISOString().slice(0, 10)}`);
        }
        out.push(check);
      }
      return out;
    },
  };
  return con;
}

/** Reports: state sales-tax summary and brand annual payout (1099-K style) export. */
export function createReports(db, { domain }) {
  const csv = (header, list) => [header.join(','), ...list.map(r => header.map(h => { const v = r[h] ?? ''; return /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v); }).join(','))].join('\n');
  // Refund components are persisted from the exact native refund allocation,
  // not inferred from Bag status or pro-rated from a cash total. Older partial
  // refunds without evidence must be reconciled, never silently reported as 0.
  const refundAllocation = async bag => {
    const refunds = await rows(db,"SELECT * FROM refunds WHERE bag_id=$1 AND status='approved'",[bag.id]);
    const totals = { amount: 0, subtotal: 0, shipping: 0, tax: 0, commission: 0 };
    let allocated = 0;
    for (const refund of refunds) {
      const parts = refund.amountCents===bag.totalCents && [refund.subtotalCents,refund.shippingCents,refund.taxCents,refund.commissionCents].every(v=>v==null)
        ? { subtotalCents:bag.subtotalCents,shippingCents:bag.shippingCents,taxCents:bag.taxCents,commissionCents:bag.commissionCents }
        : refund;
      totals.amount += refund.amountCents;
      if (![parts.subtotalCents,parts.shippingCents,parts.taxCents,parts.commissionCents].every(v=>Number.isSafeInteger(v) && v>=0)
        || parts.subtotalCents+parts.shippingCents+parts.taxCents!==refund.amountCents || parts.commissionCents>parts.subtotalCents) continue;
      allocated += refund.amountCents;
      for (const key of ['subtotal','shipping','tax','commission']) totals[key] += parts[`${key}Cents`];
    }
    const complete = totals.amount===bag.refundedCents && allocated===totals.amount
      && totals.subtotal<=bag.subtotalCents && totals.shipping<=bag.shippingCents && totals.tax<=bag.taxCents && totals.commission<=bag.commissionCents;
    return { ...totals,complete,unallocated:Math.max(0,bag.refundedCents-allocated) };
  };
  return {
    async salesTax({ from, to } = {}) {
      const params = []; const where = [];
      if (from) { params.push(new Date(from)); where.push(`created_at>=$${params.length}`); }
      if (to) { params.push(new Date(to)); where.push(`created_at<$${params.length}`); }
      const bags = await rows(db, `SELECT id FROM bags${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, params);
      const states = new Map();
      for (const { id: bagId } of bags) {
        const bag = await domain.getBag(bagId);
        const st = bag.shipTo?.region || 'UNKNOWN';
        const row = states.get(st) || { state: st, bags: 0, grossSalesCents: 0, shippingCents: 0, taxCollectedCents: 0, refundedCents: 0, taxRefundedCents: 0, refundedSalesCents: 0, refundedShippingCents: 0, refundAllocationComplete: true, unallocatedRefundCents: 0 };
        row.bags += 1; row.grossSalesCents += bag.subtotalCents; row.shippingCents += bag.shippingCents; row.taxCollectedCents += bag.taxCents;
        const allocation = await refundAllocation(bag);
        row.refundedCents += bag.refundedCents; row.taxRefundedCents += allocation.tax; row.refundedSalesCents += allocation.subtotal; row.refundedShippingCents += allocation.shipping;
        row.refundAllocationComplete &&= allocation.complete; row.unallocatedRefundCents += allocation.unallocated;
        states.set(st, row);
      }
      const list = [...states.values()].map(r => ({ ...r, netSalesCents: r.refundAllocationComplete ? r.grossSalesCents - r.refundedSalesCents : null,
        netTaxCents: r.refundAllocationComplete ? r.taxCollectedCents - r.taxRefundedCents : null, reconciliationRequired: !r.refundAllocationComplete }))
        .sort((a, b) => a.state.localeCompare(b.state));
      return { from: from || null, to: to || null, states: list, note: 'Sandbox marketplace-facilitator summary by ship-to state; confirm nexus and filing with a tax advisor.',
        csv: csv(['state', 'bags', 'grossSalesCents', 'shippingCents', 'taxCollectedCents', 'refundedCents', 'taxRefundedCents', 'refundedSalesCents', 'refundedShippingCents', 'netSalesCents', 'netTaxCents', 'refundAllocationComplete', 'unallocatedRefundCents', 'reconciliationRequired'], list) };
    },
    async brandAnnualPayouts(year, brandId) {
      const y = int(Number(year), 'year', 2000, 2100);
      const start = new Date(Date.UTC(y, 0, 1)); const end = new Date(Date.UTC(y + 1, 0, 1));
      const brands = await rows(db, `SELECT id,name,stripe_account_id FROM brands${brandId ? ' WHERE id=$1' : ''} ORDER BY id`, brandId ? [brandId] : []);
      const out = [];
      for (const b of brands) {
        const bags = await rows(db, 'SELECT * FROM bags WHERE brand_id=$1 AND created_at>=$2 AND created_at<$3', [b.id, start, end]);
        const allocations = await Promise.all(bags.map(refundAllocation));
        const refundAllocationComplete = allocations.every(a=>a.complete);
        const monthly = Array(12).fill(0);
        for (const bag of bags) monthly[new Date(bag.createdAt).getUTCMonth()] += bag.totalCents;
        const paid = await first(db, "SELECT COALESCE(SUM(amount_cents-reversed_cents),0)::int AS c FROM transfers WHERE brand_id=$1 AND status IN ('paid','reversed') AND paid_at>=$2 AND paid_at<$3", [b.id, start, end]);
        out.push({ brandId: b.id, brandName: b.name, connectedAccount: b.stripeAccountId || null, year: y,
          grossPaymentVolumeCents: bags.reduce((s, x) => s + x.totalCents, 0), transactionCount: bags.length,
          refundsCents: bags.reduce((s, x) => s + x.refundedCents, 0), commissionCents: refundAllocationComplete ? bags.reduce((s,x,i)=>s+x.commissionCents-allocations[i].commission,0) : null,
          refundAllocationComplete, reconciliationRequired: !refundAllocationComplete, unallocatedRefundCents: allocations.reduce((s,a)=>s+a.unallocated,0),
          netTransfersPaidCents: paid.c, monthlyGrossCents: monthly });
      }
      const header = ['brandId', 'brandName', 'connectedAccount', 'year', 'grossPaymentVolumeCents', 'transactionCount', 'refundsCents', 'commissionCents', 'netTransfersPaidCents', 'refundAllocationComplete', 'unallocatedRefundCents', 'reconciliationRequired', ...Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`)];
      return { year: y, brands: out, note: '1099-K style data only. Under Stripe Connect, Stripe may file 1099-Ks for connected accounts; confirm responsibilities before filing.',
        csv: csv(header, out.map(r => ({ ...r, ...Object.fromEntries(r.monthlyGrossCents.map((v, i) => [`m${String(i + 1).padStart(2, '0')}`, v])) }))) };
    },
  };
}
