import { randomUUID } from 'node:crypto';

const PLATFORM_DEFAULTS = Object.freeze({
  merchantOfRecord: 'avafem', currency: 'USD', discountBps: 0, discountFunding: 'avafem', loyaltyBps: 500,
  freeShippingThresholdCents: null, freeShippingFunding: 'avafem', returnShippingFunding: 'avafem',
  ownedShippingCents: 0, returnWindowDays: 30, reservationMinutes: 15,
  taxProvider: 'stripe_tax', taxLiableParty: 'avafem', taxConfigurationRef: '', enabled: true,
});
const BRAND_KEYS = ['model', 'inventoryAuthority', 'inventoryOwner', 'fulfiller', 'settlementModel',
  'commissionBps', 'shippingCents', 'partnerPromotionAgreement'];
const STRUCTURAL_KEYS = ['model', 'inventoryAuthority', 'inventoryOwner', 'fulfiller', 'settlementModel'];
const fail = (message, statusCode = 422, code = 'COMMERCE_POLICY_INVALID', details) => {
  throw Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const clone = value => structuredClone(value);

function boundedText(value, field, { required = false, max = 2000 } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || (required && !value.trim())) fail(`Provide a valid ${field}.`);
  // Policies contain references and explanations, never provider credentials.
  if (/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+|\bwhsec_[A-Za-z0-9]+|\bBearer\s+[A-Za-z0-9._~-]{16,}/iu.test(value))
    fail(`${field} must not contain credentials.`);
  return value.trim();
}
function request(input, keys) {
  if (!object(input) || Object.keys(input).some(key => ![...keys, 'expectedVersion', 'reason'].includes(key)))
    fail('Only the documented commerce policy fields are supported.');
  if (!integer(input.expectedVersion, 0, 2_147_483_646)) fail('Provide expectedVersion as a nonnegative integer.');
  const reason = boundedText(input.reason, 'reason', { required: true });
  const changes = {};
  for (const key of keys) if (Object.hasOwn(input, key)) changes[key] = input[key];
  return { expectedVersion: input.expectedVersion, reason, changes };
}
function platformConfig(value) {
  for (const key of ['merchantOfRecord', 'taxLiableParty']) if (value[key] !== 'avafem') fail('Only Avafem merchant and tax configuration is supported.');
  if (value.currency !== 'USD' || value.taxProvider !== 'stripe_tax') fail('Only USD with Stripe Tax is supported.');
  if (!integer(value.discountBps, 0, 10_000)) fail('discountBps must be between 0 and 10000.');
  if (!integer(value.loyaltyBps, 0, 10_000)) fail('loyaltyBps must be between 0 and 10000.');
  for (const key of ['discountFunding', 'freeShippingFunding', 'returnShippingFunding'])
    if (!['avafem', 'partner'].includes(value[key])) fail(`${key} must be avafem or partner.`);
  if (value.freeShippingThresholdCents !== null && !integer(value.freeShippingThresholdCents, 0, 100_000_000))
    fail('freeShippingThresholdCents must be null or bounded nonnegative integer cents.');
  if (!integer(value.ownedShippingCents, 0, 100_000_000)) fail('ownedShippingCents must be bounded nonnegative integer cents.');
  if (!integer(value.returnWindowDays, 0, 365)) fail('returnWindowDays must be between 0 and 365.');
  if (!integer(value.reservationMinutes, 1, 60)) fail('reservationMinutes must be between 1 and 60.');
  if (typeof value.enabled !== 'boolean') fail('enabled must be a boolean.');
  return { ...value, taxConfigurationRef: boundedText(value.taxConfigurationRef, 'taxConfigurationRef', { max: 200 }) };
}
function brandConfig(value) {
  const validPartner = value.model === 'partner' && value.inventoryAuthority === 'external' && value.inventoryOwner === 'partner'
    && value.fulfiller === 'partner' && value.settlementModel === 'commission';
  const validOwned = value.model === 'first_party' && value.inventoryAuthority === 'native' && value.inventoryOwner === 'avafem'
    && value.fulfiller === 'avafem' && value.settlementModel === 'retail' && value.commissionBps === 0;
  if (!validPartner && !validOwned) fail('Use the complete supported partner or first-party commercial model.');
  if (!integer(value.commissionBps, 0, 10_000)) fail('commissionBps must be between 0 and 10000.');
  if (!integer(value.shippingCents, 0, 100_000_000)) fail('shippingCents must be bounded nonnegative integer cents.');
  return { ...value, partnerPromotionAgreement: boundedText(value.partnerPromotionAgreement, 'partnerPromotionAgreement') };
}
const brandKey = value => boundedText(value, 'brandId', { required: true, max: 120 });

/** Versioned configuration only: does not enable live mode, collect tax, move
 * funds, or establish partner consent. Quote creation must check every affected
 * partner's snapshotted partnerPromotionAgreement before partner-funded costs.
 *
 * Reads accept an existing tx to avoid nested transactions. save/saveBrand take
 * partial configuration + mandatory {expectedVersion,reason}; version 0 denotes
 * an unconfigured, derived default. Successful writes append version and audit.
 */
