import { fail, text } from './util.mjs';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { validatePublicHttpsUrl } from '../integrations/webhooks.mjs';

/** Store-platform adapters behind one interface:
 *   verify(credentials) -> { storeRef }
 *   listProducts(credentials) -> normalized product rows ({ sku, title, description, priceCents, inventoryQty, images, category })
 *   createOrder(credentials, bag) -> { externalId }
 * The default transport pins a checked public DNS address in HTTPS and never redirects.
 * Tests may inject both `fetch` and `resolve`; neither requires a real network call. */
const cents = value => { const n = Number(String(value ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const strip = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const httpsUrl = (value, name) => {
  let u; try { u = new URL(value); } catch { fail(`${name} must be a URL.`); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail(`${name} must use https without credentials or fragments.`, 422, 'CONNECTOR_DESTINATION_DENIED');
  return u.origin;
};

function pinnedRequest(checked, init, { request, signal, maxResponseBytes }) {
  const pinned = checked.addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(checked.url, {
      method: init?.method || 'GET', headers: init?.headers, agent: false, signal,
      lookup: (_hostname, options, callback) => {
        const address = { address: pinned.address, family: isIP(pinned.address) };
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, res => {
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        res.destroy();
        resolve({ status, ok: false, redirected: false, url: checked.url.href });
        return;
      }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          reject(Object.assign(new Error('Store response exceeded the size limit.'), { statusCode: 502, code: 'CONNECTOR_RESPONSE_INVALID' }));
          res.destroy(); req.destroy();
        } else chunks.push(Buffer.from(chunk));
      });
      res.once('error', reject);
      res.once('aborted', () => reject(new Error('Store response aborted.')));
      res.once('end', () => resolve({ status, ok: true, redirected: false, url: checked.url.href,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject);
    req.end(init?.body);
  });
}

/** One bounded request, including DNS and body parsing. No automatic retry or redirect. */
function createCall({ fetch, getFetch, resolve = lookup, getResolve, request = https.request, timeoutMs = 10_000, maxResponseBytes = 2_000_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('Invalid connector timeout.');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_000_000) fail('Invalid connector response limit.');
  return async (url, init = {}) => {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      reject(Object.assign(new Error('The store request timed out; its outcome is not verified.'), { statusCode: 504, code: 'CONNECTOR_TIMEOUT' }));
      controller.abort();
    }, timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        let checked;
        try {
          checked = await validatePublicHttpsUrl(url, { resolve: getResolve ? getResolve() : resolve });
          // The retired 6bone allocation is not a public destination either.
          if (checked.addresses.some(({ address }) => /^3ffe:/i.test(address))) throw new Error('Reserved address.');
        }
        catch { fail('The store must resolve only to public HTTPS addresses.', 422, 'CONNECTOR_DESTINATION_DENIED'); }
        controller.signal.throwIfAborted();
        const injected = getFetch ? getFetch() : fetch;
        // Native fetch cannot pin a checked DNS result. Use native HTTPS for the
        // production default; only explicitly injected test transports use fetch.
        const r = injected && injected !== globalThis.fetch
          ? await injected(checked.url.href, { ...init, redirect: 'manual', signal: controller.signal })
          : await pinnedRequest(checked, init, { request, signal: controller.signal, maxResponseBytes });
        if (r?.redirected || (r?.url && r.url !== checked.url.href) || (r?.status >= 300 && r.status < 400))
          fail('Store redirects are not allowed.', 502, 'CONNECTOR_REDIRECT_DENIED');
        if (r?.status === 401 || r?.status === 403) fail('The store rejected these credentials.', 401, 'CONNECTOR_UNAUTHORIZED');
        if (r?.status === 429) fail('The store is rate limiting requests; retry later.', 429, 'CONNECTOR_RATE_LIMITED');
        if (!Number.isInteger(r?.status) || r.status < 200 || r.status >= 300 || r.ok !== true) fail('The store request failed.', 502, 'CONNECTOR_ERROR');
        return await r.json();
      })()]);
    } catch (error) {
      if (['CONNECTOR_DESTINATION_DENIED', 'CONNECTOR_REDIRECT_DENIED', 'CONNECTOR_UNAUTHORIZED', 'CONNECTOR_RATE_LIMITED', 'CONNECTOR_TIMEOUT', 'CONNECTOR_RESPONSE_INVALID', 'CONNECTOR_ERROR'].includes(error?.code)) throw error;
      fail('The store request could not be verified.', 502, 'CONNECTOR_ERROR');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

export {createCall as createConnectorCall};

const orderId = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,29}$/.test(String(value)) || (typeof value === 'number' && !Number.isSafeInteger(value)))
    fail('The store did not return a valid order identity.', 502, 'CONNECTOR_RESPONSE_INVALID');
  return String(value);
};
const proofInvalid = () => fail('The store order proof is incomplete or invalid.', 502, 'CONNECTOR_RESPONSE_INVALID');
const money = value => {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value ?? ''));
  if (!match) return proofInvalid();
  const fraction = (match[2] || '').padEnd(4, '0');
  const valueCents = Number(match[1]) * 100 + Number(fraction.slice(0, 2));
  if (fraction.slice(2) !== '00' || !Number.isSafeInteger(valueCents)) return proofInvalid();
  return valueCents;
};
const collection = (value, max = 249) => { if (!Array.isArray(value) || value.length > max) return proofInvalid(); return value; };
const quantity = value => { if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) return proofInvalid(); return value; };
const markerValues = (list, key) => collection(list, 1000).filter(v => v?.key === key).map(v => v.value);
const address = (value, woo) => {
  if (!value || typeof value !== 'object') return proofInvalid();
  return { name: [value.first_name, value.last_name].filter(Boolean).join(' ').trim(),
    line1: value[woo ? 'address_1' : 'street_1'] || '', line2: value[woo ? 'address_2' : 'street_2'] || '',
    city: value.city || '', region: value.state || '', postal: value[woo ? 'postcode' : 'zip'] || '', country: value[woo ? 'country' : 'country_iso2'] || '' };
};

