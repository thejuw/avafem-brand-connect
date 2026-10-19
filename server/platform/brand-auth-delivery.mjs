import { isIP } from 'node:net';
import { hash } from '../auth.mjs';
import { first, rows } from './util.mjs';
import { createResendInviteAdapter } from './invite-delivery.mjs';

// No request-controlled origin, transport URL or credentials. Configuration is
// server-only; local-only tests inject transports and never send real email.
export function authLinkOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash
      || isIP(u.hostname) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)
      || /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

/** Verify the sending domain (including SPF + DKIM) before any auth email.
 * GET only: never creates domains, modifies DNS or enables a provider account.
 * https://resend.com/docs/api-reference/domains/get-domain */
export function createResendAuthAdapter({ apiKey, from, domainId, fetch: transport = globalThis.fetch } = {}) {
  const sender = createResendInviteAdapter({ apiKey, from, fetch: transport });
  if (!sender || !/^[a-f0-9-]{36}$/i.test(domainId || '')) return null;
  const domain = from.split('@')[1].toLowerCase();
  return {
    provider: 'resend', simulated: false,
    async checkDomain() {
      try {
        const r = await transport(`https://api.resend.com/domains/${domainId}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${apiKey}` } });
        if (!r.ok) return false;
        const raw = await r.text(); if (raw.length > 32_768) return false;
        const d = JSON.parse(raw), records = Array.isArray(d.records) ? d.records : [];
        return d.id === domainId && d.name === domain && d.status === 'verified' && d.capabilities?.sending === 'enabled'
          && d.click_tracking === false // never let tracking rewrite bearer links
          && ['SPF', 'DKIM'].every(kind => {
            const set = records.filter(r => r.record === kind);
            return set.length > 0 && set.every(r => r.status === 'verified');
          });
      } catch { return false; }
    },
    send: input => sender.send({ ...input, operationId: `brand-auth:${input.operationId}` }),
  };
}

/** A claimed dispatch is never automatically retried after an unknown outcome.
 * The encrypted mailbox is retained for local tests, not exposed by default.
 * Provider acceptance is not inbox delivery. No I/O on construction or login. */
