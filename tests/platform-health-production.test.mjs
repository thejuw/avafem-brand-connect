import test from 'node:test';
import assert from 'node:assert/strict';
import {platformFixture} from './helpers/platform-fixture.mjs';
import {declareFields,SEGMENT_FIELDS,MESSAGE_FIELDS,CAMPAIGN_KINDS} from '../server/platform/health-classification.mjs';
import {createHealthVault} from '../server/platform/health.mjs';
import {createCrm} from '../server/platform/crm.mjs';

test('every segment/template/flow field declares health; new unclassified or downgraded health fields fail closed',()=>{
  for (const registry of [SEGMENT_FIELDS,MESSAGE_FIELDS,CAMPAIGN_KINDS]) for (const definition of Object.values(registry)) {
    assert.equal(typeof definition.health,'boolean'); if (definition.source==='health') assert.equal(definition.health,true);
  }
  assert.throws(()=>declareFields({newIntakeField:{source:'health'}}),/classification/);
  assert.throws(()=>declareFields({newCycleField:{source:'health',health:false}}),/classification/);
  assert.throws(()=>declareFields({newField:{health:false}}),/classification/);
});

test('unclassified fields and explicit privacy downgrades cannot enter segment evaluation or message rendering',{timeout:60_000},async t=>{
  const f=await platformFixture(t),crm=f.platform.crm;
  await assert.rejects(crm.createSegment({rules:{futureHealthField:true}}),e=>e.code==='HEALTH_CLASSIFICATION_REQUIRED');
  await assert.rejects(crm.evaluate({futureHealthField:true}),e=>e.code==='HEALTH_CLASSIFICATION_REQUIRED');
  await assert.rejects(crm.createSegment({rules:{concern:'sensitivity'},health:false}),e=>e.code==='HEALTH_CLASSIFICATION_REQUIRED');
  const segment=await crm.createSegment({rules:{minSpendCents:0}});
  for (const input of [{template:'Hi {{futureHealthField}}'},{template:'Hi {{cyclePhase}}',health:false}]) {
    await assert.rejects(crm.createCampaign({kind:'broadcast',channel:'email',segmentId:segment.id,...input}),e=>e.code==='HEALTH_CLASSIFICATION_REQUIRED');
  }
  const shopper=await crm.upsertShopper({email:'declared-health@example.invalid',consent:{email:true,marketing:true,health:false}});
  const campaign=await crm.createCampaign({kind:'broadcast',channel:'email',segmentId:segment.id,health:true,template:'Sensitive static reminder'});
  assert.equal(campaign.health,true);
  assert.equal((await crm.runCampaign(campaign.id)).queued,0);
  assert.equal((await crm.outbox({shopperId:shopper.id})).length,0);
});

test('outbox reads are bounded and never run the migration or any cleanup write',{timeout:60_000},async t=>{
  const f=await platformFixture(t),crm=f.platform.crm;
  const s=await crm.upsertShopper({email:'bounded-outbox@example.invalid'});
  for (let i=0;i<105;i++) await crm.sendTransactional(s.id,{subject:`Notice ${i}`,body:'Synthetic notice',dedupeKey:`bounded-${i}`});
  const guard={query:(sql,params)=>{
    assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE|JOIN campaigns|JOIN segments)\b/i,'read path cannot run a cleanup scan/write');
    return f.db.query(sql,params);
  }};
  const reader=createCrm(guard,{secret:f.config.encryptionKey,clock:f.clock,health:f.platform.health,domain:f.domain});
  assert.equal((await reader.outbox({shopperId:s.id})).length,100);
  assert.equal((await reader.outbox({shopperId:s.id,limit:20,offset:100})).length,5);
  await assert.rejects(reader.outbox({limit:501}));
  assert.equal((await f.platform.privacy.export(s.id,'owner')).messages.length,105,'explicit DSAR exports are not silently paginated');
});

test('legacy rows are withheld, migrated in bounded batches, original-key checked, and completion is idempotent',{timeout:60_000},async t=>{
  const f=await platformFixture(t),{crm,health}=f.platform;
  const s=await crm.upsertShopper({email:'batch-migration@example.invalid',consent:{email:true,marketing:true,health:true}});
  const seg=await crm.createSegment({rules:{concern:'synthetic'}});
  const camp=await crm.createCampaign({kind:'broadcast',channel:'email',segmentId:seg.id,template:'Static private reminder'});
  for (let i=0;i<3;i++) await f.db.query(`INSERT INTO message_outbox(id,campaign_id,shopper_id,channel,recipient_enc,recipient_hint,subject,body,dedupe_key,created_at)
    VALUES($1,$2,$3,'email',$4,'s***@example.invalid','PRIVATE LEGACY','PRIVATE LEGACY BODY',$5,NOW())`,
    [`migration-row-${i}`,camp.id,s.id,crm.pii.encrypt('batch-migration@example.invalid'),`legacy-${i}`]);
  let outbox=await crm.outbox({shopperId:s.id});
  assert.ok(outbox.every(m=>m.migrationPending)); assert.ok(!JSON.stringify(outbox).includes('PRIVATE LEGACY'));
  assert.equal((await health.migrationStatus()).pendingRows,3);
  await assert.rejects(f.platform.privacy.export(s.id,'owner'),e=>e.code==='HEALTH_MESSAGE_MIGRATION_REQUIRED');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM privacy_requests WHERE shopper_id=$1 AND kind='export'",[s.id])).rows[0].n,0);
  await assert.rejects(createHealthVault(f.db,{secret:'wrong-original-key',clock:f.clock}),e=>e.code==='HEALTH_MESSAGE_KEY_REQUIRED');
  const first=await health.migrateOutbox({force:true,batchSize:2});
  assert.equal(first.processed,2);assert.equal(first.complete,false);
  const next=await health.migrateOutbox({batchSize:2});
  assert.equal(next.processed,1);assert.equal(next.complete,true);
  assert.equal((await health.migrateOutbox()).processed,0);
  const raw=(await f.db.query('SELECT * FROM message_outbox WHERE shopper_id=$1',[s.id])).rows;
  assert.ok(raw.every(m=>m.protection_version===2 && m.contains_health && m.body_enc));
  assert.ok(!JSON.stringify(raw).includes('PRIVATE LEGACY'));
  outbox=await crm.outbox({shopperId:s.id});assert.ok(outbox.every(m=>m.body==='PRIVATE LEGACY BODY'));
  // An older worker arriving after the completion marker is still picked up by
  // the bounded background migration, never by a message read.
  await f.db.query(`INSERT INTO message_outbox(id,shopper_id,channel,recipient_enc,recipient_hint,subject,body,dedupe_key,created_at)
    VALUES('late-legacy',$1,'email',$2,'s***@example.invalid','Late service notice','Late service body','late-legacy',NOW())`,[s.id,crm.pii.encrypt('batch-migration@example.invalid')]);
  assert.equal((await health.migrateOutbox()).processed,1);
  assert.equal((await f.platform.privacy.export(s.id,'owner')).messages.length,4);
});
