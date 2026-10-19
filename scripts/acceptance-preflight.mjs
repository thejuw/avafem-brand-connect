#!/usr/bin/env node
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_SCENARIOS = [
  {id:'A01',title:'Install, encrypted OAuth, reinstall, and uninstall',checks:['three_store_installations','offline_oauth_verified','tokens_encrypted_at_rest','reinstall_rotates_credentials','uninstall_pauses_listings','open_bags_keep_fallback','delivered_payouts_not_blocked'],providers:['shopify_installation'],artifacts:['provider_response','security_review','signed_webhook']},
  {id:'A02',title:'Three distinct catalogs and full reconciliation',checks:['catalogs_fetched_from_three_stores','distinct_catalog_fingerprints','products_variants_prices_inventory_match','catalog_create_update_delete_applied','stock_changes_applied','claims_edits_require_review','full_resync_repairs_webhook_loss'],providers:['shopify_product','shopify_webhook_delivery'],artifacts:['shopify_catalog','signed_webhook','reconciliation']},
  {id:'A03',title:'Stripe paid checkout and correct three-brand order split',checks:['actual_stripe_test_checkout_paid','signed_payment_webhook_processed','address_allow_list_matches','line_prices_quantities_match','flat_shipping_and_authoritative_tax_match','three_brand_bags_split_correctly','one_shopify_order_per_bag','no_health_or_cycle_data'],providers:['stripe_checkout_session','stripe_payment_intent','stripe_charge','stripe_event','shopify_order'],artifacts:['provider_response','signed_webhook','ledger_export']},
  {id:'A04',title:'Commission allocation and delayed brand transfers',checks:['commission_base_and_rounding_match_policy','flat_shipping_allocation_matches','transfer_group_links_charge_and_bags','source_transaction_matches_charge','no_transfer_before_return_window','actual_test_transfers_after_window','transfer_and_bank_payout_distinguished','credit_release_matches_policy'],providers:['shopify_order','stripe_charge','stripe_transfer','stripe_balance_transaction'],artifacts:['provider_response','ledger_export','reconciliation']},
  {id:'A05',title:'Partial shipments and actual shopper notices',checks:['partial_fulfillment_per_item','remaining_quantities_stay_open','tracking_syncs_to_avafem','all_item_quantities_reconcile','duplicate_tracking_no_duplicate_notice','actual_shopper_notice_delivered'],providers:['shopify_fulfillment','shopify_webhook_delivery','email_delivery'],artifacts:['provider_response','signed_webhook','delivery_receipt']},
  {id:'A06',title:'Full and partial refunds plus bidirectional cancellation',checks:['full_refund_in_both_directions','partial_refund_in_both_directions','cancellation_in_both_directions','tax_shipping_commission_partial_rounding_match','actual_transfer_reversal_verified','negative_balance_failure_handled','credit_clawback_matches_policy','no_duplicate_refund_or_fulfillment'],providers:['shopify_order','shopify_refund','stripe_refund','stripe_transfer_reversal','stripe_event'],artifacts:['provider_response','signed_webhook','ledger_export','reconciliation']},
  {id:'A07',title:'Signed events, disorder, retries, idempotency, and limits',checks:['bad_hmac_rejected','valid_raw_body_hmac_accepted','duplicate_event_has_one_effect','out_of_order_events_converge','same_idempotency_key_replays','different_body_same_key_rejected','transfer_retry_is_idempotent','rate_limit_and_backoff_verified','uncertain_order_push_never_falls_back_twice'],providers:['shopify_webhook_delivery','stripe_event','stripe_transfer'],artifacts:['signed_webhook','application_log','provider_response']},
  {id:'A08',title:'Nightly reconciliation to the cent',checks:['actual_nightly_worker_completed','three_store_orders_catalog_and_tracking_reconciled','stripe_charges_fees_refunds_transfers_matched','every_journal_balances','external_net_difference_is_zero_cents','lost_events_recovered_without_duplicate_money'],providers:['shopify_order','stripe_balance_transaction'],artifacts:['provider_response','ledger_export','reconciliation','application_log']},
  {id:'A09',title:'Tenant boundaries, PII protection, and encrypted storage',checks:['cross_brand_browser_access_denied','cross_brand_api_and_mcp_access_denied','handoff_is_single_bag_expiring_and_single_use','handoff_never_bootstraps_operations_session','minimal_pii_allow_list_only','pii_and_credentials_encrypted_at_rest','backup_access_and_log_redaction_verified','no_health_data_in_brand_or_agent_payloads'],providers:['shopify_order','stripe_charge'],artifacts:['security_review','application_log','provider_response']},
  {id:'A10',title:'Checkout, fulfillment, and store-limit edge cases',checks:['out_of_stock_blocks_checkout','invalid_address_blocks_or_requires_correction','unsupported_currency_rejected','missing_or_invalid_tax_blocks_listing_or_push','paused_or_disconnected_brand_blocks_new_orders','open_bags_remain_fulfillable','applicable_store_order_limits_respected','no_invented_untracked_inventory'],providers:['shopify_order','shopify_webhook_delivery'],artifacts:['provider_response','application_log','reconciliation']},
];
export const EXPECTED_STORE_DOMAINS = ['i4vd1u-s8.myshopify.com','qpsd02-jz.myshopify.com','ir7112-v1.myshopify.com'];
export const EXPECTED_STORE_COUNT = EXPECTED_STORE_DOMAINS.length;

