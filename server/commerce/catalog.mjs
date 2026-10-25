/** Public catalog projection. Product scalar/JSON counters are legacy aliases;
 * a native listing exposes only the new variant authority and never unit cost. */
export function createCommerceCatalog({policies,inventory}) {
  return async products=>{
    const terms=new Map(),variants=new Map();
    for(const brandId of new Set(products.map(p=>p.brandId))){
      const policy=await policies.getBrand(brandId);terms.set(brandId,policy);
      if(policy.model==='first_party')variants.set(brandId,await inventory.list({brandId}));
    }
    return products.map(product=>{
      const policy=terms.get(product.brandId);if(policy.model!=='first_party')return product;
      const native=(variants.get(product.brandId)||[]).filter(v=>v.productId===product.id);
      return {...product,inventoryAuthority:'native',settlementModel:'retail',checkoutSelector:'variantId',
        inventoryQty:native.reduce((s,v)=>s+v.available,0),priceCents:native.length?Math.min(...native.map(v=>v.unitPriceCents)):product.priceCents,
        variants:native.map(v=>({id:v.id,variantId:v.id,sku:v.sku,title:v.label,price:{amount:v.unitPriceCents,currency:'USD'},inventory:{qty:v.available},inventoryAuthority:'native'}))};
    });
  };
}
