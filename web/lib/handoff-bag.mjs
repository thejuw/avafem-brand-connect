/** Adapt the privacy-projected contract without reintroducing excluded fields. */
export function normalizeHandoffBag(input = {}) {
  const bag = input && typeof input === 'object' ? input : {};
  const source = bag.shipTo || bag.ship_to || {};
  const shipTo = {};
  for (const field of ['name','line1','line2','city','region','postal','country']) {
    if (typeof source[field] === 'string') shipTo[field] = source[field];
  }
  return {
    id:bag.id || bag.bag_id || bag.bagId || '',
    orderRef:bag.orderRef || bag.order_ref || '',
    brandName:bag.brandName || bag.brand_name || '',
    status:typeof bag.status === 'string' ? bag.status : undefined,
    shipTo,
    items:Array.isArray(bag.items) ? bag.items.filter(item => item && typeof item === 'object').map(item => ({
      sku:item.sku, title:item.title, qty:item.qty ?? item.quantity,
      unitPriceCents:item.unitPriceCents ?? item.unit_price,
    })) : [],
  };
}
