import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './helpers/platform-fixture.mjs';

const shipTo = { name: 'Synthetic Shopper', line1: '100 Test Street', city: 'Austin', region: 'TX', postal: '78701', country: 'US' };
const productInput = title => ({ title, description: 'Synthetic cotton washcloth for isolated onboarding tests.', category: 'body-care/accessories',
  priceCents: 1200, inventoryQty: 10, images: ['https://cdn.shopify.com/s/test/cloth.png'], taxCode: 'txcd_99999999', shippingProfile: 'standard',
  evidence: { ingredients_inci: ['Cotton'], certifications: [], claims: [], contraindications: '' } });

async function invited(f, label) {
  const signup = await f.ok(f.request({ method: 'POST', url: '/api/portal/signup', payload: { brandName: `Synthetic ${label}`, email: `${label}@example.com` } }));
  const preview = await f.request({ method: 'GET', url: `/api/onboarding/invites/${signup.inviteToken}` });
  assert.equal(preview.statusCode, 200, preview.body); assert.equal(preview.headers['set-cookie'], undefined);
  assert.deepEqual(Object.keys(preview.json().data).sort(), ['brand', 'expiresAt', 'sandbox']);
  const accepted = await f.request({ method: 'POST', url: `/api/invites/${signup.inviteToken}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await f.domain.getBrand(signup.brandId)).onboardingMode, 'two_step', 'invite acceptance enrolls before any store detection');
  const cookie = String(accepted.headers['set-cookie']).split(';')[0], csrf = accepted.json().data.csrfToken;
  const request = o => f.request({ ...o, headers: { cookie, 'x-csrf-token': csrf, ...o.headers } });
  const session = await f.ok(request({ method: 'GET', url: '/api/onboarding/session' }));
  assert.equal(session.brandId, signup.brandId); assert.equal(session.role, 'brand');
  return { brandId: signup.brandId, request, cookie, csrf, signup };
}

async function storesFixture(t, overrides = {}) {
  let f;
  const calls = [], controls = {}, adapters = {};
  for (const platform of ['shopify', 'woocommerce', 'bigcommerce']) {
    const control = controls[platform] = { verified: true, syncError: null, connectError: null, incomplete: false, flagged: false };
    adapters[platform] = { simulated: true,
      async connect(brandId, credentials) {
        calls.push({ method: 'connect', platform, brandId });
        if (control.connectError) throw control.connectError;
        if (platform === 'shopify' && control.verified) {
          // A server-owned fake proof, never a user assertion or real token.
          const shop = new URL(credentials.storeUrl).hostname;
          await f.db.query(`INSERT INTO shopify_connections(brand_id,shop,token_encrypted,granted_scopes,status,installed_at)
            VALUES($1,$2,NULL,'[]','connected',NOW())`, [brandId, shop]);
        }
        return { verified: control.verified, storeRef: credentials.storeUrl || `synthetic-${platform}.example.com`, simulated: true };
      },
      async profile(brandId) { calls.push({ method: 'profile', platform, brandId }); return { name: `Verified ${platform} fixture`, contactEmail: `${platform}@example.com`,
        logoUrl: 'https://cdn.shopify.com/s/test/logo.png', returnPolicy: { text: 'Synthetic store policy; Avafem terms remain separately reviewed.' },
        commissionBps: 0, returnWindowDays: 0, payoutsEnabled: true, status: 'approved', health: 'PRIVATE_HEALTH', token: 'PRIVATE_TOKEN' }; },
      async sync(brandId) {
        calls.push({ method: 'sync', platform, brandId }); if (control.syncError) throw control.syncError;
        if (control.incomplete) return { total: 1, accepted: 0, errors: [{ code: 'SYNTHETIC_ROW_FAILURE' }] };
        await f.domain.upsertProduct(brandId, `ONB-${platform.toUpperCase()}`, { ...productInput(`${platform} cloth`), ...(control.flagged ? { description: 'This product cures cancer.' } : {}) });
        return { total: 1, accepted: 1, errors: [] };
      },
    };
  }
  f = await platformFixture(t, { platform: { onboarding: { storeAdapters: adapters, ...overrides } } });
  return { ...f, calls, controls };
}

test('invite acceptance → each simulated verified store imports profile/catalog and activates only the brand with deferred payouts', async t => {
  const f = await storesFixture(t);
  for (const platform of ['shopify', 'woocommerce', 'bigcommerce']) {
    const b = await invited(f, platform), url = platform === 'shopify' ? 'https://synthetic-onboarding.myshopify.com' : platform === 'bigcommerce' ? 'https://synthetic-onboarding.mybigcommerce.com' : 'https://synthetic-woo.example.com';
    const detected = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/detect`, payload: { storeUrl: url } }));
    assert.equal(detected.verified, false); assert.equal(detected.capability.configured, false);
    const status = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform, credentials: { storeUrl: url } } }));
    assert.equal(status.connection.platform, platform); assert.equal(status.connection.verified, true); assert.equal(status.connection.simulated, true);
    assert.equal(status.steps.store.complete, true); assert.equal(status.brand.status, 'live'); assert.equal(status.activation.productsRemainCurated, true);
    assert.equal(status.steps.payouts.status, 'deferred'); assert.equal(status.steps.payouts.deferred, true); assert(status.payoutNotice.includes('held'));
    assert.equal(status.brand.name, `Verified ${platform} fixture`); assert.equal(status.profile.requiresReview, true);
    assert.equal(status.profile.provenance.source, platform); assert.equal(status.capabilities.payouts.configured, false);
    const brand = await f.domain.getBrand(b.brandId); assert.equal(brand.commissionBps, 1500); assert.equal(brand.returnWindowDays, 30);
    assert.equal(brand.stripeAccountId, null); assert.equal(brand.payoutsEnabled, false);
    const products = await f.domain.listProducts({ brandId: b.brandId }); assert.equal(products.length, 1); assert.notEqual(products[0].status, 'approved');
    assert.equal((await f.domain.listProducts({ brandId: b.brandId, status: 'approved' })).length, 0);
    await assert.rejects(f.domain.createSandboxOrder({ items: [{ brandId: b.brandId, sku: products[0].sku, qty: 1 }], shipTo }), e => e.code === 'PRODUCT_UNAVAILABLE');
    assert(!/PRIVATE_HEALTH|PRIVATE_TOKEN|consumerSecret|tokenEncrypted/.test(JSON.stringify(status)));
    const repeated = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform } }));
    assert.equal(repeated.brand.status, 'live'); assert.equal(f.calls.filter(c => c.method === 'connect' && c.brandId === b.brandId).length, 1);
  }
});

