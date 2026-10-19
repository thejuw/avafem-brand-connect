import test from 'node:test';
import assert from 'node:assert/strict';
import {redactedRequestPath} from '../server/log-redaction.mjs';
test('HTTP diagnostics remove capability tokens and all query values',()=>{
  for(const [input,expected] of [
    ['/onboard/private-token','/onboard/[redacted]'],['/api/onboarding/invites/private-token','/api/onboarding/invites/[redacted]'],
    ['/api/invites/private-token/accept?secret=value','/api/invites/[redacted]/accept'],['/api/handoffs/private-token/shipments','/api/handoffs/[redacted]/shipments'],
    ['/handoff/private-token','/handoff/[redacted]'],['/api/brands?search=private','/api/brands'],
  ])assert.equal(redactedRequestPath(input),expected);
});