export function woocommerceAdapter(options = {}) {
  const call = createCall(options);
  const auth = c => ({ authorization: `Basic ${Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64')}`, accept: 'application/json' });
  const base = c => { if (!c?.consumerKey?.startsWith('ck_') || !c?.consumerSecret?.startsWith('cs_')) fail('WooCommerce needs a ck_ consumer key and cs_ consumer secret.'); return `${httpsUrl(c.storeUrl, 'storeUrl')}/wp-json/wc/v3`; };
  return {
    platform: 'woocommerce',
    async verify(c) { await call(`${base(c)}/system_status`, { headers: auth(c) }); return { storeRef: httpsUrl(c.storeUrl, 'storeUrl') }; },
    async profile(c) {
      const p=await call(`${base(c)}/system_status`,{headers:auth(c)}),s=p.store || {};
      return { ...(s.name || p.store_name ? {name:text(s.name || p.store_name,160)} : {}),
        ...(s.email || p.store_email ? {contactEmail:text(s.email || p.store_email,254)} : {}),
        ...(s.logo_url || p.store_logo ? {logoUrl:text(s.logo_url || p.store_logo,2000)} : {}),
        ...(s.return_policy || p.return_policy ? {returnPolicy:text(s.return_policy || p.return_policy,12000)} : {}) };
    },
    async listProducts(c) {
      const out = [];
      for (let page = 1; page <= 50; page++) {
        const list = await call(`${base(c)}/products?per_page=100&page=${page}&status=publish`, { headers: auth(c) });
        if(!Array.isArray(list) || list.length>100) return proofInvalid();
        for (const p of list) out.push({ sku: text(p.sku, 120) || `WC-${p.id}`, title: text(p.name, 500), description: strip(p.description || p.short_description),
          priceCents: cents(p.price || p.regular_price), inventoryQty: Number.isInteger(p.stock_quantity) ? Math.max(0, p.stock_quantity) : 0,
          images: (p.images || []).map(i => i.src).filter(s => /^https:/.test(s)).slice(0, 20), category: text(p.categories?.[0]?.slug || '', 200), externalId: orderId(p.id),
          ...(p.type ? {productType:text(p.type,150)} : {}),...(Array.isArray(p.tags)?{tags:p.tags.map(t=>text(t.name,150)).filter(Boolean)}:{}),
          ...(Array.isArray(p.categories)?{collections:p.categories.map(t=>text(t.slug || t.name,150)).filter(Boolean)}:{}) });
        if (list.length < 100) {Object.defineProperty(out,'complete',{value:true});return out;}
      }
      fail('The complete catalog exceeds the bounded page limit.',422,'CATALOG_PAGINATION_LIMIT');
    },
    async createOrder(c, bag, { dispatchId } = {}) {
      const body = { status: 'processing', set_paid: true, customer_note: `Avafem ${bag.orderRef}`,
        shipping: { first_name: bag.shipTo.name, address_1: bag.shipTo.line1, address_2: bag.shipTo.line2 || '', city: bag.shipTo.city, state: bag.shipTo.region, postcode: bag.shipTo.postal, country: bag.shipTo.country },
        line_items: bag.items.map(i => ({ sku: i.sku, quantity: i.qty, total: ((i.unitPriceCents * i.qty) / 100).toFixed(2) })), meta_data: [{ key: 'avafem_bag_id', value: bag.id }, ...(dispatchId ? [{ key: 'avafem_dispatch_id', value: dispatchId }] : [])] };
      const o = await call(`${base(c)}/orders`, { method: 'POST', headers: { ...auth(c), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { externalId: orderId(o?.id) };
    },
    /** Authoritative read-only recovery evidence; never infer absence from a 404. */
    async getOrder(c, externalId) {
      const expectedId = orderId(externalId);
      const o = await call(`${base(c)}/orders/${expectedId}`, { headers: auth(c) });
      if (orderId(o?.id) !== expectedId) return proofInvalid();
      const lines = collection(o.line_items, 100), refunds = collection(o.refunds, 100);
      let fulfillments = null;
      // This optional Woo feature is required to prove an unfulfilled void.
      // Disabled/unavailable fulfillment APIs block retry, never imply zero.
      try { fulfillments = collection(await call(`${base(c)}/orders/${expectedId}/fulfillments?per_page=100&page=1`, { headers: auth(c) }), 99); } catch { /* Unknown history remains explicit below. */ }
      if (fulfillments?.some(f => String(f.entity_id) !== expectedId || f.entity_type !== 'WC_Order')) return proofInvalid();
      return { externalId: expectedId, platform: 'woocommerce', complete: true,
        bagMarkers: markerValues(o.meta_data, 'avafem_bag_id'), dispatchMarkers: markerValues(o.meta_data, 'avafem_dispatch_id'),
        status: o.status, currency: o.currency, totalCents: money(o.total), subtotalCents: lines.reduce((sum, l) => sum + money(l.total), 0),
        shippingCents: money(o.shipping_total), taxCents: money(o.total_tax), discountCents: money(o.discount_total),
        extraCharges: collection(o.fee_lines, 100).length > 0 || collection(o.coupon_lines, 100).length > 0,
        items: lines.map(l => ({ sku: l.sku, qty: quantity(l.quantity), totalCents: money(l.total) })), shipping: address(o.shipping, true),
        hasRefunds: refunds.length > 0, paid: typeof o.date_paid === 'string' && Number.isFinite(Date.parse(o.date_paid)),
        canConfirm: ['processing', 'completed'].includes(o.status),
        voidVerified: o.status === 'cancelled' && o.date_completed === null && fulfillments !== null && fulfillments.length === 0,
        fulfillmentProofComplete: fulfillments !== null };
    },
  };
}

export function bigcommerceAdapter(options = {}) {
  const call = createCall(options);
  const headers = c => ({ 'x-auth-token': c.accessToken, accept: 'application/json', 'content-type': 'application/json' });
  const base = c => { if (!/^[a-z0-9]{5,20}$/i.test(c?.storeHash || '') || !c?.accessToken) fail('BigCommerce needs a storeHash and accessToken.'); return `https://api.bigcommerce.com/stores/${c.storeHash}`; };
  return {
    platform: 'bigcommerce',
    async verify(c) { const s = await call(`${base(c)}/v2/store`, { headers: headers(c) }); return { storeRef: text(s?.domain || c.storeHash, 300) }; },
    async profile(c) {
      const s=await call(`${base(c)}/v2/store`,{headers:headers(c)});
      return { ...(s.name ? {name:text(s.name,160)} : {}),...(s.admin_email ? {contactEmail:text(s.admin_email,254)} : {}),
        ...(s.logo?.url || s.logo_url ? {logoUrl:text(s.logo?.url || s.logo_url,2000)} : {}),...(s.return_policy ? {returnPolicy:text(s.return_policy,12000)} : {}) };
    },
    async listProducts(c) {
      const out = [];
      for (let page = 1; page <= 50; page++) {
        const r = await call(`${base(c)}/v3/catalog/products?include=images&limit=250&page=${page}&is_visible=true`, { headers: headers(c) });
        if(!Array.isArray(r.data) || r.data.length>250) return proofInvalid();
        for (const p of r.data) out.push({ sku: text(p.sku, 120) || `BC-${p.id}`, title: text(p.name, 500), description: strip(p.description),
          priceCents: cents(p.price), inventoryQty: Math.max(0, p.inventory_level || 0), images: (p.images || []).map(i => i.url_standard).filter(s => /^https:/.test(s)).slice(0, 20), category: '', externalId: orderId(p.id),
          ...(p.type?{productType:text(p.type,150)}:{}),...(Array.isArray(p.categories)?{collections:p.categories.map(String)}:{}),...(Array.isArray(p.tags)?{tags:p.tags.map(String)}:{}) });
        const pagination=r.meta?.pagination;
        if(!pagination) return out; // Missing proof permits upserts, never deletion.
        if(!Number.isInteger(pagination.total_pages) || pagination.total_pages<0 || (pagination.total_pages===0 && r.data.length) || (pagination.current_page!==undefined && pagination.current_page!==page)) return proofInvalid();
        if(page>=pagination.total_pages) {Object.defineProperty(out,'complete',{value:true});return out;}
      }
      fail('The complete catalog exceeds the bounded page limit.',422,'CATALOG_PAGINATION_LIMIT');
    },
    async createOrder(c, bag, { dispatchId } = {}) {
      const body = { status_id: 11, customer_id: 0, billing_address: { first_name: bag.shipTo.name, street_1: bag.shipTo.line1, city: bag.shipTo.city, state: bag.shipTo.region, zip: bag.shipTo.postal, country_iso2: bag.shipTo.country, email: 'orders@avafem.invalid' },
        shipping_addresses: [{ first_name: bag.shipTo.name, street_1: bag.shipTo.line1, city: bag.shipTo.city, state: bag.shipTo.region, zip: bag.shipTo.postal, country_iso2: bag.shipTo.country }],
        products: bag.items.map(i => ({ name: i.title || i.sku, sku: i.sku, quantity: i.qty, price_inc_tax: i.unitPriceCents / 100, price_ex_tax: i.unitPriceCents / 100 })), staff_notes: `Avafem ${bag.orderRef} / ${bag.id}${dispatchId ? ` / dispatch ${dispatchId}` : ''}` };
      const o = await call(`${base(c)}/v2/orders`, { method: 'POST', headers: headers(c), body: JSON.stringify(body) });
      return { externalId: orderId(o?.id) };
    },
    async getOrder(c, externalId) {
      const expectedId = orderId(externalId), path = `${base(c)}/v2/orders/${expectedId}`;
      const o = await call(path, { headers: headers(c) });
      if (orderId(o?.id) !== expectedId || o.is_deleted !== false) return proofInvalid();
      // Fixed paths only: never fetch resource URLs supplied by the provider.
      const [products, shipping, shipments] = await Promise.all(['products', 'shipping_addresses', 'shipments'].map(async resource =>
        collection(await call(`${path}/${resource}?limit=250&page=1`, { headers: headers(c) }))));
      if (shipping.length !== 1 || o.shipping_address_count !== 1 || [...products, ...shipping, ...shipments].some(v => String(v.order_id) !== expectedId)) return proofInvalid();
      const total = money(o.total_inc_tax), exclusive = money(o.total_ex_tax);
      if (exclusive > total || products.reduce((sum, p) => sum + quantity(p.quantity), 0) !== o.items_total) return proofInvalid();
      return { externalId: expectedId, platform: 'bigcommerce', complete: true, staffNotes: o.staff_notes,
        status: o.status_id, currency: o.currency_code, transactionalCurrency: o.default_currency_code,
        exchangeRate: o.currency_exchange_rate, totalCents: total, subtotalCents: money(o.subtotal_ex_tax),
        shippingCents: money(o.shipping_cost_ex_tax), taxCents: total - exclusive,
        discountCents: money(o.discount_amount) + money(o.coupon_discount),
        extraCharges: money(o.handling_cost_ex_tax) !== 0 || money(o.wrapping_cost_ex_tax) !== 0,
        items: products.map(p => ({ sku: p.sku, qty: quantity(p.quantity), totalCents: money(p.total_ex_tax) })), shipping: address(shipping[0], false),
        hasRefunds: money(o.refunded_amount) > 0, paid: ['captured', 'paid'].includes(o.payment_status),
        canConfirm: [2, 3, 8, 9, 10, 11].includes(o.status_id),
        voidVerified: o.status_id === 5 && o.items_shipped === 0 && !o.date_shipped && shipments.length === 0,
        fulfillmentProofComplete: true };
    },
  };
}

/** CSV fallback: accepts Avafem columns or a Shopify product export (Handle/Title/Body (HTML)/Variant SKU/...). */
export function csvRows(csvParse, csv) {
  const raw = csvParse(csv, { columns: true, skip_empty_lines: true, trim: true, max_record_size: 100_000 });
  if (!raw.length || raw.length > 5000) fail('Provide 1–5,000 CSV rows.', 422, 'INVALID_IMPORT');
  const pick = (r, ...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return undefined; };
  const out = [];
  for (const r of raw) {
    const sku = pick(r, 'sku', 'SKU', 'Variant SKU') || (pick(r, 'Handle') ? `SH-${pick(r, 'Handle')}` : '');
    const title = pick(r, 'title', 'Title', 'name', 'Name');
    if (!title && pick(r, 'Handle')) { const prev = out.find(p => p.handle === r.Handle); if (prev && pick(r, 'Image Src')) prev.images.push(r['Image Src']); continue; }
    const price = pick(r, 'priceCents', 'price_cents');
    out.push({ handle: r.Handle, sku: text(sku, 120), title: text(title, 500), description: strip(pick(r, 'description', 'Body (HTML)', 'Description') || ''),
      priceCents: price != null ? Number(price) : cents(pick(r, 'price', 'Price', 'Variant Price')),
      inventoryQty: Number(pick(r, 'inventoryQty', 'inventory_qty', 'Variant Inventory Qty', 'Stock') ?? 0) || 0,
      images: String(pick(r, 'images', 'Image Src') || '').split('|').filter(Boolean), category: text(pick(r, 'category', 'Type', 'Product Category') || '', 200),
      taxCode: text(pick(r, 'taxCode', 'tax_code') || '', 100),externalId:text(pick(r,'sourceProductId','externalId','ID') || sku,200),
      ...(pick(r,'productType','product_type','Type')?{productType:text(pick(r,'productType','product_type','Type'),150)}:{}),
      ...(pick(r,'tags','Tags')?{tags:String(pick(r,'tags','Tags')).split(/[|,]/).map(v=>v.trim()).filter(Boolean)}:{}),
      ...(pick(r,'collections','Collection')?{collections:String(pick(r,'collections','Collection')).split('|').map(v=>v.trim()).filter(Boolean)}:{}) });
  }
  return out.map(({ handle, ...row }) => row);
}
