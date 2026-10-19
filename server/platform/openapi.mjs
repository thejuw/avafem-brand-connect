/** OpenAPI additions for platform modules. /v1 paths use brand bearer scopes;
 * /api paths are operator (admin session + CSRF) or brand-session routes. */
export const PLATFORM_PATHS = [];
export function addPaths(list) { PLATFORM_PATHS.push(...list); }
const recoveryProperties={operationId:{type:'string',pattern:'^[A-Za-z0-9_-]{8,100}$'},reason:{type:'string',minLength:10,maxLength:1000,description:'Operator reason. Do not include credentials, shopper details or health information.'}};
const recoveryBody=(properties={},required=[])=>({type:'object',required:['operationId','reason',...required],properties:{...recoveryProperties,...properties}});
const strictBody=(properties={},required=[])=>({type:'object',additionalProperties:false,properties,...(required.length?{required}:{})});
const emptyBody=strictBody();
const string=(maxLength,extra={})=>({type:'string',maxLength,...extra});
const operationId=string(100,{pattern:'^[A-Za-z0-9_-]{8,100}$'});
const operatorReason=string(1000,{minLength:10,description:'Trimmed operator reason; exclude credentials, shopper details and health information.'});
const curationFilters={brandId:string(100),status:{type:'string',enum:['draft','in_review','approved','rejected']},collection:string(200),productType:string(200),tag:string(200),sinceReview:{type:'string',enum:['new','changed','new_or_changed']}};
const inviteBody=strictBody({operationId,email:string(254,{format:'email',description:'Optional operator-selected recipient; otherwise use the brand contact. External delivery requires separate server configuration.'})},['operationId']);
const invitePreview=strictBody({brand:strictBody({id:{type:'string'},name:{type:'string'}},['id','name']),expiresAt:{type:'string',format:'date-time'},sandbox:{const:true}},['brand','expiresAt','sandbox']);
const brandSession=strictBody({brandId:{type:'string'},csrfToken:{type:'string',description:'Anti-CSRF token for this browser session, not an API bearer credential.'},role:{const:'brand'},sandbox:{const:true}},['brandId','csrfToken','role','sandbox']);
const deliveryReceipt={type:'object',properties:{status:{type:'string',enum:['not_configured','pending','accepted','uncertain']},providerAccepted:{type:'boolean',description:'A provider API receipt, not proof of inbox delivery.'},delivered:{const:false},simulated:{type:'boolean'},requiresReview:{type:'boolean'},replayed:{type:'boolean'},id:{type:'string'},providerId:{type:['string','null']},recipientHint:{type:'string'}},required:['status','providerAccepted','delivered','simulated']};
const invitationResult=strictBody({id:{type:'string'},token:string(100,{description:'Signed, expiring single-use bearer invitation. Do not log, publish or include in audit notes.'}),brandId:{type:'string'},expiresAt:{type:'string',format:'date-time'},path:{type:'string',description:'Local onboarding path containing the same secret invitation.'},delivery:deliveryReceipt},['id','token','brandId','expiresAt','path','delivery']);
const onboardingNote='Browser session only; API/OAuth bearer credentials are forbidden. Brand sessions are restricted to their own brand; owner operations may select a brand. Mutations require x-csrf-token. A connected/active brand does not approve its products or verify payouts. Public detection/profile metadata is advisory or untrusted; unconfigured provider actions do not fake success.';
const inviteNote='Owner operations workspace only; brand sessions and API/OAuth bearer credentials are forbidden. Mutations require x-csrf-token. Body operationId provides 24-hour HTTP idempotency for create/resend; do not substitute an Idempotency-Key header. Signed links expire and are single-use. Email needs an explicitly configured server driver and public HTTPS origin. Provider acceptance is not inbox delivery; simulated adapters are labeled. Unknown outcomes remain reserved and are never automatically resent.';
const curationNote='Owner operations workspace only; brand sessions and API/OAuth bearer credentials are forbidden. Mutations require x-csrf-token. Product approval is separate from store connection and brand activation. Bulk decisions are atomic and fingerprint-bound. Flagged listings require explicit per-product review/override; no provider or payout is verified by curation.';