export async function createBrandAuthDelivery(db, { auth, clock = () => new Date(), publicBaseUrl, adapter = null, enableExternal = false } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS brand_auth_deliveries (
    mail_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','uncertain','expired','blocked')),
    provider_id TEXT, error_code TEXT, attempted_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  )`);
  const origin = authLinkOrigin(publicBaseUrl);
  const configured = Boolean(origin && adapter && typeof adapter.checkDomain === 'function' && typeof adapter.send === 'function'
    && (adapter.simulated === true || enableExternal === true));
  const simulated = !configured || adapter.simulated === true;
  return {
    capabilities() { return { configured, simulated, provider: configured ? adapter.provider : null, delivered: false, externalDeliveryAllowed: enableExternal === true }; },
    async run({ limit = 10 } = {}) {
      if (!configured) return { status: 'not_configured', simulated: true, dispatched: 0, delivered: false };
      const pending = await first(db, 'SELECT o.id FROM brand_auth_outbox o WHERE NOT EXISTS (SELECT 1 FROM brand_auth_deliveries d WHERE d.mail_id=o.id) LIMIT 1');
      if (!pending) return { status: 'idle', simulated, dispatched: 0, providerAccepted: 0, delivered: false };
      // Verification failure does not consume links; the worker can recheck DNS
      // on its next scheduled run. No recipient-dependent provider I/O at login.
      if (await adapter.checkDomain() !== true) return { status: 'domain_unverified', simulated, dispatched: 0, delivered: false };
      const claims = await db.transaction(async tx => {
        const mail = await rows(tx, `SELECT o.* FROM brand_auth_outbox o WHERE NOT EXISTS
          (SELECT 1 FROM brand_auth_deliveries d WHERE d.mail_id=o.id) ORDER BY o.created_at,o.id LIMIT $1 FOR UPDATE`, [Math.max(1, Math.min(100, Number(limit) || 10))]);
        const claimed = [];
        for (const m of mail) {
          let state = 'expired', body, recipient, tokenHash;
          try {
            body = auth.decrypt(m.bodyEnc); recipient = auth.decrypt(m.toEnc);
            const urls = String(body).match(/https?:\/\/[^\s]+/g) || [];
            const u = urls.length === 1 ? new URL(urls[0]) : null;
            const raw = u && /^#(?:token|invite)=([A-Za-z0-9_-]{43})$/.exec(u.hash)?.[1];
            tokenHash = raw ? hash(raw) : null;
            await auth.lockBrandMembership(tx, m.brandId);
            const member = await first(tx, "SELECT * FROM brand_members WHERE id=$1 AND brand_id=$2 AND status IN ('invited','active') FOR UPDATE", [m.memberId, m.brandId]);
            const t = raw ? await first(tx, 'SELECT * FROM brand_login_tokens WHERE token_hash=$1 FOR UPDATE', [hash(raw)]) : null;
            if (!u || u.origin !== origin || u.pathname !== '/brand/login' || u.search || u.username || u.password || !raw
              || !/^[^@\s\r\n]+@[^@\s\r\n]+\.[^@\s\r\n]+$/.test(recipient)) state = 'blocked';
            else if (member && t && t.memberId === m.memberId && t.brandId === m.brandId && !t.consumedAt && new Date(t.expiresAt) > clock()) state = 'dispatching';
          } catch { state = 'blocked'; }
          await tx.query('INSERT INTO brand_auth_deliveries(mail_id,state,attempted_at,updated_at) VALUES($1,$2,$3,$3)', [m.id, state, clock()]);
          if (state === 'dispatching') claimed.push({ mailId: m.id, memberId: m.memberId, brandId: m.brandId, tokenHash, to: recipient, body });
        }
        return claimed;
      });
      let accepted = 0, dispatched = 0;
      for (const m of claims) {
        // Earlier sends can wait on provider I/O. Recheck each later claim at
        // its own dispatch point, not only when the whole batch was reserved.
        const eligible = await db.transaction(async tx => {
          await auth.lockBrandMembership(tx, m.brandId);
          const member = await first(tx, "SELECT id FROM brand_members WHERE id=$1 AND brand_id=$2 AND status IN ('invited','active') FOR UPDATE", [m.memberId, m.brandId]);
          const t = await first(tx, 'SELECT * FROM brand_login_tokens WHERE token_hash=$1 FOR UPDATE', [m.tokenHash]);
          const delivery = await first(tx, 'SELECT state FROM brand_auth_deliveries WHERE mail_id=$1 FOR UPDATE', [m.mailId]);
          const valid = Boolean(member && t && t.memberId === m.memberId && t.brandId === m.brandId && !t.consumedAt && new Date(t.expiresAt) > clock() && delivery?.state === 'dispatching');
          if (!valid) await tx.query("UPDATE brand_auth_deliveries SET state='expired',updated_at=$2 WHERE mail_id=$1 AND state='dispatching'", [m.mailId, clock()]);
          return valid;
        });
        if (!eligible) continue;
        dispatched++;
        let receipt;
        try { receipt = await adapter.send({ to: m.to, body: m.body, subject: 'Your Avafem brand sign-in link', operationId: m.mailId }); } catch { /* provider outcome requires review, never replay blindly */ }
        const valid = receipt?.accepted === true && /^[A-Za-z0-9_-]{1,100}$/.test(receipt?.id || '');
        await db.query("UPDATE brand_auth_deliveries SET state=$2,provider_id=$3,error_code=$4,updated_at=$5 WHERE mail_id=$1 AND state='dispatching'", [m.mailId, valid ? 'accepted' : 'uncertain', valid ? receipt.id : null, valid ? null : 'AUTH_EMAIL_UNCERTAIN', clock()]);
        if (valid) accepted++;
      }
      return { status: 'processed', simulated, dispatched, providerAccepted: accepted, delivered: false };
    },
  };
}
