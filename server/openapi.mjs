import { mergePlatformPaths } from './platform/openapi.mjs';
export function openApiDocument(baseUrl) {
  const json = schema => ({ content: { 'application/json': { schema } } });
  const response = { '200': { description: 'Successful operation', ...json({ type: 'object', properties: { data: {} } }) },
    '401': { description: 'Authentication required' }, '403': { description: 'Insufficient scope or another brand’s resource' },
    '422': { description: 'Validation error or idempotency body conflict' }, '429': { description: '10 requests per second, burst 30; Retry-After supplied' } };
  const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } };
  const path = name => ({ name, in: 'path', required: true, schema: { type: 'string' } });
  const operation = (operationId, scope, schema, parameters = []) => ({ operationId, security: [{ oauth2: [scope] }, { apiKey: [] }], parameters,
    ...(schema ? { requestBody: { required: true, ...json(schema) } } : {}), responses: response });
  return mergePlatformPaths({
    openapi: '3.1.0', info: { title: 'Avafem Brand Connect API', version: '0.1.0', description: 'Sandbox implementation. Brand credentials cannot access another brand’s Bags. All POST mutations require 24-hour idempotency keys. Money is represented in integer USD cents. Refunds create human-reviewed proposals.' },
    servers: [{ url: baseUrl }],
    paths: {
      '/v1/brands/connect-session': { post: operation('getBrandConnectSession','orders:read',{ type:'object' },[key]) },
      '/v1/products': { get: operation('listProducts','catalog:read') },
      '/v1/products/{sku}': { put: operation('upsertProduct','catalog:write',{ $ref:'#/components/schemas/Product' },[path('sku')]) },
      '/v1/products/import': { post: operation('importProducts','catalog:write',{ type:'object', properties:{ rows:{ type:'array', maxItems:5000, items:{$ref:'#/components/schemas/Product'} }, csv:{type:'string'} } },[key]) },
      '/v1/products/import/{id}': { get: operation('getImport','catalog:read',null,[path('id')]) },
      '/v1/inventory/{sku}': { patch: operation('updateInventory','catalog:write',{type:'object',required:['qty'],properties:{qty:{type:'integer',minimum:0}}},[path('sku')]) },
      '/v1/bags': { get: operation('listBags','orders:read',null,[{name:'status',in:'query',schema:{type:'string'}}]) },
      '/v1/bags/{id}': { get: operation('getBag','orders:read',null,[path('id')]) },
      '/v1/bags/{id}/shipments': { post: operation('markShipped','orders:fulfill',{$ref:'#/components/schemas/Shipment'},[path('id'),key]) },
      '/v1/bags/{id}/refunds': { post: operation('requestRefund','refunds:write',{type:'object',required:['reason'],properties:{reason:{type:'string',minLength:3},amountCents:{type:'integer',minimum:1}}},[path('id'),key]) },
      '/v1/payouts': { get: operation('listPayouts','payouts:read') },
      '/v1/payouts/summary': { get: operation('getPayoutSummary','payouts:read') },
      '/v1/webhook-endpoints': { post: operation('createWebhookEndpoint','orders:read',{type:'object',required:['url'],properties:{url:{type:'string',format:'uri'}}},[key]),get:operation('listWebhookEndpoints','orders:read') },
      '/v1/webhook-endpoints/{id}/replay': { post: operation('replayWebhookEvent','orders:read',{type:'object',required:['eventId'],properties:{eventId:{type:'string'}}},[path('id'),key]) },
      '/v1/sandbox/orders': { post: operation('createSandboxOrder','orders:read',{type:'object',description:'Creates a synthetic order for the authenticated brand only.'},[key]) },
    },
    components: {
      securitySchemes: {
        apiKey: { type:'http', scheme:'bearer', description:'High-entropy avf_test_ API key; stored hashed and shown once.' },
        oauth2: { type:'oauth2', flows: { clientCredentials: {
          tokenUrl:`${baseUrl}/oauth/token`,
          scopes:{'catalog:read':'Read own catalog','catalog:write':'Write own catalog','orders:read':'Read own Bags','orders:fulfill':'Record own tracking','payouts:read':'Read own simulated transfers','refunds:write':'Propose own refunds'},
        } } },
      },
      schemas: {
        Product: {
          type:'object', required:['title','priceCents'],
          properties:{sku:{type:'string'},title:{type:'string'},description:{type:'string'},category:{type:'string'},priceCents:{type:'integer',minimum:0},inventoryQty:{type:'integer',minimum:0},images:{type:'array',items:{type:'string',format:'uri'}},evidence:{type:'object'},taxCode:{type:'string'},shippingProfile:{type:'string'}},
        },
        Shipment: {
          type:'object', required:['carrier','trackingNumber'],
          properties: {
            carrier:{type:'string'}, trackingNumber:{type:'string'}, trackingUrl:{type:['string','null'],format:'uri'},
            items:{type:'array',items:{type:'object',required:['sku','qty'],properties:{sku:{type:'string'},qty:{type:'integer',minimum:1}}}},
          },
        },
      },
    },
  }, operation);
}
