import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';
import { PLATFORM_PATHS } from '../server/platform/openapi.mjs';

test('every documented platform path is a registered route and appears in /openapi.json', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const doc = (await f.request({ method: 'GET', url: '/openapi.json' })).json();
  for (const [method, path] of PLATFORM_PATHS) {
    assert.ok(f.app.hasRoute({ method: method.toUpperCase(), url: path.replace(/\{(\w+)\}/g, ':$1') }), `${method} ${path} registered`);
    assert.ok(doc.paths[path]?.[method], `${method} ${path} documented`);
  }
});
