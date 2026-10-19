import test from 'node:test';
import assert from 'node:assert/strict';
import { displayLabel } from './display-label.mjs';

test('Shopify verified app object renders its title as text', () => {
  assert.equal(displayLabel({id:'gid://shopify/App/1',title:'Avafem Test Connector'}), 'Avafem Test Connector');
});
test('Shopify verified shop object renders its domain as text', () => {
  assert.equal(displayLabel({id:'gid://shopify/Shop/1',name:'My Store 2',myshopifyDomain:'my-store-2.myshopify.com'}), 'my-store-2.myshopify.com');
});
test('Configured string labels and missing configuration are supported', () => {
  assert.equal(displayLabel('My Store 2'), 'My Store 2');
  assert.equal(displayLabel(null,'No store configured'), 'No store configured');
});
test('Unexpected entity fields never return an object as a React child', () => {
  for (const value of [{title:{unexpected:true}}, [], {name:[]}, true, NaN]) {
    assert.equal(displayLabel(value,'Unknown connector'), 'Unknown connector');
  }
});
