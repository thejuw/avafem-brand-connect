import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ACCEPTANCE_MANIFEST_SCHEMA, ACCEPTANCE_SCENARIOS, EXPECTED_STORE_COUNT, EXPECTED_STORE_DOMAINS, parseStoreDomains, runPreflight, validateAcceptanceManifest } from '../scripts/acceptance-preflight.mjs';

const now=Date.parse('2026-10-18T14:00:00Z');
const domains=[...EXPECTED_STORE_DOMAINS];
const startedAt='2026-10-18T10:00:00Z';
const completedAt='2026-10-18T12:00:00Z';
const artifactKinds=['provider_response','signed_webhook','application_log','ledger_export','reconciliation','shopify_catalog','security_review','delivery_receipt'];
const sources=['shopify','stripe','avafem','email_provider'];
const script=fileURLToPath(new URL('../scripts/acceptance-preflight.mjs',import.meta.url));

function providerId(kind,index=0) {
  const shopify={shopify_installation:'AppInstallation',shopify_product:'Product',shopify_order:'Order',shopify_fulfillment:'Fulfillment',shopify_refund:'Refund'};
  if (shopify[kind]) return `gid://shopify/${shopify[kind]}/${1000+index}`;
  if (kind==='shopify_webhook_delivery') return `00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
  const prefixes={stripe_checkout_session:'cs_test_',stripe_payment_intent:'pi_',stripe_charge:'ch_',stripe_event:'evt_',stripe_transfer:'tr_',stripe_transfer_reversal:'trr_',stripe_refund:'re_',stripe_balance_transaction:'txn_',email_delivery:'notice_'};
  return `${prefixes[kind]}SYNTHETIC_UNIT_TEST_${index}`;
}
async function declaredFixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'avafem-acceptance-unit-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const artifacts=[];
  for (const kind of artifactKinds) for (const source of sources) {
    const id=`${source}_${kind}`;
    // These are deliberately not real provider captures. Structural completeness
    // must never turn this synthetic fixture into an acceptance PASS.
    await writeFile(join(dir,`${id}.json`),'SYNTHETIC UNIT TEST FIXTURE; NOT PROVIDER EVIDENCE.');
    artifacts.push({id,path:`${id}.json`,kind,source,capturedAt:completedAt,redacted:true,sha256:'f'.repeat(64)});
  }
  const manifest={schemaVersion:1,run:{id:'SYNTHETIC-UNIT-TEST',environment:'test',actualProviders:true,redacted:true,startedAt,completedAt},
    stores:domains.map((domain,index)=>({domain,kind:'development',testMode:true,shopId:`gid://shopify/Shop/${index+1}`,appInstallationId:providerId('shopify_installation',index),catalog:{source:'shopify-admin-graphql',capturedAt:completedAt,fingerprint:['a','b','c'][index].repeat(64),productCount:index+1,artifactId:'shopify_shopify_catalog'}})),
    stripe:{mode:'test',accountId:'acct_SYNTHETIC_UNIT_TEST'},artifacts,
    scenarios:ACCEPTANCE_SCENARIOS.map((scenario,scenarioIndex)=>({id:scenario.id,status:'executed',startedAt,completedAt,storeDomains:domains,
      observations:Object.fromEntries(scenario.checks.map(check=>[check,true])),
      artifactIds:artifacts.map(artifact=>artifact.id),
      providers:scenario.providers.flatMap(kind=>{
        const source=kind.startsWith('shopify_')?'shopify':kind.startsWith('stripe_')?'stripe':'email_provider';
        const provider=(storeDomain,index)=>({kind,id:providerId(kind,scenarioIndex*10+index),...(storeDomain?{storeDomain}:{}),artifactIds:[`${source}_provider_response`]});
        return kind.startsWith('shopify_')?domains.map(provider):[provider(null,0)];
      }),
    })),
  };
  return {dir,manifest};
}
const validate=(fixture)=>validateAcceptanceManifest({storesRaw:domains.join(','),manifest:fixture.manifest,manifestDir:fixture.dir,now});

