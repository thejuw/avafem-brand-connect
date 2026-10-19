import { fail, text } from './util.mjs';

/** Store-platform adapters behind one interface:
 *   verify(credentials) -> { storeRef }
 *   listProducts(credentials) -> normalized product rows ({ sku, title, description, priceCents, inventoryQty, images, category })
 *   createOrder(credentials, bag) -> { externalId }
 * All network access goes through the injected `fetch`, so tests run fully mocked. */
const cents = value => { const n = Number(String(value ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const strip = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const httpsUrl = (value, name) => { let u; try { u = new URL(value); } catch { fail(`${name} must be a URL.`); } if (u.protocol !== 'https:') fail(`${name} must use https.`); return u.origin; };
async function call(fetch, url, init) {
  const r = await fetch(url, init);
  if (r.status === 401 || r.status === 403) fail('The store rejected these credentials.', 401, 'CONNECTOR_UNAUTHORIZED');
  if (r.status === 429) fail('The store is rate limiting requests; retry later.', 429, 'CONNECTOR_RATE_LIMITED');
  if (!r.ok) fail(`Store request failed (${r.status}).`, 502, 'CONNECTOR_ERROR');
  return r.json();
}

export function woocommerceAdapter({ fetch }) {
  const auth = c => ({ authorization: `Basic ${Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64')}`, accept: 'application/json' });
  const base = c => { if (!c?.consumerKey?.startsWith('ck_') || !c?.consumerSecret?.startsWith('cs_')) fail('WooCommerce needs a ck_ consumer key and cs_ consumer secret.'); return `${httpsUrl(c.storeUrl, 'storeUrl')}/wp-json/wc/v3`; };
  return {
    platform: 'woocommerce',
    async verify(c) { const info = await call(fetch, `${base(c)}/system_status`, { headers: auth(c) }); return { storeRef: text(info?.environment?.site_url || c.storeUrl, 300) }; },
    async listProducts(c) {
      const out = [];
      for (let page = 1; page <= 50; page++) {
        const list = await call(fetch, `${base(c)}/products?per_page=100&page=${page}&status=publish`, { headers: auth(c) });
        for (const p of list) out.push({ sku: text(p.sku, 120) || `WC-${p.id}`, title: text(p.name, 500), description: strip(p.description || p.short_description),
          priceCents: cents(p.price || p.regular_price), inventoryQty: Number.isInteger(p.stock_quantity) ? Math.max(0, p.stock_quantity) : 0,
          images: (p.images || []).map(i => i.src).filter(s => /^https:/.test(s)).slice(0, 20), category: text(p.categories?.[0]?.slug || '', 200), externalId: String(p.id) });
        if (list.length < 100) break;
      }
      return out;
    },
    async createOrder(c, bag) {
      const body = { status: 'processing', set_paid: true, customer_note: `Avafem ${bag.orderRef}`,
        shipping: { first_name: bag.shipTo.name, address_1: bag.shipTo.line1, address_2: bag.shipTo.line2 || '', city: bag.shipTo.city, state: bag.shipTo.region, postcode: bag.shipTo.postal, country: bag.shipTo.country },
        line_items: bag.items.map(i => ({ sku: i.sku, quantity: i.qty, total: ((i.unitPriceCents * i.qty) / 100).toFixed(2) })), meta_data: [{ key: 'avafem_bag_id', value: bag.id }] };
      const o = await call(fetch, `${base(c)}/orders`, { method: 'POST', headers: { ...auth(c), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { externalId: String(o.id) };
    },
  };
}

export function bigcommerceAdapter({ fetch }) {
  const headers = c => ({ 'x-auth-token': c.accessToken, accept: 'application/json', 'content-type': 'application/json' });
  const base = c => { if (!/^[a-z0-9]{5,20}$/i.test(c?.storeHash || '') || !c?.accessToken) fail('BigCommerce needs a storeHash and accessToken.'); return `https://api.bigcommerce.com/stores/${c.storeHash}`; };
  return {
    platform: 'bigcommerce',
    async verify(c) { const s = await call(fetch, `${base(c)}/v2/store`, { headers: headers(c) }); return { storeRef: text(s?.domain || c.storeHash, 300) }; },
    async listProducts(c) {
      const out = [];
      for (let page = 1; page <= 50; page++) {
        const r = await call(fetch, `${base(c)}/v3/catalog/products?include=images&limit=250&page=${page}&is_visible=true`, { headers: headers(c) });
        for (const p of r.data || []) out.push({ sku: text(p.sku, 120) || `BC-${p.id}`, title: text(p.name, 500), description: strip(p.description),
          priceCents: cents(p.price), inventoryQty: Math.max(0, p.inventory_level || 0), images: (p.images || []).map(i => i.url_standard).filter(s => /^https:/.test(s)).slice(0, 20), category: '', externalId: String(p.id) });
        if (!r.meta?.pagination || page >= r.meta.pagination.total_pages) break;
      }
      return out;
    },
    async createOrder(c, bag) {
      const body = { status_id: 11, customer_id: 0, billing_address: { first_name: bag.shipTo.name, street_1: bag.shipTo.line1, city: bag.shipTo.city, state: bag.shipTo.region, zip: bag.shipTo.postal, country_iso2: bag.shipTo.country, email: 'orders@avafem.invalid' },
        shipping_addresses: [{ first_name: bag.shipTo.name, street_1: bag.shipTo.line1, city: bag.shipTo.city, state: bag.shipTo.region, zip: bag.shipTo.postal, country_iso2: bag.shipTo.country }],
        products: bag.items.map(i => ({ name: i.title || i.sku, sku: i.sku, quantity: i.qty, price_inc_tax: i.unitPriceCents / 100, price_ex_tax: i.unitPriceCents / 100 })), staff_notes: `Avafem ${bag.orderRef} / ${bag.id}` };
      const o = await call(fetch, `${base(c)}/v2/orders`, { method: 'POST', headers: headers(c), body: JSON.stringify(body) });
      return { externalId: String(o.id) };
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
      taxCode: text(pick(r, 'taxCode', 'tax_code') || '', 100) });
  }
  return out.map(({ handle, ...row }) => row);
}
