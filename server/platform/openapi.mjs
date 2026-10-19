/** OpenAPI additions for platform modules. /v1 paths use brand bearer scopes;
 * /api paths are operator (admin session + CSRF) or brand-session routes. */
export const PLATFORM_PATHS = [];
export function addPaths(list) { PLATFORM_PATHS.push(...list); }
const recoveryProperties={operationId:{type:'string',pattern:'^[A-Za-z0-9_-]{8,100}$'},reason:{type:'string',minLength:10,maxLength:1000,description:'Operator reason. Do not include credentials, shopper details or health information.'}};
const recoveryBody=(properties={},required=[])=>({type:'object',required:['operationId','reason',...required],properties:{...recoveryProperties,...properties}});
addPaths([
  ['get','/api/admin/recovery','adminRecoveryQueues','admin'],
  ['get','/api/admin/recovery/connectors','adminConnectorRecoveryCases','admin'],
  ['post','/api/admin/recovery/connectors/{bagId}/resolve','adminResolveConnectorOrder','admin',recoveryBody({action:{enum:['confirm','void']},externalId:{type:'string',pattern:'^[1-9][0-9]{0,29}$'}},['action','externalId'])],
  ['post','/api/admin/recovery/connectors/{bagId}/retry','adminUseVerifiedConnectorRetry','admin',recoveryBody()],
  ['get','/api/admin/recovery/subscriptions','adminSubscriptionReviews','admin'],
  ['post','/api/admin/recovery/subscriptions/{id}/reconcile','adminReconcileSimulatedRenewal','admin',recoveryBody({attemptId:{type:'string',minLength:1,maxLength:100},resolution:{enum:['paid','declined','voided']},proof:{type:'object',description:'Exact server-issued mock proof requirements; never proof of a real provider payment.'}},['attemptId','resolution'])],
  ['post','/api/admin/recovery/subscriptions/{id}/continue','adminContinueSavedRenewalReview','admin',{type:'object',required:['operationId'],properties:{operationId:recoveryProperties.operationId},description:'Continue the saved operation with its original encrypted evidence and actor. Does not call the charger.'}],
  ...['resume','cancel'].map(action=>['post',`/api/admin/recovery/subscriptions/{id}/${action}`,`admin${action==='resume'?'Resume':'Cancel'}ReviewedRenewal`,'admin',recoveryBody()]),
  ['get','/api/admin/recovery/credits','adminPendingCreditReviews','admin'],
  ['get','/api/admin/recovery/history','adminFinancialRecoveryHistory','admin'],
  ['post','/api/admin/recovery/disputes/{id}/resolve','adminResolveLostDisputeHold','admin',recoveryBody({resolution:{enum:['operator_verified_recovery','writeoff']},recoveryReference:{type:'string',maxLength:120}},['resolution'])],
  ['post','/api/admin/recovery/holds/{id}/release','adminReleaseReviewedPayoutHold','admin',recoveryBody()],
  ['post','/api/admin/recovery/credits/{id}/resolve','adminResolvePendingCredit','admin',recoveryBody({action:{enum:['release','writeoff']}},['action'])],
  ['get','/api/admin/recovery/health-outbox','adminHealthOutboxMigrationStatus','admin'],
  ['post','/api/admin/recovery/health-outbox/migrate','adminMigrateHealthOutboxBatch','admin',{type:'object',properties:{batchSize:{type:'integer',minimum:1,maximum:500}},description:'Protect one bounded batch with the original encryption key. Stop legacy workers first.'}],
]);
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
addPaths([
  ['get', '/api/bank/shoppers/{id}', 'adminBankAccount', 'admin'],
  ['post', '/api/bank/shoppers/{id}/earn', 'adminBankEarn', 'admin', { type: 'object', required: ['orderId'] }],
  ['post', '/api/bank/shoppers/{id}/goodwill', 'adminBankGoodwill', 'admin', { type: 'object', required: ['amountCents'] }],
  ['post', '/api/bank/shoppers/{id}/redeem', 'adminBankRedeem', 'admin', { type: 'object', required: ['amountCents'] }],
  ['get', '/api/bank/liability', 'adminBankLiability', 'admin'],
  ['post', '/api/bank/run', 'adminBankRun', 'admin'],
  ['get', '/api/admin/console', 'adminConsole', 'admin'],
  ['get', '/api/admin/disputes', 'listDisputes', 'payouts:read'],
  ['post', '/api/admin/disputes', 'adminOpenDispute', 'admin', { type: 'object', required: ['externalId', 'bagId'] }],
  ['post', '/api/admin/disputes/{id}/evidence', 'adminDisputeEvidence', 'admin', { type: 'object' }],
  ['post', '/api/admin/disputes/{id}/resolve', 'adminResolveDispute', 'admin', { type: 'object', required: ['outcome'] }],
  ['get', '/api/admin/holds', 'adminHolds', 'admin'],
  ['post', '/api/admin/holds/{id}/release', 'adminReleaseHold', 'admin', {type:'object',required:['reason','idempotencyKey'],properties:{reason:recoveryProperties.reason,idempotencyKey:recoveryProperties.operationId}}],
  ['get', '/api/admin/stuck-transfers', 'adminStuckTransfers', 'admin'],
  ['post', '/api/admin/stuck-transfers/{id}/retry', 'adminRetryStuck', 'admin'],
  ['get', '/api/admin/alerts', 'adminAlerts', 'admin'],
  ['post', '/api/admin/alerts/scan', 'adminScanAlerts', 'admin'],
  ['post', '/api/admin/alerts/{id}/ack', 'adminAckAlert', 'admin'],
  ['post', '/api/admin/payout-checks', 'adminPayoutChecks', 'admin', { type: 'object', properties: { enforce: { type: 'boolean' } } }],
  ['post', '/api/risk/checkout', 'adminScoreCheckout', 'admin', { type: 'object' }],
  ['get', '/api/risk/assessments', 'adminRiskAssessments', 'admin'],
  ['get', '/api/brands/{id}/payout-check', 'brandPayoutCheck', 'payouts:read'],
  ['get', '/api/reports/sales-tax', 'adminSalesTaxReport', 'admin'],
  ['get', '/api/reports/brand-payouts', 'brandAnnualPayouts', 'payouts:read'],
  ['get', '/v1/disputes', 'listBrandDisputes', 'payouts:read'],
  ['get', '/v1/reports/payouts', 'brandAnnualPayoutReport', 'payouts:read'],
]);
addPaths([
  ['post', '/api/portal/signup', 'portalSignup', 'public', { type: 'object', required: ['brandName', 'email'] }],
  ['get', '/api/portal/review-queue', 'adminCatalogReviewQueue', 'admin'],
  ['get', '/api/portal/{brandId}/status', 'portalStatus', 'catalog:read'],
  ['patch', '/api/portal/{brandId}/profile', 'portalProfile', 'catalog:write', { type: 'object' }],
  ['post', '/api/portal/{brandId}/stripe/link', 'portalStripeLink', 'payouts:read'],
  ['post', '/api/portal/{brandId}/stripe/return', 'portalStripeReturn', 'payouts:read'],
  ['post', '/api/portal/{brandId}/connect', 'portalConnect', 'catalog:write', { type: 'object', required: ['platform'] }],
  ['get', '/api/portal/{brandId}/connectors', 'portalConnectors', 'catalog:read'],
  ['post', '/api/portal/{brandId}/connectors/{platform}/sync', 'portalConnectorSync', 'catalog:write'],
  ['delete', '/api/portal/{brandId}/connectors/{platform}', 'portalConnectorDisconnect', 'catalog:write'],
  ['post', '/api/portal/{brandId}/catalog/csv', 'portalCsvImport', 'catalog:write', { type: 'object', required: ['csv'] }],
  ['post', '/api/portal/{brandId}/activate', 'adminActivateBrand', 'admin'],
  ['post', '/api/connectors/orders/{bagId}/push', 'adminPushConnectorOrder', 'admin'],
  ['get', '/api/brands/{id}/analytics', 'brandAnalytics', 'orders:read'],
  ['get', '/v1/analytics', 'brandAnalyticsApi', 'orders:read'],
  ['post', '/api/placements', 'requestPlacement', 'catalog:write', { type: 'object', required: ['kind', 'productId'] }],
  ['get', '/api/placements', 'listPlacements', 'catalog:read'],
  ['post', '/api/placements/{id}/decision', 'adminDecidePlacement', 'admin', { type: 'object', required: ['decision'] }],
  ['post', '/api/placements/{id}/cancel', 'cancelPlacement', 'catalog:write'],
  ['get', '/api/billing', 'listBilling', 'payouts:read'],
  ['post', '/api/billing/{id}/paid', 'adminMarkBillingPaid', 'admin'],
  ['get', '/api/placements/feed/{kind}', 'adminPlacementFeed', 'admin'],
  ['post', '/api/placements/{id}/click', 'adminPlacementClick', 'admin'],
  ['get', '/v1/placements', 'listPlacementsApi', 'catalog:read'],
  ['post', '/v1/placements', 'requestPlacementApi', 'catalog:write', { type: 'object', required: ['kind', 'productId'] }],
  ['get', '/v1/billing', 'listBillingApi', 'payouts:read'],
  ['post', '/v1/catalog/csv', 'importCatalogCsvApi', 'catalog:write', { type: 'object', required: ['csv'] }],
]);
addPaths([
  ['get', '/api/subscriptions', 'adminListSubscriptions', 'admin'],
  ['post', '/api/crm/shoppers/{id}/subscriptions', 'adminCreateSubscription', 'admin', { type: 'object', required: ['items', 'shipTo'] }],
  ['post', '/api/subscriptions/{id}/status', 'adminSubscriptionStatus', 'admin', { type: 'object', required: ['status'] }],
  ['get', '/api/subscriptions/{id}/runs', 'adminSubscriptionRuns', 'admin'],
  ['post', '/api/subscriptions/run', 'adminRunSubscriptions', 'admin'],
  ['get', '/api/shipping/rules', 'adminShippingRule', 'admin'],
  ['put', '/api/shipping/rules', 'adminSetShippingRule', 'admin', { type: 'object', required: ['freeThresholdCents'] }],
  ['post', '/api/shipping/quote', 'adminShippingQuote', 'admin', { type: 'object', required: ['items'] }],
  ['post', '/api/shipping/orders/{orderId}/apply', 'adminApplyShippingSubsidy', 'admin'],
  ['get', '/api/shipping/subsidies', 'adminShippingSubsidies', 'admin'],
  ['get', '/api/privacy/shoppers/{id}/health-access-log', 'adminHealthAccessLog', 'admin'],
  ['post', '/api/privacy/shoppers/{id}/export', 'adminDsarExport', 'admin'],
  ['post', '/api/privacy/shoppers/{id}/delete', 'adminDsarDelete', 'admin', { type: 'object', required: ['confirm'], properties: { confirm: { const: 'DELETE' } } }],
  ['get', '/api/privacy/requests', 'adminPrivacyRequests', 'admin'],
  ['post', '/api/compliance/check', 'complianceCheck', 'catalog:read', { type: 'object' }],
  ['get', '/api/products/{id}/compliance', 'productCompliance', 'catalog:read'],
  ['post', '/api/products/{id}/compliance/override', 'adminComplianceOverride', 'admin', { type: 'object', required: ['reason'] }],
  ['get', '/api/compliance/brands/{id}', 'brandComplianceReport', 'catalog:read'],
  ['get', '/v1/compliance', 'brandComplianceApi', 'catalog:read'],
]);
export function mergePlatformPaths(doc, operation) {
  for (const [method, path, operationId, scope, body] of PLATFORM_PATHS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op = operation(operationId, scope === 'admin' ? 'admin' : scope, body || null, params);
    if (scope === 'public') { op.security = []; op.tags = ['public']; }
    else if (scope === 'admin' || path.startsWith('/api/')) { op.security = [{ sessionCookie: [] }]; op.tags = [scope === 'admin' ? 'operator' : 'brand-session']; }
    if(path.startsWith('/api/admin/recovery')) {
      op.description='Owner operations workspace only; brand credentials are forbidden. Mutations require x-csrf-token. Decisions retain immutable evidence and gates; no Stripe charge or bank payout is created. Only a separately verified connector retry may create one remote order.';
      op.responses={...op.responses,'409':{description:'Recovery blocked: incomplete evidence, active worker, eligibility gate or conflicting decision. Do not reset or blindly retry.'},'503':{description:'Original health-message encryption key is unavailable. Preserve the data and restore the correct key; never replace it with a new key.'}};
    }
    if(path==='/api/crm/outbox') op.parameters.push(
      {name:'shopperId',in:'query',schema:{type:'string'}},
      {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:500,default:100}},
      {name:'offset',in:'query',schema:{type:'integer',minimum:0,maximum:100000,default:0}},
    );
    doc.paths[path] = { ...(doc.paths[path] || {}), [method]: op };
  }
  doc.components.securitySchemes = { ...(doc.components.securitySchemes || {}), sessionCookie: { type: 'apiKey', in: 'cookie', name: 'avf_session', description: 'Browser session; mutations also need x-csrf-token.' } };
  return doc;
}
