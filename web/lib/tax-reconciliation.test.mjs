import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaxReport, taxReportForRun, taxRoundingPayload, refreshTaxReport, acknowledgeTaxRounding, taxReportLabel, taxProvenanceNotice } from './tax-reconciliation.mjs';
const run = { id: `uco_${'a'.repeat(32)}`, test: true, state: 'completed' };
const report = () => ({ id: `taxrecon_${'b'.repeat(32)}`, runId: run.id, reportHash: 'c'.repeat(64), evidenceHash: 'd'.repeat(64),
  test: true, scope: 'separate_platform_rounding_subledger_only', status: 'unrecorded_platform_variance',
  fullAcceptancePassed: false, readyToRecord: true, reviewCount: 0, checks: [],
  totals: { stripeReversedTaxCents: 50, shopifyRefundTaxCents: 48, rawVarianceCents: 2, recordedPlatformVarianceCents: 0, unaccountedVarianceCents: 2 } });

test('Raw tax difference survives platform accounting and never becomes full acceptance', () => {
  const value = report(); value.status = 'reconciled_platform_rounding'; value.readyToRecord = false;
  value.totals.recordedPlatformVarianceCents = 2; value.totals.unaccountedVarianceCents = 0;
  const normalized = normalizeTaxReport(value, run.id);
  assert.equal(normalized.totals.rawVarianceCents, 2); assert.equal(normalized.totals.recordedPlatformVarianceCents, 2);
  assert.equal(normalized.totals.unaccountedVarianceCents, 0); assert.equal(normalized.fullAcceptancePassed, false);
  assert.equal(normalized.readyToRecord, false); assert.match(taxReportLabel(normalized), /raw variance retained/);
  assert.equal(run.state, 'completed', 'Tax report must never mutate the separate cash lifecycle');
});
test('Unknown or malformed cents remain unverified and cannot authorize acknowledgement', () => {
  for (const amount of [null, undefined, '2', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = report(); value.totals.rawVarianceCents = amount;
    const normalized = normalizeTaxReport(value, run.id);
    assert.equal(normalized.totals.rawVarianceCents, null); assert.equal(normalized.readyToRecord, false);
    assert.throws(() => taxRoundingPayload(normalized, run.id, true));
  }
  const invalid = report(); invalid.totals.stripeReversedTaxCents = -1;
  assert.equal(normalizeTaxReport(invalid, run.id).totals.stripeReversedTaxCents, null);
});
test('Signed negative variance stays signed; inconsistent totals and review states cannot authorize accounting', () => {
  const negative = report(); Object.assign(negative.totals, { stripeReversedTaxCents: 46, rawVarianceCents: -2, unaccountedVarianceCents: -2 });
  assert.equal(normalizeTaxReport(negative, run.id).totals.rawVarianceCents, -2);
  for (const change of [value => { value.reviewCount = 1; }, value => { value.status = 'review'; },
    value => { value.totals.unaccountedVarianceCents = 0; }, value => { value.readyToRecord = false; }]) {
    const value = report(); change(value); assert.equal(normalizeTaxReport(value, run.id).readyToRecord, false);
  }
});
test('Foreign run, live, broader scope, invalid identities and acceptance assertions are rejected', () => {
  for (const patch of [{ runId: `uco_${'f'.repeat(32)}` }, { test: false }, { scope: 'cash_repair' },
    { fullAcceptancePassed: true }, { id: 'arbitrary' }, { reportHash: 'not-a-hash' }])
    assert.throws(() => normalizeTaxReport({ ...report(), ...patch }, run.id));
  assert.equal(taxReportForRun(normalizeTaxReport(report(), run.id), `uco_${'f'.repeat(32)}`), null);
});
test('Acknowledgement requires explicit confirmation and has stable bounded identities with no caller cents', () => {
  const normalized = normalizeTaxReport(report(), run.id);
  assert.throws(() => taxRoundingPayload(normalized, run.id, false));
  const first = taxRoundingPayload(normalized, run.id, true), second = taxRoundingPayload(normalized, run.id, true);
  assert.deepEqual(first, second); assert.match(first.operationId, /^[A-Za-z0-9_-]{8,100}$/);
  assert.deepEqual(Object.keys(first).sort(), ['confirmPlatformOnly', 'operationId', 'reportHash', 'reportId']);
  assert.equal(first.confirmPlatformOnly, true);
});
test('Refresh performs only the separate report read and acknowledgement only its explicit platform endpoint', async () => {
  const calls = [], request = async (path, options) => { calls.push({ path, options }); return report(); };
  const refreshed = await refreshTaxReport({ run, enabled: true, request });
  assert.deepEqual(calls[0], { path: `/api/unified-checkout/${run.id}/tax-reconciliation-report`, options: { method: 'POST', body: {}, cache: 'no-store' } });
  await acknowledgeTaxRounding({ run, report: refreshed, confirmed: true, enabled: true, request });
  assert.equal(calls[1].path, `/api/unified-checkout/${run.id}/tax-rounding`);
  assert.equal(calls[1].options.headers['Idempotency-Key'], calls[1].options.body.operationId);
  assert.ok(calls.every(call => !/\/(refund|settle|payout|reconcile)$/.test(call.path)));
});
test('Nonowner, nontest, unconfirmed and stale cross-run reports never send requests', async () => {
  const request = () => assert.fail('No action allowed');
  for (const change of [{ enabled: false }, { run: { ...run, test: false } }])
    await assert.rejects(refreshTaxReport({ run, enabled: true, request, ...change }));
  await assert.rejects(acknowledgeTaxRounding({ run, enabled: true, request, report: report(), confirmed: false }));
  await assert.rejects(acknowledgeTaxRounding({ run, enabled: true, request, report: { ...report(), runId: `uco_${'f'.repeat(32)}` }, confirmed: true }));
});
test('UI report projection excludes raw provider objects, secrets and shopper data', () => {
  const normalized = normalizeTaxReport({ ...report(), raw: { secret: 'MUST_NOT_RETURN' }, email: 'private@example.test',
    checks: [{ name: 'sk_test_SYNTHETIC', status: 'review', code: 'SAFE_CODE', raw: 'MUST_NOT_RETURN' }] }, run.id);
  assert.doesNotMatch(JSON.stringify(normalized), /MUST_NOT_RETURN|private@example|sk_test_/);
});

test('Accounted dashboard evidence remains explicitly a frozen snapshot, never a live Tax API audit or acceptance', () => {
  const value = report(); value.status = 'reconciled_platform_rounding'; value.readyToRecord = false;
  value.totals.recordedPlatformVarianceCents = 2; value.totals.unaccountedVarianceCents = 0;
  value.provenance = { source: 'operator_verified_dashboard', observationMode: 'frozen_snapshot_not_live_tax_api',
    dashboardSnapshotOnly: true, taxLineApiAvailable: false, observedAt: '2026-10-19T08:27:23Z', raw: 'MUST_NOT_RETURN' };
  const normalized = normalizeTaxReport(value, run.id), notice = taxProvenanceNotice(normalized);
  assert.match(notice, /Verified sandbox dashboard snapshot—not a live Tax API audit/);
  assert.match(notice, /Native Tax line items could not be retrieved/);
  assert.equal(normalized.provenance.observedAt, '2026-10-19T08:27:23Z');
  assert.equal(normalized.totals.rawVarianceCents, 2); assert.equal(normalized.totals.unaccountedVarianceCents, 0);
  assert.equal(normalized.fullAcceptancePassed, false); assert.doesNotMatch(JSON.stringify(normalized), /MUST_NOT_RETURN/);
});
test('Unknown provenance is not invented; timestamps and non-API evidence cannot masquerade as native API reads', () => {
  const unknown = normalizeTaxReport({ ...report(), provenance: { source: 'unknown', observedAt: 'sk_test_SYNTHETIC' } }, run.id);
  assert.equal(unknown.provenance.source, null); assert.equal(unknown.provenance.observedAt, null);
  assert.match(taxProvenanceNotice(unknown), /provenance not verified/);
  const api = normalizeTaxReport({ ...report(), provenance: { source: 'native_tax_api', taxLineApiAvailable: true } }, run.id);
  assert.match(taxProvenanceNotice(api), /native Tax API reads/); assert.match(taxProvenanceNotice(api), /full acceptance is not certified/);
  const unavailable = normalizeTaxReport({ ...report(), provenance: { source: 'native_tax_api', taxLineApiAvailable: false } }, run.id);
  assert.match(taxProvenanceNotice(unavailable), /provenance not verified/);
});