test('Acceptance scope is exactly My Store 2, 4, and 6: three distinct domains', () => {
  assert.equal(EXPECTED_STORE_COUNT,3);
  assert.deepEqual(EXPECTED_STORE_DOMAINS,['i4vd1u-s8.myshopify.com','qpsd02-jz.myshopify.com','ir7112-v1.myshopify.com']);
  assert.equal(ACCEPTANCE_MANIFEST_SCHEMA.properties.stores.minItems,3);
  assert.equal(parseStoreDomains(domains.join(',')).valid,true);
  assert.equal(parseStoreDomains([...domains,'unit-test-store-8.myshopify.com'].join(',')).valid,false);
  assert.equal(parseStoreDomains([domains[0],domains[0].toUpperCase(),domains[2]].join(',')).valid,false);
  assert.equal(parseStoreDomains('https://example.com').valid,false);
  assert.equal(parseStoreDomains(['other-shop.myshopify.com',domains[1],domains[2]].join(',')).valid,false);
  assert.deepEqual(ACCEPTANCE_MANIFEST_SCHEMA.$defs.store.properties.kind.enum,['development','trial']);
  assert.equal(ACCEPTANCE_MANIFEST_SCHEMA.$defs.store.properties.testMode.const,true);
});
test('Missing configuration blocks and never reports a provider acceptance pass', async () => {
  const {report,exitCode}=await runPreflight({}, {now});
  assert.equal(report.status,'BLOCKED'); assert.equal(exitCode,2);
  assert.equal(report.acceptancePassed,false); assert.equal(report.externalRequests,0); assert.equal(report.externalMutations,0);
  assert.equal(report.scenarios.length,10); assert.ok(report.scenarios.every(scenario=>scenario.status==='NOT_RUN'));
});
test('Even structurally complete synthetic declared evidence remains NOT_RUN, never PASS', async t => {
  const fixture=await declaredFixture(t);
  const before=await readdir(fixture.dir);
  const report=await validate(fixture);
  assert.equal(report.status,'NOT_RUN',JSON.stringify(report.blockers));
  assert.equal(report.configuration,'VALID'); assert.equal(report.acceptancePassed,false);
  assert.equal(report.liveProviderScenariosExecuted,0);
  assert.ok(report.scenarios.every(scenario=>scenario.status==='NOT_RUN' && scenario.evidenceReadiness==='DECLARED_UNVERIFIED'));
  assert.deepEqual(await readdir(fixture.dir),before,'read-only validation must not create reports, captures, or state files');
});
test('Duplicate catalog fingerprints block distinct-catalog readiness', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.stores[1].catalog.fingerprint=fixture.manifest.stores[0].catalog.fingerprint;
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.ok(report.blockers.some(message=>message.includes('distinct catalog fingerprints')));
});
test('The exact authorized trial stores in explicit test mode are structurally allowed but never PASS', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.stores[1].kind='trial';
  fixture.manifest.stores[2].kind='trial';
  const report=await validate(fixture);
  assert.equal(report.configuration,'VALID',JSON.stringify(report.blockers));
  assert.equal(report.status,'NOT_RUN'); assert.equal(report.acceptancePassed,false);
  assert.equal(report.externalRequests,0); assert.equal(report.externalMutations,0);
});
test('Live, missing, or false test-mode declarations are blocked for both accepted store types', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.stores[1].kind='trial';
  for (const testMode of [false, undefined, 'true']) {
    fixture.manifest.stores[1].testMode=testMode;
    const report=await validate(fixture);
    assert.equal(report.status,'BLOCKED'); assert.ok(report.blockers.some(message=>message.includes('testMode:true')));
  }
  fixture.manifest.stores[1].testMode=true;
  fixture.manifest.stripe.mode='live';
  assert.equal((await validate(fixture)).status,'BLOCKED');
});
test('Missing artifact files and missing provider record types block evidence completeness', async t => {
  const fixture=await declaredFixture(t);
  await rm(join(fixture.dir,fixture.manifest.artifacts[0].path));
  fixture.manifest.scenarios[2].providers=fixture.manifest.scenarios[2].providers.filter(provider=>provider.kind!=='stripe_charge');
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.ok(report.blockers.some(message=>message.includes('artifact file is missing')));
  assert.ok(report.scenarios[2].missingEvidence.some(message=>message.includes('stripe_charge')));
});
test('Evidence cannot escape the manifest directory through relative paths or symlinks', async t => {
  const fixture=await declaredFixture(t);
  const outside=await mkdtemp(join(tmpdir(),'avafem-acceptance-outside-unit-'));
  t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'outside.json'),'SYNTHETIC OUTSIDE FILE');
  await symlink(join(outside,'outside.json'),join(fixture.dir,'escaped.json'));
  fixture.manifest.artifacts[0].path='escaped.json';
  fixture.manifest.artifacts[1].path='../outside.json';
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.ok(report.blockers.some(message=>message.includes('outside the evidence directory')));
  assert.ok(report.blockers.some(message=>message.includes('permitted relative evidence-file path')));
});
test('Credential fields/values are rejected without being echoed', async t => {
  const fixture=await declaredFixture(t);
  const fakeCredential='sk_test_SYNTHETICUNITTESTONLY';
  fixture.manifest.stripe.secretKey=fakeCredential;
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.ok(!JSON.stringify(report).includes(fakeCredential));
  assert.ok(report.blockers.some(message=>message.includes('prohibited credential')));
});
test('A scenario cannot claim success from a local stub or omit a store', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.scenarios[0].status='not_run';
  fixture.manifest.scenarios[0].storeDomains=domains.slice(0,2);
  fixture.manifest.scenarios[0].observations.tokens_encrypted_at_rest=false;
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.equal(report.scenarios[0].status,'NOT_RUN');
  assert.ok(report.scenarios[0].missingEvidence.some(message=>message.includes('three configured stores')));
});
test('A local simulated account cannot satisfy actual Stripe test account readiness', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.stripe.accountId='acct_sandbox_local_fixture';
  const report=await validate(fixture);
  assert.equal(report.status,'BLOCKED'); assert.ok(report.blockers.some(message=>message.includes('acct_sandbox_')));
});
test('Only the two documented configuration environment variables are read', async () => {
  const env=new Proxy({}, {get(_target,key) { assert.ok(['AVAFEM_ACCEPTANCE_STORES','AVAFEM_ACCEPTANCE_EVIDENCE'].includes(key)); return undefined; }});
  const result=await runPreflight(env,{now}); assert.equal(result.report.status,'BLOCKED');
});
test('CLI missing configuration exits nonzero with explicit E2E NOT_RUN', () => {
  const result=spawnSync(process.execPath,[script,'--check'],{encoding:'utf8',env:{}});
  assert.equal(result.status,2); assert.equal(result.stderr,'');
  const report=JSON.parse(result.stdout); assert.match(report.message,/E2E NOT RUN/); assert.equal(report.acceptancePassed,false);
});
test('CLI complete declared fixture exits 3, not a green acceptance exit', async t => {
  const fixture=await declaredFixture(t);
  const evidence=join(fixture.dir,'manifest.json');
  await writeFile(evidence,JSON.stringify(fixture.manifest));
  const result=spawnSync(process.execPath,[script,'--check'],{encoding:'utf8',env:{AVAFEM_ACCEPTANCE_STORES:domains.join(','),AVAFEM_ACCEPTANCE_EVIDENCE:evidence}});
  assert.equal(result.status,3,result.stdout); assert.equal(JSON.parse(result.stdout).status,'NOT_RUN');
});
test('Malformed provider shapes are validation failures, not uncaught exceptions', async t => {
  const fixture=await declaredFixture(t);
  fixture.manifest.scenarios[0].providers=[{kind:17,id:{invalid:true},artifactIds:[]}];
  const report=await validate(fixture); assert.equal(report.status,'BLOCKED');
});