// Extra tuple metadata is merged below; request schemas mirror routes.mjs,
// including strict object bodies and optional empty mutation bodies.
addPaths([
  ['get','/api/onboarding/invites/{token}','previewOnboardingInvite','public',null,{description:'Public minimal invitation preview: brand ID/name, expiry and sandbox only. No cookie/session is created, token is not consumed, and no contact, credentials or payout status is exposed. Accept using POST /api/invites/{token}/accept.',responseSchema:invitePreview}],
  ['get','/api/invites/{token}','previewBrandInvite','public',null,{description:'Public compatibility preview; same minimal fields and no session/consumption as the onboarding preview.',responseSchema:invitePreview}],
  ['post','/api/invites/{token}/accept','acceptBrandInvite','public',{type:'object',required:['acceptedSandboxTerms'],properties:{acceptedSandboxTerms:{const:true}}},{description:'Validate and consume one active signed or legacy invitation, record sandbox terms, and create a non-owner brand-only HttpOnly browser session. No provider authorization, product approval, email delivery or payout completion is implied. Does not require an existing session or CSRF token.',responseSchema:brandSession}],
  ['get','/api/onboarding/session','resumeBrandOnboardingSession','brand-session',null,{description:'Requires an existing brand browser session; owner-only workspace and bearer credentials are rejected. Returns only this brand ID, anti-CSRF token, role and sandbox marker.',responseSchema:brandSession,tenant:'authenticated-brand-session'}],
  ['get','/api/onboarding/{brandId}','getTwoStepOnboarding','catalog:write',null,{description:onboardingNote}],
  ['post','/api/onboarding/{brandId}/detect','detectOnboardingStore','catalog:write',strictBody({storeUrl:string(2048,{minLength:1,format:'uri',description:'Public HTTPS origin only, without credentials, port, path, query or fragment. Default local-only detection makes no network requests; explicitly enabled probes use fixed bounded same-origin public JSON endpoints only.'})},['storeUrl']),{description:`${onboardingNote} Platform hints are always advisory/unverified; ambiguous or unavailable detection offers CSV/feed fallback. Detection never installs an app or grants permissions.`,responseSchema:{type:'object',required:['storeUrl','platform','advisory','verified','probeStatus','evidence','fallback','capability'],properties:{storeUrl:{type:'string',format:'uri'},platform:{type:'string',enum:['shopify','woocommerce','bigcommerce','unknown']},advisory:{const:true},verified:{const:false},probeStatus:{type:'string',enum:['not_needed_hostname_hint','disabled_local_only','complete','ambiguous','blocked_destination','blocked_redirect','timed_out']},evidence:{type:'array',maxItems:3,items:{type:'object',properties:{platform:{type:'string'},kind:{enum:['hostname_hint','public_json']},probe:{type:'string'}}}},fallback:{type:'array',items:{enum:['csv','feed']}},capability:strictBody({configured:{const:false},status:{const:'needs_provider_configuration'}},['configured','status'])}}}],
  ['post','/api/onboarding/{brandId}/connect','connectOnboardingStore','catalog:write',strictBody({platform:{type:'string',enum:['shopify','woocommerce','bigcommerce','csv']},credentials:{type:'object',additionalProperties:string(2000),description:'Platform-specific credentials, sent only to a configured verified server adapter. Never log or persist plaintext credentials; Shopify uses its own approved OAuth install flow.'}},['platform']),{description:`${onboardingNote} Import defaults to unapproved listings. Shopify without a configured driver returns authorizationRequired:true, configured:false and the authorization route; this is not a successful connection.`}],
  ['post','/api/onboarding/{brandId}/catalog','importOnboardingCsv','catalog:write',strictBody({csv:string(3_000_000,{minLength:1,description:'CSV fallback catalog. Rejected rows block completion; valid products remain subject to independent curation.'})},['csv']),{description:onboardingNote}],
  ...['sync','refresh'].map(action=>['post',`/api/onboarding/{brandId}/${action}`,action==='sync'?'syncOnboardingCatalog':'refreshApprovedOnboardingStore','catalog:write',emptyBody,{optionalBody:true,description:`${onboardingNote} ${action==='refresh'?'Refresh the exact already-approved store/profile after OAuth; does not create a new authorization.':'Re-import the selected store catalog; incomplete or changed-connection evidence blocks completion.'}`}]),
  ['patch','/api/onboarding/{brandId}/profile','editOnboardingDisplayProfile','catalog:write',strictBody({name:string(160),supportEmail:string(254),logoUrl:string(2048),returnPolicy:string(12_000,{description:'Plain display-policy text only. Does not change the canonical return window, holds, shipping, commission or legal terms.'})}),{description:`${onboardingNote} Only display fields may be edited; imported policy and logo suggestions remain untrusted until reviewed.`}],
  ...['skip','start'].map(action=>['post',`/api/onboarding/{brandId}/payouts/${action}`,action==='skip'?'deferOnboardingPayouts':'startConfiguredPayoutOnboarding','catalog:write',emptyBody,{optionalBody:true,description:`${onboardingNote} ${action==='skip'?'Store onboarding can finish while payables remain held until payout onboarding is verified.':'Requires a configured test-mode payout adapter. Returns a provider-hosted HTTPS onboarding link, mode:test and providerVerified:false; a link/browser return never completes KYC or enables payouts. No card/bank details are accepted here.'}`}]),
  ['post','/api/onboarding/{brandId}/shopify/authorize','authorizeExactOnboardingShopifyStore','catalog:write',emptyBody,{optionalBody:true,description:`${onboardingNote} Requires detection of the exact .myshopify.com store plus a configured public HTTPS callback. Creates a state-bound OAuth install URL and secure callback cookie; merchant approval and verified callback are still required.`}],
  ['get','/api/admin/curation','adminCurationQueue','admin',null,{description:`${curationNote} Optional ids selects at most 500 comma-separated product IDs; otherwise narrow by the documented filters. Default queue contains draft/in_review products. Unknown query fields are rejected.`,query:{...curationFilters,ids:string(10_000,{description:'Comma-separated product IDs; at most 500 nonempty IDs. Does not change or approve any product.'})},strictQuery:true}],
  ['post','/api/admin/curation/bulk','adminBulkCurateProducts','admin',{...strictBody({operationId,reason:operatorReason,action:{type:'string',enum:['approved','rejected']},products:{type:'array',minItems:1,maxItems:500,items:strictBody({id:string(100,{minLength:1}),fingerprint:{type:'string',pattern:'^[a-f0-9]{64}$'},overrideReason:operatorReason},['id','fingerprint'])},filter:strictBody(curationFilters)},['operationId','reason','action']),anyOf:[{required:['products']},{required:['filter'],properties:{filter:{minProperties:1}}}]},{description:`${curationNote} Select unique product IDs/current fingerprints or a nonempty filter (maximum 500 matches). Same body operationId replays; changed body conflicts. A stale fingerprint or invalid row rolls back the entire selection.`,bodyIdempotency:true}],
  ['put','/api/admin/curation/brands/{brandId}/auto-approve','adminSetInitialCatalogAutoApproval','admin',strictBody({enabled:{type:'boolean'},reason:operatorReason},['enabled','reason']),{description:`${curationNote} Admin-only, audited opt-in for a clean initial catalog cohort; disabled by default. Does not approve flagged products, existing drafts, later imports or changed listings.`}],
  ['get','/api/admin/onboarding/{brandId}/invites','adminListBrandInvitations','admin',null,{description:`${inviteNote} Lists redacted invite IDs/statuses and safe delivery receipts/capabilities; never returns tokens, token hashes, recipient addresses or email bodies.`}],
  ['post','/api/admin/onboarding/{brandId}/invites','adminCreateAndOptionallyEmailInvite','admin',inviteBody,{description:`${inviteNote} Returns the owner-only signed local link even when delivery is not_configured; no email is claimed in that state.`,bodyIdempotency:true,responseSchema:invitationResult}],
  ['post','/api/admin/onboarding/{brandId}/invites/{inviteId}/resend','adminReplaceAndOptionallyEmailInvite','admin',inviteBody,{description:`${inviteNote} Atomically revokes the selected old link and creates one replacement. Same operationId replays the encrypted response; a different concurrent replacement cannot mint another link. Accepted or already-revoked invitations cannot be replaced.`,bodyIdempotency:true,responseSchema:invitationResult}],
  ['post','/api/admin/onboarding/{brandId}/invites/{inviteId}/revoke','adminRevokeBrandInvitation','admin',emptyBody,{optionalBody:true,description:`${inviteNote} Revocation blocks future invitation preview/acceptance. It does not revoke an already-established brand session; accepted invites require the separate session/credential lifecycle.`}],
]);
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
  for (const [method, path, operationId, scope, body, extra={}] of PLATFORM_PATHS) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op = operation(operationId, scope === 'admin' ? 'admin' : scope, body || null, params);
    if (scope === 'public') { op.security = []; op.tags = ['public']; }
    else if (scope === 'admin' || path.startsWith('/api/')) {
      op.security = [{ sessionCookie: [] }]; op.tags = [scope === 'admin' ? 'operator' : 'brand-session'];
      op['x-browser-session-required']=true;op['x-bearer-allowed']=false;op['x-owner-required']=scope==='admin';
      op['x-csrf-required']=!['get','head','options'].includes(method);
      if(op['x-csrf-required'])op.parameters.push({name:'x-csrf-token',in:'header',required:true,schema:{type:'string',minLength:1},description:'The anti-CSRF token issued with this browser session. Not an API bearer credential.'});
    }
    if(extra.description)op.description=extra.description;
    if(extra.tenant || (path.startsWith('/api/onboarding/') && scope!=='public'))op['x-tenant-scope']=extra.tenant || 'authenticated-brand-or-owner-workspace';
    if(extra.optionalBody && op.requestBody)op.requestBody.required=false;
    if(extra.bodyIdempotency)op['x-idempotency-body-field']='operationId';
    if(extra.query)op.parameters.push(...Object.entries(extra.query).map(([name,schema])=>({name,in:'query',required:false,schema})));
    if(extra.strictQuery)op['x-strict-query']=true;
    if(extra.responseSchema)op.responses={...op.responses,'200':{description:'Successful operation; sandbox/test boundaries remain in force.',content:{'application/json':{schema:strictBody({data:extra.responseSchema},['data'])}}}};
    if(scope==='public' && path.includes('/invites/'))op.responses={...op.responses,'401':{description:'Invitation is invalid, expired, revoked or already consumed. No session is created.'}};
    if(scope!=='public' && (path.startsWith('/api/onboarding/') || path.startsWith('/api/admin/onboarding/') || path.startsWith('/api/admin/curation')))op.responses={...op.responses,
      '409':{description:'Connection, invite, curation fingerprint, lifecycle or operation conflict; review authoritative state rather than blindly retry.'},
      '503':{description:'Required provider/OAuth/email/payout configuration is unavailable. No successful connection, delivery or payout verification is implied.'}};
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
  doc.info.description=doc.info.description.replace('All POST mutations require 24-hour idempotency keys.','Use each route’s documented idempotency mechanism: scoped API mutations use Idempotency-Key where specified; browser invite create/resend and bulk curation use body operationId. Browser mutations require session CSRF protection.');
  return doc;
}
