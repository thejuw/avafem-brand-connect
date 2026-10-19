import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture, isoDate, DAY } from './helpers/platform-fixture.mjs';
import { createCrm } from '../server/platform/crm.mjs';

const consent = { email: true, marketing: true, health: true };
async function healthCampaign(f, email) {
  const { crm, health } = f.platform;
  const shopper = await crm.upsertShopper({ email, firstName: 'Synthetic', consent });
  await health.write(shopper.id, { cycle: { lastPeriodStart: isoDate(new Date(f.clock().getTime() - 20 * DAY)), cycleLength: 28 } });
  const segment = await crm.createSegment({ rules: { cyclePhase: 'luteal' } });
  const campaign = await crm.createCampaign({ name: 'Synthetic cycle subject', kind: 'broadcast', channel: 'email', segmentId: segment.id,
    template: 'Phase={{cyclePhase}} next={{nextPeriodStart}}' });
  return { shopper, campaign };
}

test('health campaign subject/body are encrypted and authorized outbox reads are purpose-audited', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'health-outbox@example.test');
  assert.equal((await crm.runCampaign(campaign.id)).queued, 1);
  const raw = (await f.db.query('SELECT * FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows[0];
  assert.equal(raw.contains_health, true);
  assert.equal(raw.subject, '[health message]');
  assert.equal(raw.body, '[health message]');
  for (const value of ['luteal', 'next=', 'Synthetic cycle subject']) assert.ok(!JSON.stringify(raw).includes(value));
  assert.ok(raw.body_enc);
  assert.equal(raw.campaign_id, null, 'health-segment membership must not be joined from plaintext metadata');
  assert.match(raw.dedupe_key, /^health_v1_[a-f0-9]{64}$/);
  assert.ok(!raw.dedupe_key.includes(campaign.id));
  assert.throws(() => crm.pii.decrypt(raw.body_enc), 'the shopper-PII key cannot decrypt health message content');
  const outbox = await f.ok(f.owner({ method: 'GET', url: `/api/crm/outbox?shopperId=${shopper.id}` }));
  assert.equal(outbox[0].subject, 'Synthetic cycle subject');
  assert.match(outbox[0].body, /^Phase=luteal next=\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(raw).includes(outbox[0].body.split('next=')[1]), 'no next-period date may remain in a raw outbox field');
  assert.equal(outbox[0].healthWithheld, false);
  assert.equal(outbox[0].campaignId, campaign.id);
  assert.equal(outbox[0].bodyEnc, undefined);
  const log = await health.accessLog(shopper.id);
  assert.ok(log.some(e => e.action === 'outbox_write' && e.purpose === 'campaign'));
  assert.ok(log.some(e => e.action === 'outbox_read' && e.purpose === 'campaign' && e.actor === 'owner'));
  await assert.rejects(health.readMessage(shopper.id, raw.body_enc, {}), e => e.code === 'PURPOSE_REQUIRED');
});

test('health consent revocation withholds queued content; only explicit DSAR export can bypass it', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health, privacy } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'revoked-outbox@example.test');
  await crm.runCampaign(campaign.id);
  await crm.setConsent(shopper.id, { health: false });
  const before = (await health.accessLog(shopper.id)).filter(e => e.action === 'outbox_read').length;
  const outbox = await f.ok(f.owner({ method: 'GET', url: `/api/crm/outbox?shopperId=${shopper.id}` }));
  assert.equal(outbox[0].healthWithheld, true);
  assert.equal(outbox[0].body, '[health content withheld]');
  assert.equal(outbox[0].subject, '[health content withheld]');
  assert.equal(outbox[0].campaignId, null);
  assert.ok(!JSON.stringify(outbox).includes('luteal'));
  assert.equal((await health.accessLog(shopper.id)).filter(e => e.action === 'outbox_read').length, before);
  await assert.rejects(crm.outbox({ shopperId: shopper.id, purpose: 'campaign', bypassConsent: true }), e => e.code === 'CONSENT_REQUIRED');
  const exported = await privacy.export(shopper.id, 'dsar-reviewer');
  assert.match(exported.messages[0].body, /^Phase=luteal next=/);
  assert.ok((await health.accessLog(shopper.id)).some(e => e.action === 'outbox_read' && e.purpose === 'dsar_export' && e.actor === 'dsar-reviewer'));
});

