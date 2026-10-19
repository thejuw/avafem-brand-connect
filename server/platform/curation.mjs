import { requireAdmin } from '../auth.mjs';
import { id, first, rows, fail, text, sha } from './util.mjs';
import { checkProduct, productReviewFingerprint } from './compliance.mjs';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
const actorName = (actor, automatic = false) => {
  if (automatic && actor === 'system:onboarding') return actor;
  requireAdmin(actor);
  return actor.credentialId || 'owner';
};
const reason = value => { const out = text(value, 1001); if (out.length < 10 || out.length > 1000) fail('Give an explicit curation reason of 10–1000 characters.'); return out; };
const normalizeFilters = input => {
  const filters = {};
  for (const key of ['brandId', 'status', 'collection', 'productType', 'tag', 'sinceReview']) if (input?.[key]) filters[key] = text(input[key], 150);
  if (filters.status && !['draft', 'in_review', 'approved', 'rejected'].includes(filters.status)) fail('Unknown product status.');
  if (filters.sinceReview && !['new', 'changed', 'new_or_changed'].includes(filters.sinceReview)) fail('Unknown review-change filter.');
  return filters;
};
const changed = p => Boolean(p.reviewedFingerprint && p.reviewedFingerprint !== productReviewFingerprint(p));
const isNew = p => !p.reviewedFingerprint && !p.reviewedAt && p.status !== 'approved';
const matches = (p, f) => (!f.brandId || p.brandId === f.brandId) && (!f.status || p.status === f.status)
  && (!f.collection || (p.collections || []).includes(f.collection)) && (!f.productType || p.productType === f.productType)
  && (!f.tag || (p.tags || []).includes(f.tag)) && (!f.sinceReview || (f.sinceReview === 'new' ? isNew(p) : f.sinceReview === 'changed' ? changed(p) : isNew(p) || changed(p)));

/** Admin product decisions are independent of connection/payout readiness. No
 * provider write happens here. All selected-row decisions, overrides and audit
 * entries share one canonical transaction; a stale selection changes nothing. */
