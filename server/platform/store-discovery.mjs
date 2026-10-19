import { isIP } from 'node:net';
import { createConnectorCall } from './connectors.mjs';
import { isPublicIp } from '../integrations/webhooks.mjs';

const SOURCES = new Set(['shopify', 'woocommerce', 'bigcommerce', 'csv']);
const PRIVATE_HOST = /(^|\.)(?:localhost|local|internal|home|test|invalid|onion)$/;
const SECRET = /(?:sk|rk)_(?:live|test)_|whsec_|shpat_|shpss_|(?:consumer_)?secret[=:]/i;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const denied = () => { throw Object.assign(new Error('Provide a public HTTPS store origin without a path, query, credentials or fragment.'), { statusCode: 422, code: 'STORE_URL_INVALID' }); };

function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return denied();
  let url;
  try { url = new URL(value.trim()); } catch { return denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/' || url.port) return denied();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || PRIVATE_HOST.test(hostname) || hostname === 'metadata.google.internal') return denied();
  if (isIP(hostname)) {
    if (!isPublicIp(hostname) || /^3ffe:/i.test(hostname)) return denied();
  } else if (hostname.length > 253 || !hostname.includes('.') || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return denied();
  // Normalize an optional DNS root dot before either hint matching or probing.
  if (url.hostname.endsWith('.')) url.hostname = hostname;
  return url;
}

function hostHint(hostname) {
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(hostname)) return 'shopify';
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mybigcommerce\.com$/.test(hostname)) return 'bigcommerce';
  return null;
}

const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const boundedArray = (value, max = 1000) => Array.isArray(value) && value.length <= max;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

// These are read-only public JSON endpoints, not authentication/ownership proofs.
// https://developer.woocommerce.com/docs/category/store-api
// https://shopify.dev/docs/api/ajax/reference/cart#get-locale-cart-js
// https://docs.bigcommerce.com/developer/docs/admin/checkout-and-cart/custom-checkouts/rest-storefront
const PROBES = Object.freeze([
  { platform: 'woocommerce', name: 'wordpress_namespaces', path: '/wp-json/', matches: body => plainObject(body)
    && boundedArray(body.namespaces) && body.namespaces.some(v => typeof v === 'string' && /^wc\/(?:v[1-3]|store\/v1)$/.test(v)) },
  { platform: 'shopify', name: 'shopify_ajax_cart', path: '/cart.js', matches: body => plainObject(body)
    && typeof body.token === 'string' && body.token.length > 0 && body.token.length <= 512
    && currency(body.currency) && boundedArray(body.items) && nonnegativeInt(body.item_count)
    && nonnegativeInt(body.total_price) && nonnegativeInt(body.original_total_price) && nonnegativeInt(body.total_discount) },
  { platform: 'bigcommerce', name: 'bigcommerce_storefront_carts', path: '/api/storefront/carts', matches: body => boundedArray(body, 10)
    // An empty generic JSON array has no platform-specific evidence. On stores
    // without a session cart, detection intentionally falls back to manual setup.
    && body.length > 0 && body.every(cart => plainObject(cart) && uuid(cart.id) && plainObject(cart.currency)
      && currency(cart.currency.code) && typeof cart.isTaxIncluded === 'boolean'
      && Number.isFinite(cart.cartAmount) && cart.cartAmount >= 0 && plainObject(cart.lineItems)
      && boundedArray(cart.lineItems.physicalItems) && boundedArray(cart.lineItems.digitalItems)) },
]);

export function storeDiscoveryCapabilities() {
  return {
    shopify: { configured: false, status: 'needs_provider_configuration', authorization: 'verified_oauth_install_required' },
    woocommerce: { configured: false, status: 'needs_provider_configuration', authorization: 'verified_store_credentials_required' },
    bigcommerce: { configured: false, status: 'needs_provider_configuration', authorization: 'verified_store_credentials_required' },
    csv: { configured: false, status: 'needs_reviewed_import' },
    feed: { configured: false, status: 'needs_provider_configuration' },
  };
}

/**
 * Advisory detection only; never creates a connector, approves a listing, or
 * fetches a caller-supplied path. Default local mode does no DNS/network I/O.
 * Explicit allowProbe:true enables at most three fixed same-origin public JSON
 * GETs. Every GET revalidates/pins public DNS using the shared safe transport.
 * Transport options (fetch/resolve/request/timeoutMs) are server/test injection,
 * never user request options. No response content or credential enters results.
 */