const SOURCES = ['shopify','stripe','avafem','email_provider'];
const ARTIFACT_KINDS = ['provider_response','signed_webhook','application_log','ledger_export','reconciliation','ui_capture','shopify_catalog','security_review','delivery_receipt'];
const PROVIDER_PATTERNS = {
  shopify_installation:/^gid:\/\/shopify\/AppInstallation\/\d+$/,
  shopify_product:/^gid:\/\/shopify\/Product\/\d+$/,
  shopify_order:/^gid:\/\/shopify\/Order\/\d+$/,
  shopify_fulfillment:/^gid:\/\/shopify\/Fulfillment\/\d+$/,
  shopify_refund:/^gid:\/\/shopify\/Refund\/\d+$/,
  shopify_webhook_delivery:/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  stripe_checkout_session:/^cs_test_[A-Za-z0-9_]+$/,
  stripe_payment_intent:/^pi_[A-Za-z0-9_]+$/,
  stripe_charge:/^ch_[A-Za-z0-9_]+$/,
  stripe_event:/^evt_[A-Za-z0-9_]+$/,
  stripe_transfer:/^tr_[A-Za-z0-9_]+$/,
  stripe_transfer_reversal:/^trr_[A-Za-z0-9_]+$/,
  stripe_refund:/^re_[A-Za-z0-9_]+$/,
  stripe_balance_transaction:/^txn_[A-Za-z0-9_]+$/,
  email_delivery:/^[A-Za-z0-9][A-Za-z0-9_.:-]{4,200}$/,
};
const DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const HASH = /^[a-f0-9]{64}$/i;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => [...new Set(values)];
const artifactExtensions = new Set(['.json','.jsonl','.csv','.txt','.log','.png','.jpg','.jpeg','.webp','.pdf']);
const forbiddenKey = /^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|stripe[_-]?secret[_-]?key|shopify[_-]?admin[_-]?token|authorization|cookie|password|webhook[_-]?secret|shipping[_-]?address|ship[_-]?to|customer[_-]?email|phone|cycle[_-]?data|health[_-]?data)$/i;
const credentialValue = /\b(?:sk_(?:live|test)_[A-Za-z0-9]+|shpat_[A-Za-z0-9]+|shpss_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|avf_(?:live|test)_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9_.-]+)\b/;

