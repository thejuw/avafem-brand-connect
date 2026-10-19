import { createHmac } from 'node:crypto';
import { keyring, first, rows, fail, text, int, DAY } from './util.mjs';
import {campaignNeedsHealth} from './health-classification.mjs';

/** Health vault: intake answers and cycle data live in their own table, encrypted
 * with a purpose-bound key, and every read/write is recorded in health_access_log.
 * Reads require an explicit purpose and the shopper's health consent. */
export const PHASES = ['menstrual', 'follicular', 'ovulatory', 'luteal'];
export function cyclePhase(cycle, at) {
  if (!cycle?.lastPeriodStart) return null;
  const length = Number.isInteger(cycle.cycleLength) && cycle.cycleLength >= 20 && cycle.cycleLength <= 45 ? cycle.cycleLength : 28;
  const start = Date.parse(cycle.lastPeriodStart); if (!Number.isFinite(start)) return null;
  const elapsed = Math.floor((at.getTime() - start) / DAY); if (elapsed < 0) return null;
  const day = (elapsed % length) + 1;
  const phase = day <= 5 ? 'menstrual' : day <= 13 ? 'follicular' : day <= 16 ? 'ovulatory' : 'luteal';
  return { day, length, phase, daysUntilNextPeriod: length - day + 1,
    nextPeriodStart: new Date(start + (Math.floor(elapsed / length) + 1) * length * DAY).toISOString().slice(0, 10) };
}
const PURPOSES = ['profile', 'segmentation', 'campaign', 'support', 'dsar_export', 'intake_update'];

