import { safeCheckoutMessage } from './provider-test-checkout.mjs';
import { isLoopbackHost } from './stripe-test-entry.mjs';

export const UNIFIED_STORES = Object.freeze([
  Object.freeze({ shop: 'i4vd1u-s8.myshopify.com', name: 'My Store 2' }),
  Object.freeze({ shop: 'qpsd02-jz.myshopify.com', name: 'My Store 4' }),
  Object.freeze({ shop: 'ir7112-v1.myshopify.com', name: 'My Store 6' }),
]);
const shops = new Set(UNIFIED_STORES.map(store => store.shop));
const variantId = value => typeof value === 'string' && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value);
const cents = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, fallback = '') => safeCheckoutMessage(value, fallback).slice(0, 300);
export const CASH_RECONCILIATION_NOTICE = 'Cash reconciliation does not certify Stripe Tax reporting allocation; verify it separately.';
export const unifiedCompletionLabel = state => state === 'completed' ? 'Cash lifecycle completed' : null;

export function safeStripeCheckoutUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.port
      || url.username || url.password || url.search
      || !/^\/(?:c\/)?pay\/cs_test_[A-Za-z0-9_]+\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function unifiedCheckoutLink(run) {
  return run?.test === true && run?.state === 'checkout_open'
    ? safeStripeCheckoutUrl(run.checkoutUrl) : null;
}

/** A return URL identifies a saved run only. It is never payment evidence. */
export function resolveUnifiedCheckoutReturn(location) {
  const path = location?.pathname;
  const params = new URLSearchParams(location?.search || '');
  const kind = path === '/unified-checkout/success' ? 'success'
    : path === '/unified-checkout/cancel' || (path === '/' && params.has('checkout_cancelled')) ? 'cancelled' : null;
  if (!kind) return null;
  const key = path === '/' ? 'checkout_cancelled' : 'run';
  const candidate = params.get(key);
  const runId = params.getAll(key).length === 1 && /^uco_[a-f0-9]{32}$/.test(candidate || '') ? candidate : null;
  // Do not retain the Session ID, arbitrary query fields, fragments or credentials.
  const cleanPath = `${path}${runId ? `?${key}=${runId}` : ''}`;
  return { kind, runId, cleanPath };
}

export async function loadUnifiedReturnedRun(context, request) {
  if (!context?.runId || !/^uco_[a-f0-9]{32}$/.test(context.runId))
    throw new Error('This checkout return has no valid saved run reference. Open a saved unified checkout below.');
  const run = await request(`/api/unified-checkout/${context.runId}`, {
    method: 'GET', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  if (run?.id !== context.runId || run.test !== true)
    throw new Error('The saved test run could not be verified. No payment or order action was requested.');
  return run;
}

export function normalizeUnifiedOptions(value) {
  if (value?.test !== true || !Array.isArray(value.stores) || value.stores.length !== 3
    || new Set(value.stores.map(store => store?.shop)).size !== 3
    || value.stores.some(store => !shops.has(store?.shop))) {
    throw new Error('The server must return only the three exact authorized stores in test mode.');
  }
  return {
    test: true,
    stores: UNIFIED_STORES.map(identity => {
      const store = value.stores.find(item => item.shop === identity.shop);
      const variants = (Array.isArray(store.variants) ? store.variants : []).filter(item =>
        variantId(item?.id) && cents(item.priceCents) && item.priceCents > 0
        && Number.isSafeInteger(item.inventoryQty) && item.inventoryQty >= 0,
      ).map(item => ({
        id: item.id, sku: text(item.sku), title: text(item.title), productTitle: text(item.productTitle),
        priceCents: item.priceCents, inventoryQty: item.inventoryQty,
      }));
      return {
        shop: identity.shop, name: text(store.name, identity.name), brandId: text(store.brandId),
        connected: store.connected === true, configured: store.configured === true,
        shippingCents: cents(store.shippingCents) ? store.shippingCents : null,
        commissionBps: Number.isSafeInteger(store.commissionBps) ? store.commissionBps : null,
        returnWindowDays: Number.isSafeInteger(store.returnWindowDays) ? store.returnWindowDays : null,
        variants,
      };
    }),
    stripe: {
      verified: value.stripe?.verified === true, mode: text(value.stripe?.mode),
      accountId: text(value.stripe?.accountId),
    },
    blockers: (Array.isArray(value.blockers) ? value.blockers : []).map(item => ({
      code: text(item?.code, 'SETUP_REQUIRED'), message: text(item?.message, 'Review the store connection before continuing.'),
      shop: shops.has(item?.shop) ? item.shop : null,
    })),
    warnings: (Array.isArray(value.warnings) ? value.warnings : []).map(item => text(item)).filter(Boolean),
  };
}

export function evaluateUnifiedCart(options, items) {
  const issues = [];
  const payload = [];
  const included = new Set();
  const seen = new Set();
  let subtotalCents = 0;
  let shippingCents = 0;
  if (options?.test !== true || !Array.isArray(options.stores)) {
    return { valid: false, issues: ['Load the three authorized test catalogs first.'], items: [], subtotalCents: null, shippingCents: null, taxCents: null, totalCents: null };
  }
  for (const line of Array.isArray(items) ? items : []) {
    const store = options.stores.find(item => item.shop === line?.shop);
    const variant = store?.variants.find(item => item.id === line?.variantId);
    const key = `${line?.shop}:${line?.variantId}`;
    if (!shops.has(line?.shop) || !store || !variant || seen.has(key)) {
      issues.push('A cart item is unavailable, duplicated or outside the three authorized stores.'); continue;
    }
    seen.add(key);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 5 || line.quantity > variant.inventoryQty) {
      issues.push(`${store.name}: choose quantity 1–5 within actual available stock.`); continue;
    }
    if (!store.connected || !store.configured || !cents(store.shippingCents)
      || store.commissionBps !== 1500 || !Number.isSafeInteger(store.returnWindowDays) || store.returnWindowDays < 7) {
      issues.push(`${store.name}: verified connection, shipping and settlement policies are required.`); continue;
    }
    included.add(store.shop);
    subtotalCents += variant.priceCents * line.quantity;
    payload.push({ shop: store.shop, variantId: variant.id, quantity: line.quantity });
  }
  for (const store of UNIFIED_STORES) {
    if (!included.has(store.shop)) issues.push(`Add an in-stock item from ${store.name}.`);
  }
  for (const store of options.stores) if (included.has(store.shop)) shippingCents += store.shippingCents;
  if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(shippingCents)) issues.push('The cart amount is outside safe integer-cent limits.');
  if (options.stripe?.verified !== true || options.stripe?.mode !== 'test') issues.push('Verify Stripe test credentials before creating hosted checkout.');
  if (options.blockers?.length) issues.push('Resolve the reported provider setup blockers before checkout.');
  payload.sort((a, b) => a.shop.localeCompare(b.shop) || a.variantId.localeCompare(b.variantId));
  return {
    valid: issues.length === 0 && payload.length > 0, issues: [...new Set(issues)], items: payload,
    subtotalCents: Number.isSafeInteger(subtotalCents) ? subtotalCents : null,
    shippingCents: Number.isSafeInteger(shippingCents) ? shippingCents : null,
    // Stripe Checkout collects the one shipping address and computes authoritative tax.
    taxCents: null, totalCents: null,
  };
}

