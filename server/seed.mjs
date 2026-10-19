import { createDomain } from './domain.mjs';

/** Idempotent local fixtures. Nothing here connects a payment processor, brand
 * store, email service or carrier. Every persisted record is sandbox-only. */
export async function seedDatabase(db, domain = createDomain(db)) {
  const definitions = [
    {id:'brand_bloom',name:'Bloom Botanics',slug:'bloom-botanics',commissionBps:1500,shipping:500,
      sku:'BLOOM-COTTON-16',title:'Organic cotton period pads · 16 pack',category:'period-care/pads',price:3200,
      ingredients:['Organic cotton','Plant-based absorbent core'],image:'https://images.unsplash.com/photo-1608571423902-eed4a5ad8108?w=600'},
    {id:'brand_lunelle',name:'Lunelle',slug:'lunelle',commissionBps:1200,shipping:0,
      sku:'LUNELLE-CUP',title:'Reusable menstrual cup',category:'period-care/cups',price:2900,
      ingredients:['Medical-grade silicone'],image:'https://images.unsplash.com/photo-1556229010-6c3f2c9ca5f8?w=600'},
    {id:'brand_hearth',name:'Hearth & Hue',slug:'hearth-hue',commissionBps:1800,shipping:495,
      sku:'HEARTH-HEAT-6',title:'Comfort heat patches · 6 pack',category:'wellness/heat-patches',price:2800,
      ingredients:['Iron powder','Activated carbon','Water','Salt'],image:'https://images.unsplash.com/photo-1600612253971-422e7f7faeb6?w=600'},
  ];
  for (const fixture of definitions) {
    const found = await db.query('SELECT id FROM brands WHERE id=$1',[fixture.id]);
    if (!found.rows.length) {
      await domain.createBrand(fixture);
      await domain.updateBrand(fixture.id,{
        connectionTier:'dashboard',agreementSigned:true,stripeAccountId:`acct_sandbox_${fixture.slug.replaceAll('-','')}`,
        chargesEnabled:true,payoutsEnabled:true,returnWindowDays:30,
        shipFromAddress:{name:fixture.name,line1:'100 Sandbox Way',city:'Austin',region:'TX',postal:'78701',country:'US'},
        shippingTable:[{country:'US',priceCents:fixture.shipping}],supportEmail:`support@${fixture.slug}.example`,
        connectionHealthy:true,testOrderPassed:true,
      });
    }
    const products=await domain.listProducts({brandId:fixture.id});
    if (!products.some(product=>product.sku===fixture.sku)) {
      const product=await domain.upsertProduct(fixture.id,fixture.sku,{
        title:fixture.title,description:'Sandbox catalog fixture for integration and fulfillment testing. No efficacy claims.',
        category:fixture.category,priceCents:fixture.price,inventoryQty:48,images:[fixture.image],
        evidence:{ingredients_inci:fixture.ingredients,certifications:[],claims:[],contraindications:'See package instructions.'},
        taxCode:'txcd_99999999',shippingProfile:'standard',
      });
      await domain.reviewProduct(product.id,{status:'approved',note:'Sandbox example reviewed for workflow testing only.'});
    }
    const brand=await domain.getBrand(fixture.id);
    // Extend only the original seven-day demo defaults, never a custom policy.
    if (brand.returnWindowDays===7) await domain.updateBrand(fixture.id,{returnWindowDays:30});
    if (brand.status==='onboarding' && !brand.onboardingRequirements.length) await domain.updateBrand(fixture.id,{status:'ready'});
  }
  const queue=await domain.listProducts({brandId:'brand_bloom'});
  if (!queue.some(product=>product.sku==='BLOOM-WASH-200')) await domain.upsertProduct('brand_bloom','BLOOM-WASH-200',{
    title:'Gentle body wash · 200 ml',description:'A fragrance-free wash. The supplied claim citation awaits human assessment.',
    category:'body-care/wash',priceCents:1800,inventoryQty:32,images:[definitions[0].image],
    evidence:{ingredients_inci:['Aqua','Decyl glucoside','Glycerin'],certifications:[],
      claims:[{text:'Supports a gentle cleansing routine',source_url:'https://example.com/sandbox-evidence',type:'structure'}],contraindications:'External use only.'},
    taxCode:'txcd_99999999',shippingProfile:'standard',
  });
  const hearth=await domain.listProducts({brandId:'brand_hearth'});
  if (!hearth.some(product=>product.sku==='HEARTH-TEA-20')) await domain.upsertProduct('brand_hearth','HEARTH-TEA-20',{
    title:'Evening herbal tea · 20 sachets',description:'Sandbox draft: ingredients and evidence still need to be supplied.',
    category:'wellness/tea',priceCents:1600,inventoryQty:20,images:[definitions[2].image],
    evidence:{ingredients_inci:[],certifications:[],claims:[],contraindications:''},taxCode:'',shippingProfile:'standard',
  });
  const existing=await db.query('SELECT id FROM orders WHERE order_ref=$1',['SANDBOX-EX-1042']);
  if (!existing.rows.length) {
    const order=await domain.createSandboxOrder({externalId:'EX-1042',currency:'USD',
      shipTo:{name:'Alex Sandbox',line1:'123 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'},
      items:definitions.map(fixture=>({brandId:fixture.id,sku:fixture.sku,qty:1})),
    });
    const lunelle=order.bags.find(bag=>bag.brandId==='brand_lunelle');
    await domain.recordShipment(lunelle.id,{carrier:'USPS',trackingNumber:'SANDBOX-LUNELLE-1042',trackingUrl:'https://tools.usps.com/go/TrackConfirmAction'});
    const bag=order.bags.find(bag=>bag.brandId==='brand_hearth');
    await domain.recordShipment(bag.id,{carrier:'UPS',trackingNumber:'SANDBOX-HEARTH-1042',trackingUrl:'https://www.ups.com/track'});
    await domain.markDelivered(bag.id);
  }
  return domain.dashboard();
}

export default seedDatabase;