test('legacy health campaign rows are withheld until an explicit migration batch protects them', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'legacy-outbox@example.test');
  const legacyKey = `${campaign.id}:${shopper.id}`;
  await f.db.query(`INSERT INTO message_outbox(id,campaign_id,shopper_id,channel,recipient_enc,recipient_hint,subject,body,dedupe_key,created_at)
    VALUES('msg_legacy_review',$1,$2,'email',$3,'s***@example.test','LEGACY_HEALTH_SUBJECT','LEGACY_HEALTH_BODY',$4,$5)`,
    [campaign.id, shopper.id, crm.pii.encrypt('legacy-outbox@example.test'), legacyKey, f.clock()]);
  await crm.setConsent(shopper.id, { health: false });
  assert.equal((await crm.outbox({shopperId:shopper.id}))[0].migrationPending,true);
  await health.migrateOutbox({force:true});
  const outbox = await crm.outbox({ shopperId: shopper.id, actor: 'reviewer', purpose: 'campaign' });
  assert.equal(outbox[0].body, '[health content withheld]');
  const raw = (await f.db.query("SELECT subject,body,body_enc,contains_health,campaign_id,dedupe_key FROM message_outbox WHERE id='msg_legacy_review'")).rows[0];
  assert.equal(raw.contains_health, true);
  assert.equal(raw.subject, '[health message]');
  assert.equal(raw.body, '[health message]');
  assert.ok(raw.body_enc);
  assert.ok(!JSON.stringify(raw).includes('LEGACY_HEALTH'));
  assert.equal(raw.campaign_id, null);
  assert.equal(raw.dedupe_key, health.messageDedupe(legacyKey));
  const exportRead = await crm.outbox({ shopperId: shopper.id, actor: 'reviewer', purpose: 'dsar_export', bypassConsent: true });
  assert.equal(exportRead[0].body, 'LEGACY_HEALTH_BODY');
  assert.equal(exportRead[0].campaignId, campaign.id);
  await crm.setConsent(shopper.id, { health: true });
  assert.equal((await crm.runCampaign(campaign.id)).queued, 0, 'migrated dedupe keys must preserve existing delivery idempotency');
  assert.ok((await health.accessLog(shopper.id)).some(e => e.action === 'outbox_encrypt'));
});

test('ordinary campaigns and transactional messages retain non-health semantics without health consent', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm } = f.platform;
  const shopper = await crm.upsertShopper({ email: 'ordinary-outbox@example.test', firstName: 'Synthetic', consent: { email: true, marketing: true, health: false } });
  const segment = await crm.createSegment({ rules: { minSpendCents: 0 } });
  const campaign = await crm.createCampaign({ name: 'Hello', kind: 'broadcast', channel: 'email', segmentId: segment.id, template: 'Hello {{firstName}}' });
  assert.equal((await crm.runCampaign(campaign.id)).queued, 1);
  await crm.sendTransactional(shopper.id, { subject: 'Support update', body: 'Your ticket is resolved.', dedupeKey: 'ordinary-review' });
  const outbox = await crm.outbox({ shopperId: shopper.id });
  assert.ok(outbox.some(m => m.body === 'Hello Synthetic' && m.subject === 'Hello'));
  assert.ok(outbox.some(m => m.body === 'Your ticket is resolved.' && m.subject === 'Support update'));
  assert.ok(outbox.every(m => m.healthWithheld === undefined));
  const raw = (await f.db.query('SELECT contains_health,body_enc FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows;
  assert.ok(raw.every(m => m.contains_health === false && m.body_enc === null));
});

