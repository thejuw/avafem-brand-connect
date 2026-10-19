import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorSummary } from './connector-summary.mjs';

test('Import summary distinguishes transport issues from incomplete draft products', () => {
  const summary = connectorSummary({imported:16,issues:[],products:Array.from({length:16},()=>({status:'draft',inventoryQty:0,validationIssues:[{field:'taxCode'}]}))});
  assert.deepEqual(summary, {kind:'import',title:'Catalog import complete',imported:16,issues:0,drafts:16});
});
test('Preflight summary supports verified GraphQL shop and app entities', () => {
  const summary = connectorSummary({verified:true,shop:{myshopifyDomain:'test.myshopify.com'},app:{title:'Avafem Test Connector'},missingScopes:[]});
  assert.equal(summary.verified,true);
  assert.equal(summary.shop,'test.myshopify.com');
  assert.equal(summary.app,'Avafem Test Connector');
});
test('Missing scopes prevent a misleading verified result', () => {
  assert.equal(connectorSummary({verified:true,missingScopes:['read_orders']}).verified,false);
});