test('unknown store can use native CSV fallback, finish without a bank account, and retain manual product review', async t => {
  const f = await storesFixture(t), b = await invited(f, 'csv');
  const detected = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/detect`, payload: { storeUrl: 'https://custom-catalog.example.com' } }));
  assert.equal(detected.platform, 'unknown'); assert.equal(detected.probeStatus, 'disabled_local_only'); assert.deepEqual(detected.fallback, ['csv', 'feed']);
  const csv = 'sku,title,description,category,price,inventoryQty,images,taxCode\nCSV-CLOTH,Cotton cloth,Plain cotton cloth,body-care/accessories,12.00,10,https://cdn.shopify.com/s/test/cloth.png,txcd_99999999\n';
  const status = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/catalog`, payload: { csv } }));
  assert.equal(status.connection.platform, 'csv'); assert.equal(status.connection.verified, true); assert.equal(status.steps.store.complete, true);
  assert.equal(status.brand.status, 'live'); assert.equal(status.steps.payouts.status, 'deferred'); assert.equal(status.catalog.approved, 0);
  assert.equal((await f.domain.listProducts({ brandId: b.brandId }))[0].sku, 'CSV-CLOTH'); assert.equal(f.calls.length, 0);
  const skip = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/payouts/skip`, payload: {} }));
  assert.equal(skip.steps.payouts.deferred, true); assert.equal((await f.domain.getBrand(b.brandId)).payoutsEnabled, false);
});

test('operator approval permits an order, but deferred payouts stay held and upcoming payout jobs create one honest prompt', async t => {
  const f = await storesFixture(t), b = await invited(f, 'held-payable');
  await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'woocommerce', credentials: { storeUrl: 'https://synthetic-woo.example.com' } } }));
  const product = (await f.domain.listProducts({ brandId: b.brandId }))[0];
  await f.ok(f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } }));
  const order = await f.domain.createSandboxOrder({ externalId: 'TWO-STEP-PAYOUT-HOLD', items: [{ brandId: b.brandId, sku: product.sku, qty: 1 }], shipTo });
  const bag = order.bags[0]; assert.equal((await f.domain.listTransfers({ brandId: b.brandId }))[0].status, 'held');
  await f.domain.recordShipment(bag.id, { carrier: 'Synthetic Carrier', trackingNumber: 'SYNTHETIC-ONBOARDING-001' });
  await f.domain.markDelivered(bag.id);
  const jobs = await f.domain.listJobs({ brandId: b.brandId }); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'held');
  await f.db.query("UPDATE bags SET delivered_at=NOW()-interval '60 days',payout_due_at=NOW()-interval '1 day' WHERE id=$1", [bag.id]);
  await f.db.query("UPDATE transfers SET due_at=NOW()-interval '1 day' WHERE bag_id=$1", [bag.id]);
  await f.db.query("UPDATE jobs SET due_at=NOW()-interval '1 day' WHERE bag_id=$1", [bag.id]);
  assert.equal((await f.domain.runDueSandboxPayouts()).processed, 0);
  const prompt = await f.platform.onboarding.payoutPrompts(); assert.equal(prompt.prompted, 1); assert.equal(prompt.externalEmailDelivered, false);
  await f.platform.onboarding.payoutPrompts();
  const alerts = (await f.db.query("SELECT * FROM platform_alerts WHERE resource_id=$1 AND kind='payout_onboarding_required'", [b.brandId])).rows;
  assert.equal(alerts.length, 1); assert.equal((await f.domain.listTransfers({ brandId: b.brandId }))[0].status, 'held');
  assert.equal((await f.domain.listCredits({ brandId: b.brandId }))[0].status, 'pending');
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM ledger_journals WHERE bag_id=$1 AND kind='sandbox_payout'", [bag.id])).rows[0].n, 0);
});

test('onboarding rejects foreign tenants, bearer sessions, missing CSRF and attempts to set authority fields', async t => {
  const f = await storesFixture(t), b = await invited(f, 'tenant');
  const foreign = '/api/onboarding/brand_hearth';
  assert.equal((await b.request({ method: 'GET', url: foreign })).statusCode, 403);
  assert.equal((await b.request({ method: 'PATCH', url: `${foreign}/profile`, payload: { name: 'COUNTERFEIT' } })).statusCode, 403);
  const credential = await f.credential(b.brandId, ['catalog:read', 'catalog:write']);
  const bearer = await f.bearer(credential, { method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'csv' } });
  assert.equal(bearer.statusCode, 403); assert.equal(bearer.json().error.code, 'BROWSER_SESSION_REQUIRED');
  const noCsrf = await f.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, headers: { cookie: b.cookie }, payload: { platform: 'csv' } });
  assert.equal(noCsrf.statusCode, 403); assert.equal(noCsrf.json().error.code, 'CSRF_REQUIRED');
  assert.equal((await f.request({ method: 'GET', url: `/api/onboarding/${b.brandId}` })).statusCode, 401);
  assert.equal((await b.request({ method: 'GET', url: '/api/admin/curation' })).statusCode, 403);
  for (const payload of [{ status: 'live' }, { payoutsEnabled: true }, { commissionBps: 0 }, { returnWindowDays: 0 }])
    assert.equal((await b.request({ method: 'PATCH', url: `/api/onboarding/${b.brandId}/profile`, payload })).statusCode, 422);
  assert.equal((await f.domain.getBrand('brand_hearth')).name, 'Hearth & Hue'); assert.equal(f.calls.length, 0);
});

test('missing Shopify and payout drivers return honest unconfigured capabilities without fake provider completion', async t => {
  const f = await platformFixture(t), b = await invited(f, 'unconfigured');
  const status = await f.ok(b.request({ method: 'GET', url: `/api/onboarding/${b.brandId}` }));
  assert.equal(status.capabilities.payouts.configured, false); assert.equal(status.capabilities.payouts.mode, 'unconfigured');
  await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/detect`, payload: { storeUrl: 'https://synthetic-missing.myshopify.com' } }));
  const missing = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'shopify' } }));
  assert.equal(missing.configured, false); assert.equal(missing.authorizationRequired, true);
  const oauth = await b.request({ method: 'POST', url: missing.next.path, payload: {} }); assert.equal(oauth.statusCode, 503); assert.equal(oauth.json().error.code, 'SHOPIFY_OAUTH_NOT_CONFIGURED');
  const payout = await b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/payouts/start`, payload: {} });
  assert.equal(payout.statusCode, 503); assert.equal(payout.json().error.code, 'PAYOUT_ONBOARDING_NOT_CONFIGURED');
  assert.equal((await f.domain.getBrand(b.brandId)).connectionHealthy, false); assert.equal((await f.domain.getBrand(b.brandId)).payoutsEnabled, false);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM shopify_oauth_states WHERE brand_id=$1', [b.brandId])).rows[0].n, 0);
});

test('unverified connection, incomplete imports and flagged listings cannot auto-activate a brand', async t => {
  const f = await storesFixture(t), b = await invited(f, 'failure');
  f.controls.woocommerce.verified = false;
  let response = await b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'woocommerce' } });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'STORE_CONNECTION_UNVERIFIED');
  assert.notEqual((await f.domain.getBrand(b.brandId)).status, 'live'); assert.equal((await f.domain.listProducts({ brandId: b.brandId })).length, 0);
  f.controls.woocommerce.verified = true; f.controls.woocommerce.incomplete = true;
  response = await b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'woocommerce' } });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'CATALOG_IMPORT_INCOMPLETE');
  assert.notEqual((await f.domain.getBrand(b.brandId)).status, 'live');
  f.controls.woocommerce.incomplete = false; f.controls.woocommerce.flagged = true;
  const status = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/sync`, payload: {} }));
  assert.equal(status.activation.brandActive, false); assert.equal(status.activation.blockedReason, 'ONBOARDING_COMPLIANCE_REVIEW');
  assert.equal(status.catalog.approved, 0); assert.equal((await f.domain.listProducts({ brandId: b.brandId }))[0].status === 'approved', false);
});

