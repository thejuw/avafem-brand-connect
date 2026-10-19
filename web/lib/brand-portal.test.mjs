import test from 'node:test';
import assert from 'node:assert/strict';
import { API_SCOPES,canManageCredentials,canManageTeam,clearPortalSecrets,credentialMetadata,credentialRequest,initials,linkFromHash,loginReceipt,money,monthOptions,pct,placementEstimate,placementRequest,reportUrl,safePortalError,statementPreview,visibleNav } from './brand-portal.mjs';

test('portal nav follows role scopes', () => {
  assert.deepEqual(visibleNav(['payouts:read', 'reports:read']).map(n => n[0]), ['dashboard', 'payouts', 'settings']);
  assert.deepEqual(visibleNav(['catalog:read', 'orders:read']).map(n => n[0]), ['dashboard', 'products', 'settings']);
  assert(visibleNav(['catalog:read', 'reports:read', 'members:manage']).some(n => n[0] === 'team'));
});
test('only exact fragment tokens are accepted', () => {
  const t = 'a'.repeat(43);
  assert.deepEqual(linkFromHash(`#token=${t}`), { kind: 'token', token: t });
  assert.deepEqual(linkFromHash(`#invite=${t}`), { kind: 'invite', token: t });
  for (const bad of ['', '#token=short', `#token=${t}&x=1`, `?token=${t}`, `#evil=${t}`]) assert.equal(linkFromHash(bad), null);
});
test('month options, report urls and formatting', () => {
  const m = monthOptions(new Date(Date.UTC(2026, 0, 15)), 2); assert.deepEqual(m.map(x => x.value), ['2026-01', '2025-12']);
  assert.equal(reportUrl('statement', '2026-01', 'csv'), '/api/brand-portal/statements?month=2026-01&format=csv');
  assert.equal(reportUrl('annual', 2026, 'json'), '/api/brand-portal/reports/annual?year=2026&format=json');
  assert.equal(money(290460), '$2,904.60'); assert.equal(money(2760), '$27.60'); assert.equal(money(null),'—');assert.equal(money(undefined),'—');assert.equal(money(0),'$0.00');assert.equal(money(-2),'-$0.02');assert.equal(pct(0.048), '4.8%'); assert.equal(pct(null), '—');
  assert.equal(initials('Lumina Botanica'), 'LB');
});

test('simulated sign-in receipts never say an email was delivered or is on its way',()=>{
  const receipt=loginReceipt({requested:true,simulated:true});
  assert.match(receipt.title,/sandbox/);assert.match(receipt.message,/simulated local outbox/);assert.match(receipt.message,/No email was delivered/);
  assert(!/on its way|Check your inbox/i.test(JSON.stringify(receipt)));
  assert.match(loginReceipt({simulated:false}).message,/not proof of inbox delivery/);
});

test('sensitive portal controls require an identified owner, not an invite or finance/staff role',()=>{
  const owner={memberId:'member_synthetic',role:'owner',scopes:['credentials:manage','members:manage']};
  assert.equal(canManageCredentials(owner),true);assert.equal(canManageTeam(owner),true);
  for(const me of [{...owner,memberId:null},{...owner,role:'invite'},{...owner,role:'staff'},{...owner,role:'finance'},{...owner,scopes:[]}]){assert.equal(canManageCredentials(me),false);assert.equal(canManageTeam(me),false);}
});

test('credential requests bind only existing integration scopes and metadata drops all secret values',()=>{
  assert.deepEqual(credentialRequest({operationId:'synthetic_operation',label:' Test sync ',scopes:['orders:read','catalog:read','orders:read']}),{operationId:'synthetic_operation',kind:'api_key',label:'Test sync',scopes:['catalog:read','orders:read']});
  for(const scopes of [[],['credentials:manage'],['members:manage'],['reports:read'],['unknown']])assert.throws(()=>credentialRequest({operationId:'synthetic_operation',label:'Test',scopes}));
  assert.equal(API_SCOPES.length,6);
  const safe=credentialMetadata([{id:'client_synthetic',kind:'api_key',active:true,label:'Test',scopes:['catalog:read','members:manage'],apiKey:'PRIVATE_SECRET',secretHash:'PRIVATE_HASH',token:'PRIVATE_TOKEN',credentials:{value:'PRIVATE_CREDENTIAL'}},{id:'client_oauth',kind:'oauth_client',clientSecret:'PRIVATE_OAUTH'}]);
  assert.equal(safe.length,1);assert.deepEqual(safe[0].scopes,['catalog:read']);assert(!/PRIVATE|secret|apiKey|token|credentials/i.test(JSON.stringify(safe)));
});

