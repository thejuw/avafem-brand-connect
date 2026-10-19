/** Connector responses may contain GraphQL entities rather than text labels. */
export function displayLabel(value, fallback = '—') {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    const candidates = [value.myshopifyDomain, value.myshopify_domain, value.domain, value.title, value.name, value.displayName, value.shop, value.id];
    const textValue = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
    if (textValue) return textValue;
  }
  return fallback;
}