export function createStoreDiscovery({ allowProbe = false, timeoutMs = 1500, ...transport } = {}) {
  if (typeof allowProbe !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000)
    throw Object.assign(new Error('Invalid store discovery configuration.'), { statusCode: 422, code: 'STORE_DISCOVERY_CONFIG_INVALID' });
  const call = createConnectorCall({ ...transport, timeoutMs, maxResponseBytes: 128_000 });
  return {
    capabilities: storeDiscoveryCapabilities,
    async detect({ storeUrl } = {}) {
      const origin = publicOrigin(storeUrl), hint = hostHint(origin.hostname);
      const result = { storeUrl: origin.origin, platform: hint || 'unknown', advisory: true, verified: false,
        evidence: hint ? [{ platform: hint, kind: 'hostname_hint' }] : [], fallback: ['csv', 'feed'],
        capability: { configured: false, status: 'needs_provider_configuration' },
        probeStatus: hint ? 'not_needed_hostname_hint' : 'disabled_local_only' };
      if (hint || !allowProbe) return result;
      result.probeStatus = 'complete';
      for (const probe of PROBES) {
        let body;
        try { body = await call(new URL(probe.path, origin).href, { method: 'GET', headers: { accept: 'application/json' } }); }
        catch (error) {
          if (error?.code === 'CONNECTOR_DESTINATION_DENIED') {
            result.evidence = []; result.probeStatus = 'blocked_destination'; break;
          }
          if (error?.code === 'CONNECTOR_REDIRECT_DENIED') {
            result.evidence = []; result.probeStatus = 'blocked_redirect'; break;
          }
          if (error?.code === 'CONNECTOR_TIMEOUT') {
            result.evidence = []; result.probeStatus = 'timed_out'; break;
          }
          // 404, credential-required APIs and malformed/non-JSON storefronts are
          // normal non-evidence. Never echo raw errors, URLs or response bodies.
          continue;
        }
        if (probe.matches(body)) result.evidence.push({ platform: probe.platform, kind: 'public_json', probe: probe.name });
      }
      if (result.probeStatus === 'complete') {
        const platforms = [...new Set(result.evidence.map(v => v.platform))];
        if (platforms.length === 1) result.platform = platforms[0];
        else if (platforms.length > 1) result.probeStatus = 'ambiguous';
      }
      return result;
    },
  };
}

function plainText(value, max) {
  if (typeof value !== 'string' || value.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || SECRET.test(value)) return null;
  return value.trim() || null;
}

function logoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || SECRET.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  // This synchronous sanitizer never resolves or fetches arbitrary image hosts.
  // Only known public provider asset CDNs are eligible for a suggested logo.
  // Custom-host logos need a separate validated asset-import/proxy workflow.
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/^(?:cdn\.shopify\.com|cdn[0-9]+\.bigcommerce\.com|i[0-3]\.wp\.com)$/.test(url.hostname)) return null;
  url.search = ''; url.hash = '';
  return url.href;
}

/**
 * Sanitize display suggestions from a caller's independently AUTHENTICATED
 * connected-store response. This helper does not authenticate the response.
 * Never use public detection/hints as this input's authentication provenance.
 * Only normalized display fields survive; no commission, hold, shipping,
 * customer, credentials, connection/approval status, or legal-policy authority.
 * HTML policies are omitted rather than parsed/executed; an authenticated
 * adapter may supply an explicitly normalized plain-text returnPolicy.text.
 */
export function sanitizeStoreProfile(source, metadata) {
  if (!SOURCES.has(source)) throw Object.assign(new Error('Unsupported store profile source.'), { statusCode: 422, code: 'STORE_PROFILE_SOURCE_INVALID' });
  const input = plainObject(metadata) ? metadata : {};
  const name = plainText(input.name ?? input.storeName ?? input.store_name, 200);
  const logo = input.logoUrl ?? input.logoURL ?? (typeof input.logo === 'string' ? input.logo : input.logo?.url) ?? input.brand?.logo?.image?.url;
  const email = plainText(input.contactEmail ?? input.contact_email ?? input.email, 254);
  const contactEmail = email && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(email) ? email : null;
  const policy = input.returnPolicy ?? input.return_policy;
  const policyText = plainText(typeof policy === 'string' ? policy : policy?.text, 8000);
  const provenance = { source, kind: source === 'csv' ? 'provided_import_metadata' : 'authenticated_connected_store' };
  return { name, logoUrl: logoUrl(logo), contactEmail,
    returnPolicy: { text: policyText, untrusted: true, requiresReview: true, provenance: { ...provenance } },
    untrusted: true, requiresReview: true, provenance };
}