test('campaign checks fresh health consent before enqueue and ciphertext cannot be reassigned to another shopper', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'race-outbox@example.test');
  const original = health.encryptMessage.bind(health);
  health.encryptMessage = async (...args) => { await crm.setConsent(shopper.id, { health: false }); return original(...args); };
  const result = await crm.runCampaign(campaign.id);
  assert.equal(result.queued, 0);
  assert.equal(result.skipped[0].reason, 'NO_HEALTH_CONSENT');
  health.encryptMessage = original;
  await crm.setConsent(shopper.id, { health: true });
  await crm.runCampaign(campaign.id);
  const raw = (await f.db.query('SELECT body_enc FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows[0];
  const other = await crm.upsertShopper({ email: 'other-outbox@example.test', consent: { health: true } });
  assert.equal(await health.readMessage(other.id, raw.body_enc, { actor: 'reviewer', purpose: 'campaign' }), null);
  assert.equal(await health.readMessage(shopper.id, 'bad-ciphertext', { actor: 'reviewer', purpose: 'campaign' }), null);
});

test('DSAR erasure removes encrypted health-message copies and never re-encrypts erased placeholders', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, privacy } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'erased-outbox@example.test');
  await crm.runCampaign(campaign.id);
  await privacy.erase(shopper.id, 'reviewer', { confirm: 'DELETE' });
  const outbox = await crm.outbox({ shopperId: shopper.id });
  assert.equal(outbox[0].healthWithheld, true);
  const raw = (await f.db.query('SELECT body,body_enc,subject FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows[0];
  assert.equal(raw.body, '[erased]');
  assert.equal(raw.subject, '[erased]');
  assert.equal(raw.body_enc, null);
});

test('erasure between campaign rendering and enqueue cannot resurrect a health message', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, health, privacy } = f.platform;
  const { shopper, campaign } = await healthCampaign(f, 'erase-race-outbox@example.test');
  const original = health.encryptMessage.bind(health);
  health.encryptMessage = async (...args) => {
    const encrypted = await original(...args);
    await privacy.erase(shopper.id, 'reviewer', { confirm: 'DELETE' });
    return encrypted;
  };
  const result = await crm.runCampaign(campaign.id);
  assert.equal(result.queued, 0);
  assert.equal(result.skipped[0].reason, 'NO_CONSENT');
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS count FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows[0].count, 0);
});

test('completed erasure before transactional enqueue cannot resurrect recipient or freeform content', { timeout: 60_000 }, async t => {
  const f = await platformFixture(t);
  const { crm, privacy, health } = f.platform;
  const shopper = await crm.upsertShopper({ email: 'transactional-race@example.test', consent: { email: false, marketing: false } });
  // Existing service-email semantics intentionally do not require marketing/contact
  // opt-in. The privacy fix must not silently turn those service messages off.
  assert.ok(await crm.sendTransactional(shopper.id, { subject: 'Service notice', body: 'Before deletion', dedupeKey: 'service-before-delete' }));
  let erased = false;
  const eraseOnce = async () => {
    if (!erased) { erased = true; await privacy.erase(shopper.id, 'reviewer', { confirm: 'DELETE' }); }
  };
  const guardedDb = {
    query: async (sql, params) => {
      // This intercepts the vulnerable pre-fix non-transactional insert after its
      // shopper read. The fixed path is intercepted before acquiring its transaction.
      if (/INSERT INTO message_outbox/.test(sql)) await eraseOnce();
      return f.db.query(sql, params);
    },
    transaction: async fn => { await eraseOnce(); return f.db.transaction(fn); },
  };
  const racingCrm = createCrm(guardedDb, { secret: f.config.encryptionKey, clock: f.clock, health, domain: f.domain });
  await assert.rejects(racingCrm.sendTransactional(shopper.id, { subject: 'PRIVATE_SUBJECT_REENTRY', body: 'PRIVATE_BODY_REENTRY', dedupeKey: 'after-erase' }), e => e.code === 'NOT_FOUND');
  assert.equal(erased, true);
  const raw = (await f.db.query('SELECT recipient_enc,recipient_hint,subject,body FROM message_outbox WHERE shopper_id=$1', [shopper.id])).rows;
  assert.equal(raw.length, 1, 'only the previously scrubbed notice may remain');
  assert.deepEqual(raw[0], { recipient_enc: 'erased', recipient_hint: 'erased', subject: '[erased]', body: '[erased]' });
});
