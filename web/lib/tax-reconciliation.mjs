import { safeCheckoutMessage } from './provider-test-checkout.mjs';

const runPattern = /^uco_[a-f0-9]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const scope = 'separate_platform_rounding_subledger_only';
const statuses = new Set(['matched', 'reconciled_platform_rounding', 'unrecorded_platform_variance', 'review']);
const centKeys = ['stripeReversedTaxCents', 'shopifyRefundTaxCents', 'rawVarianceCents', 'recordedPlatformVarianceCents', 'unaccountedVarianceCents'];
const safeText = value => safeCheckoutMessage(value, 'Not verified').slice(0, 180);
const safeObservedAt = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

export function normalizeTaxReport(value, runId) {
  if (!runPattern.test(runId || '') || value?.runId !== runId || value.test !== true
    || value.fullAcceptancePassed !== false || value.scope !== scope || !statuses.has(value.status)
    || !/^taxrecon_[a-f0-9]{32}$/.test(value.id || '') || !hashPattern.test(value.reportHash || ''))
    throw new Error('The separate test-only Tax report could not be verified for this saved run.');
  const totals = Object.fromEntries(centKeys.map(key => [key, Number.isSafeInteger(value.totals?.[key]) ? value.totals[key] : null]));
  for (const key of ['stripeReversedTaxCents', 'shopifyRefundTaxCents']) if (totals[key] < 0) totals[key] = null;
  const complete = centKeys.every(key => Number.isSafeInteger(totals[key]))
    && totals.rawVarianceCents === totals.stripeReversedTaxCents - totals.shopifyRefundTaxCents
    && totals.unaccountedVarianceCents === totals.rawVarianceCents - totals.recordedPlatformVarianceCents;
  const reviewCount = Number.isSafeInteger(value.reviewCount) && value.reviewCount >= 0 ? value.reviewCount : null;
  const source = ['operator_verified_dashboard', 'native_tax_api', 'api_reference'].includes(value.provenance?.source) ? value.provenance.source : null;
  return { id: value.id, runId, reportHash: value.reportHash,
    evidenceHash: hashPattern.test(value.evidenceHash || '') ? value.evidenceHash : null,
    test: true, fullAcceptancePassed: false, scope, status: value.status, totals, reviewCount,
    provenance: { source, dashboardSnapshotOnly: source === 'operator_verified_dashboard' || value.provenance?.dashboardSnapshotOnly === true,
      observationMode: value.provenance?.observationMode === 'frozen_snapshot_not_live_tax_api' ? 'frozen_snapshot_not_live_tax_api' : null,
      taxLineApiAvailable: typeof value.provenance?.taxLineApiAvailable === 'boolean' ? value.provenance.taxLineApiAvailable : null,
      observedAt: safeObservedAt(value.provenance?.observedAt) },
    readyToRecord: value.readyToRecord === true && complete && reviewCount === 0
      && ['unrecorded_platform_variance', 'reconciled_platform_rounding'].includes(value.status),
    checks: (Array.isArray(value.checks) ? value.checks : []).slice(0, 30).map(check => ({
      name: safeText(check?.name), status: safeText(check?.status), code: check?.code ? safeText(check.code) : null,
    })),
  };
}

export const taxReportForRun = (report, runId) => report?.runId === runId ? report : null;
export function taxRoundingPayload(report, runId, confirmed) {
  const verified = normalizeTaxReport(report, runId);
  if (confirmed !== true || !verified.readyToRecord)
    throw new Error('A current eligible Tax report and explicit platform-only acknowledgement are required.');
  return { reportId: verified.id, reportHash: verified.reportHash,
    operationId: `taxround_${runId.slice(4)}_${verified.reportHash.slice(0, 32)}`, confirmPlatformOnly: true };
}
function requireRun(run, enabled) {
  if (!enabled || run?.test !== true || !runPattern.test(run.id || ''))
    throw new Error('Separate Tax reconciliation is available only for a saved test run in the local owner workspace.');
}
export async function refreshTaxReport({ run, enabled, request }) {
  requireRun(run, enabled);
  return normalizeTaxReport(await request(`/api/unified-checkout/${run.id}/tax-reconciliation-report`, {
    method: 'POST', body: {}, cache: 'no-store',
  }), run.id);
}
export async function acknowledgeTaxRounding({ run, report, confirmed, enabled, request }) {
  requireRun(run, enabled);
  const body = taxRoundingPayload(report, run.id, confirmed);
  return normalizeTaxReport(await request(`/api/unified-checkout/${run.id}/tax-rounding`, {
    method: 'POST', body, cache: 'no-store', headers: { 'Idempotency-Key': body.operationId },
  }), run.id);
}

export function taxReportLabel(report) {
  if (!report) return 'Not verified';
  if (report.readyToRecord) return 'Platform rounding awaits acknowledgement';
  return ({ matched: 'Native tax amounts matched', reconciled_platform_rounding: 'Platform rounding accounted · raw variance retained',
    unrecorded_platform_variance: 'Unaccounted platform variance', review: 'Tax evidence requires review' })[report.status] || 'Not verified';
}

export function taxProvenanceNotice(report) {
  const provenance = report?.provenance;
  if (provenance?.source === 'operator_verified_dashboard' || provenance?.dashboardSnapshotOnly
    || provenance?.observationMode === 'frozen_snapshot_not_live_tax_api')
    return 'Verified sandbox dashboard snapshot—not a live Tax API audit. Native Tax line items could not be retrieved; this frozen observation does not certify live Tax reporting or full acceptance.';
  if (['native_tax_api', 'api_reference'].includes(provenance?.source) && provenance.taxLineApiAvailable === true)
    return 'Tax evidence source: native Tax API reads. Verification remains limited to this separate report; full acceptance is not certified.';
  return 'Tax evidence provenance not verified. No live Tax API audit or full acceptance is claimed.';
}
