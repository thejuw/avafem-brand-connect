const integer=(minimum=0,maximum=100_000_000)=>({type:'integer',minimum,maximum});
const string={type:'string',minLength:1,maxLength:200};
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
export function mergeCommercePaths(doc) {
  const base='/api/admin/commerce',version={expectedVersion:integer(0,2147483646),reason:{type:'string',minLength:3,maxLength:1000}},op={operationId:{type:'string',pattern:'^[A-Za-z0-9_-]{8,100}$'}};
  const funding={type:'string',enum:['avafem','partner']};
  const settings=object({...version,enabled:{type:'boolean'},merchantOfRecord:{const:'avafem'},currency:{const:'USD'},taxProvider:{const:'stripe_tax'},taxLiableParty:{const:'avafem'},taxConfigurationRef:{type:'string',maxLength:200},
    discountBps:integer(0,10000),discountFunding:funding,loyaltyBps:integer(0,10000),freeShippingThresholdCents:{anyOf:[integer(),{type:'null'}]},freeShippingFunding:funding,returnShippingFunding:funding,
    ownedShippingCents:integer(),returnWindowDays:integer(0,365),reservationMinutes:integer(1,60)},['expectedVersion','reason']);
  const brand=object({...version,model:{enum:['partner','first_party']},inventoryAuthority:{enum:['external','native']},inventoryOwner:funding,fulfiller:funding,settlementModel:{enum:['commission','retail']},commissionBps:integer(0,10000),shippingCents:integer(),partnerPromotionAgreement:{type:'string',maxLength:2000}},['expectedVersion','reason']);
  const pathParam=name=>({in:'path',name,required:true,schema:string});
  const operation=(name,body,params=[])=>({operationId:name,security:[{operationsSession:[]}],parameters:[...params,...(body?[{in:'header',name:'X-CSRF-Token',required:true,schema:string}]:[])],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:{200:{description:'Sandbox result in data; never proof of provider settlement.'},401:{description:'Authentication required'},403:{description:'Operations session/CSRF required; simulation mutations also require local owner listener.'},409:{description:'Version conflict, closed reservation, unavailable stock, or workflow boundary.'},422:{description:'Unsupported or invalid fields.'}}});
  const items={type:'array',minItems:1,maxItems:100,items:object({reference:string,qty:integer(1,100)},['reference','qty'])};
  const routes={
    '':{get:operation('readCommerceBackend')},'/settings':{put:operation('saveCommerceSettings',settings)},
    '/brands/{brandId}':{put:operation('saveBrandCommerceModel',brand,[pathParam('brandId')])},
    '/variants':{post:operation('createNativeVariant',object({productId:string,sku:string,label:string,unitPriceCents:integer(0,2000000000),unitCostCents:integer(0,2000000000)},['productId','sku','unitCostCents']))},
    '/variants/{id}':{patch:operation('editNativeVariant',object({expectedVersion:integer(1,2000000000),label:string,unitPriceCents:integer(0,2000000000),unitCostCents:integer(0,2000000000)},['expectedVersion']),[pathParam('id')])},
    '/inventory/adjust':{post:operation('adjustNativeStock',object({...op,variantId:string,delta:integer(-1000000,1000000),reason:version.reason},['operationId','variantId','delta','reason']))},
    '/checkouts':{get:operation('listCommerceSimulations'),post:operation('reserveCommerceSimulation',object({...op,
      items:{type:'array',minItems:1,maxItems:100,items:object({variantId:string,productId:string,variantSku:string,qty:integer(1,100)},['qty'])},
      shipTo:object({name:string,line1:string,line2:string,city:string,region:string,postal:string,country:{const:'US'}},['name','line1','city','region','postal','country'])},['operationId','items','shipTo']))},
    '/checkouts/{id}':{get:operation('readCommerceSimulation',null,[pathParam('id')])},
    '/checkouts/{id}/simulate-payment':{post:operation('simulateCommercePayment',object({}),[pathParam('id')])},
    '/checkouts/{id}/cancel':{post:operation('cancelCommerceReservation',object({}),[pathParam('id')])},
    '/fulfillment':{get:operation('listCommerceFulfillment')},
    '/fulfillment/{id}/ship':{post:operation('simulateCommerceShipment',object({...op,carrier:string,trackingNumber:string,trackingUrl:{type:'string',format:'uri'},items},['operationId','carrier','trackingNumber','items']),[pathParam('id')])},
    '/fulfillment/{id}/deliver':{post:operation('simulateCommerceDelivery',object(op,['operationId']),[pathParam('id')])},
    '/bags/{id}/refunds':{post:operation('simulateCommerceRefund',object({...op,reason:version.reason,items:{...items,minItems:0},refundShipping:{type:'boolean'}},['operationId','reason','items']),[pathParam('id')])},
    '/returns/inspect':{post:operation('inspectCommerceReturn',object({...op,bagId:string,reference:string,qty:integer(1,100),origin:{enum:['shipped','unshipped']},disposition:{enum:['restock','quarantine']},reason:version.reason},['operationId','bagId','reference','qty','disposition','reason']))},
    '/run':{post:operation('runCommerceSimulationWorker',object({}))},'/reconciliation':{get:operation('reconcileCommerceLocalLedger')},
  };
  for(const [path,methods] of Object.entries(routes))doc.paths[base+path]=methods;
  doc.components.securitySchemes.operationsSession={type:'apiKey',in:'cookie',name:'avf_session',description:'Identified Avafem operations session only. Brand sessions and bearer credentials are refused.'};
  return doc;
}
