import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { parse as csvParse } from 'csv-parse/sync';
import { id, first, rows, fail, text, int, normEmail, maskEmail, keyring, sha, DAY } from './util.mjs';
import { woocommerceAdapter, bigcommerceAdapter, csvRows } from './connectors.mjs';

export const PLACEMENT_PRICING = { featured_spot: { perDayCents: 2500 }, sponsored_swipe: { per1000ImpressionsCents: 1000 }, sampling_box: { perUnitCents: 150 } };

/** Self-serve brand portal, connectors, analytics and paid placements. */
export function createBrandSide(db, { clock, domain, auth, secret, shopifyConnections, fetch = globalThis.fetch, resolve = lookup, compliance }) {
  const now = () => clock();
  const creds = keyring(secret, 'connector-credentials');
  const recoveryVault = keyring(secret, 'connector-recovery-evidence');
  const transport = { getFetch: () => side.fetch, getResolve: () => side.resolve };
  const adapters = { woocommerce: woocommerceAdapter(transport), bigcommerce: bigcommerceAdapter(transport) };
  const application = brandId => first(db, 'SELECT * FROM brand_applications WHERE brand_id=$1', [brandId]);
  const setStep = async (brandId, key, value) => db.query("UPDATE brand_applications SET steps=steps||$2::jsonb,updated_at=$3 WHERE brand_id=$1", [brandId, JSON.stringify({ [key]: value }), now()]);
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  const digest = value => sha(JSON.stringify(stable(value)));
  const wall = () => new Date();
  const audit = (tx, actor, action, bag) => tx.query('INSERT INTO audit_log(actor,brand_id,action,resource_id) VALUES($1,$2,$3,$4)', [actor, bag.brandId, action, bag.id]);
  const targetFor = (platform, credentials) => `${platform}:${platform === 'woocommerce' ? new URL(credentials.storeUrl).origin : credentials.storeHash}`;
  const snapshot = bag => ({ id: bag.id, brandId: bag.brandId, orderRef: bag.orderRef,
    items: bag.items.map(i => ({ sku: i.sku, ...(i.variantSku ? { variantSku: i.variantSku } : {}), title: i.title || i.sku, qty: i.qty, unitPriceCents: i.unitPriceCents })),
    shipTo: Object.fromEntries(['name', 'line1', 'line2', 'city', 'region', 'postal', 'country'].map(k => [k, bag.shipTo?.[k] || ''])),
    subtotalCents: bag.subtotalCents, shippingCents: bag.shippingCents, taxCents: bag.taxCents, totalCents: bag.totalCents, currency: 'USD' });
  async function lockedBag(tx, bagId) {
    const bag = await first(tx, 'SELECT * FROM bags WHERE id=$1 FOR UPDATE', [bagId]);
    if (!bag) fail('Bag not found.', 404, 'NOT_FOUND');
    const order = await first(tx, 'SELECT order_ref FROM orders WHERE id=$1', [bag.orderId]);
    const shipping = bag.shipTo?.encryptedShipping ? auth.decrypt(bag.shipTo.encryptedShipping) : bag.shipTo;
    return { ...bag, shipTo: shipping, orderRef: order?.orderRef };
  }
  async function assertOpen(tx, bag) {
    if (bag.providerBound) fail('Use the provider-backed fulfillment workflow for this Bag.', 409, 'PROVIDER_WORKFLOW_REQUIRED');
    const blocked = await first(tx, `SELECT EXISTS(SELECT 1 FROM refunds WHERE bag_id=$1 AND status='proposed') AS refund_pending,
      EXISTS(SELECT 1 FROM shipments WHERE bag_id=$1) AS shipment_exists`, [bag.id]);
    if (bag.status !== 'awaiting_shipment' || bag.refundedCents > 0 || blocked.refundPending || blocked.shipmentExists)
      fail('Only unshipped, unrefunded Bags without refund proposals can be dispatched or recovered.', 409, 'INVALID_BAG_STATE');
  }
  async function selectedConnector(tx, bag, expectedTarget) {
    const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1', [bag.brandId]);
    if (!brand?.connectionHealthy || ['paused', 'disconnected'].includes(brand.status)) fail('The brand connection is unavailable.', 409, 'NO_CONNECTOR');
    const c = await first(tx, `SELECT * FROM brand_connectors WHERE brand_id=$1 AND platform=$2
      AND platform IN ('woocommerce','bigcommerce') AND status='connected' FOR UPDATE`, [bag.brandId, brand.connectionTier]);
    if (!c) fail('This brand has no selected WooCommerce or BigCommerce connector.', 409, 'NO_CONNECTOR');
    const credentials = creds.decrypt(c.credentialsEnc), marker = targetFor(c.platform, credentials);
    if (expectedTarget && marker !== expectedTarget) fail('Reconnect the original store before recovering this dispatch.', 409, 'RECOVERY_STORE_CHANGED');
    return { platform: c.platform, credentials, marker };
  }
  async function liveAttempt(tx, bagId) {
    const list = await rows(tx, "SELECT * FROM connector_dispatch_attempts WHERE bag_id=$1 AND state IN ('pending','uncertain','created','confirmed') FOR UPDATE", [bagId]);
    if (list.length > 1) fail('Conflicting dispatch history requires review.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
    return list[0];
  }
  async function makeAttempt(tx, bag, connector, legacyMarker = false, state = 'pending') {
    const frozen = { bag: snapshot(bag), legacyMarker };
    return first(tx, `INSERT INTO connector_dispatch_attempts(id,bag_id,brand_id,platform,target_ref,state,snapshot_enc,snapshot_hash,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [id('cda'), bag.id, bag.brandId, connector.platform, connector.marker, state,
      recoveryVault.encrypt(frozen), digest(frozen), wall()]);
  }
  function openSnapshot(attempt, bag) {
    const frozen = recoveryVault.decrypt(attempt.snapshotEnc);
    if (!frozen || digest(frozen) !== attempt.snapshotHash || digest(frozen.bag) !== digest(snapshot(bag)))
      fail('The Bag differs from its immutable dispatch snapshot.', 409, 'RECOVERY_BAG_CHANGED');
    return frozen;
  }
  async function closeHandoff(tx, bagId) {
    await tx.query('UPDATE handoff_links SET used_at=$2 WHERE bag_id=$1 AND used_at IS NULL', [bagId, wall()]);
    await tx.query("UPDATE sandbox_inbox SET status='closed' WHERE bag_id=$1", [bagId]);
  }
  async function busyRecovery(tx, bagId, except) {
    return first(tx, `SELECT operation_id FROM connector_order_recoveries WHERE bag_id=$1 AND lease_token IS NOT NULL
      AND lease_expires_at>NOW() AND ($2::text IS NULL OR operation_id<>$2) FOR UPDATE`, [bagId, except || null]);
  }
  const groupedItems = list => {
    const out = new Map();
    for (const line of list) {
      const sku = line.variantSku || line.sku;
      if (typeof sku !== 'string' || !sku || !Number.isSafeInteger(line.qty) || line.qty < 1) return null;
      const total = line.totalCents ?? line.qty * line.unitPriceCents;
      if (!Number.isSafeInteger(total) || total < 0) return null;
      const p = out.get(sku) || { sku, qty: 0, totalCents: 0 }; p.qty += line.qty; p.totalCents += total; out.set(sku, p);
    }
    return [...out.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  };
  function verifyOrder(proof, attempt, frozen, externalId, action) {
    const bag = frozen.bag;
    const marker = attempt.platform === 'woocommerce'
      ? Array.isArray(proof?.bagMarkers) && proof.bagMarkers.length === 1 && proof.bagMarkers[0] === bag.id
        && Array.isArray(proof.dispatchMarkers) && (frozen.legacyMarker ? proof.dispatchMarkers.length === 0 : proof.dispatchMarkers.length === 1 && proof.dispatchMarkers[0] === attempt.id)
      : proof?.staffNotes === `Avafem ${bag.orderRef} / ${bag.id}${frozen.legacyMarker ? '' : ` / dispatch ${attempt.id}`}`;
    const expectedShipping = { ...bag.shipTo };
    const bcCurrency = attempt.platform !== 'bigcommerce' || (proof.transactionalCurrency === 'USD' && Number(proof.exchangeRate) === 1);
    if (!proof || proof.complete !== true || proof.externalId !== externalId || proof.platform !== attempt.platform || !marker || !bcCurrency
      || proof.currency !== 'USD' || proof.hasRefunds !== false || proof.extraCharges !== false || proof.discountCents !== 0
      || ['subtotalCents', 'shippingCents', 'taxCents', 'totalCents'].some(k => proof[k] !== bag[k])
      || proof.subtotalCents + proof.shippingCents + proof.taxCents !== proof.totalCents
      || !Array.isArray(proof.items) || !groupedItems(proof.items) || digest(groupedItems(proof.items)) !== digest(groupedItems(bag.items))
      || digest(proof.shipping) !== digest(expectedShipping)) fail('The native order does not match the exact frozen Avafem dispatch.', 409, 'RECOVERY_PROOF_MISMATCH');
    if (action === 'confirm' && (proof.paid !== true || proof.canConfirm !== true)) fail('The native order is not a confirmable paid order.', 409, 'RECOVERY_REMOTE_STATE_INVALID');
    if (action === 'void' && proof.voidVerified !== true) fail('The native order is not authoritatively cancelled and unfulfilled.', 409, 'RECOVERY_VOID_NOT_VERIFIED');
  }
  async function releaseLease(operationId, token) {
    await db.query('UPDATE connector_order_recoveries SET lease_token=NULL,lease_expires_at=NULL WHERE operation_id=$1 AND lease_token=$2', [operationId, token]);
  }
  async function sendAttempt(reservation) {
    const { attempt, frozen, connector } = reservation, bag = frozen.bag;
    try {
      const { externalId } = await adapters[connector.platform].createOrder(connector.credentials, bag, { dispatchId: attempt.id });
      return await db.transaction(async tx => {
        await lockedBag(tx, bag.id);
        const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bag.id]);
        const current = await first(tx, 'SELECT * FROM connector_dispatch_attempts WHERE id=$1 FOR UPDATE', [attempt.id]);
        if (!current || current.state !== 'pending' || !external || external.shop !== connector.marker || external.state !== 'connector_pending')
          fail('The connector dispatch reservation changed.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
        const receipt = await first(tx, `INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at)
          VALUES($1,$2,$3,$4,$5) RETURNING *`, [bag.id, bag.brandId, connector.platform, externalId, wall()]);
        await tx.query("UPDATE external_orders SET external_order_id=$2,state='connector_created',last_error=NULL,updated_at=$3 WHERE bag_id=$1", [bag.id, externalId, wall()]);
        await tx.query("UPDATE connector_dispatch_attempts SET state='created',external_id=$2,updated_at=$3 WHERE id=$1", [attempt.id, externalId, wall()]);
        return receipt;
      });
    } catch {
      try { await db.transaction(async tx => {
        await tx.query('SELECT id FROM bags WHERE id=$1 FOR UPDATE', [bag.id]);
        await tx.query("UPDATE connector_dispatch_attempts SET state='uncertain',updated_at=$2 WHERE id=$1 AND state='pending'", [attempt.id, wall()]);
        await tx.query("UPDATE external_orders SET state='connector_uncertain',last_error='CONNECTOR_CREATE_NOT_VERIFIED',updated_at=$2 WHERE bag_id=$1 AND state='connector_pending' AND shop=$3", [bag.id, wall(), connector.marker]);
      }); } catch { /* A committed pending reservation still blocks every replay. */ }
      fail('Connector order creation is not verified. Review the provider using this Bag ID; do not resend the order.', 502, 'CONNECTOR_OUTCOME_UNCERTAIN');
    }
  }
  async function assertCatalogLease(tx,brandId,lease) {
    await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);
    const brand=await first(tx,'SELECT onboarding_state,status FROM brands WHERE id=$1',[brandId]),current=brand?.onboardingState?.catalogLease;
    if(!lease || current?.token!==lease.token || current.provider!==lease.provider || current.catalogKey!==lease.catalogKey || !current.expiresAt || new Date(current.expiresAt)<=wall())
      fail('The catalog import lease expired or was replaced; refresh the source snapshot.',409,'CATALOG_IMPORT_STALE');
    if(brand.onboardingState?.platform && (['paused','disconnected'].includes(brand.status) || !brand.onboardingState.connected || brand.onboardingState.platform!==lease.provider))
      fail('The selected store changed while its catalog was loading.',409,'STORE_CONNECTION_CHANGED');
  }
  async function withCatalogSnapshot(brandId,provider,catalogKey,fetchRows,options={}) {
    if(!['shopify','woocommerce','bigcommerce','csv','feed'].includes(provider) || typeof catalogKey!=='string' || !catalogKey || catalogKey.length>500 || typeof fetchRows!=='function') fail('Use a bounded server-owned catalog source.');
    const lease={token:id('catalog'),provider,catalogKey,expiresAt:new Date(wall().getTime()+5*60_000).toISOString()};
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);
      const brand=await first(tx,'SELECT onboarding_state FROM brands WHERE id=$1',[brandId]);if(!brand)fail('Brand not found.',404,'NOT_FOUND');
      const previous=brand.onboardingState?.catalogLease;
      if(previous?.token && new Date(previous.expiresAt)>wall())fail('A catalog import is already reading or applying this brand’s snapshot.',409,'CATALOG_IMPORT_BUSY');
      await tx.query('UPDATE brands SET onboarding_state=onboarding_state||$2::jsonb WHERE id=$1',[brandId,JSON.stringify({catalogLease:lease})]);
    });
    try {
      const list=await fetchRows();
      return await upsertRows(brandId,list,provider,catalogKey,{complete:options.complete===true || (options.complete===undefined && list?.complete===true),lease});
    } finally {
      await db.transaction(async tx=>{
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);
        const brand=await first(tx,'SELECT onboarding_state FROM brands WHERE id=$1',[brandId]);
        if(brand?.onboardingState?.catalogLease?.token===lease.token) await tx.query("UPDATE brands SET onboarding_state=onboarding_state-'catalogLease' WHERE id=$1",[brandId]);
      });
    }
  }
  async function upsertRows(brandId, list, source, catalogKey, { complete = false,lease } = {}) {
    if (!Array.isArray(list) || list.length > 5000 || !['shopify','woocommerce','bigcommerce','csv','feed'].includes(source) || !text(catalogKey,500)) fail('A bounded server-owned catalog snapshot is required.',422,'INVALID_IMPORT');
    const identities = list.map(row => String(row.externalId || row.source?.productId || (source==='csv' ? row.sku : '') || ''));
    const nonemptyIds=identities.filter(Boolean),nonemptySkus=list.map(row=>row.sku).filter(Boolean);
    if (identities.some(value=>(!value && source!=='csv') || value.length>200) || new Set(nonemptyIds).size!==nonemptyIds.length || new Set(nonemptySkus).size!==nonemptySkus.length)
      fail('Catalog source IDs and SKUs must be present and unique.',422,'CATALOG_IDENTITY_INVALID');
    const errors = [],acceptedProductIds=[],acceptedProducts=[]; let accepted = 0;
    for (const [index, row] of list.entries()) {
      try {
        if (!row.sku) fail('SKU is required.');
        const input = Object.fromEntries(['title','description','category','priceCents','inventoryQty','images','variants','evidence','taxCode','shippingProfile','productType','tags','collections']
          .filter(key=>row[key]!==undefined && (key!=='taxCode' || row[key])).map(key=>[key,row[key]]));
        const imported=await domain.upsertProduct(brandId, row.sku, input, { source: { provider:source,catalogKey,productId:identities[index],
          active:row.sourceActive!==false && (!row.sourceStatus || row.sourceStatus==='ACTIVE') },beforeUpsert:tx=>assertCatalogLease(tx,brandId,lease) });
        accepted++;acceptedProductIds.push(imported.id);acceptedProducts.push({id:imported.id,fingerprint:imported.reviewFingerprint});
      } catch (error) { errors.push({ row: index + 1, sku: text(row.sku, 120), message: text(error.message, 300) }); }
    }
    let delisted = 0;
    if (complete===true && !errors.length) delisted=await db.transaction(async tx=>{
      await assertCatalogLease(tx,brandId,lease);
      const absent=await rows(tx,`SELECT id,sku FROM products WHERE brand_id=$1 AND source_provider=$2 AND source_catalog_key=$3
        AND NOT(source_product_id=ANY($4::text[])) AND source_deleted_at IS NULL FOR UPDATE`,[brandId,source,catalogKey,identities]);
      for(const p of absent) {
        await tx.query("UPDATE products SET source_deleted_at=$2,status='draft',review_note='Removed from the complete source catalog.',updated_at=$2 WHERE id=$1",[p.id,now()]);
        await tx.query(`INSERT INTO outbox_events(id,type,aggregate_id,brand_id,payload,created_at,available_at) VALUES($1,'product.delisted',$2,$3,$4,$5,$5)`,[id('evt'),p.id,brandId,JSON.stringify({productId:p.id,sku:p.sku,source,reason:'complete_source_snapshot'}),now()]);
      }
      return absent.length;
    });
    const result = { source, total: list.length, accepted, acceptedProductIds, acceptedProducts, errors, complete:complete===true && !errors.length, delisted, at: now().toISOString() };
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
      const brand=await domain.getBrand(brandId);
      if(brand.onboardingMode==='two_step' || brand.onboardingState?.platform || brand.onboardingState?.connected)
        fail('Use the configured onboarding payout flow for this brand.',409,'USE_ONBOARDING_PAYOUT_FLOW');
      const app = await application(brandId);
      const account = app?.steps?.stripePendingAccount || `acct_sandbox_${randomBytes(8).toString('hex')}`;
      if (app) await setStep(brandId, 'stripePendingAccount', account);
      // Mocked Stripe Express AccountLink. Live: stripe.accountLinks.create({account, type:'account_onboarding', refresh_url, return_url}).
      return { account, url: `https://connect.stripe.com/setup/e/${account}/simulated`, type: 'account_onboarding', simulated: true, expiresAt: new Date(now().getTime() + 300_000).toISOString() };
    },
    async stripeReturn(brandId) {
      const brand=await domain.getBrand(brandId);
      if(brand.onboardingMode==='two_step' || brand.onboardingState?.platform || brand.onboardingState?.connected)
        fail('Use the configured onboarding payout flow for this brand.',409,'USE_ONBOARDING_PAYOUT_FLOW');
      const app = await application(brandId); const account = app?.steps?.stripePendingAccount;
      if (!account) fail('Start Stripe onboarding first.', 409, 'STRIPE_LINK_REQUIRED');
      // Mocked account.updated webhook: charges and payouts enabled.
      await domain.updateBrand(brandId, { stripeAccountId: account, chargesEnabled: true, payoutsEnabled: true });
      await setStep(brandId, 'stripe', now().toISOString());
      return side.status(brandId);
    },
    async connect(brandId, platform, credentials = {}, {onboardingFlow=false} = {}) {
      const brand = await domain.getBrand(brandId);
      if(!onboardingFlow && (brand.onboardingMode==='two_step' || brand.onboardingState?.platform || brand.onboardingState?.connected))
        fail('Use the two-step onboarding connection flow for this brand.',409,'USE_ONBOARDING_CONNECT_FLOW');
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
    async connectedProfile(brandId, platform) {
      const c=await first(db,"SELECT * FROM brand_connectors WHERE brand_id=$1 AND platform=$2 AND status='connected'",[brandId,platform]);
      if(!c || !adapters[platform]?.profile) fail('This connected store cannot provide authenticated profile metadata.',409,'PROFILE_CAPABILITY_UNAVAILABLE');
      return adapters[platform].profile(creds.decrypt(c.credentialsEnc));
    },
    // Server-only boundary. Native callers must finish validating/paginating the
    // authenticated source before passing its rows; no HTTP endpoint accepts rows.
    async importConnectedSnapshot(brandId, provider, catalogKey, list, options = {}) {
      return withCatalogSnapshot(brandId,provider,catalogKey,async()=>list,options);
    },
    withCatalogSnapshot,
    async disconnect(brandId, platform) {
      const brand = await domain.getBrand(brandId);
      const connector = await first(db, 'SELECT platform FROM brand_connectors WHERE brand_id=$1 AND platform=$2', [brandId, platform]);
      if (!connector) fail('Connector not found.', 404, 'NOT_FOUND');
      // Fail closed before erasing credentials. The core also withdraws approved
      // listings on disconnect; another connector is not an automatic fallback.
      if (brand.connectionTier === platform || (platform === 'csv' && brand.connectionTier === 'dashboard'))
        await domain.updateBrand(brandId, { connectionHealthy: false, status: 'disconnected' });
      if(brand.onboardingMode==='two_step' || brand.onboardingState?.platform) await db.query("UPDATE brands SET onboarding_state=onboarding_state||$2::jsonb WHERE id=$1",[brandId,JSON.stringify({connected:false,catalogImportComplete:false,profileVerified:false})]);
      const r = await db.query("UPDATE brand_connectors SET status='disconnected',credentials_enc=NULL WHERE brand_id=$1 AND platform=$2 RETURNING platform", [brandId, platform]);
      if (!r.rows.length) fail('Connector not found.', 404, 'NOT_FOUND');
      return { platform, disconnected: true };
    },
    async sync(brandId, platform) {
      const brand=await domain.getBrand(brandId);
      if(brand.onboardingState?.platform && (brand.onboardingState.platform!==platform || brand.connectionTier!==platform)) fail('Only the selected onboarding store can refresh this catalog.',409,'STORE_PLATFORM_MISMATCH');
      const c = await first(db, "SELECT * FROM brand_connectors WHERE brand_id=$1 AND platform=$2 AND status='connected'", [brandId, platform]);
      if (!c || !adapters[platform]) fail('No connected store for that platform.', 404, 'NOT_FOUND');
      let result;
      try { result=await withCatalogSnapshot(brandId,platform,targetFor(platform,creds.decrypt(c.credentialsEnc)),()=>adapters[platform].listProducts(creds.decrypt(c.credentialsEnc))); }
      catch (error) { await db.query("UPDATE brand_connectors SET last_result=$3 WHERE brand_id=$1 AND platform=$2", [brandId, platform, JSON.stringify({ error: error.code || 'CONNECTOR_ERROR' })]); throw error; }
      await db.query('UPDATE brand_connectors SET last_sync_at=$3,last_result=$4 WHERE brand_id=$1 AND platform=$2', [brandId, platform, now(), JSON.stringify({ total: result.total, accepted: result.accepted, errors: result.errors.length })]);
      await setStep(brandId, 'catalogSubmitted', now().toISOString());
      return result;
    },
    async importCsv(brandId, csv) {
      if (typeof csv !== 'string' || !csv.trim() || csv.length > 3_000_000) fail('Provide CSV text up to 3 MB.', 422, 'INVALID_IMPORT');
      await domain.getBrand(brandId);
      let list; try { list = csvRows(csvParse, csv); } catch (error) { if (error.statusCode) throw error; fail('CSV could not be parsed.', 422, 'INVALID_CSV'); }
      const brand=await domain.getBrand(brandId);
      if(brand.onboardingState?.platform && brand.onboardingState.platform!=='csv')fail('Use the selected store connector to refresh its catalog.',409,'STORE_PLATFORM_MISMATCH');
      const result = await withCatalogSnapshot(brandId,'csv',`csv:${brandId}`,async()=>list,{complete:false});
      if (await application(brandId)) await setStep(brandId, 'catalogSubmitted', now().toISOString());
      return result;
    },
    async pushOrder(bagId) {
      await domain.getBag(bagId);
      const reservation = await db.transaction(async tx => {
        const current = await lockedBag(tx, bagId);
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
          await closeHandoff(tx, bagId);
          return { receipt };
        }
        await assertOpen(tx, current);
        const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bagId]);
        if (external?.state === 'connector_retry_authorized') {
          if (await busyRecovery(tx, bagId)) fail('Connector recovery is already being verified.', 409, 'RECOVERY_BUSY');
          const grants = await rows(tx, "SELECT * FROM connector_order_recoveries WHERE bag_id=$1 AND status='retry_authorized' AND retry_consumed_by IS NULL FOR UPDATE", [bagId]);
          if (grants.length !== 1 || grants[0].externalId !== external.externalOrderId) fail('No unique retry authorization exists.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          const grant = grants[0], attempt = await first(tx, 'SELECT * FROM connector_dispatch_attempts WHERE id=$1 FOR UPDATE', [grant.attemptId]);
          if (!attempt || attempt.state !== 'voided' || attempt.targetRef !== external.shop) fail('Retry history is inconsistent.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          const connector = await selectedConnector(tx, current, attempt.targetRef), frozen = openSnapshot(attempt, current), token = id('lease');
          await tx.query('UPDATE connector_order_recoveries SET lease_token=$2,lease_expires_at=$3 WHERE operation_id=$1', [grant.operationId, token, new Date(Date.now() + 60_000)]);
          return { retry: { grant, attempt, frozen, connector, token } };
        }
        if (external) {
          if (/^connector_/.test(external.state)) fail('An earlier connector dispatch requires provider reconciliation; it will not be sent again.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          fail('This Bag is already reserved for fulfillment through another workflow.', 409, 'EXTERNAL_FULFILLMENT_RESERVED');
        }
        if (await liveAttempt(tx, bagId)) fail('An earlier dispatch requires recovery.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
        const connector = await selectedConnector(tx, current);
        const attempt = await makeAttempt(tx, current, connector), frozen = openSnapshot(attempt, current);
        // The same durable reservation table is honored by Shopify dispatch,
        // handoff links and the outbox. Never reserve only in process memory.
        await tx.query(`INSERT INTO external_orders(bag_id,brand_id,shop,state)
          VALUES($1,$2,$3,'connector_pending')`, [bagId, current.brandId, connector.marker]);
        await closeHandoff(tx, bagId);
        await audit(tx, 'connector-admin', 'connector.dispatch_reserved', current);
        return { connector, attempt, frozen };
      });
      if (reservation.receipt) return { ...reservation.receipt, replayed: true };
      if (!reservation.retry) return sendAttempt(reservation);
      const retry = reservation.retry;
      try {
        const proof = await adapters[retry.connector.platform].getOrder(retry.connector.credentials, retry.grant.externalId);
        verifyOrder(proof, retry.attempt, retry.frozen, retry.grant.externalId, 'void');
        const next = await db.transaction(async tx => {
          const bag = await lockedBag(tx, bagId); await assertOpen(tx, bag);
          openSnapshot(retry.attempt, bag);
          const grant = await first(tx, 'SELECT *,lease_expires_at>NOW() AS lease_valid FROM connector_order_recoveries WHERE operation_id=$1 FOR UPDATE', [retry.grant.operationId]);
          const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bagId]);
          if (!grant || grant.leaseToken !== retry.token || !grant.leaseValid || grant.status !== 'retry_authorized' || grant.retryConsumedBy
            || external?.state !== 'connector_retry_authorized' || external.shop !== retry.attempt.targetRef || external.externalOrderId !== retry.grant.externalId)
            fail('The retry authorization changed or expired.', 409, 'RECOVERY_LEASE_LOST');
          const connector = await selectedConnector(tx, bag, retry.attempt.targetRef), attempt = await makeAttempt(tx, bag, connector);
          await tx.query("UPDATE connector_order_recoveries SET status='retry_consumed',retry_consumed_by=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=$3 WHERE operation_id=$1", [grant.operationId, attempt.id, wall()]);
          await tx.query("UPDATE external_orders SET state='connector_pending',external_order_id=NULL,last_error=NULL,updated_at=$2 WHERE bag_id=$1", [bagId, wall()]);
          await closeHandoff(tx, bagId); await audit(tx, grant.actor, 'connector.retry_reserved', bag);
          return { attempt, connector, frozen: openSnapshot(attempt, bag) };
        });
        return sendAttempt(next);
      } catch (error) {
        try { await releaseLease(retry.grant.operationId, retry.token); } catch { /* Durable lease expiry remains fail closed. */ }
        if (error?.code === 'CONNECTOR_OUTCOME_UNCERTAIN') throw error;
        fail('A fresh cancellation proof is required before retry; no new order was sent.', 409, 'RECOVERY_RETRY_PROOF_REQUIRED');
      }
    },
    /** Admin-only route surface. Safe metadata only; provider reads happen only on an explicit resolution. */
    async listRecovery({ bagId, limit = 100 } = {}) {
      const cap = int(limit, 'limit', 1, 100);
      const list = await rows(db, `SELECT e.bag_id,e.brand_id,e.shop,e.state,e.external_order_id,e.updated_at
        FROM external_orders e WHERE e.state IN ('connector_pending','connector_uncertain','connector_retry_authorized')
        AND ($1::text IS NULL OR e.bag_id=$1) ORDER BY e.updated_at,e.bag_id LIMIT $2`, [bagId || null, cap]);
      return Promise.all(list.map(async row => {
        const attempts = await rows(db, `SELECT id,state,platform,external_id,created_at,updated_at FROM connector_dispatch_attempts
          WHERE bag_id=$1 ORDER BY created_at,id`, [row.bagId]);
        const history = await rows(db, `SELECT operation_id,attempt_id,action,external_id,actor,status,retry_consumed_by,created_at,updated_at
          FROM connector_order_recoveries WHERE bag_id=$1 ORDER BY created_at,operation_id`, [row.bagId]);
        const platform = row.shop.split(':')[0];
        return { bagId: row.bagId, brandId: row.brandId, platform, storeRef: row.shop.slice(platform.length + 1),
          state: row.state, externalId: row.externalOrderId, currentAttemptId: attempts.find(a => ['pending', 'uncertain', 'created', 'confirmed'].includes(a.state))?.id || null,
          updatedAt: row.updatedAt, attempts, history, providerWrites: 0 };
      }));
    },
    /** Read and verify an existing native order. 'void' never cancels remotely: it only proves prior cancellation. */
    async resolveRecovery(input = {}) {
      const { bagId, operationId, action, externalId, reason, actor } = input;
      if (typeof bagId !== 'string' || !bagId || !/^[A-Za-z0-9_-]{8,100}$/.test(operationId || '') || !['confirm', 'void'].includes(action)
        || typeof externalId !== 'string' || !/^[1-9]\d{0,29}$/.test(externalId) || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000
        || typeof actor !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(actor)) fail('Provide a valid recovery operation, action, native order ID and review reason.', 422, 'INVALID_RECOVERY');
      const requestHash = digest({ bagId, operationId, action, externalId, reason: reason.trim(), actor });
      const claim = await db.transaction(async tx => {
        const bag = await lockedBag(tx, bagId);
        const previous = await first(tx, 'SELECT *,lease_expires_at>NOW() AS lease_valid FROM connector_order_recoveries WHERE operation_id=$1 FOR UPDATE', [operationId]);
        if (previous && previous.requestHash !== requestHash) fail('The operation ID was already used for a different recovery.', 422, 'IDEMPOTENCY_CONFLICT');
        if (previous?.result) return { replay: { ...previous.result, replayed: true } };
        if (previous?.leaseToken && previous.leaseValid) fail('This recovery is already being verified.', 409, 'RECOVERY_BUSY');
        if (await busyRecovery(tx, bagId, operationId)) fail('Another recovery is already being verified for this Bag.', 409, 'RECOVERY_BUSY');
        await assertOpen(tx, bag);
        const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bagId]);
        if (!external || !['connector_pending', 'connector_uncertain'].includes(external.state)
          || await first(tx, 'SELECT bag_id FROM connector_orders WHERE bag_id=$1', [bagId])) fail('This dispatch is not awaiting recovery.', 409, 'RECOVERY_NOT_AVAILABLE');
        if (external.state === 'connector_pending' && Date.parse(external.updatedAt) > Date.now() - 60_000)
          fail('Wait for the in-flight dispatch to finish or become stale before reviewing it.', 409, 'RECOVERY_DISPATCH_IN_PROGRESS');
        const connector = await selectedConnector(tx, bag, external.shop);
        let attempt = await liveAttempt(tx, bagId);
        if (!attempt) {
          const history = await first(tx, 'SELECT COUNT(*)::int AS count FROM connector_dispatch_attempts WHERE bag_id=$1', [bagId]);
          if (history.count) fail('Missing current-attempt evidence requires review.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
          // Legacy fallback is imported only once and only before any sibling attempt exists.
          attempt = await makeAttempt(tx, bag, connector, true, 'uncertain');
        }
        if (attempt.targetRef !== external.shop || !['pending', 'uncertain'].includes(attempt.state)
          || (previous && previous.attemptId !== attempt.id)) fail('Recovery does not refer to the current dispatch attempt.', 409, 'CONNECTOR_OUTCOME_UNCERTAIN');
        const frozen = openSnapshot(attempt, bag), token = id('lease'), expires = new Date(Date.now() + 60_000);
        if (previous) await tx.query("UPDATE connector_order_recoveries SET status='processing',lease_token=$2,lease_expires_at=$3,updated_at=$4 WHERE operation_id=$1", [operationId, token, expires, wall()]);
        else await tx.query(`INSERT INTO connector_order_recoveries(operation_id,bag_id,attempt_id,action,external_id,request_hash,reason_enc,actor,status,lease_token,lease_expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10,$11,$11)`, [operationId, bagId, attempt.id, action, externalId, requestHash,
          recoveryVault.encrypt({ reason: reason.trim() }), actor, token, expires, wall()]);
        await audit(tx, actor, 'connector.recovery_started', bag);
        return { bag, connector, attempt, frozen, token, externalState: external.state };
      });
      if (claim.replay) return claim.replay;
      let proof = null, blockedReason = null;
      try {
        proof = await adapters[claim.connector.platform].getOrder(claim.connector.credentials, externalId);
        verifyOrder(proof, claim.attempt, claim.frozen, externalId, action);
      } catch (error) {
        blockedReason = ['RECOVERY_PROOF_MISMATCH', 'RECOVERY_REMOTE_STATE_INVALID', 'RECOVERY_VOID_NOT_VERIFIED'].includes(error?.code) ? error.code : 'PROVIDER_READ_UNAVAILABLE';
      }
      return db.transaction(async tx => {
        const bag = await lockedBag(tx, bagId);
        const review = await first(tx, 'SELECT *,lease_expires_at>NOW() AS lease_valid FROM connector_order_recoveries WHERE operation_id=$1 FOR UPDATE', [operationId]);
        if (!review || review.leaseToken !== claim.token || !review.leaseValid || review.status !== 'processing')
          fail('The recovery verification lease expired or changed. No dispatch was released.', 409, 'RECOVERY_LEASE_LOST');
        const external = await first(tx, 'SELECT * FROM external_orders WHERE bag_id=$1 FOR UPDATE', [bagId]);
        const attempt = await first(tx, 'SELECT * FROM connector_dispatch_attempts WHERE id=$1 FOR UPDATE', [claim.attempt.id]);
        if (!blockedReason) {
          try {
            await assertOpen(tx, bag); openSnapshot(claim.attempt, bag); await selectedConnector(tx, bag, claim.attempt.targetRef);
            if (!attempt || !['pending', 'uncertain'].includes(attempt.state) || external?.state !== claim.externalState || external.shop !== claim.attempt.targetRef
              || await first(tx, 'SELECT bag_id FROM connector_orders WHERE bag_id=$1', [bagId])) throw new Error('Changed dispatch.');
          } catch { blockedReason = 'RECOVERY_CONTEXT_CHANGED'; }
        }
        const status = blockedReason ? 'blocked' : action === 'confirm' ? 'confirmed' : 'retry_authorized';
        const result = { operationId, bagId, attemptId: claim.attempt.id, action, status, externalId,
          ...(blockedReason ? { blockedReason } : { verification: 'authoritative_readback' }), requiresSeparatePush: status === 'retry_authorized', providerWrites: 0 };
        if (!blockedReason && action === 'confirm') {
          await tx.query('INSERT INTO connector_orders(bag_id,brand_id,platform,external_id,created_at) VALUES($1,$2,$3,$4,$5)', [bagId, bag.brandId, claim.connector.platform, externalId, wall()]);
          await tx.query("UPDATE external_orders SET state='connector_created',external_order_id=$2,last_error=NULL,updated_at=$3 WHERE bag_id=$1", [bagId, externalId, wall()]);
          await tx.query("UPDATE connector_dispatch_attempts SET state='confirmed',external_id=$2,updated_at=$3 WHERE id=$1", [attempt.id, externalId, wall()]);
        } else if (!blockedReason) {
          await tx.query("UPDATE connector_dispatch_attempts SET state='voided',external_id=$2,updated_at=$3 WHERE id=$1", [attempt.id, externalId, wall()]);
          await tx.query("UPDATE external_orders SET state='connector_retry_authorized',external_order_id=$2,last_error=NULL,updated_at=$3 WHERE bag_id=$1", [bagId, externalId, wall()]);
        }
        await tx.query(`UPDATE connector_order_recoveries SET status=$2,proof_enc=$3,result=$4,lease_token=NULL,lease_expires_at=NULL,updated_at=$5 WHERE operation_id=$1`,
          [operationId, status, proof ? recoveryVault.encrypt(proof) : null, JSON.stringify(result), wall()]);
        await closeHandoff(tx, bagId);
        await audit(tx, actor, `connector.recovery_${status}`, bag);
        return result;
      }).catch(error => {
        if (error?.code === 'RECOVERY_LEASE_LOST') throw error;
        fail('Recovery could not be committed. The dispatch remains reserved; retry only the same review operation after its lease expires.', 503, 'RECOVERY_COMMIT_FAILED');
      });
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
      const list = await rows(db, "SELECT * FROM products WHERE status IN ('in_review','draft') ORDER BY updated_at");
      return Promise.all(list.map(async p => ({ id: p.id, brandId: p.brandId, sku: p.sku, title: p.title, status: p.status, validationIssues: p.validationIssues,
        compliance: compliance ? await compliance.check(p) : null, updatedAt: p.updatedAt })));
    },
    async activate(brandId, {twoStep=false,actor='system:onboarding'} = {}) {
      if(twoStep) { await domain.activateConnectedBrand(brandId,{actor}); return side.status(brandId); }
      const status = await side.status(brandId);
      if (!status.steps.find(step => step.key === 'store_connection')?.done) fail('Onboarding incomplete: Store connection.', 409, 'ONBOARDING_INCOMPLETE');
      if (status.onboardingRequirements.length) fail(`Onboarding incomplete: ${status.onboardingRequirements.join('; ')}.`, 409, 'ONBOARDING_INCOMPLETE');
      if(status.steps.some(step=>['stripe_express','profile','catalog_approved'].includes(step.key) && !step.done)) fail('Legacy activation requires the full payout, profile and approved-product checklist.',409,'ONBOARDING_INCOMPLETE');
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
      const product = await first(db, "SELECT id,status,source_deleted_at FROM products WHERE id=$1 AND brand_id=$2", [input.productId, brandId]);
      if (!product) fail('Product not found.', 404, 'NOT_FOUND');
      if (product.status !== 'approved' || product.sourceDeletedAt) fail('Only approved products can be promoted.', 409, 'PRODUCT_NOT_APPROVED');
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
        WHERE pl.kind=$1 AND pl.status='approved' AND pl.starts_at<=$2 AND pl.ends_at>$2 AND p.status='approved' AND p.source_deleted_at IS NULL AND (pl.kind<>'sponsored_swipe' OR pl.impressions<pl.units) ORDER BY pl.impressions,pl.created_at LIMIT $3`, [kind, now(), Math.min(50, limit)]);
      for (const c of list) await db.query('UPDATE placements SET impressions=impressions+1 WHERE id=$1', [c.id]);
      return list.map(c => ({ placementId: c.id, brandId: c.brandId, productId: c.productId, title: c.title, image: c.images?.[0] || null, priceCents: c.priceCents, sponsored: true, kind: c.kind }));
    },
    async click(placementId) { const r = await first(db, 'UPDATE placements SET clicks=clicks+1 WHERE id=$1 RETURNING id,clicks', [placementId]); if (!r) fail('Placement not found.', 404, 'NOT_FOUND'); return r; },
  };
  return side;
}
