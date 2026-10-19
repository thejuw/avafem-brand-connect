import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingHandoffLink } from './handoff-link.mjs';

test('A pending dispatch exposes its local shipping handoff', () => {
  assert.equal(pendingHandoffLink({status:'pending',body:{handoffPath:'/handoff/sandbox-token_123'}}), '/handoff/sandbox-token_123');
});
test('Closed, missing, and consumed dispatches do not expose shipping links', () => {
  for (const status of ['closed', 'used', undefined]) assert.equal(pendingHandoffLink({status,body:{handoffPath:'/handoff/sandbox-token'}}), null);
});
test('Dispatch content cannot create external or script links', () => {
  for (const handoffPath of ['https://example.com/handoff/token', '//example.com/handoff/token', 'javascript:alert(1)', '/onboard/token', '/handoff/token?expose=1', undefined]) {
    assert.equal(pendingHandoffLink({status:'pending',body:{handoffPath}}), null);
  }
});
