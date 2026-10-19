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
  for(const [path,methods] of Object.entries(doc.paths).filter(([path])=>path.startsWith('/api/admin/recovery'))) {
    for(const operation of Object.values(methods)) {
      assert.deepEqual(operation.security,[{sessionCookie:[]}],path);
      assert.match(operation.description,/x-csrf-token/);
      assert.ok(operation.responses['409'],path);
    }
  }
  assert.deepEqual(doc.paths['/api/admin/recovery/subscriptions/{id}/continue'].post.requestBody.content['application/json'].schema.required,['operationId']);
  assert.equal(doc.paths['/api/crm/outbox'].get.parameters.find(p=>p.name==='limit').schema.maximum,500);
});
