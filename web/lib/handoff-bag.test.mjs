import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHandoffBag } from './handoff-bag.mjs';

test('Privacy-projected snake_case handoff retains reference, address, and items', () => {
  const bag=normalizeHandoffBag({bag_id:'bag_test',order_ref:'SANDBOX-1042',ship_to:{name:'Alex Sandbox',line1:'123 Test Street',city:'Austin',region:'TX',postal:'78701',country:'US'},items:[{sku:'TEST-01',title:'Cotton essentials',qty:2,unit_price:3200}],sandbox:true});
  assert.equal(bag.id,'bag_test');
  assert.equal(bag.orderRef,'SANDBOX-1042');
  assert.equal(bag.shipTo.line1,'123 Test Street');
  assert.equal(bag.shipTo.postal,'78701');
  assert.equal(bag.items[0].qty,2);
  assert.equal(bag.items[0].unitPriceCents,3200);
  assert.equal(bag.status,undefined);
});
test('Canonical handoff shape remains supported', () => {
  const bag=normalizeHandoffBag({id:'bag_test',orderRef:'SANDBOX-1042',status:'awaiting_shipment',shipTo:{name:'Alex Sandbox',line1:'123 Test Street'}});
  assert.equal(bag.orderRef,'SANDBOX-1042');
  assert.equal(bag.shipTo.name,'Alex Sandbox');
  assert.equal(bag.status,'awaiting_shipment');
});
test('Handoff normalization never spreads health data, phone, email, or arbitrary metadata', () => {
  const bag=normalizeHandoffBag({health:'private',ship_to:{name:'Alex Sandbox',phone:'555-0100',email:'private@example.test',cycle:'private'},items:[{sku:'TEST-01',qty:1,health:'private'}]});
  for (const name of ['phone','email','cycle']) assert.equal(name in bag.shipTo,false);
  assert.equal('health' in bag,false);
  assert.equal('health' in bag.items[0],false);
});
