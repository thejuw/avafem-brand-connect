import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {TEST_STORES} from '../server/test-stores.mjs';

test('Shopify event siblings keep distinct delivery receipts while exact retries still deduplicate', {timeout:60_000}, async t => {
  const f=await platformFixture(t),shop=TEST_STORES[0].shop;
  f.testStores.findShop=async()=>({shop,brandId:'brand_bloom'});
  f.testStores.forShop=async()=>({verifyWebhook:async()=>true});
  const send=(webhookId,payload,topic='orders/updated',apiVersion='2026-01')=>f.request({method:'POST',url:'/webhooks/shopify',
    headers:{'x-shopify-shop-domain':shop,'x-shopify-topic':topic,'x-shopify-event-id':'same-synthetic-event',
      ...(webhookId?{'x-shopify-webhook-id':webhookId}:{}),'x-shopify-api-version':apiVersion},payload});
  const body={id:1001,total_price:'1.00'};
  assert.equal((await send('delivery-v1',body)).statusCode,200);
  assert.equal((await send('delivery-v1',body)).statusCode,200);
  assert.equal((await send('delivery-v2',{...body,new_api_field:true},'orders/updated','2026-04')).statusCode,200);
  assert.equal((await send('delivery-cancel',body,'orders/cancelled')).statusCode,200);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM unified_provider_events')).rows[0].n,3);
  // Reusing a precise delivery identity for a changed body remains a conflict.
  assert.equal((await send('delivery-v1',{...body,total_price:'2.00'})).statusCode,409);
  assert.equal((await send(null,body)).statusCode,200);
  assert.equal((await send(null,body)).statusCode,200);
  assert.equal((await send(null,{...body,new_api_field:true},'orders/updated','2026-04')).statusCode,200);
  assert.equal((await send(null,body,'orders/cancelled')).statusCode,200);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM unified_provider_events')).rows[0].n,6);
  // Ingress only queues encrypted evidence; it never creates provider orders.
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM provider_money_bookings')).rows[0].n,0);
});