export function createCuration(db, { domain, compliance, clock = () => new Date() }) {
  const audit = (tx, input) => tx.query(`INSERT INTO curation_audit(id,operation_id,brand_id,product_id,actor,action,reason,fingerprint,payload,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [input.id, input.operationId || null, input.brandId, input.productId || null,
    input.actor, input.action, input.reason, input.fingerprint || null, JSON.stringify(input.payload || {}), clock()]);
  const api = {
    async queue(input = {}) {
      const filters = normalizeFilters(input);
      return db.transaction(async tx => {
        const products = await rows(tx, `SELECT * FROM products ${filters.brandId ? 'WHERE brand_id=$1' : ''} ORDER BY updated_at,id LIMIT 2001`, filters.brandId ? [filters.brandId] : []);
        if (products.length > 2000) fail('Narrow the brand filter before reviewing more than 2,000 products.', 422, 'CURATION_LIMIT');
        const selected = products.filter(p => !p.sourceDeletedAt && matches(p, filters) && (filters.status || ['draft', 'in_review'].includes(p.status)));
        const output = [];
        for (const p of selected) output.push({ id: p.id, brandId: p.brandId, sku: p.sku, title: p.title, status: p.status,
          productType: p.productType || '', tags: p.tags || [], collections: p.collections || [], sourceDeletedAt: p.sourceDeletedAt,
          fingerprint: productReviewFingerprint(p), reviewedFingerprint: p.reviewedFingerprint || null, reviewedAt: p.reviewedAt,
          isNew: isNew(p), changedSinceReview: changed(p), validationIssues: p.validationIssues || [],
          compliance: await compliance.check(p, tx), updatedAt: p.updatedAt });
        return { products: output, brands: await rows(tx, 'SELECT id,name,auto_approve_products FROM brands ORDER BY name'), filters, limits: { bulkMax: 500, queueMax: 2000 } };
      });
    },
    async setAutoApprove(brandId, input = {}, actor) {
      const who = actorName(actor), why = reason(input.reason);
      if (typeof input.enabled !== 'boolean') fail('enabled must be a boolean.');
      return db.transaction(async tx => {
        const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1 FOR UPDATE', [brandId]);
        if (!brand) fail('Brand not found.', 404, 'NOT_FOUND');
        if (brand.autoApproveProducts === input.enabled) return { brandId, enabled: input.enabled, changed: false };
        await tx.query('UPDATE brands SET auto_approve_products=$2,updated_at=$3 WHERE id=$1', [brandId, input.enabled, clock()]);
        const auditId = id('curation');
        await audit(tx, { id: auditId, brandId, actor: who, action: 'autoapprove_policy', reason: why, payload: { before: brand.autoApproveProducts, enabled: input.enabled } });
        return { brandId, enabled: input.enabled, changed: true, auditId };
      });
    },
    async bulk(input = {}, actor) {
      const who = actorName(actor), why = reason(input.reason);
      if (!/^[A-Za-z0-9_:-]{8,160}$/.test(input.operationId || '')) fail('Provide a stable curation operationId.');
      if (!['approved', 'rejected'].includes(input.action)) fail('Choose approved or rejected.');
      const filters = normalizeFilters(input.filter);
      if (!input.products && !Object.keys(filters).length) fail('Select product IDs/fingerprints or an explicit nonempty filter.');
      if (input.products && (!Array.isArray(input.products) || !input.products.length || input.products.length > 500)) fail('Select 1–500 products.');
      const requestHash = sha(JSON.stringify(stable({ ...input, actor: who, reason: why })));
      return db.transaction(async tx => {
        const previous = await first(tx, 'SELECT * FROM curation_operations WHERE operation_id=$1', [input.operationId]);
        if (previous) { if (previous.requestHash !== requestHash) fail('Operation ID already binds a different curation decision.', 409, 'IDEMPOTENCY_CONFLICT'); return { ...previous.response, replayed: true }; }
        const candidates = input.products ? await rows(tx, 'SELECT * FROM products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [input.products.map(p => p.id)])
          : (await rows(tx, 'SELECT * FROM products ORDER BY id FOR UPDATE')).filter(p => matches(p, filters));
        if (!candidates.length || candidates.length > 500 || (input.products && candidates.length !== input.products.length)) fail('Every selected product must exist uniquely; select at most 500.', 422, 'CURATION_SELECTION_INVALID');
        const reviewed = [];
        for (const p of candidates) {
          const selection = input.products?.find(item => item.id === p.id);
          const fingerprint = productReviewFingerprint(p);
          if (selection && selection.fingerprint !== fingerprint) fail('A selected product changed; refresh the queue.', 409, 'CURATION_STALE');
          const result = await compliance.check(p, tx);
          if (input.action === 'approved' && result.status !== 'pass' && !result.overridden) {
            if (!selection?.overrideReason) fail('Flagged approvals require per-product explicit override reasons.', 409, 'COMPLIANCE_OVERRIDE_REQUIRED');
            const overrideReason = reason(selection.overrideReason);
            await tx.query(`INSERT INTO compliance_overrides(product_id,reason,actor,fingerprint,created_at) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(product_id) DO UPDATE SET reason=EXCLUDED.reason,actor=EXCLUDED.actor,fingerprint=EXCLUDED.fingerprint,created_at=EXCLUDED.created_at`, [p.id, overrideReason, who, fingerprint, clock()]);
            await audit(tx, { id: id('curation'), operationId: input.operationId, brandId: p.brandId, productId: p.id, actor: who, action: 'compliance_override', reason: overrideReason, fingerprint });
          }
          const updated = await domain.reviewProduct(p.id, { status: input.action, fingerprint, note: why, actor: who, operationId: input.operationId }, p.brandId, { tx });
          reviewed.push({ id: updated.id, brandId: updated.brandId, status: updated.status, fingerprint });
        }
        const response = { operationId: input.operationId, action: input.action, changed: reviewed.length, products: reviewed };
        await tx.query('INSERT INTO curation_operations(operation_id,request_hash,response,created_at) VALUES($1,$2,$3,$4)', [input.operationId, requestHash, JSON.stringify(response), clock()]);
        return response;
      });
    },
    async applyInitialAutoApprove(brandId, productIds, actor, {expectedFingerprints={}} = {}) {
      const who = actorName(actor, true);
      if (!Array.isArray(productIds) || productIds.length > 500 || new Set(productIds).size !== productIds.length) fail('Supply up to 500 unique initial product IDs.');
      return db.transaction(async tx => {
        const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1 FOR UPDATE', [brandId]);
        if (!brand) fail('Brand not found.', 404, 'NOT_FOUND');
        if (!brand.onboardingState?.catalogImportComplete || brand.onboardingState?.initialAutoApproveApplied)
          return { brandId, enabled: brand.autoApproveProducts, approved: [], skipped: productIds, applied: false, reason: 'initial_import_only' };
        if (!brand.autoApproveProducts) {
          await tx.query("UPDATE brands SET onboarding_state=onboarding_state||$2::jsonb,updated_at=$3 WHERE id=$1", [brandId, JSON.stringify({ initialAutoApproveApplied: true }), clock()]);
          await audit(tx, { id: id('curation'), brandId, actor: who, action: 'initial_autoapprove_skipped', reason: 'Initial import remains unlisted because the admin policy is disabled.', payload: { skipped: productIds } });
          return { brandId, enabled: false, approved: [], skipped: productIds, applied: false };
        }
        const products = await rows(tx, 'SELECT * FROM products WHERE brand_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE', [brandId, productIds]);
        if (products.length !== productIds.length) fail('Initial products must belong to this brand.', 404, 'NOT_FOUND');
        const approved = [], skipped = [];
        for (const p of products) {
          const expected=expectedFingerprints && Object.hasOwn(expectedFingerprints,p.id)?expectedFingerprints[p.id]:null;
          if (!/^[a-f0-9]{64}$/.test(expected || '') || expected!==productReviewFingerprint(p) || checkProduct(p).status !== 'pass' || p.validationIssues.length || p.sourceDeletedAt || p.reviewedAt || !['draft', 'in_review'].includes(p.status)) { skipped.push(p.id); continue; }
          const updated = await domain.reviewProduct(p.id, { status: 'approved', fingerprint: productReviewFingerprint(p), note: 'Admin-enabled clean initial catalog autoapproval.', actor: who }, brandId, { tx });
          approved.push(updated.id);
        }
        await tx.query("UPDATE brands SET onboarding_state=onboarding_state||$2::jsonb,updated_at=$3 WHERE id=$1", [brandId, JSON.stringify({ initialAutoApproveApplied: true }), clock()]);
        await audit(tx, { id: id('curation'), brandId, actor: who, action: 'initial_autoapprove', reason: 'Applied the admin-enabled policy to this initial import only.', payload: { approved, skipped } });
        return { brandId, enabled: true, approved, skipped, applied: true };
      });
    },
  };
  return api;
}
