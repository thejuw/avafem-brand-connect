import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ROLE_SCOPES, MEMBER_ROLES, hash } from '../auth.mjs';
import { productReviewFingerprint, checkProduct } from './compliance.mjs';
import { PLACEMENT_PRICING } from './brands.mjs';
import { DAY, id, first, rows, fail } from './util.mjs';

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LINK_TTL_MS = 15 * 60_000;
const LINKS_PER_WINDOW = 3;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
const token = () => randomBytes(32).toString('base64url');
const normalizeEmail = value => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.');
  return email;
};
const mask = email => { const [local, domain] = email.split('@'); return `${local.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`; };
// CSV cells are escaped and spreadsheet-formula prefixes neutralised.
export const csvCell = value => { let v = value == null ? '' : String(value); if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; return /[",\n\r']/.test(v) ? `"${v.replaceAll('"', '""')}"` : v; };
export const toCsv = (header, list) => [header.join(','), ...list.map(r => header.map(h => csvCell(r[h])).join(','))].join('\n');

/** Brand portal: member logins (magic link + optional scrypt password),
 * owner/staff/finance team roles, brand-facing review status, statements.
 * Email delivery is a simulated, encrypted outbox only. */
export function createBrandPortal(db, { auth, domain, brands, reports, secret, clock = () => new Date(), publicBaseUrl, emailCapabilities = () => ({ simulated: true }) }) {
  const now = () => clock();
  const emailKey = email => createHmac('sha256', String(secret)).update('avafem:brand-member-email:v1\0').update(email).digest('hex');
  const view = m => m && ({ id: m.id, brandId: m.brandId, email: auth.decrypt(m.emailEnc), role: m.role, status: m.status, hasPassword: Boolean(m.passwordHash),
    createdAt: m.createdAt, lastLoginAt: m.lastLoginAt || null, invitedBy: m.invitedBy || null });
  const actorOf = ctx => ctx?.memberId ? `member:${ctx.memberId}` : ctx?.role === 'admin' ? 'owner-workspace' : ctx?.role || 'system';
  const audit = (q, ctx, brandId, action, resourceId) => q.query('INSERT INTO audit_log(actor,brand_id,action,resource_id,created_at) VALUES($1,$2,$3,$4,$5)', [actorOf(ctx), brandId, action, resourceId, now()]);
  const link = (purpose, raw) => `${(publicBaseUrl || '').replace(/\/$/, '')}/brand/login#${purpose === 'invite' ? 'invite' : 'token'}=${raw}`;

  async function issueLink(q, member, purpose) {
    const recent = await first(q, 'SELECT COUNT(*)::int AS c FROM brand_login_tokens WHERE member_id=$1 AND created_at>$2', [member.id, new Date(now().getTime() - LINK_TTL_MS)]);
    if (recent.c >= LINKS_PER_WINDOW) return false; // silently throttled; response stays generic
    const raw = token();
    await q.query('UPDATE brand_login_tokens SET consumed_at=$2 WHERE member_id=$1 AND consumed_at IS NULL', [member.id, now()]); // newest link only
    await q.query('INSERT INTO brand_login_tokens(token_hash,member_id,brand_id,purpose,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [hash(raw), member.id, member.brandId, purpose, new Date(now().getTime() + LINK_TTL_MS), now()]);
    const brand = await first(q, 'SELECT name FROM brands WHERE id=$1', [member.brandId]);
    const body = `${purpose === 'invite' ? `You've been invited to the ${brand?.name || 'Avafem'} brand portal.` : `Sign in to the ${brand?.name || 'Avafem'} brand portal.`}\n\nThis single-use link expires in 15 minutes:\n${link(purpose, raw)}\n\nIf you didn't ask for this, ignore this email.`;
    await q.query('INSERT INTO brand_auth_outbox(id,member_id,brand_id,purpose,to_enc,body_enc,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id('bmail'), member.id, member.brandId, purpose, member.emailEnc, auth.encrypt(body), now()]);
    return true;
  }
  async function memberRow(q, brandId, memberId, lock = false) {
    const m = await first(q, `SELECT * FROM brand_members WHERE id=$1 AND brand_id=$2 AND status<>'removed'${lock ? ' FOR UPDATE' : ''}`, [memberId, brandId]);
    if (!m) fail('Team member not found.', 404, 'NOT_FOUND');
    return m;
  }
  async function assertOwnerRemains(tx, brandId, excludingId) {
    const owners = await first(tx, "SELECT COUNT(*)::int AS c FROM brand_members WHERE brand_id=$1 AND role='owner' AND status='active' AND id<>$2", [brandId, excludingId]);
    if (!owners.c) fail('A brand must keep at least one owner. Add another owner first.', 409, 'LAST_OWNER');
  }
  const hashPassword = async password => { const salt = randomBytes(16); const key = await scrypt(password, salt, 64, SCRYPT); return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`; };
  const verifyPassword = async (password, stored) => {
    // Exactly one fixed-cost KDF even for unknown/locked/ambiguous accounts or
    // corrupt hashes. Never interpret arbitrary persisted cost parameters.
    const valid = typeof stored === 'string' && /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(stored);
    const parts = valid ? stored.split('$') : null;
    const want = parts ? Buffer.from(parts[5], 'base64url') : Buffer.alloc(64);
    const got = await scrypt(String(password), parts ? Buffer.from(parts[4], 'base64url') : Buffer.alloc(16), 64, SCRYPT);
    return valid && want.length === got.length && timingSafeEqual(want, got);
  };
  const checkPassword = value => { if (typeof value !== 'string' || value.length < 12 || value.length > 200) fail('Use a password of 12 to 200 characters.'); return value; };

  const api = {
    roles: MEMBER_ROLES,
    roleScopes: ROLE_SCOPES,
    async listMembers(brandId) { return (await rows(db, "SELECT * FROM brand_members WHERE brand_id=$1 AND status<>'removed' ORDER BY created_at,id", [brandId])).map(view); },
    async addMember(brandId, input, ctx) {
      const email = normalizeEmail(input.email); const role = MEMBER_ROLES.includes(input.role) ? input.role : fail('role must be owner, staff or finance.');
      await domain.getBrand(brandId);
      return db.transaction(async tx => {
        await auth.requireMemberOwner(tx, brandId, ctx);
        const key = emailKey(email);
        const existing = await first(tx, 'SELECT * FROM brand_members WHERE brand_id=$1 AND email_key=$2 FOR UPDATE', [brandId, key]);
        if (existing && existing.status !== 'removed') fail('This person is already on your team.', 409, 'MEMBER_EXISTS');
        const member = existing
          ? await first(tx, "UPDATE brand_members SET role=$2,status='invited',password_hash=NULL,failed_logins=0,locked_until=NULL,removed_at=NULL,auth_version=auth_version+1,invited_by=$3,updated_at=$4 WHERE id=$1 RETURNING *", [existing.id, role, actorOf(ctx), now()])
          : await first(tx, "INSERT INTO brand_members(id,brand_id,email_key,email_enc,role,status,invited_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'invited',$6,$7,$7) RETURNING *",
            [id('member'), brandId, key, auth.encrypt(email), role, actorOf(ctx), now()]);
        const sent = await issueLink(tx, member, 'invite');
        await audit(tx, ctx, brandId, 'brand_member.invited', member.id);
        return { ...view(member), invitation: { simulated: emailCapabilities().simulated !== false, delivered: false, queued: sent, recipientHint: mask(email) } };
      });
    },
    async changeRole(brandId, memberId, role, ctx) {
      if (!MEMBER_ROLES.includes(role)) fail('role must be owner, staff or finance.');
      return db.transaction(async tx => {
        await auth.requireMemberOwner(tx, brandId, ctx);
        const m = await memberRow(tx, brandId, memberId, true);
        if (m.role === 'owner' && role !== 'owner') await assertOwnerRemains(tx, brandId, m.id);
        const out = await first(tx, 'UPDATE brand_members SET role=$2,updated_at=$3 WHERE id=$1 RETURNING *', [m.id, role, now()]);
        await audit(tx, ctx, brandId, `brand_member.role_changed.${m.role}_to_${role}`, m.id);
        return view(out);
      });
    },
    async removeMember(brandId, memberId, ctx) {
      return db.transaction(async tx => {
        await auth.requireMemberOwner(tx, brandId, ctx);
        const m = await memberRow(tx, brandId, memberId, true);
        if (m.role === 'owner') await assertOwnerRemains(tx, brandId, m.id);
        await tx.query("UPDATE brand_members SET status='removed',removed_at=$2,password_hash=NULL,auth_version=auth_version+1,updated_at=$2 WHERE id=$1", [m.id, now()]);
        await tx.query('DELETE FROM auth_sessions WHERE member_id=$1', [m.id]);
        await tx.query('UPDATE brand_login_tokens SET consumed_at=$2 WHERE member_id=$1 AND consumed_at IS NULL', [m.id, now()]);
        await audit(tx, ctx, brandId, 'brand_member.removed', m.id);
        return { id: m.id, removed: true };
      });
    },
    /** Always returns the same generic result so addresses cannot be enumerated. */
    async requestLogin(rawEmail) {
      let email; try { email = normalizeEmail(rawEmail); } catch { return { requested: true }; }
      await db.transaction(async tx => {
        const members = await rows(tx, "SELECT id,brand_id FROM brand_members WHERE email_key=$1 AND status IN ('invited','active') ORDER BY brand_id LIMIT 10", [emailKey(email)]);
        for (const candidate of members) {
          await auth.lockBrandMembership(tx, candidate.brandId);
          const m = await first(tx, "SELECT * FROM brand_members WHERE id=$1 AND brand_id=$2 AND status IN ('invited','active') FOR UPDATE", [candidate.id, candidate.brandId]);
          if (m && await issueLink(tx, m, m.status === 'invited' ? 'invite' : 'login')) await audit(tx, { memberId: m.id }, m.brandId, 'brand_auth.link_requested', m.id);
        }
      });
      return { requested: true };
    },
    /** Atomically consume a single-use, expiring link. */
    async consumeLink(raw) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) fail('This sign-in link is invalid, expired or already used.', 401, 'LOGIN_LINK_INVALID');
      return db.transaction(async tx => {
        const hint = await first(tx, 'SELECT member_id,brand_id FROM brand_login_tokens WHERE token_hash=$1', [hash(raw)]);
        if (!hint) fail('This sign-in link is invalid, expired or already used.', 401, 'LOGIN_LINK_INVALID');
        await auth.lockBrandMembership(tx, hint.brandId);
        const m = await first(tx, "SELECT * FROM brand_members WHERE id=$1 AND brand_id=$2 AND status IN ('invited','active') FOR UPDATE", [hint.memberId, hint.brandId]);
        if (!m) fail('This sign-in link is invalid, expired or already used.', 401, 'LOGIN_LINK_INVALID');
        const t = await first(tx, 'SELECT * FROM brand_login_tokens WHERE token_hash=$1 FOR UPDATE', [hash(raw)]);
        if (!t || t.memberId !== m.id || t.brandId !== m.brandId || t.consumedAt || !Number.isFinite(new Date(t.expiresAt).getTime()) || new Date(t.expiresAt) <= now()) fail('This sign-in link is invalid, expired or already used.', 401, 'LOGIN_LINK_INVALID');
        await tx.query('UPDATE brand_login_tokens SET consumed_at=$2 WHERE token_hash=$1', [hash(raw), now()]);
        const out = await first(tx, "UPDATE brand_members SET status='active',last_login_at=$2,failed_logins=0,locked_until=NULL,updated_at=$2 WHERE id=$1 RETURNING *", [m.id, now()]);
        await audit(tx, { memberId: m.id }, m.brandId, 'brand_auth.link_login', m.id);
        return { ...view(out), sessionVersion: out.authVersion };
      });
    },
    async passwordLogin({ email: rawEmail, password, brandId }) {
      const invalid = () => fail('Email or password is incorrect.', 401, 'INVALID_LOGIN');
      let email; try { email = normalizeEmail(rawEmail); } catch { await verifyPassword('x', null); invalid(); }
      if (typeof password !== 'string' || password.length > 200) { await verifyPassword('x', null); invalid(); }
      const candidates = await rows(db, "SELECT * FROM brand_members WHERE email_key=$1 AND status='active' AND password_hash IS NOT NULL" + (brandId ? ' AND brand_id=$2' : '') + ' ORDER BY brand_id LIMIT 2', brandId ? [emailKey(email), brandId] : [emailKey(email)]);
      // Multiple memberships require an explicit brand ID or emailed link; do
      // not leak their count through status or one expensive KDF per member.
      const candidate = candidates.length === 1 ? candidates[0] : null;
      const unlocked = candidate && !(candidate.lockedUntil && new Date(candidate.lockedUntil) > now());
      const matches = await verifyPassword(password, unlocked ? candidate.passwordHash : null);
      if (!candidate) invalid();
      const out = await db.transaction(async tx => {
        await auth.lockBrandMembership(tx, candidate.brandId);
        const m = await first(tx, 'SELECT * FROM brand_members WHERE id=$1 AND brand_id=$2 FOR UPDATE', [candidate.id, candidate.brandId]);
        if (!m || m.status !== 'active' || m.passwordHash !== candidate.passwordHash || m.authVersion !== candidate.authVersion || (m.lockedUntil && new Date(m.lockedUntil) > now())) return null;
        if (!matches) {
          const count = m.failedLogins + 1;
          await tx.query('UPDATE brand_members SET failed_logins=$2,locked_until=$3 WHERE id=$1', [m.id, count >= MAX_FAILED_LOGINS ? 0 : count, count >= MAX_FAILED_LOGINS ? new Date(now().getTime() + LOCK_MS) : null]);
          if (count >= MAX_FAILED_LOGINS) await audit(tx, { memberId: m.id }, m.brandId, 'brand_auth.locked', m.id);
          return null; // commit the failure counter, then return the generic error
        }
        const result = await first(tx, 'UPDATE brand_members SET failed_logins=0,locked_until=NULL,last_login_at=$2 WHERE id=$1 RETURNING *', [m.id, now()]);
        await audit(tx, { memberId: m.id }, m.brandId, 'brand_auth.password_login', m.id);
        return result;
      });
      if (!out) invalid();
      return { ...view(out), sessionVersion: out.authVersion };
    },
    async setPassword(ctx, { currentPassword, newPassword }) {
      if (!ctx.memberId) fail('Sign in with your own email to set a password.', 403, 'MEMBER_SESSION_REQUIRED');
      checkPassword(newPassword);
      const m = await memberRow(db, ctx.brandId, ctx.memberId);
      if (m.passwordHash && !(typeof currentPassword === 'string' && currentPassword.length <= 200 && await verifyPassword(currentPassword, m.passwordHash))) fail('Your current password is incorrect.', 403, 'INVALID_PASSWORD');
      const nextHash = await hashPassword(newPassword);
      await db.transaction(async tx => {
        await auth.lockBrandMembership(tx, ctx.brandId);
        const fresh = await memberRow(tx, ctx.brandId, ctx.memberId, true);
        if (fresh.status !== 'active' || fresh.passwordHash !== m.passwordHash || fresh.authVersion !== m.authVersion) fail('Sign in again before changing your password.', 409, 'PASSWORD_CHANGED');
        await tx.query('UPDATE brand_members SET password_hash=$2,auth_version=auth_version+1,updated_at=$3 WHERE id=$1', [m.id, nextHash, now()]);
        await tx.query('DELETE FROM auth_sessions WHERE member_id=$1 AND token_hash IS DISTINCT FROM $2', [m.id, ctx.tokenHash || null]);
        await tx.query('UPDATE brand_login_tokens SET consumed_at=$2 WHERE member_id=$1 AND consumed_at IS NULL', [m.id, now()]);
        await audit(tx, ctx, ctx.brandId, 'brand_auth.password_set', m.id);
      });
      return { passwordSet: true, otherSessionsSignedOut: true };
    },
    async me(ctx) {
      const brand = await domain.getBrand(ctx.brandId);
      const m = ctx.memberId ? view(await memberRow(db, ctx.brandId, ctx.memberId)) : null;
      return { brandId: ctx.brandId, brandName: brand.name, memberId: ctx.memberId || null, email: m?.email || null, role: ctx.memberRole, scopes: ctx.scopes,
        hasPassword: m?.hasPassword || false, session: ctx.memberId ? 'member' : 'invite_link', csrfToken: ctx.csrfToken, sandbox: true };
    },
    /** Simulated outbox (sandbox only). Decrypts bodies; callers must be authorised. */
    async outbox({ brandId, memberId, limit = 20 } = {}) {
      const list = await rows(db, `SELECT * FROM brand_auth_outbox WHERE ($1::text IS NULL OR brand_id=$1) AND ($2::text IS NULL OR member_id=$2) ORDER BY created_at DESC,id DESC LIMIT $3`, [brandId || null, memberId || null, Math.min(100, limit)]);
      return list.map(e => ({ id: e.id, brandId: e.brandId, memberId: e.memberId, purpose: e.purpose, to: auth.decrypt(e.toEnc), body: auth.decrypt(e.bodyEnc), simulated: true, delivered: false, createdAt: e.createdAt }));
    },

    // ---------- product review status ----------
    async productStatus(brandId) {
      const list = await rows(db, 'SELECT * FROM products WHERE brand_id=$1 ORDER BY updated_at DESC,id', [brandId]);
      const counts = { draft: 0, in_review: 0, approved: 0, rejected: 0 };
      const products = list.map(p => {
        counts[p.status] = (counts[p.status] || 0) + 1;
        const compliance = checkProduct(p); const fingerprint = productReviewFingerprint(p);
        const changedSinceReview = Boolean(p.reviewedFingerprint && p.reviewedFingerprint !== fingerprint);
        const issues = Array.isArray(p.validationIssues) ? p.validationIssues : [];
        const fixes = [
          ...issues.map(i => ({ kind: 'validation', field: i.field || null, message: typeof i === 'string' ? i : i.message || String(i.code || 'Fix this field.') })),
          ...compliance.flags.map(f => ({ kind: f.severity === 'block' ? 'compliance_block' : 'compliance_warning', code: f.code, field: f.field, match: f.match, message: f.message })),
          ...(p.sourceDeletedAt ? [{ kind: 'source', message: 'This product was removed from your store. Restore it there to relist.' }] : []),
          ...(p.status === 'rejected' && p.reviewNote ? [{ kind: 'reviewer_note', message: p.reviewNote }] : []),
        ];
        const canResubmit = ['draft', 'rejected'].includes(p.status) && !issues.length && !p.sourceDeletedAt && (p.status === 'draft' || changedSinceReview || !p.reviewedFingerprint);
        return { id: p.id, sku: p.sku, title: p.title, status: p.status, priceCents: p.priceCents, inventoryQty: p.inventoryQty, image: (p.images || [])[0] || null,
          reviewNote: p.reviewNote || '', reviewedAt: p.reviewedAt || null, updatedAt: p.updatedAt, changedSinceReview,
          compliance: { status: compliance.status, flags: compliance.flags, needsAvafemOverride: compliance.status === 'blocked' }, whatToFix: fixes, canResubmit };
      });
      return { brandId, counts, listed: counts.approved, inReview: counts.in_review, products,
        note: 'Avafem curators approve every listing. Price and stock changes sync without review; content changes go back to review.' };
    },
    async resubmit(brandId, productId, ctx) {
      return db.transaction(async tx => {
        await tx.query('SELECT id FROM products WHERE id=$1 AND brand_id=$2 FOR UPDATE', [productId, brandId]);
        const p = await first(tx, 'SELECT * FROM products WHERE id=$1 AND brand_id=$2', [productId, brandId]);
        if (!p) fail('Product not found.', 404, 'NOT_FOUND');
        if (!['draft', 'rejected'].includes(p.status)) fail(`This product is already ${p.status.replace('_', ' ')}.`, 409, 'NOT_RESUBMITTABLE');
        if ((p.validationIssues || []).length) fail('Fix the listed catalog issues before resubmitting.', 409, 'CATALOG_INVALID');
        if (p.sourceDeletedAt) fail('Restore this product in your store first.', 409, 'SOURCE_DELETED');
        if (p.status === 'rejected' && p.reviewedFingerprint && p.reviewedFingerprint === productReviewFingerprint(p)) fail('Edit the listing to address the review notes before resubmitting.', 409, 'EDIT_REQUIRED');
        const out = await first(tx, "UPDATE products SET status='in_review',review_note='Resubmitted by brand.',updated_at=$2 WHERE id=$1 RETURNING id,sku,status", [p.id, now()]);
        await audit(tx, ctx, brandId, 'product.resubmitted', p.id);
        return out;
      });
    },

    // ---------- statements and annual report ----------
    async statement(brandId, month) {
      const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || '')); if (!m) fail('month must be YYYY-MM.');
      const start = new Date(Date.UTC(+m[1], +m[2] - 1, 1)); const end = new Date(Date.UTC(+m[1], +m[2], 1));
      const brand = await domain.getBrand(brandId);
      const lines = await rows(db, `SELECT t.id AS transfer_id,t.bag_id,t.status,t.amount_cents,t.reversed_cents,t.due_at,t.paid_at,t.created_at,
        b.subtotal_cents,b.total_cents,b.commission_cents,b.refunded_cents FROM transfers t JOIN bags b ON b.id=t.bag_id AND b.brand_id=t.brand_id
        WHERE t.brand_id=$1 AND t.created_at>=$2 AND t.created_at<$3 ORDER BY t.created_at,t.id`, [brandId, start, end]);
      const out = lines.map(l => ({ transferId: l.transferId, bagId: l.bagId, createdAt: l.createdAt, status: l.status, dueAt: l.dueAt || '', paidAt: l.paidAt || '',
        merchandiseCents: l.subtotalCents, commissionCents: l.commissionCents, refundedCents: l.refundedCents, transferCents: l.amountCents, reversedCents: l.reversedCents, netCents: l.amountCents - l.reversedCents }));
      const sum = k => out.reduce((s, r) => s + Number(r[k] || 0), 0);
      const totals = { lines: out.length, merchandiseCents: sum('merchandiseCents'), commissionCents: sum('commissionCents'), refundedCents: sum('refundedCents'), transferCents: sum('transferCents'), reversedCents: sum('reversedCents'), netCents: sum('netCents'),
        paidCents: out.filter(r => r.status === 'paid' || r.status === 'reversed').reduce((s, r) => s + r.netCents, 0), heldOrScheduledCents: out.filter(r => ['held', 'scheduled'].includes(r.status)).reduce((s, r) => s + r.netCents, 0) };
      const header = ['transferId', 'bagId', 'createdAt', 'status', 'dueAt', 'paidAt', 'merchandiseCents', 'commissionCents', 'refundedCents', 'transferCents', 'reversedCents', 'netCents'];
      return { brandId, brandName: brand.name, month: `${m[1]}-${m[2]}`, currency: 'USD', lines: out, totals, sandbox: true,
        note: 'Sandbox statement of simulated transfers. Amounts are integer USD cents.', csv: toCsv(header, out) };
    },
    async annualReport(brandId, year) {
      const r = await reports.brandAnnualPayouts(year, brandId); const row = r.brands.find(b => b.brandId === brandId);
      if (!row) fail('Brand not found.', 404, 'NOT_FOUND');
      const header = ['brandId', 'brandName', 'year', 'grossPaymentVolumeCents', 'transactionCount', 'refundsCents', 'commissionCents', 'netTransfersPaidCents', 'reconciliationRequired', ...Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`)];
      const flat = { ...row, ...Object.fromEntries(row.monthlyGrossCents.map((v, i) => [`m${String(i + 1).padStart(2, '0')}`, v])) };
      const { connectedAccount, ...safe } = row; // connected account IDs stay operator-only
      return { year: r.year, report: { ...safe, connectedAccountOnFile: Boolean(connectedAccount) }, note: r.note, csv: toCsv(header, [flat]), sandbox: true };
    },

    // ---------- dashboard ----------
    async dashboard(ctx) {
      const brandId = ctx.brandId; const has = s => ctx.role === 'admin' || ctx.scopes?.includes(s);
      const brand = await domain.getBrand(brandId); const t = now().getTime();
      const iso = ms => new Date(ms).toISOString();
      const out = { brand: { id: brand.id, name: brand.name, status: brand.status }, role: ctx.memberRole || (ctx.role === 'admin' ? 'operator' : null), window: { days: 30, from: iso(t - 30 * DAY), to: iso(t) }, sandbox: true };
      if (has('orders:read')) {
        const [cur, prev] = await Promise.all([brands.analytics(brandId, { from: iso(t - 30 * DAY), to: iso(t + 1000) }), brands.analytics(brandId, { from: iso(t - 60 * DAY), to: iso(t - 30 * DAY) })]);
        out.sales = { grossSalesCents: cur.sales.grossSalesCents, netSalesCents: cur.sales.netSalesCents, bags: cur.sales.bags, priorGrossSalesCents: prev.sales.grossSalesCents,
          changeRate: prev.sales.grossSalesCents ? +((cur.sales.grossSalesCents - prev.sales.grossSalesCents) / prev.sales.grossSalesCents).toFixed(4) : null };
        out.conversion = { likes: cur.conversion.likes, likedThenPurchased: cur.conversion.likedThenPurchased, rate: cur.conversion.likeToPurchaseRate, bags: cur.sales.bags };
        out.returns = { refundedBags: cur.returns.refundedBags, bags: cur.sales.bags, rate: cur.returns.returnRate };
        out.topProducts = cur.topProducts.slice(0, 5).map(p => ({ sku: p.sku, title: p.title, units: p.units, revenueCents: p.revenueCents }));
      }
      if (has('payouts:read')) {
        const next = await first(db, "SELECT COALESCE(SUM(amount_cents-reversed_cents),0)::int AS cents, MIN(due_at) AS due, COUNT(*)::int AS n FROM transfers WHERE brand_id=$1 AND status='scheduled'", [brandId]);
        const held = await first(db, "SELECT COALESCE(SUM(amount_cents-reversed_cents),0)::int AS cents FROM transfers WHERE brand_id=$1 AND status='held'", [brandId]);
        out.upcomingPayout = { scheduledCents: next.cents, nextDueAt: next.due || null, transfers: next.n, heldCents: held.cents, payoutsEnabled: Boolean(brand.payoutsEnabled) };
      }
      if (has('catalog:read')) {
        const c = await rows(db, 'SELECT status,COUNT(*)::int AS n FROM products WHERE brand_id=$1 GROUP BY status', [brandId]);
        const counts = Object.fromEntries(['draft', 'in_review', 'approved', 'rejected'].map(s => [s, c.find(r => r.status === s)?.n || 0]));
        out.listings = { listed: counts.approved, inReview: counts.in_review, needsAttention: counts.draft + counts.rejected, counts };
        out.placements = { pricing: { featuredSpotPerDayCents: PLACEMENT_PRICING.featured_spot.perDayCents, sponsoredSwipePer1000Cents: PLACEMENT_PRICING.sponsored_swipe.per1000ImpressionsCents, samplingBoxPerUnitCents: PLACEMENT_PRICING.sampling_box.perUnitCents },
          active: (await first(db, "SELECT COUNT(*)::int AS n FROM placements WHERE brand_id=$1 AND status IN ('requested','approved','active')", [brandId])).n };
        out.store = (await brands.connectors(brandId)).map(s => ({ platform: s.platform, status: s.status, lastSyncAt: s.lastSyncAt || null }));
      }
      return out;
    },
  };
  return api;
}
