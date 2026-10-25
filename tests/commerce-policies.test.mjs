import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../server/db.mjs';
import { createCommercePolicies } from '../server/commerce/policies.mjs';

const OWNED = { model: 'first_party', inventoryAuthority: 'native', inventoryOwner: 'avafem',
  fulfiller: 'avafem', settlementModel: 'retail', commissionBps: 0 };
const PARTNER = { model: 'partner', inventoryAuthority: 'external', inventoryOwner: 'partner',
  fulfiller: 'partner', settlementModel: 'commission', commissionBps: 1500 };
const code = value => error => error.code === value;
async function fixture(t) {
  const db = await createDatabase({ connectionString: null });
  t.after(() => db.close());
  await db.migrate();
  await db.query(`INSERT INTO brands(id,name,slug,commission_bps,shipping_table) VALUES
    ('brand_partner','Partner','partner',1500,'[{"country":"US","priceCents":325}]'),
    ('brand_other','Other','other',1800,'[{"country":"CA","priceCents":900}]')`);
  const policies = await createCommercePolicies(db, { clock: () => new Date('2026-10-25T12:00:00.000Z') });
  return { db, policies };
}

test('policy defaults are explicit and existing brand flags never infer first-party ownership', async t => {
  const { db, policies } = await fixture(t);
  assert.deepEqual(await policies.get(), {
    version: 0, merchantOfRecord: 'avafem', currency: 'USD', discountBps: 0, discountFunding: 'avafem', loyaltyBps: 500,
    freeShippingThresholdCents: null, freeShippingFunding: 'avafem', returnShippingFunding: 'avafem',
    ownedShippingCents: 0, returnWindowDays: 30, reservationMinutes: 15,
    taxProvider: 'stripe_tax', taxLiableParty: 'avafem', taxConfigurationRef: '', enabled: true,
  });
  await db.query("UPDATE brands SET connection_tier='dashboard',stripe_account_id=NULL WHERE id='brand_partner'");
  assert.deepEqual(await policies.getBrand('brand_partner'), { version: 0, brandId: 'brand_partner', ...PARTNER,
    shippingCents: 325, partnerPromotionAgreement: '' });
  const other = await policies.getBrand('brand_other');
  assert.equal(other.commissionBps, 1800);
  assert.equal(other.shippingCents, 0);
  assert.equal(other.model, 'partner');
  assert.equal((await db.query('SELECT * FROM commerce_policy_audit')).rows.length, 0);
  await assert.rejects(policies.getBrand('missing'), code('COMMERCE_BRAND_NOT_FOUND'));
});

test('platform updates append immutable versions and matching actor/reason audit atomically', async t => {
  const { db, policies } = await fixture(t);
  const one = await policies.save({ expectedVersion: 0, reason: 'Initial promotion, paid by Avafem.',
    discountBps: 500, freeShippingThresholdCents: 5000, taxConfigurationRef: 'settings_fixture', ownedShippingCents: 250 }, 'admin:one');
  assert.equal(one.version, 1);
  assert.equal(one.discountBps, 500);
  const two = await policies.save({ expectedVersion: 1, reason: 'Pause new quotes.', enabled: false }, 'admin:two');
  assert.equal(two.version, 2);
  assert.equal(two.discountBps, 500);
  assert.equal(two.enabled, false);
  const versions = (await db.query('SELECT * FROM commerce_platform_policy_versions ORDER BY version')).rows;
  assert.equal(versions[0].config.enabled, true);
  assert.equal(versions[1].config.enabled, false);
  const audit = (await db.query('SELECT * FROM commerce_policy_audit ORDER BY version')).rows;
  assert.deepEqual(audit.map(row => [row.scope, row.version, row.actor, row.reason]), [
    ['platform', 1, 'admin:one', 'Initial promotion, paid by Avafem.'], ['platform', 2, 'admin:two', 'Pause new quotes.'],
  ]);
  assert.ok(audit.every(row => new Date(row.created_at).toISOString() === '2026-10-25T12:00:00.000Z'));
  await db.transaction(async tx => {
    assert.deepEqual(await policies.get(tx), two);
    assert.equal((await policies.getBrand('brand_partner', tx)).version, 0);
  });
});