test('profile edits are display-only and survive re-sync; direct sync provider failures expose only controlled diagnostics', async t => {
  const f = await storesFixture(t), b = await invited(f, 'profile');
  await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'woocommerce' } }));
  const edited = await f.ok(b.request({ method: 'PATCH', url: `/api/onboarding/${b.brandId}/profile`, payload: { name: 'Owner edited display name', returnPolicy: 'Owner-reviewed display policy.' } }));
  assert.equal(edited.brand.name, 'Owner edited display name'); assert.equal(edited.profile.requiresReview, false);
  const synced = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/sync`, payload: {} })); assert.equal(synced.brand.name, 'Owner edited display name');
  f.controls.woocommerce.syncError = Object.assign(new Error('PRIVATE_TOKEN PRIVATE_SHOPPER_ADDRESS'), { statusCode: 502, code: 'PROVIDER_FAILED' });
  const failed = await b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/sync`, payload: {} });
  assert.equal(failed.statusCode, 502); assert(!/PRIVATE_TOKEN|PRIVATE_SHOPPER/.test(failed.body), failed.body);
});

test('new onboarding cannot complete deferred payouts through the legacy simulated Stripe link/return paths', async t => {
  const f = await storesFixture(t), b = await invited(f, 'no-legacy-payout');
  async function legacyBlocked() {
    for (const action of ['link', 'return']) {
      const response = await b.request({ method: 'POST', url: `/api/portal/${b.brandId}/stripe/${action}`, payload: {} });
      assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'USE_ONBOARDING_PAYOUT_FLOW');
    }
  }
  const accepted = await f.domain.getBrand(b.brandId);
  assert.equal(accepted.onboardingMode, 'two_step'); assert.equal(accepted.payoutSetup, 'deferred');
  assert.notEqual(accepted.status, 'live'); assert.notEqual(accepted.status, 'ready');
  assert.equal(accepted.onboardingState.platform, undefined); assert.notEqual(accepted.onboardingState.connected, true);
  await legacyBlocked(); // Critical: no detect/connect call has happened yet.
  await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/detect`, payload: { storeUrl: 'https://synthetic-woo.example.com' } }));
  await legacyBlocked();
  await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/connect`, payload: { platform: 'woocommerce', credentials: { storeUrl: 'https://synthetic-woo.example.com' } } }));
  const product = (await f.domain.listProducts({ brandId: b.brandId }))[0];
  await f.ok(f.owner({ method: 'POST', url: `/api/products/${product.id}/review`, payload: { decision: 'approved' } }));
  const order = await f.domain.createSandboxOrder({ externalId: 'NO-LEGACY-PAYOUT', items: [{ brandId: b.brandId, sku: product.sku, qty: 1 }], shipTo });
  assert.equal((await f.domain.listTransfers({ brandId: b.brandId }))[0].status, 'held');
  await legacyBlocked();
  const status = await f.ok(b.request({ method: 'POST', url: `/api/onboarding/${b.brandId}/sync`, payload: {} }));
  assert.equal(status.steps.payouts.status, 'deferred'); assert.equal(status.capabilities.payouts.configured, false);
  const brand = await f.domain.getBrand(b.brandId); assert.equal(brand.payoutSetup, 'deferred'); assert.equal(brand.stripeAccountId, null);
  assert.equal(brand.payoutsEnabled, false); assert.equal(brand.chargesEnabled, false);
  assert.equal((await f.domain.listTransfers({ brandId: b.brandId }))[0].status, 'held');
  assert.equal((await f.db.query('SELECT steps FROM brand_applications WHERE brand_id=$1', [b.brandId])).rows[0].steps.stripePendingAccount, undefined);
  assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM ledger_journals WHERE bag_id=$1 AND kind='sandbox_payout'", [order.bags[0].id])).rows[0].n, 0);
});

test('a failed two-step invitation transition consumes no new session or cookie and cannot expose the legacy payout gap', async t => {
  const f = await platformFixture(t), invite = await f.auth.createInvite('brand_bloom');
  const before = (await f.db.query('SELECT COUNT(*)::int AS n FROM auth_sessions')).rows[0].n;
  t.mock.method(f.domain, 'enterTwoStepOnboarding', async () => { throw Object.assign(new Error('Synthetic onboarding transition blocked.'), { statusCode: 409, code: 'ONBOARDING_TRANSITION_BLOCKED' }); });
  const response = await f.request({ method: 'POST', url: `/api/invites/${invite.token}/accept`, payload: { acceptedSandboxTerms: true } });
  assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().error.code, 'ONBOARDING_TRANSITION_BLOCKED');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM auth_sessions')).rows[0].n, before);
  assert.equal((await f.request({ method: 'POST', url: `/api/invites/${invite.token}/accept`, payload: { acceptedSandboxTerms: true } })).statusCode, 401);
});
