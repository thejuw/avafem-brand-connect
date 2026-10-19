export const PLATFORM_SECTIONS = [
  { id: 'shoppers', label: 'Shoppers', path: '/api/crm/shoppers', adminOnly: true, note: 'Masked list. Open a profile via the API; health data needs consent and every read is audited.' },
  { id: 'segments', label: 'Segments', path: '/api/crm/segments', adminOnly: true },
  { id: 'campaigns', label: 'Campaigns', path: '/api/crm/campaigns', adminOnly: true, actions: [{ label: 'Run scheduled flows', path: '/api/crm/jobs/run' }] },
  { id: 'outbox', label: 'Simulated outbox', path: '/api/crm/outbox', adminOnly: true, note: 'Nothing is delivered. Messages are recorded locally with masked recipients.' },
  { id: 'tickets', label: 'Support inbox', path: '/api/crm/tickets' },
];
export function platformRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const firstArray = Object.values(data).find(Array.isArray);
    return firstArray || [data];
  }
  return [];
}
export function platformColumns(rows, max = 7) {
  const keys = [];
  for (const row of rows.slice(0, 20)) for (const k of Object.keys(row || {})) if (!keys.includes(k) && !/enc$|Enc$/.test(k)) keys.push(k);
  return keys.slice(0, max);
}
export function formatCell(key, value) {
  if (value == null) return '—';
  if (/Cents$/.test(key) && Number.isSafeInteger(value)) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
  if (typeof value === 'object') { const s = JSON.stringify(value); return s.length > 80 ? `${s.slice(0, 77)}…` : s; }
  return String(value);
}