export const ACCEPTANCE_MANIFEST_SCHEMA = {
  $schema:'https://json-schema.org/draft/2020-12/schema',
  title:'Avafem declared acceptance evidence; not an execution or verification certificate',
  type:'object',required:['schemaVersion','run','stores','stripe','artifacts','scenarios'],additionalProperties:false,
  properties:{
    schemaVersion:{const:1},
    run:{type:'object',required:['id','environment','actualProviders','redacted','startedAt','completedAt'],properties:{id:{type:'string',minLength:1},environment:{const:'test'},actualProviders:{const:true},redacted:{const:true},startedAt:{type:'string',format:'date-time'},completedAt:{type:'string',format:'date-time'},declaredBy:{type:'string'}},additionalProperties:false},
    stores:{type:'array',minItems:EXPECTED_STORE_COUNT,maxItems:EXPECTED_STORE_COUNT,items:{$ref:'#/$defs/store'}},
    stripe:{type:'object',required:['mode','accountId'],properties:{mode:{const:'test'},accountId:{type:'string',pattern:'^acct_(?!sandbox_)[A-Za-z0-9_]+$'}},additionalProperties:false},
    artifacts:{type:'array',minItems:1,maxItems:200,items:{$ref:'#/$defs/artifact'}},
    scenarios:{type:'array',minItems:10,maxItems:10,items:{$ref:'#/$defs/scenario'}},
  },
  $defs:{
    store:{type:'object',required:['domain','kind','testMode','shopId','appInstallationId','catalog'],properties:{domain:{type:'string',enum:EXPECTED_STORE_DOMAINS},kind:{enum:['development','trial']},testMode:{const:true},shopId:{type:'string',pattern:'^gid://shopify/Shop/[0-9]+$'},appInstallationId:{type:'string',pattern:'^gid://shopify/AppInstallation/[0-9]+$'},catalog:{$ref:'#/$defs/catalog'}},additionalProperties:false},
    catalog:{type:'object',required:['source','capturedAt','fingerprint','productCount','artifactId'],properties:{source:{const:'shopify-admin-graphql'},capturedAt:{type:'string',format:'date-time'},fingerprint:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},productCount:{type:'integer',minimum:1},artifactId:{type:'string',minLength:1}},additionalProperties:false},
    artifact:{type:'object',required:['id','path','kind','source','capturedAt','redacted','sha256'],properties:{id:{type:'string',minLength:1},path:{type:'string',minLength:1},kind:{enum:ARTIFACT_KINDS},source:{enum:SOURCES},capturedAt:{type:'string',format:'date-time'},redacted:{const:true},sha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}},additionalProperties:false},
    provider:{type:'object',required:['kind','id','artifactIds'],properties:{kind:{enum:Object.keys(PROVIDER_PATTERNS)},id:{type:'string',minLength:1},storeDomain:{type:'string'},artifactIds:{type:'array',minItems:1,items:{type:'string'}}},additionalProperties:false},
    scenario:{type:'object',required:['id','status','startedAt','completedAt','storeDomains','observations','providers','artifactIds'],properties:{id:{enum:ACCEPTANCE_SCENARIOS.map(s=>s.id)},status:{enum:['executed','not_run','blocked']},startedAt:{type:'string',format:'date-time'},completedAt:{type:'string',format:'date-time'},storeDomains:{type:'array',minItems:EXPECTED_STORE_COUNT,maxItems:EXPECTED_STORE_COUNT,uniqueItems:true,items:{type:'string'}},observations:{type:'object',additionalProperties:{type:'boolean'}},providers:{type:'array',minItems:1,maxItems:200,items:{$ref:'#/$defs/provider'}},artifactIds:{type:'array',minItems:1,items:{type:'string'}}},additionalProperties:false},
  },
};

function unknownFields(value, allowed, location, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (Object.keys(value).some(key => !allowed.includes(key))) errors.push(`${location}: unexpected fields are not permitted.`);
}
function containsCredentials(value) {
  if (typeof value === 'string') return credentialValue.test(value);
  if (Array.isArray(value)) return value.some(containsCredentials);
  if (value && typeof value === 'object') return Object.entries(value).some(([key,item]) => forbiddenKey.test(key) || containsCredentials(item));
  return false;
}
export function parseStoreDomains(raw) {
  const domains = typeof raw === 'string' ? raw.split(',').map(domain=>domain.trim().toLowerCase()).filter(Boolean) : [];
  const valid = domains.length === EXPECTED_STORE_COUNT && unique(domains).length === EXPECTED_STORE_COUNT && domains.every(domain=>DOMAIN.test(domain) && EXPECTED_STORE_DOMAINS.includes(domain));
  return {domains:domains.filter(domain=>DOMAIN.test(domain)),valid};
}
function scenarioResult(definition, missingEvidence = []) {
  return {id:definition.id,title:definition.title,status:'NOT_RUN',evidenceReadiness:missingEvidence.length?'INCOMPLETE':'DECLARED_UNVERIFIED',missingEvidence};
}
function makeReport(domains, blockers, scenarios) {
  return {
    mode:'configuration_validation_only',
    message:'Configuration validation only. E2E NOT RUN.',
    status:blockers.length?'BLOCKED':'NOT_RUN',configuration:blockers.length?'INCOMPLETE':'VALID',
    acceptancePassed:false,liveProviderScenariosExecuted:0,externalRequests:0,externalMutations:0,
    configuredStoreCount:unique(domains).length,
    expectedStoreCount:EXPECTED_STORE_COUNT,
    evidenceIntegrity:'NOT_VERIFIED; artifact existence and metadata only',
    blockers,scenarios,
    nextAction:blockers.length?'Resolve configuration/evidence gaps, then run an explicitly authorized live acceptance exercise.':'Run and independently verify the actual provider acceptance exercise; a complete manifest is not proof of success.',
  };
}

