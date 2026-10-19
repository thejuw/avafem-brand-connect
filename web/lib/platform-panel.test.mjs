import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_SECTIONS, platformRows, platformColumns, formatCell } from './platform-panel.mjs';

test('platform panel sections target platform API routes and hide encrypted columns', () => {
  assert.ok(PLATFORM_SECTIONS.every(s => s.path.startsWith('/api/')));
  assert.equal(new Set(PLATFORM_SECTIONS.map(s => s.id)).size, PLATFORM_SECTIONS.length);
  assert.deepEqual(platformRows({ rows: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(platformRows(null), []);
  assert.deepEqual(platformColumns([{ id: 1, emailEnc: 'x', amountCents: 5 }]), ['id', 'amountCents']);
  assert.equal(formatCell('amountCents', 1234), '$12.34');
  assert.equal(formatCell('x', null), '—');
});