export function unifiedRunRecords(value) {
  const runs = Array.isArray(value) ? value : Array.isArray(value?.runs) ? value.runs : [];
  return runs.filter(run => run && typeof run === 'object' && typeof run.id === 'string');
}

export function safeUnifiedError(value) {
  return safeCheckoutMessage(typeof value === 'string' ? value : value?.message,
    'The unified provider workflow could not be verified. Refresh the saved run before retrying.');
}

export function clearUnifiedShopifyForm(form) {
  form?.reset?.();
  const field = form?.elements?.namedItem?.('shopifyClientSecret');
  if (field) field.value = '';
}

/** Uncontrolled secret field -> same-origin owner request; only safe metadata returns. */
export async function configureUnifiedShopifyCredentials({ form, shop, enabled, hostname, request }) {
  let clientSecret = '';
  try {
    if (!enabled || !isLoopbackHost(hostname) || !UNIFIED_STORES.slice(1).some(store => store.shop === shop))
      throw new Error('Store credentials can only be configured for My Store 4 or 6 in the local owner workspace.');
    const clientId = String(form?.elements?.namedItem?.('shopifyClientId')?.value || '').trim();
    clientSecret = String(form?.elements?.namedItem?.('shopifyClientSecret')?.value || '').trim();
    const confirmed = form?.elements?.namedItem?.('confirmOwnedStore')?.checked === true;
    if (!clientId || clientId.length > 128 || clientSecret.length < 16 || clientSecret.length > 500 || !confirmed)
      throw new Error('Enter the app client ID and secret, and confirm that the app belongs to this exact store’s organization.');
    let result;
    try {
      result = await request('/api/local/shopify-test-credentials', {
        method: 'POST', cache: 'no-store', referrerPolicy: 'no-referrer',
        body: { shop, clientId, clientSecret, confirmOwnedStore: true },
      });
    } catch {
      // Never echo an upstream exception: it may contain submitted request values.
      throw new Error('Shopify credentials could not be verified. Check exact-store app ownership and the 15 approved scopes, then try again.');
    }
    if (result?.verified !== true || result.shop !== shop || result.secretReturned !== false
      || result.secretStorage !== 'server encrypted database')
      throw new Error('Shopify did not return verified, encrypted, exact-store configuration.');
    return { verified: true, shop, secretStorage: 'server encrypted database', secretReturned: false };
  } finally {
    clientSecret = '';
    clearUnifiedShopifyForm(form);
  }
}
