/** Pure helpers for the brand portal UI (tested without a browser). */
export const PORTAL_NAV = [
  ['dashboard', 'Dashboard', null],
  ['products', 'Products', 'catalog:read'],
  ['payouts', 'Payouts', 'reports:read'],
  ['team', 'Team', 'members:manage'],
  ['settings', 'Settings', null],
];
export const visibleNav = (scopes = []) => PORTAL_NAV.filter(([, , scope]) => !scope || scopes.includes(scope));
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(Number(cents || 0)) >= 100000 ? 0 : 2 }).format(Number(cents || 0) / 100);
export const pct = rate => rate == null ? '—' : `${(Number(rate) * 100).toFixed(1)}%`;
export const greeting = (date = new Date()) => { const h = date.getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
export const STATUS_LABEL = { draft: 'Draft', in_review: 'In review', approved: 'Listed', rejected: 'Needs changes' };
/** Read a sign-in token from the URL fragment (never sent to servers or logs). */
export function linkFromHash(hash = '') {
  const m = /^#(token|invite)=([A-Za-z0-9_-]{43})$/.exec(String(hash));
  return m ? { kind: m[1], token: m[2] } : null;
}
export const monthOptions = (now = new Date(), count = 12) => Array.from({ length: count }, (_, i) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  return { value: d.toISOString().slice(0, 7), label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
});
export const reportUrl = (kind, value, format) => kind === 'statement'
  ? `/api/brand-portal/statements?month=${encodeURIComponent(value)}&format=${format}`
  : `/api/brand-portal/reports/annual?year=${encodeURIComponent(value)}&format=${format}`;
export const ROLE_HELP = { owner: 'Everything, including team and credentials', staff: 'Catalog, orders, shipping and support', finance: 'Payouts, statements and tax reports' };
export const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
