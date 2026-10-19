import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleNav, linkFromHash, monthOptions, reportUrl, money, pct, initials } from './brand-portal.mjs';

test('portal nav follows role scopes', () => {
  assert.deepEqual(visibleNav(['payouts:read', 'reports:read']).map(n => n[0]), ['dashboard', 'payouts', 'settings']);
  assert.deepEqual(visibleNav(['catalog:read', 'orders:read']).map(n => n[0]), ['dashboard', 'products', 'settings']);
  assert(visibleNav(['catalog:read', 'reports:read', 'members:manage']).some(n => n[0] === 'team'));
});
test('only exact fragment tokens are accepted', () => {
  const t = 'a'.repeat(43);
  assert.deepEqual(linkFromHash(`#token=${t}`), { kind: 'token', token: t });
  assert.deepEqual(linkFromHash(`#invite=${t}`), { kind: 'invite', token: t });
  for (const bad of ['', '#token=short', `#token=${t}&x=1`, `?token=${t}`, `#evil=${t}`]) assert.equal(linkFromHash(bad), null);
});
test('month options, report urls and formatting', () => {
  const m = monthOptions(new Date(Date.UTC(2026, 0, 15)), 2); assert.deepEqual(m.map(x => x.value), ['2026-01', '2025-12']);
  assert.equal(reportUrl('statement', '2026-01', 'csv'), '/api/brand-portal/statements?month=2026-01&format=csv');
  assert.equal(reportUrl('annual', 2026, 'json'), '/api/brand-portal/reports/annual?year=2026&format=json');
  assert.equal(money(290460), '$2,905'); assert.equal(money(2760), '$27.60'); assert.equal(pct(0.048), '4.8%'); assert.equal(pct(null), '—');
  assert.equal(initials('Lumina Botanica'), 'LB');
});
