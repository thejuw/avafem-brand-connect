import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccessRoute } from './access-route.mjs';

test('Capability links select the restricted entry page', () => {
  assert.deepEqual(resolveAccessRoute('/handoff/test-token'), {kind:'handoff', token:'test-token'});
  assert.deepEqual(resolveAccessRoute('/onboard/test-token'), {kind:'invite', token:'test-token'});
});
test('Missing or malformed token paths do not select operations bootstrap', () => {
  for (const path of ['/handoff', '/handoff/', '/handoff/%bad', '/onboard/', '/onboard/token/extra']) {
    assert.ok(resolveAccessRoute(path), path);
  }
});
test('Normal workspace paths remain on the authenticated application', () => {
  for (const path of ['/', '/connections', '/handoff-other']) assert.equal(resolveAccessRoute(path), null);
});
