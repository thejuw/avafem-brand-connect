import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { parse as csvParse } from 'csv-parse/sync';
import { id, first, rows, fail, text, int, normEmail, maskEmail, keyring, DAY } from './util.mjs';
import { woocommerceAdapter, bigcommerceAdapter, csvRows } from './connectors.mjs';

export const PLACEMENT_PRICING = { featured_spot: { perDayCents: 2500 }, sponsored_swipe: { per1000ImpressionsCents: 1000 }, sampling_box: { perUnitCents: 150 } };

/** Self-serve brand portal, connectors, analytics and paid placements. */
export function createBrandSide(db, { clock, domain, auth, secret, shopifyConnections, fetch = globalThis.fetch, resolve = lookup, compliance }) {
  const now = () => clock();
  const creds = keyring(secret, 'connector-credentials');
  const transport = { getFetch: () => side.fetch, getResolve: () => side.resolve };
  const adapters = { woocommerce: woocommerceAdapter(transport), bigcommerce: bigcommerceAdapter(transport) };
  const application = brandId => first(db, 'SELECT * FROM brand_applications WHERE brand_id=$1', [brandId]);
  const setStep = async (brandId, key, value) => db.query("UPDATE brand_applications SET steps=steps||$2::jsonb,updated_at=$3 WHERE brand_id=$1", [brandId, JSON.stringify({ [key]: value }), now()]);
  async function upsertRows(brandId, list, source) {
    const errors = []; let accepted = 0;
    for (const [index, row] of list.entries()) {
      try {
        if (!row.sku) fail('SKU is required.');
        await domain.upsertProduct(brandId, row.sku, { title: row.title, description: row.description, category: row.category, priceCents: row.priceCents,
          inventoryQty: row.inventoryQty, images: row.images, ...(row.taxCode ? { taxCode: row.taxCode } : {}) });
        accepted++;
      } catch (error) { errors.push({ row: index + 1, sku: text(row.sku, 120), message: text(error.message, 300) }); }
    }
    const result = { source, total: list.length, accepted, errors, at: now().toISOString() };
    if (compliance) result.compliance = await compliance.scanBrand(brandId);
    return result;
  }
  const side = {
    fetch, resolve,
    // ---------- portal ----------
    async signup(input = {}) {
      const name = text(input.brandName, 160) || fail('brandName is required.');
      const email = normEmail(input.email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('A valid contact email is required.');
      let website = '';
      if (input.website) { try { const u = new URL(input.website); if (u.protocol !== 'https:') throw 0; website = u.origin; } catch { fail('website must be an https URL.'); } }
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}-${randomBytes(3).toString('hex')}`;
      const brand = await domain.createBrand({ name, slug });
      await domain.updateBrand(brand.id, { status: 'invited', supportEmail: email });
      await db.query('INSERT INTO brand_applications(brand_id,contact_enc,website,category,steps,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
        [brand.id, creds.encrypt({ email, contactName: text(input.contactName, 120) }), website, text(input.category, 100), JSON.stringify({ signup: now().toISOString() }), now()]);
      const invite = await auth.createInvite(brand.id);
      return { brandId: brand.id, status: 'invited', invitePath: `/onboard/${invite.token}`, inviteToken: invite.token, expiresAt: invite.expiresAt, contactHint: maskEmail(email) };
    },
    async updateProfile(brandId, input = {}) {
      const patch = {};
      if (input.shipFromAddress) patch.shipFromAddress = Object.fromEntries(['name', 'line1', 'line2', 'city', 'region', 'postal', 'country'].map(k => [k, text(input.shipFromAddress[k], 200)]).filter(([, v]) => v));
      if (Array.isArray(input.shippingTable)) patch.shippingTable = input.shippingTable.slice(0, 20).map(r => ({ method: text(r.method, 40) || 'standard', priceCents: int(r.priceCents, 'shippingTable.priceCents', 0, 100_000), days: int(r.days ?? 5, 'shippingTable.days', 0, 60) }));
      if (input.supportEmail) { const e = normEmail(input.supportEmail); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail('supportEmail must be valid.'); patch.supportEmail = e; }
      const brand = await domain.getBrand(brandId);
      if (brand.status === 'invited') patch.status = 'onboarding';
      await domain.updateBrand(brandId, patch);
      return side.status(brandId);
    },
    async stripeLink(brandId) {
      await domain.getBrand(brandId);
      const app = await application(brandId);
      const account = app?.steps?.stripePendingAccount || `acct_sandbox_${randomBytes(8).toString('hex')}`;
      if (app) await setStep(brandId, 'stripePendingAccount', account);
      // Mocked Stripe Express AccountLink. Live: stripe.accountLinks.create({account, type:'account_onboarding', refresh_url, return_url}).
      return { account, url: `https://connect.stripe.com/setup/e/${account}/simulated`, type: 'account_onboarding', simulated: true, expiresAt: new Date(now().getTime() + 300_000).toISOString() };
    },
    async stripeReturn(brandId) {
      const app = await application(brandId); const account = app?.steps?.stripePendingAccount;
      if (!account) fail('Start Stripe onboarding first.', 409, 'STRIPE_LINK_REQUIRED');
      // Mocked account.updated webhook: charges and payouts enabled.
      await domain.updateBrand(brandId, { stripeAccountId: account, chargesEnabled: true, payoutsEnabled: true });
      await setStep(brandId, 'stripe', now().toISOString());
      return side.status(brandId);
    },
    async connect(brandId, platform, credentials = {}) {
      const brand = await domain.getBrand(brandId);
      if (platform === 'shopify') return { platform, next: { method: 'POST', path: `/api/brands/${brandId}/shopify/authorize` }, message: 'Shopify uses the OAuth install flow.' };
      if (platform === 'csv') {
        await db.query(`INSERT INTO brand_connectors(brand_id,platform,store_ref,created_at) VALUES($1,'csv','csv-upload',$2) ON CONFLICT(brand_id,platform) DO UPDATE SET status='connected'`, [brandId, now()]);
      } else {
        const adapter = adapters[platform] || fail('platform must be shopify, woocommerce, bigcommerce or csv.');
        const { storeRef } = await adapter.verify(credentials);
        const safe = platform === 'woocommerce' ? { storeUrl: credentials.storeUrl, consumerKey: credentials.consumerKey, consumerSecret: credentials.consumerSecret } : { storeHash: credentials.storeHash, accessToken: credentials.accessToken };
        await db.query(`INSERT INTO brand_connectors(brand_id,platform,credentials_enc,store_ref,created_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(brand_id,platform) DO UPDATE SET credentials_enc=EXCLUDED.credentials_enc,store_ref=EXCLUDED.store_ref,status='connected'`, [brandId, platform, creds.encrypt(safe), storeRef, now()]);
      }
      await domain.updateBrand(brandId, { connectionTier: platform === 'csv' ? 'dashboard' : platform, connectionHealthy: true,
        ...(brand.status === 'disconnected' ? { status: 'onboarding' } : {}) });
      await setStep(brandId, 'store', now().toISOString());
      return { platform, connected: true, storeRef: platform === 'csv' ? 'csv-upload' : (await first(db, 'SELECT store_ref FROM brand_connectors WHERE brand_id=$1 AND platform=$2', [brandId, platform])).storeRef };
    },
    async connectors(brandId) { return rows(db, 'SELECT brand_id,platform,store_ref,status,last_sync_at,last_result,created_at FROM brand_connectors WHERE brand_id=$1 ORDER BY platform', [brandId]); },
    async disconnect(brandId, platform) {
      const brand = await domain.getBrand(brandId);
      const connector = await first(db, 'SELECT platform FROM brand_connectors WHERE brand_id=$1 AND platform=$2', [brandId, platform]);
      if (!connector) fail('Connector not found.', 404, 'NOT_FOUND');
      // Fail closed before erasing credentials. The core also withdraws approved
      // listings on disconnect; another connector is not an automatic fallback.
      if (brand.connectionTier === platform || (platform === 'csv' && brand.connectionTier === 'dashboard'))
        await domain.updateBrand(brandId, { connectionHealthy: false, status: 'disconnected' });
      const r = await db.query("UPDATE brand_connectors SET status='disconnected',credentials_enc=NULL WHERE brand_id=$1 AND platform=$2 RETURNING platform", [brandId, platform]);
      if (!r.rows.length) fail('Connector not found.', 404, 'NOT_FOUND');
      return { platform, disconnected: true };
    },
    async sync(brandId, platform) {
      const c = await first(db, "SELECT * FROM brand_connectors WHERE brand_id=$1 AND platform=$2 AND status='connected'", [brandId, platform]);
      if (!c || !adapters[platform]) fail('No connected store for that platform.', 404, 'NOT_FOUND');
      let list;
      try { list = await adapters[platform].listProducts(creds.decrypt(c.credentialsEnc)); }
      catch (error) { await db.query("UPDATE brand_connectors SET last_result=$3 WHERE brand_id=$1 AND platform=$2", [brandId, platform, JSON.stringify({ error: error.code || 'CONNECTOR_ERROR' })]); throw error; }
      const result = await upsertRows(brandId, list, platform);
      await db.query('UPDATE brand_connectors SET last_sync_at=$3,last_result=$4 WHERE brand_id=$1 AND platform=$2', [brandId, platform, now(), JSON.stringify({ total: result.total, accepted: result.accepted, errors: result.errors.length })]);
      await setStep(brandId, 'catalogSubmitted', now().toISOString());
      return result;
    },
    async importCsv(brandId, csv) {
      if (typeof csv !== 'string' || !csv.trim() || csv.length > 3_000_000) fail('Provide CSV text up to 3 MB.', 422, 'INVALID_IMPORT');
      await domain.getBrand(brandId);
      let list; try { list = csvRows(csvParse, csv); } catch (error) { if (error.statusCode) throw error; fail('CSV could not be parsed.', 422, 'INVALID_CSV'); }
      const result = await upsertRows(brandId, list, 'csv');
      if (await application(brandId)) await setStep(brandId, 'catalogSubmitted', now().toISOString());
      return result;
    },
    async pushOrder(bagId) {
      const bag = await domain.getBag(bagId);
      const reservation = await db.transaction(async tx => {
        const current = await first(tx, 'SELECT * FROM bags WHERE id=$1 FOR UPDATE', [bagId]);
        if (!current) fail('Bag not found.', 404, 'NOT_FOUND');
        const receipt = await first(tx, 'SELECT * FROM connector_orders WHERE bag_id=$1', [bagId]);
        if (receipt) {
          const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1', [bagId]);
          if (receipt.brandId !== current.brandId || !adapters[receipt.platform] || current.providerBound ||
            (external && (external.state !== 'connector_created' || external.externalOrderId !== receipt.externalId || external.brandId !== current.brandId)))
            fail('This connector receipt conflicts with another fulfillment workflow. Provider review is required.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          // Earlier versions stored only a success receipt. Repair its shared
          // ownership marker, without guessing a remote target or sending again.
          if (!external) await tx.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state,external_order_id)
            VALUES($1,$2,$3,'connector_created',$4)`, [bagId, receipt.brandId, `${receipt.platform}:legacy-receipt`, receipt.externalId]);
          await tx.query('UPDATE handoff_links SET used_at=$2 WHERE bag_id=$1 AND used_at IS NULL', [bagId, now()]);
          await tx.query("UPDATE sandbox_inbox SET status='closed' WHERE bag_id=$1", [bagId]);
          return { receipt };
        }
        if (current.providerBound) fail('Use the provider-backed fulfillment workflow for this Bag.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
        const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1', [bagId]);
        if (external) {
          if (/^connector_/.test(external.state)) fail('An earlier connector dispatch requires provider reconciliation; it will not be sent again.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          fail('This Bag is already reserved for fulfillment through another workflow.', 409, 'EXTERNAL_FULFILLMENT_RESERVED');
        }
        const blocked = await first(tx, `SELECT
          EXISTS(SELECT 1 FROM refunds WHERE bag_id=$1 AND status='proposed') AS refund_pending,
          EXISTS(SELECT 1 FROM shipments WHERE bag_id=$1) AS shipment_exists`, [bagId]);
        if (current.status !== 'awaiting_shipment' || current.refundedCents > 0 || blocked.refundPending || blocked.shipmentExists)
          fail('Only unshipped, unrefunded Bags without refund proposals can be pushed.', 409, 'INVALID_BAG_STATE');
        const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1', [current.brandId]);
        if (!brand?.connectionHealthy || ['paused', 'disconnected'].includes(brand.status)) fail('The brand connection is unavailable.', 409, 'NO_CONNECTOR');
        const c = await first(tx, `SELECT * FROM brand_connectors WHERE brand_id=$1 AND platform=$2
          AND platform IN ('woocommerce','bigcommerce') AND status='connected' FOR UPDATE`, [current.brandId, brand.connectionTier]);
        if (!c) fail('This brand has no selected WooCommerce or BigCommerce connector.', 409, 'NO_CONNECTOR');
        const credentials = creds.decrypt(c.credentialsEnc);
        const target = c.platform === 'woocommerce' ? new URL(credentials.storeUrl).origin : credentials.storeHash;
        const marker = `${c.platform}:${target}`;
        // The same durable reservation table is honored by Shopify dispatch,
        // handoff links and the outbox. Never reserve only in process memory.
        await tx.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state)
          VALUES($1,$2,$3,'connector_pending')`, [bagId, current.brandId, marker]);
        await tx.query('UPDATE handoff_links SET used_at=$2 WHERE bag_id=$1 AND used_at IS NULL', [bagId, now()]);
        await tx.query("UPDATE sandbox_inbox SET status='closed' WHERE bag_id=$1", [bagId]);
        return { platform: c.platform, credentials, marker };
      });
      if (reservation.receipt) return { ...reservation.receipt, replayed: true };
      try {
        const { externalId } = await adapters[reservation.platform].createOrder(reservation.credentials, bag);
        return await db.transaction(async tx => {
          const current = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bagId]);
          if (!current || current.shop !== reservation.marker || current.state !== 'connector_pending')
            fail('The connector dispatch reservation changed.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          const receipt = await first(tx, `INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at)
            VALUES($1,$2,$3,$4,$5) RETURNING *`, [bagId, bag.brandId, reservation.platform, externalId, now()]);
          await tx.query("UPDATE external_orders SET external_order_id=$2,state='connector_created',last_error=NULL,updated_at=$3 WHERE bag_id=$1", [bagId, externalId, now()]);
          return receipt;
        });
      } catch {
        // A failure can occur after a paid provider order exists (including a
        // local receipt-write failure). Persist uncertainty; no retry is safe.
        try { await db.query("UPDATE external_orders SET state='connector_uncertain',last_error='CONNECTOR_CREATE_NOT_VERIFIED',updated_at=$2 WHERE bag_id=$1 AND state='connector_pending' AND shop=$3", [bagId, now(), reservation.marker]); } catch { /* A committed pending reservation still blocks every replay. */ }
        fail('Connector order creation is not verified. Review the provider using this Bag ID; do not resend the order.', 502, 'CONNECTOR_OUTCOME_UNCERTAIN');
      }
    },
    async status(brandId) {
      const brand = await domain.getBrand(brandId); const app = await application(brandId);
      const products = await first(db, `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='approved')::int AS approved, COUNT(*) FILTER (WHERE status='in_review')::int AS in_review,
        COUNT(*) FILTER (WHERE status='rejected')::int AS rejected FROM products WHERE brand_id=$1`, [brandId]);
      const connectors = await side.connectors(brandId);
      let shopify = null; try { shopify = shopifyConnections ? await shopifyConnections.status(brandId) : null; } catch { shopify = null; }
      const storeConnected = connectors.some(c => c.status === 'connected') || Boolean(shopify?.connected || shopify?.status === 'connected');
      const steps = [
        { key: 'signup', done: true },
        { key: 'agreement', done: brand.agreementSigned },
        { key: 'profile', done: Boolean(brand.shipFromAddress?.line1 && brand.shippingTable?.length && brand.supportEmail) },
        { key: 'store_connection', done: storeConnected },
        { key: 'stripe_express', done: Boolean(brand.stripeAccountId && brand.chargesEnabled && brand.payoutsEnabled) },
        { key: 'catalog_submitted', done: products.total > 0 },
        { key: 'catalog_approved', done: products.approved > 0 },
        { key: 'live', done: brand.status === 'live' },
      ];
      return { brandId, brandName: brand.name, status: brand.status, steps, nextStep: steps.find(s => !s.done)?.key || null, products, connectors,
        onboardingRequirements: brand.onboardingRequirements, selfServe: Boolean(app) };
    },
    async reviewQueue() {
      const list = await rows(db, "SELECT id,brand_id,sku,title,status,validation_issues,evidence,description,category,updated_at FROM products WHERE status IN ('in_review','draft') ORDER BY updated_at");
      return Promise.all(list.map(async p => ({ id: p.id, brandId: p.brandId, sku: p.sku, title: p.title, status: p.status, validationIssues: p.validationIssues,
        compliance: compliance ? await compliance.check(p) : null, updatedAt: p.updatedAt })));
    },
    async activate(brandId) {
      const status = await side.status(brandId);
      if (!status.steps.find(step => step.key === 'store_connection')?.done) fail('Onboarding incomplete: Store connection.', 409, 'ONBOARDING_INCOMPLETE');
      if (status.onboardingRequirements.length) fail(`Onboarding incomplete: ${status.onboardingRequirements.join('; ')}.`, 409, 'ONBOARDING_INCOMPLETE');
      await domain.updateBrand(brandId, { status: 'live' });
      if (await application(brandId)) await setStep(brandId, 'live', now().toISOString());
      return side.status(brandId);
    },
    // ---------- analytics ----------
    async analytics(brandId, { from, to } = {}) {
      await domain.getBrand(brandId);
      const params = [brandId]; let range = '';
      if (from) { params.push(new Date(from)); range += ` AND created_at>=$${params.length}`; }
      if (to) { params.push(new Date(to)); range += ` AND created_at<$${params.length}`; }
      const bags = await rows(db, `SELECT id,status,subtotal_cents,refunded_cents,total_cents,commission_cents,transfer_cents,items,created_at FROM bags WHERE brand_id=$1${range}`, params);
      const gross = bags.reduce((s, b) => s + b.subtotalCents, 0);
      const refundedBags = bags.filter(b => b.status === 'refunded');
      const products = new Map();
      for (const b of bags) for (const i of b.items || []) {
        const p = products.get(i.sku) || { sku: i.sku, title: i.title || i.sku, units: 0, revenueCents: 0, returnedUnits: 0 };
        p.units += i.qty; p.revenueCents += (i.unitPriceCents || 0) * i.qty; if (b.status === 'refunded') p.returnedUnits += i.qty;
        products.set(i.sku, p);
      }
      const swipe = await first(db, `SELECT COUNT(DISTINCT sl.shopper_id)::int AS swipers, COUNT(*) FILTER (WHERE sl.liked)::int AS likes, COUNT(*)::int AS swipes
        FROM swipe_likes sl JOIN products p ON p.id=sl.product_id WHERE p.brand_id=$1`, [brandId]);
      const converted = await first(db, `SELECT COUNT(DISTINCT sl.shopper_id)::int AS c FROM swipe_likes sl JOIN products p ON p.id=sl.product_id
        JOIN shopper_orders so ON so.shopper_id=sl.shopper_id AND so.brand_id=p.brand_id WHERE p.brand_id=$1 AND sl.liked`, [brandId]);
      const placements = await first(db, "SELECT COALESCE(SUM(impressions),0)::int AS impressions, COALESCE(SUM(clicks),0)::int AS clicks FROM placements WHERE brand_id=$1", [brandId]);
      return { brandId, from: from || null, to: to || null,
        sales: { bags: bags.length, grossSalesCents: gross, refundedCents: bags.reduce((s, b) => s + b.refundedCents, 0), netSalesCents: gross - refundedBags.reduce((s, b) => s + b.subtotalCents, 0),
          averageBagCents: bags.length ? Math.round(gross / bags.length) : 0, commissionCents: bags.filter(b => b.status !== 'refunded').reduce((s, b) => s + b.commissionCents, 0) },
        returns: { refundedBags: refundedBags.length, returnRate: bags.length ? +(refundedBags.length / bags.length).toFixed(4) : 0 },
        conversion: { swipes: swipe.swipes, likes: swipe.likes, swipers: swipe.swipers, likedThenPurchased: converted.c, likeToPurchaseRate: swipe.swipers ? +(converted.c / swipe.swipers).toFixed(4) : 0,
          placementImpressions: placements.impressions, placementClicks: placements.clicks, placementCtr: placements.impressions ? +(placements.clicks / placements.impressions).toFixed(4) : 0 },
        topProducts: [...products.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.units - a.units).slice(0, 10), sandbox: true };
    },
    // ---------- paid placements ----------
    async requestPlacement(brandId, input = {}) {
      const kind = Object.hasOwn(PLACEMENT_PRICING, input.kind) ? input.kind : fail('kind must be featured_spot, sponsored_swipe or sampling_box.');
      const product = await first(db, "SELECT id,status FROM products WHERE id=$1 AND brand_id=$2", [input.productId, brandId]);
      if (!product) fail('Product not found.', 404, 'NOT_FOUND');
      if (product.status !== 'approved') fail('Only approved products can be promoted.', 409, 'PRODUCT_NOT_APPROVED');
      const starts = new Date(input.startsAt || now()); const ends = new Date(input.endsAt || starts.getTime() + 7 * DAY);
      if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts || ends - starts > 90 * DAY) fail('Use a valid window of up to 90 days.');
      let units = 0; let price;
      if (kind === 'featured_spot') price = Math.ceil((ends - starts) / DAY) * PLACEMENT_PRICING.featured_spot.perDayCents;
      else if (kind === 'sponsored_swipe') { units = int(input.units, 'units (impressions)', 1000, 10_000_000); price = Math.ceil(units / 1000) * PLACEMENT_PRICING.sponsored_swipe.per1000ImpressionsCents; }
      else { units = int(input.units, 'units (samples)', 10, 100_000); price = units * PLACEMENT_PRICING.sampling_box.perUnitCents; }
      return first(db, `INSERT INTO placements(id,brand_id,kind,product_id,starts_at,ends_at,units,price_cents,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$9) RETURNING *`,
        [id('plc'), brandId, kind, product.id, starts, ends, units, price, now()]);
    },
    async listPlacements(brandId) { return rows(db, `SELECT * FROM placements${brandId ? ' WHERE brand_id=$1' : ''} ORDER BY created_at DESC`, brandId ? [brandId] : []); },
    async decidePlacement(placementId, decision, { method = 'invoice' } = {}) {
      if (!['approved', 'rejected'].includes(decision)) fail('decision must be approved or rejected.');
      return db.transaction(async tx => {
        const p = await first(tx, 'SELECT * FROM placements WHERE id=$1 FOR UPDATE', [placementId]); if (!p) fail('Placement not found.', 404, 'NOT_FOUND');
        if (p.status !== 'requested') return { placement: p, billing: await first(tx, 'SELECT * FROM billing_records WHERE placement_id=$1', [p.id]) };
        const placement = await first(tx, 'UPDATE placements SET status=$2,updated_at=$3 WHERE id=$1 RETURNING *', [p.id, decision, now()]);
        const billing = decision === 'approved' ? await first(tx, `INSERT INTO billing_records(id,brand_id,placement_id,amount_cents,status,method,created_at,updated_at) VALUES($1,$2,$3,$4,'invoiced',$5,$6,$6) RETURNING *`,
          [id('bill'), p.brandId, p.id, p.priceCents, ['invoice', 'payout_offset'].includes(method) ? method : 'invoice', now()]) : null;
        return { placement, billing };
      });
    },
    async cancelPlacement(brandId, placementId) {
      return db.transaction(async tx => {
        const p = await first(tx, 'SELECT * FROM placements WHERE id=$1 AND brand_id=$2 FOR UPDATE', [placementId, brandId]); if (!p) fail('Placement not found.', 404, 'NOT_FOUND');
        if (p.status === 'approved' && new Date(p.startsAt) <= now()) fail('A running placement cannot be cancelled.', 409, 'PLACEMENT_RUNNING');
        if (!['requested', 'approved'].includes(p.status)) return p;
        await tx.query("UPDATE billing_records SET status='void',updated_at=$2 WHERE placement_id=$1 AND status='invoiced'", [p.id, now()]);
        return first(tx, "UPDATE placements SET status='cancelled',updated_at=$2 WHERE id=$1 RETURNING *", [p.id, now()]);
      });
    },
    async billing(brandId) { return rows(db, `SELECT * FROM billing_records${brandId ? ' WHERE brand_id=$1' : ''} ORDER BY created_at DESC`, brandId ? [brandId] : []); },
    async markBillingPaid(billingId) { const r = await first(db, "UPDATE billing_records SET status='paid',updated_at=$2 WHERE id=$1 AND status='invoiced' RETURNING *", [billingId, now()]); if (!r) fail('Invoiced billing record not found.', 404, 'NOT_FOUND'); return r; },
    /** Shopper-app feed: active, in-window placements; sponsored swipes stop at purchased impressions. */
    async feed(kind, { limit = 10 } = {}) {
      if (!Object.hasOwn(PLACEMENT_PRICING, kind)) fail('Unknown placement kind.');
      const list = await rows(db, `SELECT pl.id,pl.brand_id,pl.kind,pl.product_id,pl.units,pl.impressions,p.title,p.images,p.price_cents FROM placements pl JOIN products p ON p.id=pl.product_id
        WHERE pl.kind=$1 AND pl.status='approved' AND pl.starts_at<=$2 AND pl.ends_at>$2 AND p.status='approved' AND (pl.kind<>'sponsored_swipe' OR pl.impressions<pl.units) ORDER BY pl.impressions,pl.created_at LIMIT $3`, [kind, now(), Math.min(50, limit)]);
      for (const c of list) await db.query('UPDATE placements SET impressions=impressions+1 WHERE id=$1', [c.id]);
      return list.map(c => ({ placementId: c.id, brandId: c.brandId, productId: c.productId, title: c.title, image: c.images?.[0] || null, priceCents: c.priceCents, sponsored: true, kind: c.kind }));
    },
    async click(placementId) { const r = await first(db, 'UPDATE placements SET clicks=clicks+1 WHERE id=$1 RETURNING id,clicks', [placementId]); if (!r) fail('Placement not found.', 404, 'NOT_FOUND'); return r; },
  };
  return side;
}
