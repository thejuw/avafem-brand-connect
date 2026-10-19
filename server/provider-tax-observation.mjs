import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This is an audited, fixed TEST observation, not arbitrary caller-supplied
// evidence or an alternative provider API. Updating it requires source review.
export const MANAGED_TAX_OBSERVATION_SHA256 = '9744e5a86466ba174409d1b4ab43c20a519cde7c84466091e64f7e7ecca86b90';
const artifactRef = 'stripe-managed-tax-observation-20261019.json';
const artifactUrl = new URL(`../docs/evidence/${artifactRef}`, import.meta.url);
const platform = 'acct_1U74iQGgawRtH2qe';

export async function loadObservedTaxEvidence(mapping, { readArtifact = () => readFile(artifactUrl) } = {}) {
  try {
    const bytes = await readArtifact();
    if (createHash('sha256').update(bytes).digest('hex') !== MANAGED_TAX_OBSERVATION_SHA256) return null;
    const artifact = JSON.parse(bytes.toString('utf8'));
    if (artifact.schemaVersion !== 1 || artifact.source !== 'operator_verified_dashboard' || artifact.test !== true
      || artifact.accountId !== platform || mapping?.accountId !== platform) return null;
    const run = artifact.runs.find(value => value.runId === mapping.runId);
    if (!run || run.original.id !== mapping.originalTaxTransactionId || run.reversals.length !== mapping.refunds?.length
      || !mapping.refunds.every(value => run.reversals.some(reversal => reversal.id === value.taxTransactionId && reversal.reference === value.refundId))) return null;
    return structuredClone({ source: artifact.source, runId: run.runId, accountId: platform, test: true,
      observedAt: artifact.observedAt, artifactRef, artifactSha256: MANAGED_TAX_OBSERVATION_SHA256,
      apiLimitation: artifact.apiLimitation, original: run.original, reversals: run.reversals });
  } catch { return null; }
}
