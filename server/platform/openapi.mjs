/** OpenAPI additions for platform modules. /v1 paths use brand bearer scopes;
 * /api paths are operator (admin session + CSRF) or brand-session routes. */
export const PLATFORM_PATHS = [];
export function addPaths(list) { PLATFORM_PATHS.push(...list); }
addPaths([
  ['get', '/v1/reviews', 'listBrandReviews', 'orders:read'],
  ['get', '/v1/tickets', 'listBrandTickets', 'orders:read'],
  ['post', '/v1/tickets/{id}/replies', 'replyBrandTicket', 'orders:read', { type: 'object', required: ['body'], properties: { body: { type: 'string', maxLength: 4000 } } }],
  ['get', '/api/crm/shoppers', 'adminListShoppers', 'admin'],
  ['post', '/api/crm/shoppers', 'adminUpsertShopper', 'admin', { type: 'object', required: ['email'], properties: { email: { type: 'string' }, firstName: { type: 'string' }, phone: { type: 'string' }, consent: { type: 'object' } } }],
  ['get', '/api/crm/shoppers/{id}', 'adminShopperProfile', 'admin'],
  ['patch', '/api/crm/shoppers/{id}/consent', 'adminSetConsent', 'admin', { type: 'object' }],
  ['put', '/api/crm/shoppers/{id}/intake', 'adminWriteIntake', 'admin', { type: 'object' }],
  ['post', '/api/crm/shoppers/{id}/orders', 'adminLinkOrder', 'admin', { type: 'object', required: ['orderId'] }],
  ['post', '/api/crm/shoppers/{id}/swipes', 'adminRecordSwipe', 'admin', { type: 'object', required: ['productId', 'liked'] }],
  ['post', '/api/crm/shoppers/{id}/reviews', 'adminCreateReview', 'admin', { type: 'object', required: ['bagId', 'productId', 'rating'] }],
  ['get', '/api/crm/segments', 'adminListSegments', 'admin'],
  ['post', '/api/crm/segments', 'adminCreateSegment', 'admin', { type: 'object', required: ['rules'] }],
  ['get', '/api/crm/segments/{id}/members', 'adminSegmentMembers', 'admin'],
  ['get', '/api/crm/campaigns', 'adminListCampaigns', 'admin'],
  ['post', '/api/crm/campaigns', 'adminCreateCampaign', 'admin', { type: 'object', required: ['kind', 'channel'] }],
  ['post', '/api/crm/campaigns/{id}/run', 'adminRunCampaign', 'admin'],
  ['get', '/api/crm/outbox', 'adminSimulatedOutbox', 'admin'],
  ['post', '/api/crm/tickets', 'adminOpenTicket', 'admin', { type: 'object', required: ['subject'] }],
  ['get', '/api/crm/tickets', 'listTickets', 'orders:read'],
  ['get', '/api/crm/tickets/{id}', 'getTicket', 'orders:read'],
  ['post', '/api/crm/tickets/{id}/replies', 'replyTicket', 'orders:read', { type: 'object' }],
  ['post', '/api/crm/tickets/{id}/actions', 'adminTicketAction', 'admin', { type: 'object', required: ['action'], properties: { action: { enum: ['refund', 'credit'] }, amountCents: { type: 'integer' } } }],
  ['get', '/api/crm/brand/reviews', 'brandSessionReviews', 'orders:read'],
  ['post', '/api/crm/jobs/run', 'adminRunPlatformJobs', 'admin'],
]);
export function mergePlatformPaths(doc, operation) {
  for (const [method, path, operationId, scope, body] of PLATFORM_PATHS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op = operation(operationId, scope === 'admin' ? 'admin' : scope, body || null, params);
    if (scope === 'admin' || path.startsWith('/api/')) { op.security = [{ sessionCookie: [] }]; op.tags = [scope === 'admin' ? 'operator' : 'brand-session']; }
    doc.paths[path] = { ...(doc.paths[path] || {}), [method]: op };
  }
  doc.components.securitySchemes = { ...(doc.components.securitySchemes || {}), sessionCookie: { type: 'apiKey', in: 'cookie', name: 'avf_session', description: 'Browser session; mutations also need x-csrf-token.' } };
  return doc;
}