test('portal password and key DOM fields clear and controlled errors cannot echo capabilities',()=>{
  const fields=Object.fromEntries(['password','currentPassword','newPassword','apiKey'].map(name=>[name,{value:'SYNTHETIC_PRIVATE_VALUE'}]));
  clearPortalSecrets({elements:{namedItem:name=>fields[name]}});assert(Object.values(fields).every(field=>field.value===''));
  for(const value of ['avf_test_SYNTHETIC','sk_test_SYNTHETIC','https://example.test/#token=synthetic','password=SYNTHETIC','client_secret=SYNTHETIC'])assert.equal(safePortalError(new Error(value),'Safe fallback'),'Safe fallback');
  assert.equal(safePortalError(new Error('The last owner cannot be removed.')),'The last owner cannot be removed.');
});

test('statement preview is exact-brand test-only and preserves unknown cents rather than inventing zero',()=>{
  const report={brandId:'brand_synthetic',sandbox:true,currency:'USD',month:'2026-10',lines:[{transferId:'transfer_synthetic',bagId:'bag_synthetic',status:'held',merchandiseCents:290460,commissionCents:43569,refundedCents:null,transferCents:246891,reversedCents:0,netCents:246891,shopperAddress:'PRIVATE_ADDRESS',connectedAccount:'PRIVATE_ACCOUNT'}],totals:{merchandiseCents:290460,commissionCents:43569,netCents:246891,heldOrScheduledCents:246891},credentials:'PRIVATE_SECRET'};
  const safe=statementPreview(report,'brand_synthetic');assert.equal(safe.lines[0].refundedCents,null);assert.equal(safe.totals.paidCents,null);assert.equal(money(safe.lines[0].netCents),'$2,468.91');assert(!/PRIVATE|shopperAddress|connectedAccount|credentials/.test(JSON.stringify(safe)));
  for(const change of [{brandId:'foreign'},{sandbox:false},{currency:'CAD'},{month:'2026-13'},{lines:null}])assert.throws(()=>statementPreview({...report,...change},'brand_synthetic'));
  assert.match(safe.note,/simulated transfers/);assert.match(safe.note,/not a bank receipt/);
});

test('campaign request uses an exact approved selection with bounded dates/units and never adds billing authority',()=>{
  const products=[{id:'approved_synthetic',status:'approved'},{id:'draft_synthetic',status:'draft'}],now=new Date('2026-10-19T12:00:00Z');
  const input={productId:'approved_synthetic',kind:'featured_spot',startDate:'2026-10-20',days:'7',units:1000};
  const body=placementRequest(input,products,now);assert.deepEqual(body,{kind:'featured_spot',productId:'approved_synthetic',startsAt:'2026-10-20T00:00:00.000Z',endsAt:'2026-10-27T00:00:00.000Z'});assert(!Object.keys(body).some(key=>/brandId|approved|payment|charge|priceCents/.test(key)));
  for(const change of [{productId:'draft_synthetic'},{productId:'foreign'},{kind:'unknown'},{startDate:'2026-02-31'},{startDate:'2026-10-18'},{days:0},{days:91},{kind:'sponsored_swipe',units:999},{kind:'sampling_box',units:9}])assert.throws(()=>placementRequest({...input,...change},products,now));
  assert.throws(()=>placementRequest(input,[{id:'approved_synthetic',status:'approved',sourceDeletedAt:'2026-10-19'}],now));
  const pricing={featuredSpotPerDayCents:2500,sponsoredSwipePer1000Cents:1000,samplingBoxPerUnitCents:150};
  assert.equal(placementEstimate(input,pricing),17500);assert.equal(placementEstimate({...input,kind:'sponsored_swipe',units:1001},pricing),2000);assert.equal(placementEstimate({...input,kind:'sampling_box',units:10},pricing),1500);assert.equal(placementEstimate(input,{}),null);
});