test('platform strict validation forbids unknown/live/currency/secret fields, missing reasons and invalid types', async t => {
  const { db, policies } = await fixture(t);
  const invalid = [
    { secretKey: 'not-a-key' }, { live: true }, { currency: 'CAD' }, { merchantOfRecord: 'partner' },
    { taxLiableParty: 'partner' }, { taxProvider: 'estimated_tax' }, { discountBps: 10_001 },
    { discountBps: '500' }, { discountBps: 0.5 }, { discountFunding: 'shared' },
    { loyaltyBps: -1 }, { loyaltyBps: 10_001 }, { loyaltyBps: '500' }, { loyaltyBps: 0.5 },
    { returnShippingFunding: null }, { freeShippingThresholdCents: -1 }, { ownedShippingCents: 1.5 },
    { enabled: 'true' }, { reservationMinutes: 0 }, { reservationMinutes: 61 }, { returnWindowDays: 366 },
    { taxConfigurationRef: 'sk_test_credentialmustnotpersist' }, { reason: '' }, { expectedVersion: undefined },
  ];
  for (const input of invalid) await assert.rejects(policies.save({ expectedVersion: 0, reason: 'Validation fixture.', ...input }), code('COMMERCE_POLICY_INVALID'));
  await assert.rejects(policies.save({ expectedVersion: 0, reason: 'Fixture.' }, ''), code('COMMERCE_POLICY_INVALID'));
  assert.equal((await policies.get()).version, 0);
  assert.equal((await db.query('SELECT * FROM commerce_platform_policy_versions')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM commerce_policy_audit')).rows.length, 0);
});

test('all three partner funding choices are explicit policy only and never manufacture partner agreement', async t => {
  const { policies } = await fixture(t);
  const result = await policies.save({ expectedVersion: 0, reason: 'Require separately agreed partner-funded offers.',
    discountFunding: 'partner', freeShippingFunding: 'partner', returnShippingFunding: 'partner' });
  assert.equal(result.discountFunding, 'partner');
  assert.equal(result.freeShippingFunding, 'partner');
  assert.equal(result.returnShippingFunding, 'partner');
  assert.equal((await policies.getBrand('brand_partner')).partnerPromotionAgreement, '');
});

test('loyalty rate is versioned independently from discounts and accepts bounded endpoints', async t => {
  const { db, policies } = await fixture(t);
  const one = await policies.save({ expectedVersion: 0, reason: 'Disable new canonical credit accrual.', loyaltyBps: 0 });
  assert.equal(one.loyaltyBps, 0);
  assert.equal(one.discountBps, 0);
  const two = await policies.save({ expectedVersion: 1, reason: 'Explicit bounded loyalty fixture.', loyaltyBps: 10_000 });
  assert.equal(two.loyaltyBps, 10_000);
  const history = (await db.query('SELECT config FROM commerce_platform_policy_versions ORDER BY version')).rows;
  assert.equal(history[0].config.loyaltyBps, 0);
  assert.equal(history[1].config.loyaltyBps, 10_000);
});

test('concurrent platform saves from independent service instances accept exactly one expected version', async t => {
  const { db, policies } = await fixture(t);
  const second = await createCommercePolicies(db);
  const results = await Promise.allSettled([
    policies.save({ expectedVersion: 0, reason: 'First editor.', discountBps: 100 }),
    second.save({ expectedVersion: 0, reason: 'Second editor.', discountBps: 200 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected').reason;
  assert.equal(rejected.code, 'COMMERCE_POLICY_VERSION_CONFLICT');
  assert.equal(rejected.details.currentVersion, 1);
  assert.equal((await db.query('SELECT * FROM commerce_platform_policy_versions')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM commerce_policy_audit')).rows.length, 1);
});

test('first-party requires the complete native/Avafem/retail/zero-commission configuration', async t => {
  const { policies } = await fixture(t);
  for (const input of [
    { model: 'first_party' }, { ...OWNED, commissionBps: 1500 }, { ...OWNED, inventoryAuthority: 'external' },
    { ...OWNED, inventoryOwner: 'partner' }, { ...OWNED, fulfiller: 'partner' }, { ...OWNED, settlementModel: 'commission' },
    { ...PARTNER, inventoryAuthority: 'native' }, { enabled: true }, { stripeAccountId: 'acct_notallowed' },
  ]) await assert.rejects(policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Invalid commercial combination.', ...input }), code('COMMERCE_POLICY_INVALID'));
  const saved = await policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Explicitly assign Avafem-owned products.', ...OWNED }, 'admin:inventory');
  assert.equal(saved.version, 1);
  assert.equal(saved.model, 'first_party');
  assert.equal(saved.commissionBps, 0);
  assert.equal(saved.shippingCents, 325);
  assert.equal((await policies.getBrand('brand_other')).model, 'partner');
});

test('native variant, Bag allocation, and pending checkout references independently lock commercial structure', async t => {
  const { db, policies } = await fixture(t);
  await db.query('CREATE TABLE commerce_native_variants(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL)');
  await db.query('CREATE TABLE commerce_bag_allocations(bag_id TEXT PRIMARY KEY,brand_id TEXT NOT NULL)');
  await db.query('CREATE TABLE commerce_checkouts(id TEXT PRIMARY KEY,state TEXT NOT NULL,brand_ids JSONB NOT NULL)');
  for (const [table, insert] of [
    ['commerce_native_variants', "INSERT INTO commerce_native_variants VALUES('v1','brand_partner')"],
    ['commerce_bag_allocations', "INSERT INTO commerce_bag_allocations VALUES('b1','brand_partner')"],
    ['commerce_checkouts', "INSERT INTO commerce_checkouts VALUES('c1','pending','[\"brand_partner\"]')"],
  ]) {
    await db.query(insert);
    await assert.rejects(policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Unsafe ownership reassignment.', ...OWNED }), code('COMMERCE_POLICY_STRUCTURE_LOCKED'));
    // Cleanup here is isolated test data, not an application recovery operation.
    await db.query(`DELETE FROM ${table}`);
  }
  assert.equal((await policies.getBrand('brand_partner')).version, 0);
  assert.equal((await db.query('SELECT * FROM commerce_policy_audit')).rows.length, 0);
  // A different tenant's stock or checkout does not freeze this brand.
  await db.query("INSERT INTO commerce_checkouts VALUES('c2','pending','[\"brand_other\"]')");
  assert.equal((await policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Explicit owned configuration.', ...OWNED })).version, 1);
});

test('used partner terms may be versioned without rewriting brands or historic policies', async t => {
  const { db, policies } = await fixture(t);
  await db.query('CREATE TABLE commerce_bag_allocations(bag_id TEXT PRIMARY KEY,brand_id TEXT NOT NULL)');
  const one = await policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Persist current partner terms.' });
  await db.query("INSERT INTO commerce_bag_allocations VALUES('old_bag','brand_partner')");
  const two = await policies.saveBrand('brand_partner', { expectedVersion: 1, reason: 'Signed future promotion terms.',
    commissionBps: 1200, shippingCents: 400, partnerPromotionAgreement: 'agreement:partner-fixture-v2' }, 'admin:finance');
  assert.equal(two.version, 2);
  assert.equal(two.commissionBps, 1200);
  assert.equal(two.shippingCents, 400);
  assert.equal((await db.query("SELECT commission_bps FROM brands WHERE id='brand_partner'")).rows[0].commission_bps, 1500);
  const history = (await db.query("SELECT * FROM commerce_brand_policy_versions WHERE brand_id='brand_partner' ORDER BY version")).rows;
  assert.equal(history[0].config.commissionBps, one.commissionBps);
  assert.equal(history[0].config.partnerPromotionAgreement, '');
  assert.equal(history[1].config.partnerPromotionAgreement, two.partnerPromotionAgreement);
  await assert.rejects(policies.saveBrand('brand_partner', { expectedVersion: 2, reason: 'Cannot change structural model.', ...OWNED }), code('COMMERCE_POLICY_STRUCTURE_LOCKED'));
});

test('brand optimistic version conflict is tenant-local and failed audit rolls back the version', async t => {
  const { db, policies } = await fixture(t);
  const results = await Promise.allSettled([
    policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'One.', shippingCents: 100 }),
    policies.saveBrand('brand_partner', { expectedVersion: 0, reason: 'Two.', shippingCents: 200 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'COMMERCE_POLICY_VERSION_CONFLICT');
  assert.equal((await policies.saveBrand('brand_other', { expectedVersion: 0, reason: 'Independent tenant.' })).version, 1);
  await db.query('ALTER TABLE commerce_policy_audit ADD CONSTRAINT reject_fixture_audit CHECK(actor<>\'blocked_fixture\')');
  await assert.rejects(policies.saveBrand('brand_partner', { expectedVersion: 1, reason: 'Audit must be atomic.', shippingCents: 300 }, 'blocked_fixture'));
  assert.equal((await policies.getBrand('brand_partner')).version, 1);
  assert.equal((await db.query("SELECT * FROM commerce_brand_policy_versions WHERE brand_id='brand_partner'")).rows.length, 1);
});

test('immutable provider-test store bindings cannot be repurposed as native first-party identities',async t=>{
  const {db,policies}=await fixture(t);
  await db.query('CREATE TABLE provider_test_stores(brand_id TEXT PRIMARY KEY REFERENCES brands(id))');
  await db.query("INSERT INTO provider_test_stores(brand_id) VALUES('brand_partner')");
  await assert.rejects(policies.saveBrand('brand_partner',{expectedVersion:0,reason:'Do not repurpose a provider acceptance identity',...OWNED}),code('COMMERCE_POLICY_EXTERNAL_BINDING'));
  assert.equal((await policies.getBrand('brand_partner')).version,0);
  assert.equal((await policies.getBrand('brand_partner')).model,'partner');
  assert.equal((await policies.saveBrand('brand_other',{expectedVersion:0,reason:'Separate explicit native product identity',...OWNED})).model,'first_party');
});
