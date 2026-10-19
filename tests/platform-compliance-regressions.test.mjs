import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { platformFixture } from './helpers/platform-fixture.mjs';

const listing = description => ({ title: 'Gentle cleansing balm', description, category: 'body-care/balm', priceCents: 1200, inventoryQty: 10,
  images: ['https://images.example.com/fixture.jpg'], taxCode: 'txcd_99999999', shippingProfile: 'standard',
  evidence: { ingredients_inci: ['Aqua'], certifications: [], claims: [], contraindications: 'External use only.' } });

test('approval rechecks edited listing inside the transaction after an earlier clean HTTP read', { timeout: 20_000 }, async t => {
  const f = await platformFixture(t);
  const product = await f.domain.upsertProduct('brand_bloom', 'COMPLIANCE-RACE', listing('A gentle cleansing routine.'));
  assert.equal((await f.platform.compliance.check(product.id)).canGoLive, true);
  const review = f.domain.reviewProduct.bind(f.domain);
  t.mock.method(f.domain, 'reviewProduct', async (...args) => {
    await f.domain.upsertProduct('brand_bloom', product.sku, listing('Cures PCOS and treats endometriosis.'));
    return review(...args);
  });
  const response = await f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } });
  assert.equal(response.statusCode, 409, response.body); assert.match(response.body, /COMPLIANCE_BLOCKED/);
  assert.equal((await f.domain.getProduct(product.id)).status, 'in_review');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND type='product.approved'", [product.id])).rows[0].n, 0);
});

test('direct domain callers cannot bypass compliance; overrides are exact-content and transactional', { timeout: 20_000 }, async t => {
  const f = await platformFixture(t);
  const product = await f.domain.upsertProduct('brand_bloom', 'COMPLIANCE-DIRECT', listing('Cures PCOS.'));
  await assert.rejects(() => f.domain.reviewProduct(product.id, { status: 'approved' }), { code: 'COMPLIANCE_BLOCKED' });
  const overridden = await f.platform.compliance.override(product.id, 'Sandbox operator explicitly reviewed this exact content.', 'owner');
  assert.equal(overridden.overridden, true);
  assert.equal((await f.domain.reviewProduct(product.id, { status: 'approved' })).status, 'approved');
  await f.domain.upsertProduct('brand_bloom', product.sku, listing('Cures PCOS and prevents cancer.'));
  assert.equal((await f.platform.compliance.check(product.id)).overridden, false);
  await assert.rejects(() => f.domain.reviewProduct(product.id, { status: 'approved' }), { code: 'COMPLIANCE_BLOCKED' });
  assert.equal((await f.domain.reviewProduct(product.id, { status: 'rejected' })).status, 'rejected', 'rejection is not blocked');
  assert.ok((await f.platform.compliance.scanBrand('brand_bloom')).blocked.includes(product.id));
});

test('transactional compliance reads use tx, chain caller hooks, and reread their current row', { timeout: 20_000 }, async t => {
  let hookCalls = 0;
  const app = await createApp({ worker: false, seed: true, connectionString: null,
    config: { sessionSecret: 'fixture-session-secret', encryptionKey: 'fixture-encryption-key' },
    domainOptions: { beforeProductApproval: async (product, tx) => {
      if (product.sku !== 'COMPLIANCE-HOOK') return;
      hookCalls++;
      await tx.query('UPDATE products SET description=$2 WHERE id=$1', [product.id, 'Cures PCOS.']);
    } },
    integrations: {
      shopify: { status: async () => ({ available: false, configured: false }) },
      stripe: { status: async () => ({ available: false, configured: false, mode: 'test' }) },
    } });
  t.after(() => app.close());
  const { domain, platform, db } = app.avafem;
  const product = await domain.upsertProduct('brand_bloom', 'COMPLIANCE-HOOK', listing('A gentle cleansing routine.'));
  await assert.rejects(() => domain.reviewProduct(product.id, { status: 'approved' }), { code: 'COMPLIANCE_BLOCKED' });
  assert.equal(hookCalls, 1);
  assert.equal((await domain.getProduct(product.id)).description, 'A gentle cleansing routine.', 'failed approval rolls back caller-hook edits too');
  // This would deadlock serialized PGlite if either read used the outer db.
  const read = await db.transaction(tx => platform.compliance.check(product.id, tx));
  assert.equal(read.canGoLive, true);
});