export async function createHealthVault(db, { secret, clock }) {
  const vault = keyring(secret, 'health-data');
  const messages = keyring(secret, 'health-messages');
  const messageDedupe = value => `health_v1_${createHmac('sha256', String(secret)).update('avafem:health-message-dedupe:').update(String(value)).digest('hex')}`;
  const now = () => clock();
  async function log(q, shopperId, actor, purpose, action) {
    await q.query('INSERT INTO health_access_log(shopper_id,actor,purpose,action,created_at) VALUES($1,$2,$3,$4,$5)', [shopperId, actor, purpose, action, now()]);
  }
  function messagePurpose({ purpose, bypassConsent = false } = {}) {
    if (!PURPOSES.includes(purpose)) fail('A declared health-data access purpose is required.', 400, 'PURPOSE_REQUIRED');
    if (bypassConsent && purpose !== 'dsar_export') fail('Health-message consent may only be bypassed for a DSAR export.', 403, 'CONSENT_REQUIRED');
  }
  async function messageAllowed(shopperId, options) {
    messagePurpose(options);
    const s = await first(db, 'SELECT consent,deleted_at FROM shoppers WHERE id=$1', [shopperId]);
    return Boolean(s && !s.deletedAt && (options.bypassConsent || s.consent?.health));
  }
  const migrationId='health-outbox-v2',verifier='avafem:health-outbox-v2:original-key';
  const recipientKey=keyring(secret,'shopper-pii');
  // Run once at boot, then in bounded background/admin batches if needed. Never
  // scan or rewrite the outbox on a message read. Version-0 rows are withheld
  // until migrated, including rows written by an older worker after completion.
  async function migrateOutbox({force=false,batchSize=500}={}) {
    int(batchSize,'batchSize',1,500);
    return db.transaction(async tx => {
      await tx.query('INSERT INTO health_outbox_migrations(id,key_verifier_enc) VALUES($1,$2) ON CONFLICT DO NOTHING',[migrationId,messages.encrypt(verifier)]);
      const state=await first(tx,'SELECT * FROM health_outbox_migrations WHERE id=$1 FOR UPDATE',[migrationId]);
      try { if (messages.decrypt(state.keyVerifierEnc)!==verifier) throw new Error('wrong key'); }
      catch { fail('The original encryption key is required for health-message migration.',503,'HEALTH_MESSAGE_KEY_REQUIRED'); }
      if (state.completedAt && !force) {
        const late=await first(tx,'SELECT EXISTS(SELECT 1 FROM message_outbox WHERE protection_version<2) AS pending');
        if (!late.pending) return {processed:0,processedTotal:state.processedCount,complete:true,completedAt:state.completedAt};
      }
      const legacy = await rows(tx, `SELECT m.*,c.kind,c.template,c.health AS campaign_health,s.rules,s.health AS segment_health
        FROM message_outbox m LEFT JOIN campaigns c ON c.id=m.campaign_id LEFT JOIN segments s ON s.id=c.segment_id
        WHERE m.protection_version<2 ORDER BY m.id LIMIT $1 FOR UPDATE OF m`,[batchSize]);
      for (const m of legacy) {
        if (m.recipientEnc==='erased') {
          await tx.query("UPDATE message_outbox SET subject='[erased]',body='[erased]',body_enc=NULL,protection_version=2 WHERE id=$1",[m.id]);
          continue;
        }
        // Even plaintext legacy bodies still have encrypted recipients. Validate
        // that the original key is present before re-encrypting any content.
        try { if (typeof recipientKey.decrypt(m.recipientEnc)!=='string') throw new Error('invalid recipient'); }
        catch { fail('The original encryption key is required for health-message migration.',503,'HEALTH_MESSAGE_KEY_REQUIRED'); }
        let sensitive=m.containsHealth;
        if (m.campaignId) {
          try { sensitive ||= !m.kind || campaignNeedsHealth({kind:m.kind,template:m.template,health:m.campaignHealth},{rules:m.rules || {},health:m.segmentHealth}); }
          catch { sensitive=true; } // Unclassified legacy data is protected, never exposed.
        }
        if (!sensitive) { await tx.query('UPDATE message_outbox SET protection_version=2 WHERE id=$1',[m.id]); continue; }
        let content = { shopperId: m.shopperId, subject: m.subject, body: m.body };
        if (m.bodyEnc) {
          try { content = messages.decrypt(m.bodyEnc); } catch { fail('Health message migration requires its original encryption key.', 409, 'HEALTH_MESSAGE_UNAVAILABLE'); }
          if (content?.shopperId !== m.shopperId) fail('Health message migration identity mismatch.', 409, 'HEALTH_MESSAGE_UNAVAILABLE');
        }
        await tx.query("UPDATE message_outbox SET contains_health=TRUE,body_enc=$2,campaign_id=NULL,dedupe_key=$3,subject='[health message]',body='[health message]',protection_version=2 WHERE id=$1",
          [m.id, messages.encrypt({ ...content, campaignId: content.campaignId ?? m.campaignId }), /^health_v1_[a-f0-9]{64}$/.test(m.dedupeKey) ? m.dedupeKey : messageDedupe(m.dedupeKey)]);
        await log(tx, m.shopperId, 'outbox-migration', 'campaign', 'outbox_encrypt');
      }
      const pending=(await first(tx,'SELECT EXISTS(SELECT 1 FROM message_outbox WHERE protection_version<2) AS pending')).pending;
      const updated=await first(tx,'UPDATE health_outbox_migrations SET processed_count=processed_count+$2,completed_at=$3 WHERE id=$1 RETURNING *',[migrationId,legacy.length,pending ? null : now()]);
      return {processed:legacy.length,processedTotal:updated.processedCount,complete:!pending,completedAt:updated.completedAt};
    });
  }
  await migrateOutbox();
  return {
    vault,
    protectOutbox:migrateOutbox,
    migrateOutbox,
    async migrationStatus() {
      const state=await first(db,'SELECT processed_count,completed_at FROM health_outbox_migrations WHERE id=$1',[migrationId]);
      const pending=await first(db,'SELECT COUNT(*)::int AS count FROM message_outbox WHERE protection_version<2');
      return {version:2,processedTotal:state?.processedCount || 0,pendingRows:pending.count,complete:Boolean(state?.completedAt) && pending.count===0,completedAt:state?.completedAt || null,originalKeyRequired:true};
    },
    messageDedupe,
    async encryptMessage(shopperId, { subject, body, campaignId = null }, { actor = 'system', purpose } = {}) {
      if (!await messageAllowed(shopperId, { purpose })) return null;
      const encrypted = messages.encrypt({ shopperId, subject, body, campaignId });
      await log(db, shopperId, actor, purpose, 'outbox_write');
      return encrypted;
    },
    async readMessage(shopperId, encrypted, { actor = 'system', purpose, bypassConsent = false } = {}) {
      if (!await messageAllowed(shopperId, { purpose, bypassConsent }) || !encrypted) return null;
      let value;
      try { value = messages.decrypt(encrypted); } catch { return null; }
      if (value?.shopperId !== shopperId || typeof value.subject !== 'string' || typeof value.body !== 'string') return null;
      await log(db, shopperId, actor, purpose, 'outbox_read');
      return { subject: value.subject, body: value.body, campaignId: value.campaignId ?? null };
    },
    async write(shopperId, { intake, cycle }, actor = 'system') {
      const current = await this.read(shopperId, { actor, purpose: 'intake_update', bypassConsent: true }) || {};
      const next = { intake: intake ? sanitizeIntake(intake) : current.intake || {}, cycle: cycle ? sanitizeCycle(cycle) : current.cycle || {} };
      await db.query(`INSERT INTO health_records(shopper_id,data_enc,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(shopper_id) DO UPDATE SET data_enc=EXCLUDED.data_enc,updated_at=EXCLUDED.updated_at`, [shopperId, vault.encrypt(next), now()]);
      await log(db, shopperId, actor, 'intake_update', 'write');
      return next;
    },
    async read(shopperId, { actor = 'system', purpose, bypassConsent = false } = {}) {
      if (!PURPOSES.includes(purpose)) fail('A declared health-data access purpose is required.', 400, 'PURPOSE_REQUIRED');
      const row = await first(db, `SELECT h.data_enc, s.consent, s.deleted_at FROM shoppers s LEFT JOIN health_records h ON h.shopper_id=s.id WHERE s.id=$1`, [shopperId]);
      if (!row || row.deletedAt) return null;
      if (!bypassConsent && !row.consent?.health) return null;
      if (!row.dataEnc) return null;
      await log(db, shopperId, actor, purpose, 'read');
      return vault.decrypt(row.dataEnc);
    },
    async accessLog(shopperId) { return rows(db, 'SELECT id,actor,purpose,action,created_at FROM health_access_log WHERE shopper_id=$1 ORDER BY id', [shopperId]); },
    log,
  };
}
function sanitizeIntake(input) {
  const list = v => Array.isArray(v) ? v.map(x => text(x, 80).toLowerCase()).filter(Boolean).slice(0, 30) : [];
  return { concerns: list(input.concerns), sensitivities: list(input.sensitivities), goals: list(input.goals),
    answers: Object.fromEntries(Object.entries(input.answers || {}).slice(0, 50).map(([k, v]) => [text(k, 80), text(String(v), 500)])) };
}
function sanitizeCycle(input) {
  const date = text(input.lastPeriodStart, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('cycle.lastPeriodStart must be YYYY-MM-DD.');
  const length = input.cycleLength == null ? 28 : Number(input.cycleLength);
  if (!Number.isInteger(length) || length < 20 || length > 45) fail('cycle.cycleLength must be 20–45 days.');
  return { lastPeriodStart: date || null, cycleLength: length };
}
