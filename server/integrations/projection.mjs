import { createHash } from 'node:crypto';
import { cents, invalid } from './errors.mjs';

const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));

/** Whitelist shipping data. Never spread a customer/profile object into a connector payload. */
export function projectShippingAddress(address = {}) {
  return compact({
    name: clean(address.name ?? [address.firstName, address.lastName].filter(Boolean).join(' ')),
    line1: clean(address.line1 ?? address.address1),
    line2: clean(address.line2 ?? address.address2),
    city: clean(address.city, 100),
    region: clean(address.region ?? address.state ?? address.provinceCode ?? address.province, 100),
    postal: clean(address.postal ?? address.postalCode ?? address.postal_code ?? address.zip, 30),
    country: clean(address.country ?? address.countryCode ?? address.countryCodeV2, 2)?.toUpperCase(),
    // Phone is intentionally omitted by default. Shipping providers can request it explicitly later.
  });
}

/**
 * Canonical Bag -> brand contract. Only these keys can cross the brand boundary.
 * Accepts the design's snake_case contract and the app's camelCase domain model.
 * Health/cycle/customer profile data, unrestricted notes, and the shopper's email never leave here.
 */
export function projectBrandBag(bag, options = {}) {
  if (!bag || typeof bag !== 'object') throw invalid('A Bag is required.');
  const bagId = clean(bag.bag_id ?? bag.bagId ?? bag.id, 128);
  if (!bagId) throw invalid('Bag ID is required.');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bagId)) throw invalid('Bag ID must be a stable identifier, without free text.');
  const items = (bag.items ?? bag.lineItems ?? []).map(item => {
    const qty = item.qty ?? item.quantity;
    if (!Number.isSafeInteger(qty) || qty < 1) throw invalid('Item quantity must be a positive integer.');
    return compact({
      sku: clean(item.sku, 128),
      title: clean(item.title ?? item.name),
      qty,
      unit_price: cents(item.unit_price ?? item.unitPriceCents ?? item.unitPrice ?? item.priceCents ?? item.price?.amount, 'item unit price'),
      variant_id: clean(item.variant_id ?? item.variantId ?? item.shopifyVariantId ?? item.externalVariantId, 128),
      tax_code: clean(item.tax_code ?? item.taxCode, 50),
    });
  });
  if (!items.length) throw invalid('At least one Bag item is required.');
  const address = projectShippingAddress(bag.ship_to ?? bag.shipTo ?? bag.shippingAddress ?? bag.shipping ?? {});
  const relayEmail = clean(options.relayEmail ?? bag.relay_email ?? bag.relayEmail, 254);
  return compact({
    bag_id: bagId,
    order_ref: clean(bag.order_ref ?? bag.orderRef ?? bag.orderId, 128),
    created_at: clean(bag.created_at ?? bag.createdAt, 40),
    ship_to: address,
    items,
    currency: clean(bag.currency ?? 'USD', 3)?.toUpperCase(),
    shipping_method: clean(bag.shipping_method ?? bag.shippingMethod ?? 'standard', 100),
    shipping_paid: cents(bag.shipping_paid ?? bag.shippingCents ?? bag.shippingPaid ?? 0, 'shipping'),
    tax: cents(bag.tax ?? bag.taxCents ?? 0, 'tax'),
    packing_slip: { branded: Boolean(bag.packing_slip?.branded ?? bag.packingSlip?.branded), gift: Boolean(bag.packing_slip?.gift ?? bag.packingSlip?.gift) },
    ship_by: clean(bag.ship_by ?? bag.shipBy, 40),
    paid: bag.paid === true || bag.paymentStatus === 'paid' || options.paid === true,
    return_window_days: Number.isSafeInteger(bag.return_window_days ?? bag.returnWindowDays) ? (bag.return_window_days ?? bag.returnWindowDays) : undefined,
    relay_email: relayEmail,
    idempotency_key: clean(bag.idempotency_key ?? bag.idempotencyKey ?? `${bagId}:v1`, 200),
  });
}

/** Stable, Shopify-safe marker: 36 characters, independent of Bag ID length/character set. */
export function shopifyBagTag(bagId) {
  return `avf_${createHash('sha256').update(String(bagId)).digest('hex').slice(0, 32)}`;
}

/** Whitelist outbound event envelope; never serialize arbitrary domain event payloads. */
export function projectOutboundEvent(event) {
  if (!event || !/^[a-z][a-z0-9_.-]{1,79}$/.test(event.type ?? '')) throw invalid('A valid webhook event type is required.');
  const data = event.data ?? event.payload ?? {};
  const bag = data.bag ?? (data.items ? data : undefined);
  const safeData = bag ? { bag: projectBrandBag(bag) } : compact({
    bag_id: clean(data.bag_id ?? data.bagId, 128),
    order_ref: clean(data.order_ref ?? data.orderRef, 128),
    product_id: clean(data.product_id ?? data.productId, 128),
    brand_id: clean(data.brand_id ?? data.brandId, 128),
    refund_id: clean(data.refund_id ?? data.refundId, 128),
    sku: clean(data.sku, 128),
    status: clean(data.status, 80),
    carrier: clean(data.carrier, 100),
    tracking_number: clean(data.tracking_number ?? data.trackingNumber, 100),
    tracking_url: safeTrackingUrl(data.tracking_url ?? data.trackingUrl),
    amount: Number.isSafeInteger(data.amount ?? data.amountCents) ? (data.amount ?? data.amountCents) : undefined,
    currency: clean(data.currency, 3),
    inventory_qty: Number.isSafeInteger(data.inventoryQty ?? data.inventory_qty) ? (data.inventoryQty ?? data.inventory_qty) : undefined,
    quantity_change: Number.isSafeInteger(data.quantityChange ?? data.quantity_change) ? (data.quantityChange ?? data.quantity_change) : undefined,
    shipped_at: clean(data.shippedAt ?? data.shipped_at, 40),
    delivered_at: clean(data.deliveredAt ?? data.delivered_at, 40),
    due_at: clean(data.dueAt ?? data.due_at, 40),
  });
  return { id: clean(event.id ?? event.event_id, 128), type: event.type, version: 1, sandbox: event.sandbox === true || data.sandbox === true, created_at: clean(event.created_at ?? event.createdAt, 40), data: safeData };
}

export function safeTrackingUrl(value) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
