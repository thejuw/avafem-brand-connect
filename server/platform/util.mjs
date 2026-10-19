import { randomUUID, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const DAY = 86_400_000;
export const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const sha = value => createHash('sha256').update(String(value)).digest('hex');
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const record = row => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v instanceof Date ? v.toISOString() : v]));
export const first = async (q, sql, params = []) => record((await q.query(sql, params)).rows[0]);
export const rows = async (q, sql, params = []) => (await q.query(sql, params)).rows.map(record);
export const fail = (message, statusCode = 422, code = 'VALIDATION_ERROR') => { throw Object.assign(new Error(message), { statusCode, code }); };
export const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const int = (value, name, min = 0, max = 2_000_000_000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}.`);
  return value;
};
export const normEmail = value => text(value, 320).toLowerCase();
export const maskEmail = email => { const [u = '', d = ''] = String(email).split('@'); return `${u.slice(0, 1)}***@${d}`; };
export const maskPhone = phone => `***${String(phone).replace(/\D/g, '').slice(-2)}`;
/** Purpose-bound AES-256-GCM key, derived so a leak of one domain key (e.g. credentials)
 * does not expose health data and vice versa. */
export function keyring(secret, purpose) {
  if (!secret) throw new Error('An encryption secret is required.');
  const key = createHash('sha256').update(`avafem:${purpose}:`).update(String(secret)).digest();
  return {
    encrypt(value) {
      const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), data].map(x => x.toString('base64url')).join('.');
    },
    decrypt(value) {
      if (value == null) return null;
      const [iv, tag, data] = String(value).split('.').map(x => Buffer.from(x, 'base64url'));
      const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
    },
  };
}
export async function exec(db, sql) { for (const s of sql.split(/;\s*\n/).filter(p => p.trim())) await db.query(s); }
