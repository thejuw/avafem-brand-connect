import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {exec} from '../server/platform/util.mjs';

test('idempotent migration scrubs historical erasure leftovers even when the shopper is already tombstoned', {timeout:60_000}, async t => {
  const f=await platformFixture(t),s=await f.platform.crm.upsertShopper({email:'legacy-erase@example.invalid',consent:{email:true}});
  const p=(await f.domain.listProducts({brandId:'brand_bloom',status:'approved'}))[0];
  const sub=await f.platform.subscriptions.create(s.id,{items:[{brandId:p.brandId,sku:p.sku}],shipTo:{name:'Synthetic Name',line1:'1 Synthetic Street',city:'Austin',region:'TX',postal:'78701',country:'US'}});
  const ticket=await f.platform.crm.openTicket({shopperId:s.id,subject:'Private old subject',body:'Private old body'});
  await f.platform.crm.sendTransactional(s.id,{subject:'Private old subject',body:'Private old body',dedupeKey:'legacy-erasure'});
  // Reproduce the old persisted state: already-cancelled subscriptions retained
  // their address and completed DSAR requests left ticket/outbox subjects intact.
  await f.db.query("UPDATE subscriptions SET status='cancelled' WHERE id=$1",[sub.id]);
  await f.db.query('UPDATE shoppers SET deleted_at=NOW() WHERE id=$1',[s.id]);
  const schema=await readFile(new URL('../server/platform/schema.sql',import.meta.url),'utf8');
  await exec(f.db,schema); await exec(f.db,schema);
  assert.equal((await f.db.query('SELECT ship_to_enc FROM subscriptions WHERE id=$1',[sub.id])).rows[0].ship_to_enc,null);
  const saved=(await f.db.query('SELECT subject,messages FROM support_tickets WHERE id=$1',[ticket.id])).rows[0];
  assert.equal(saved.subject,'[erased]'); assert.ok(saved.messages.every(m=>m.body==='[erased]'));
  const message=(await f.db.query('SELECT subject,body,body_enc,recipient_enc FROM message_outbox WHERE shopper_id=$1',[s.id])).rows[0];
  assert.deepEqual(message,{subject:'[erased]',body:'[erased]',body_enc:null,recipient_enc:'erased'});
});