export async function createCommercePolicies(db, { clock = () => new Date() } = {}) {
  if (!db?.query || !db?.transaction || typeof clock !== 'function') fail('A database and clock are required.', 500);
  const now = () => {
    const result = new Date(clock());
    if (!Number.isFinite(result.getTime())) fail('The policy clock is invalid.', 500);
    return result.toISOString();
  };
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_platform_policy_versions (
    version INTEGER PRIMARY KEY CHECK(version>0), config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_brand_policy_versions (
    brand_id TEXT NOT NULL REFERENCES brands(id), version INTEGER NOT NULL CHECK(version>0),
    config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(brand_id,version)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS commerce_policy_audit (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('platform','brand')), policy_key TEXT NOT NULL,
    brand_id TEXT REFERENCES brands(id), version INTEGER NOT NULL CHECK(version>0), actor TEXT NOT NULL,
    reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, UNIQUE(scope,policy_key,version)
  )`);
  async function get(tx = db) {
    const row = (await tx.query('SELECT version,config FROM commerce_platform_policy_versions ORDER BY version DESC LIMIT 1')).rows[0];
    return row ? { version: row.version, ...platformConfig(clone(row.config)) } : { version: 0, ...clone(PLATFORM_DEFAULTS) };
  }
  async function getBrand(brandId, tx = db) {
    brandId = brandKey(brandId);
    const brand = (await tx.query('SELECT id,commission_bps,shipping_table FROM brands WHERE id=$1', [brandId])).rows[0];
    if (!brand) fail('Brand not found.', 404, 'COMMERCE_BRAND_NOT_FOUND');
    const row = (await tx.query('SELECT version,config FROM commerce_brand_policy_versions WHERE brand_id=$1 ORDER BY version DESC LIMIT 1', [brandId])).rows[0];
    if (row) return { version: row.version, brandId, ...brandConfig(clone(row.config)) };
    const usRate = Array.isArray(brand.shipping_table) ? brand.shipping_table.find(rate => rate.country === 'US') : undefined;
    const config = brandConfig({ model: 'partner', inventoryAuthority: 'external', inventoryOwner: 'partner', fulfiller: 'partner',
      settlementModel: 'commission', commissionBps: brand.commission_bps, shippingCents: usRate?.priceCents ?? 0, partnerPromotionAgreement: '' });
    return { version: 0, brandId, ...config };
  }
  async function audit(tx, scope, key, brandId, version, actor, reason, at) {
    await tx.query(`INSERT INTO commerce_policy_audit(id,scope,policy_key,brand_id,version,actor,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [`cpol_${randomUUID().replaceAll('-', '')}`, scope, key, brandId, version, actor, reason, at]);
  }
  const conflict = current => fail('Commerce policy changed; reload before saving.', 409, 'COMMERCE_POLICY_VERSION_CONFLICT', { currentVersion: current.version });
  async function save(input, actor = 'owner') {
    const parsed = request(input, Object.keys(PLATFORM_DEFAULTS));
    actor = boundedText(actor, 'actor', { required: true, max: 200 });
    return db.transaction(async tx => {
      // The database adapter serializes mutations across PostgreSQL pools via a
      // transaction advisory lock; the unique version key is a final safeguard.
      const current = await get(tx);
      if (current.version !== parsed.expectedVersion) conflict(current);
      const { version: previous, ...prior } = current;
      const config = platformConfig({ ...prior, ...parsed.changes });
      const version = previous + 1, at = now();
      await tx.query('INSERT INTO commerce_platform_policy_versions(version,config,created_at) VALUES($1,$2,$3)', [version, JSON.stringify(config), at]);
      await audit(tx, 'platform', 'platform', null, version, actor, parsed.reason, at);
      return { version, ...config };
    });
  }
  async function hasStructuralReferences(tx, brandId) {
    // Fixed server-owned table names. Some modules initialize after this one.
    for (const table of ['commerce_native_variants', 'commerce_bag_allocations', 'commerce_checkouts']) {
      const exists = (await tx.query('SELECT to_regclass($1) AS relation', [table])).rows[0]?.relation;
      if (!exists) continue;
      const predicate = table === 'commerce_checkouts' ? 'brand_ids ? $1' : 'brand_id=$1';
      if ((await tx.query(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`, [brandId])).rows.length) return true;
    }
    return false;
  }
  async function saveBrand(brandId, input, actor = 'owner') {
    brandId = brandKey(brandId);
    const parsed = request(input, BRAND_KEYS);
    actor = boundedText(actor, 'actor', { required: true, max: 200 });
    return db.transaction(async tx => {
      // Snapshot/stock creators must take this same brand lock before reading
      // policy and writing their reference. Historical commercial terms stay put.
      if (!(await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE', [brandId])).rows.length)
        fail('Brand not found.', 404, 'COMMERCE_BRAND_NOT_FOUND');
      const current = await getBrand(brandId, tx);
      if (current.version !== parsed.expectedVersion) conflict(current);
      const { version: previous, brandId: ignored, ...prior } = current;
      const config = brandConfig({ ...prior, ...parsed.changes });
      if(config.model==='first_party' && current.model!=='first_party'
        && (await tx.query("SELECT to_regclass('provider_test_stores') AS relation")).rows[0]?.relation
        && (await tx.query('SELECT 1 FROM provider_test_stores WHERE brand_id=$1 LIMIT 1',[brandId])).rows.length)
        fail('This brand belongs to an immutable provider test-store binding. Create a separate Avafem-owned brand.',409,'COMMERCE_POLICY_EXTERNAL_BINDING');
      if (STRUCTURAL_KEYS.some(key => config[key] !== current[key]) && await hasStructuralReferences(tx, brandId))
        fail('Commercial ownership and inventory authority are locked after stock or checkout use.', 409, 'COMMERCE_POLICY_STRUCTURE_LOCKED');
      const version = previous + 1, at = now();
      await tx.query('INSERT INTO commerce_brand_policy_versions(brand_id,version,config,created_at) VALUES($1,$2,$3,$4)', [brandId, version, JSON.stringify(config), at]);
      await audit(tx, 'brand', brandId, brandId, version, actor, parsed.reason, at);
      return { version, brandId, ...config };
    });
  }
  return { get, save, getBrand, saveBrand };
}
