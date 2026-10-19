import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadObservedTaxEvidence, MANAGED_TAX_OBSERVATION_SHA256 } from '../server/provider-tax-observation.mjs';

const file = new URL('../docs/evidence/stripe-managed-tax-observation-20261019.json', import.meta.url);
const bytes = await readFile(file), artifact = JSON.parse(bytes.toString('utf8'));
const mapping = run => ({ runId: run.runId, accountId: artifact.accountId, originalTaxTransactionId: run.original.id,
  refunds: run.reversals.map(value => ({ refundId: value.reference, taxTransactionId: value.id })) });

test('audited managed Tax snapshot binds both exact existing runs without pretending to expose API line items', async () => {
  for (const run of artifact.runs) {
    const result = await loadObservedTaxEvidence(mapping(run));
    assert.equal(result.source, 'operator_verified_dashboard'); assert.equal(result.test, true);
    assert.equal(result.artifactSha256, MANAGED_TAX_OBSERVATION_SHA256);
    assert.deepEqual(result.original, run.original); assert.deepEqual(result.reversals, run.reversals);
    assert.equal(result.line_items, undefined); assert.equal(result.reversals[0].originalTransactionId, undefined);
  }
});
test('changed or missing artifact is never accepted, even with the correct transaction IDs', async () => {
  const input = mapping(artifact.runs[0]);
  assert.equal(await loadObservedTaxEvidence(input, { readArtifact: async () => Buffer.concat([bytes, Buffer.from(' ')]) }), null);
  assert.equal(await loadObservedTaxEvidence(input, { readArtifact: async () => { throw new Error('PRIVATE_VALUE'); } }), null);
});
test('wrong platform, future run and incomplete or swapped mappings cannot borrow the fixed observation', async () => {
  const input = mapping(artifact.runs[0]);
  for (const value of [{ ...input, accountId: 'acct_other' }, { ...input, runId: `uco_${'f'.repeat(32)}` },
    { ...input, originalTaxTransactionId: artifact.runs[1].original.id }, { ...input, refunds: input.refunds.slice(1) },
    { ...input, refunds: input.refunds.map((item, index) => ({ ...item, refundId: input.refunds[(index + 1) % input.refunds.length].refundId })) }])
    assert.equal(await loadObservedTaxEvidence(value), null);
});