/** No provider calls, credential loading, artifact-content reads, or writes. */
export async function validateAcceptanceManifest({storesRaw,manifest,manifestDir=process.cwd(),now=Date.now()}) {
  const {domains,valid} = parseStoreDomains(storesRaw);
  const blockers=[];
  if (!valid) blockers.push('AVAFEM_ACCEPTANCE_STORES must name the exact three authorized domains for My Store 2, 4, and 6; arbitrary replacement stores are not permitted. Development or trial stores require explicit testMode:true evidence.');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    blockers.push('A declared evidence manifest is required; no actual provider scenarios have been run by this tool.');
    return makeReport(domains,blockers,ACCEPTANCE_SCENARIOS.map(def=>scenarioResult(def,['No evidence manifest.'])));
  }
  if (containsCredentials(manifest)) {
    blockers.push('Manifest contains a prohibited credential or shopper-data field/value. Replace it with redacted evidence references; no value has been printed.');
    return makeReport(domains,blockers,ACCEPTANCE_SCENARIOS.map(def=>scenarioResult(def,['Manifest rejected before evidence inspection.'])));
  }
  unknownFields(manifest,['schemaVersion','run','stores','stripe','artifacts','scenarios'],'manifest',blockers);
  if (manifest.schemaVersion!==1) blockers.push('manifest.schemaVersion must be 1.');
  const run=manifest.run || {};
  unknownFields(run,['id','environment','actualProviders','redacted','startedAt','completedAt','declaredBy'],'run',blockers);
  if (!nonempty(run.id) || run.environment!=='test' || run.actualProviders!==true || run.redacted!==true) blockers.push('run requires an ID, test environment, actualProviders:true and redacted:true; these remain declarations, not verified execution.');
  if (!iso(run.startedAt) || !iso(run.completedAt) || Date.parse(run.completedAt)<Date.parse(run.startedAt) || Date.parse(run.completedAt)>now+300000) blockers.push('run timestamps must be valid, ordered, and not in the future.');
  const stripe=manifest.stripe || {};
  unknownFields(stripe,['mode','accountId'],'stripe',blockers);
  if (stripe.mode!=='test' || !/^acct_(?!sandbox_)[A-Za-z0-9_]+$/.test(stripe.accountId || '')) blockers.push('stripe requires mode:test and an actual platform account reference; local acct_sandbox_ records are not provider evidence, and account IDs alone do not prove test mode.');

  const artifacts=Array.isArray(manifest.artifacts)?manifest.artifacts:[];
  if (!artifacts.length || artifacts.length>200) blockers.push('Provide 1–200 redacted evidence artifact records.');
  const artifactById=new Map();
  let base;
  try { base=await realpath(manifestDir); } catch { blockers.push('Evidence directory is unavailable.'); }
  for (const [index,artifact] of artifacts.slice(0,200).entries()) {
    const location=`artifacts[${index}]`;
    unknownFields(artifact,['id','path','kind','source','capturedAt','redacted','sha256'],location,blockers);
    if (!artifact || !nonempty(artifact.id) || artifactById.has(artifact.id)) { blockers.push(`${location}: artifact ID must be nonempty and unique.`); continue; }
    artifactById.set(artifact.id,artifact);
    if (!ARTIFACT_KINDS.includes(artifact.kind) || !SOURCES.includes(artifact.source) || artifact.redacted!==true || !iso(artifact.capturedAt) || Date.parse(artifact.capturedAt)>now+300000 || !HASH.test(artifact.sha256 || '')) blockers.push(`${location}: kind, source, capture timestamp, redacted:true and a declared SHA-256 are required.`);
    const path=artifact.path;
    if (!base || !nonempty(path) || isAbsolute(path) || path.split(/[\\/]/).some(part=>part==='..' || part.startsWith('.')) || !artifactExtensions.has(extname(path).toLowerCase())) { blockers.push(`${location}: artifact must be a permitted relative evidence-file path within the manifest directory.`); continue; }
    try {
      const actual=await realpath(resolve(base,path));
      if (actual!==base && !actual.startsWith(`${base}${sep}`)) throw new Error('outside');
      const metadata=await stat(actual);
      if (!metadata.isFile() || metadata.size===0 || metadata.size>25*1024*1024) throw new Error('invalid');
    } catch { blockers.push(`${location}: nonempty regular artifact file is missing, inaccessible, outside the evidence directory, or too large.`); }
  }
  const stores=Array.isArray(manifest.stores)?manifest.stores:[];
  if (stores.length!==EXPECTED_STORE_COUNT || unique(stores.map(store=>store?.domain)).length!==EXPECTED_STORE_COUNT) blockers.push('manifest.stores must contain exactly three distinct stores.');
  const fingerprints=[];
  for (const [index,store] of stores.entries()) {
    const location=`stores[${index}]`;
    unknownFields(store,['domain','kind','testMode','shopId','appInstallationId','catalog'],location,blockers);
    if (!store || !domains.includes(store.domain) || !EXPECTED_STORE_DOMAINS.includes(store.domain) || !['development','trial'].includes(store.kind) || store.testMode!==true || !/^gid:\/\/shopify\/Shop\/\d+$/.test(store.shopId || '') || !PROVIDER_PATTERNS.shopify_installation.test(store.appInstallationId || '')) blockers.push(`${location}: exact configured target domain, kind:development or trial, explicit testMode:true, provider shop ID, and app-installation ID are required.`);
    const catalog=store?.catalog || {};
    unknownFields(catalog,['source','capturedAt','fingerprint','productCount','artifactId'],`${location}.catalog`,blockers);
    if (catalog.source!=='shopify-admin-graphql' || !iso(catalog.capturedAt) || Date.parse(catalog.capturedAt)>now+300000 || !HASH.test(catalog.fingerprint || '') || !Number.isSafeInteger(catalog.productCount) || catalog.productCount<1) blockers.push(`${location}: catalog must declare a real GraphQL capture, timestamp, nonzero product count and SHA-256 fingerprint.`);
    const artifact=artifactById.get(catalog.artifactId);
    if (!artifact || artifact.kind!=='shopify_catalog' || artifact.source!=='shopify') blockers.push(`${location}: catalog must reference a Shopify catalog evidence artifact.`);
    if (HASH.test(catalog.fingerprint || '')) fingerprints.push(catalog.fingerprint.toLowerCase());
  }
  if (fingerprints.length!==EXPECTED_STORE_COUNT || unique(fingerprints).length!==EXPECTED_STORE_COUNT) blockers.push('Three distinct catalog fingerprints from actual store captures are required; this tool does not fetch or authenticate catalogs.');

  const declared=Array.isArray(manifest.scenarios)?manifest.scenarios:[];
  if (declared.length!==10 || unique(declared.map(s=>s?.id)).length!==10 || declared.some(s=>!ACCEPTANCE_SCENARIOS.some(def=>def.id===s?.id))) blockers.push('Declare each of the ten acceptance scenarios exactly once.');
  const scenarios=ACCEPTANCE_SCENARIOS.map(def=>{
    const missing=[];
    const scenario=declared.find(value=>value?.id===def.id);
    if (!scenario) { blockers.push(`${def.id}: scenario evidence is absent.`); return scenarioResult(def,['Scenario evidence absent.']); }
    unknownFields(scenario,['id','status','startedAt','completedAt','storeDomains','observations','providers','artifactIds'],def.id,missing);
    if (scenario.status!=='executed') missing.push('Actual provider execution is not declared.');
    if (!iso(scenario.startedAt) || !iso(scenario.completedAt) || Date.parse(scenario.completedAt)<Date.parse(scenario.startedAt) || Date.parse(scenario.completedAt)>now+300000) missing.push('Valid ordered actual-execution timestamps are required.');
    if (!Array.isArray(scenario.storeDomains) || scenario.storeDomains.length!==EXPECTED_STORE_COUNT || unique(scenario.storeDomains).length!==EXPECTED_STORE_COUNT || domains.some(domain=>!scenario.storeDomains.includes(domain))) missing.push('Scenario must cover all three configured stores.');
    for (const check of def.checks) if (scenario.observations?.[check]!==true) missing.push(`Missing observed condition: ${check}.`);
    const refs=Array.isArray(scenario.artifactIds)?scenario.artifactIds:[];
    if (!refs.length || refs.some(ref=>!artifactById.has(ref))) missing.push('All scenario artifacts must reference existing declared files.');
    for (const kind of def.artifacts) if (!refs.some(ref=>artifactById.get(ref)?.kind===kind)) missing.push(`Missing artifact category: ${kind}.`);
    const providers=Array.isArray(scenario.providers)?scenario.providers:[];
    if (!providers.length || providers.length>200) missing.push('Provide 1–200 actual provider-record references.');
    for (const kind of def.providers) if (!providers.some(provider=>provider?.kind===kind)) missing.push(`Missing provider-record category: ${kind}.`);
    for (const provider of providers.slice(0,200)) {
      unknownFields(provider,['kind','id','storeDomain','artifactIds'],'Provider reference',missing);
      if (!PROVIDER_PATTERNS[provider?.kind]?.test(provider?.id || '')) missing.push('Provider reference has an unsupported type or invalid ID format.');
      if (typeof provider?.kind==='string' && provider.kind.startsWith('shopify_') && !domains.includes(provider.storeDomain)) missing.push('Shopify references must identify a configured store.');
      if (!Array.isArray(provider?.artifactIds) || !provider.artifactIds.length || provider.artifactIds.some(ref=>!refs.includes(ref))) missing.push('Provider references must link to this scenario’s evidence artifacts.');
      const expectedSource=typeof provider?.kind==='string' && provider.kind.startsWith('shopify_')?'shopify':typeof provider?.kind==='string' && provider.kind.startsWith('stripe_')?'stripe':provider?.kind==='email_delivery'?'email_provider':null;
      if (expectedSource && (!Array.isArray(provider.artifactIds) || !provider.artifactIds.some(ref=>artifactById.get(ref)?.source===expectedSource))) missing.push('Provider references must include evidence labeled with the corresponding provider source.');
    }
    if (domains.some(domain=>!providers.some(provider=>typeof provider?.kind==='string' && provider.kind.startsWith('shopify_') && provider.storeDomain===domain))) missing.push('Actual Shopify record references are required for each of the three stores.');
    if (missing.length) blockers.push(`${def.id}: declared evidence is incomplete (${missing.length} gaps).`);
    return scenarioResult(def,unique(missing));
  });
  return makeReport(domains,unique(blockers),scenarios);
}

