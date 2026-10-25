/** Operations-only configuration and local simulation surface. Brand sessions,
 * integration keys and invite sessions cannot change commercial authority. */
export function registerCommerceRoutes(app,{commerce,domain,browserRoute,requireAdmin,localTestOwner,data}) {
  const admin=async r=>{const ctx=await browserRoute(r);requireAdmin(ctx);return ctx;};
  const actor=ctx=>ctx.memberId||ctx.credentialId||(ctx.owner?'owner':'operator');
  const empty=r=>{if(r.body && (typeof r.body!=='object'||Array.isArray(r.body)||Object.keys(r.body).length))throw Object.assign(new Error('This action accepts an empty object.'),{statusCode:422,code:'COMMERCE_INVALID'});};
  app.get('/api/admin/commerce',async r=>{
    await admin(r);const brands=await domain.listBrands();
    return data({settings:await commerce.policies.get(),brands:await Promise.all(brands.map(async b=>({...b,commercial:await commerce.policies.getBrand(b.id)}))),inventory:await commerce.inventory.list(),mode:'simulation'});
  });
  app.put('/api/admin/commerce/settings',async r=>{const ctx=await admin(r);return data(await commerce.policies.save(r.body,actor(ctx)));});
  app.put('/api/admin/commerce/brands/:brandId',async r=>{const ctx=await admin(r);return data(await commerce.policies.saveBrand(r.params.brandId,r.body,actor(ctx)));});
  app.post('/api/admin/commerce/variants',async r=>{const ctx=await admin(r);return data(await commerce.inventory.createVariant(r.body,actor(ctx)));});
  app.patch('/api/admin/commerce/variants/:id',async r=>{const ctx=await admin(r);return data(await commerce.inventory.updateVariant(r.params.id,r.body,actor(ctx)));});
  app.post('/api/admin/commerce/inventory/adjust',async r=>{const ctx=await admin(r);return data(await commerce.inventory.adjust(r.body,actor(ctx)));});
  app.get('/api/admin/commerce/checkouts',async r=>{await admin(r);return data(await commerce.checkout.list());});
  app.post('/api/admin/commerce/checkouts',async r=>{await localTestOwner(r);return data(await commerce.checkout.quote(r.body));});
  app.get('/api/admin/commerce/checkouts/:id',async r=>{await admin(r);return data(await commerce.checkout.get(r.params.id));});
  app.post('/api/admin/commerce/checkouts/:id/simulate-payment',async r=>{await localTestOwner(r);empty(r);return data(await commerce.checkout.simulatePayment(r.params.id));});
  app.post('/api/admin/commerce/checkouts/:id/cancel',async r=>{await localTestOwner(r);empty(r);return data(await commerce.checkout.cancel(r.params.id));});
  app.get('/api/admin/commerce/fulfillment',async r=>{await admin(r);return data(await commerce.checkout.fulfillment());});
  app.post('/api/admin/commerce/fulfillment/:id/ship',async r=>{const ctx=await localTestOwner(r);return data(await commerce.checkout.ship(r.params.id,r.body,actor(ctx)));});
  app.post('/api/admin/commerce/fulfillment/:id/deliver',async r=>{const ctx=await localTestOwner(r);return data(await commerce.checkout.deliver(r.params.id,r.body,actor(ctx)));});
  app.post('/api/admin/commerce/bags/:id/refunds',async r=>{const ctx=await localTestOwner(r);return data(await commerce.checkout.refund(r.params.id,r.body,actor(ctx)));});
  app.post('/api/admin/commerce/returns/inspect',async r=>{const ctx=await localTestOwner(r);return data(await commerce.checkout.inspect(r.body,actor(ctx)));});
  app.post('/api/admin/commerce/run',async r=>{await localTestOwner(r);empty(r);return data(await commerce.checkout.run());});
  app.get('/api/admin/commerce/reconciliation',async r=>{await admin(r);return data(await commerce.checkout.reconciliation());});
}
