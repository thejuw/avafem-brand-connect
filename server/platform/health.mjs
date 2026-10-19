import { keyring, first, rows, fail, text, DAY } from './util.mjs';

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
  const now = () => clock();
  async function log(q, shopperId, actor, purpose, action) {
    await q.query('INSERT INTO health_access_log(shopper_id,actor,purpose,action,created_at) VALUES($1,$2,$3,$4,$5)', [shopperId, actor, purpose, action, now()]);
  }
  return {
    vault,
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