export async function runPreflight(env=process.env, options={}) {
  const storesRaw=env.AVAFEM_ACCEPTANCE_STORES;
  const evidencePath=env.AVAFEM_ACCEPTANCE_EVIDENCE;
  let manifest;
  let manifestDir=options.cwd || process.cwd();
  let readError=false;
  if (evidencePath) {
    try {
      const path=resolve(manifestDir,evidencePath);
      const metadata=await stat(path);
      if (!metadata.isFile() || metadata.size>2*1024*1024) throw new Error('invalid manifest');
      manifest=JSON.parse(await readFile(path,'utf8'));
      manifestDir=dirname(path);
    } catch { readError=true; }
  }
  const report=await validateAcceptanceManifest({storesRaw,manifest,manifestDir,now:options.now});
  if (readError) { report.blockers.unshift('Evidence manifest is missing, unreadable, invalid JSON, or larger than 2 MiB.'); report.status='BLOCKED'; report.configuration='INCOMPLETE'; }
  return {report,exitCode:report.status==='BLOCKED'?2:3};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if (args.length===1 && args[0]==='--schema') {
    process.stdout.write(`${JSON.stringify(ACCEPTANCE_MANIFEST_SCHEMA,null,2)}\n`);
  } else if (args.length===1 && args[0]==='--help') {
    process.stdout.write('Usage: node scripts/acceptance-preflight.mjs [--check|--schema|--help]\nReads only AVAFEM_ACCEPTANCE_STORES and AVAFEM_ACCEPTANCE_EVIDENCE. No provider calls or mutations.\n--check validates configuration/declared evidence only. E2E is always NOT_RUN. Exit 2: BLOCKED. Exit 3: evidence structurally complete but E2E NOT_RUN.\n');
  } else if (args.some(arg=>arg!=='--check') || args.length>1) {
    process.stdout.write(`${JSON.stringify({mode:'configuration_validation_only',status:'BLOCKED',acceptancePassed:false,message:'Unsupported arguments. Use --check, --schema, or --help.'},null,2)}\n`);
    process.exitCode=2;
  } else {
    const {report,exitCode}=await runPreflight();
    process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
    process.exitCode=exitCode;
  }
}
