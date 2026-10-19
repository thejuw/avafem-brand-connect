#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';

const ORIGIN = 'http://127.0.0.1:4317';
const RUN = 'uco_33e3eed7612b443d82655b1a4e07bb55';
const SHOPS = ['i4vd1u-s8.myshopify.com', 'qpsd02-jz.myshopify.com', 'ir7112-v1.myshopify.com'];
const CODES = new Set(['AUTHENTICATION_REQUIRED', 'CSRF_REQUIRED', 'ADMIN_REQUIRED', 'INVALID_HOST', 'ORIGIN_DENIED',
  'INVALID_SIGNATURE', 'NOT_FOUND', 'TENANT_MISMATCH', 'LOCAL_TEST_ONLY', 'LOCAL_REQUEST_FAILED',
  'LOCAL_SETUP_UNVERIFIED', 'PREREQUISITE_FAILED', 'RESTORE_UNVERIFIED']);
const businessId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);
const safeError = value => CODES.has(value) ? value : null;
const probeBody = Object.freeze({ guardProbeOnly: true }); // Invalid for all financial/lifecycle schemas, even if a guard regresses.

// Native HTTP is intentional: fetch may rewrite Host, invalidating that probe.
// No proxy environment, DNS hostname, automatic redirects or cookie jar is used.
function loopbackHttp(url, options) {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password) throw new Error('LOCAL_REQUEST_FAILED');
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(parsed, { method: options.method, headers: options.headers, signal: options.signal }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.byteLength;
        if (bytes > 262144) { response.destroy(); outgoing.destroy(new Error('LOCAL_REQUEST_FAILED')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('LOCAL_REQUEST_FAILED')));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? ''])) })));
    });
    outgoing.on('error', () => reject(new Error('LOCAL_REQUEST_FAILED')));
    outgoing.end(options.body);
  });
}

export function guardBaseUrl(value = ORIGIN) {
  if (typeof value !== 'string' || ![ORIGIN, `${ORIGIN}/`].includes(value)) throw new Error('LOCAL_BASE_URL_REQUIRED');
  return ORIGIN;
}
export function denialHasNoData(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'error')
    || !body.error || typeof body.error !== 'object' || Array.isArray(body.error)
    || Object.keys(body.error).some(key => !['code', 'message'].includes(key))) return false;
  const message = body.error.message;
  return typeof body.error.code === 'string' && typeof message === 'string' && message.length <= 500
    && !/(?:\b(?:sk|rk|pk)_(?:test|live)_|whsec_|shpat_|shpss_|shpca_|Bearer\s|avf_session=|@|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/i.test(message);
}
export function completedGuardTargets(summary) {
  if (summary?.id !== RUN || summary.test !== true || summary.currency !== 'USD' || summary.state !== 'completed'
    || !Array.isArray(summary.bags) || summary.bags.length !== 3) throw new Error('LOCAL_SETUP_UNVERIFIED');
  const result = SHOPS.map(shop => {
    const bag = summary.bags.find(item => item.shop === shop);
    if (!bag || !businessId(bag.id) || !businessId(bag.brandId) || bag.payoutStatus !== 'paid') throw new Error('LOCAL_SETUP_UNVERIFIED');
    return { shop, bagId: bag.id, brandId: bag.brandId };
  });
  if (new Set(result.map(item => item.bagId)).size !== 3 || new Set(result.map(item => item.brandId)).size !== 3)
    throw new Error('LOCAL_SETUP_UNVERIFIED');
  return result;
}

/** Actual loopback HTTP guards only. No environment, provider API, signing keys,
 * valid webhook signatures, existing-run mutations, credentials or files.
 * The only authorized successful POST changes this probe's own session scope.
 */
export async function runLocalHttpGuards({ baseUrl = ORIGIN, fetchImpl = loopbackHttp } = {}) {
  const base = guardBaseUrl(baseUrl), cases = [];
  let cookie = '', csrf = '', targets = null, sessionCreated = false;
  const result = (caseId, status, expected, pass, errorCode = null) => {
    cases.push({ caseId, status, expected, pass: pass === true, errorCode: safeError(errorCode) });
  };
  async function request(path, { method = 'GET', authenticated = true, includeCsrf = true, headers = {}, body } = {}) {
    // Every outbound request is fixed loopback and every redirect is rejected.
    if (!/^\/(?:api|webhooks)\//.test(path) || path.includes('://')) throw new Error('LOCAL_REQUEST_FAILED');
    const response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(6000), headers: {
        ...(authenticated && cookie ? { cookie } : {}),
        ...(authenticated && includeCsrf && csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let bytes = 0, text = '';
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength; if (bytes > 262144) throw new Error('LOCAL_REQUEST_FAILED');
      text += new TextDecoder().decode(chunk);
    }
    let bodyValue; try { bodyValue = JSON.parse(text); } catch { bodyValue = null; }
    return { status: response.status, body: bodyValue, headers: response.headers };
  }
  async function denied(caseId, path, expected, expectedCodes, options = {}) {
    try {
      const response = await request(path, options), code = response.body?.error?.code;
      const allowed = Array.isArray(expected) ? expected.includes(response.status) : response.status === expected;
      result(caseId, response.status, expected, allowed && expectedCodes.includes(code) && denialHasNoData(response.body), code);
    } catch { result(caseId, null, expected, false, 'LOCAL_REQUEST_FAILED'); }
  }
  async function switchScope(brandId) {
    const response = await request('/api/session/brand', { method: 'POST', body: { brandId } });
    return { response, verified: response.status === 200 && response.body?.data?.brandId === brandId
      && response.body.data.owner === true && response.body.data.role === (brandId ? 'brand' : 'admin') };
  }
  try {
    const session = await request('/api/session', { authenticated: false });
    const rawCookie = session.headers.get('set-cookie') || '';
    cookie = /^avf_session=[A-Za-z0-9_-]{16,300}(?=;|$)/.exec(rawCookie)?.[0] || '';
    csrf = typeof session.body?.data?.csrfToken === 'string' ? session.body.data.csrfToken : '';
    sessionCreated = Boolean(cookie);
    const verifiedSession = session.status === 200 && cookie && /^[A-Za-z0-9_-]{16,300}$/.test(csrf)
      && session.body.data.owner === true && session.body.data.brandId === null && session.body.data.role === 'admin';
    result('independent_owner_session', session.status, 200, verifiedSession);
    if (!verifiedSession) throw new Error('LOCAL_SETUP_UNVERIFIED');
    const saved = await request(`/api/unified-checkout/${RUN}`);
    try { targets = completedGuardTargets(saved.body?.data); }
    catch { result('completed_three_store_targets', saved.status, 200, false, 'LOCAL_SETUP_UNVERIFIED'); throw new Error('LOCAL_SETUP_UNVERIFIED'); }
    result('completed_three_store_targets', saved.status, 200, saved.status === 200);
    for (const suffix of ['refund', 'fulfill', 'reconcile']) {
      await denied(`no_cookie_${suffix}`, `/api/unified-checkout/${RUN}/${suffix}`, 401, ['AUTHENTICATION_REQUIRED'],
        { method: 'POST', authenticated: false, body: probeBody });
      await denied(`missing_csrf_${suffix}`, `/api/unified-checkout/${RUN}/${suffix}`, 403, ['CSRF_REQUIRED'],
        { method: 'POST', includeCsrf: false, body: probeBody });
    }
    await denied('no_cookie_saved_run', `/api/unified-checkout/${RUN}`, 401, ['AUTHENTICATION_REQUIRED'], { authenticated: false });
    await denied('bad_host_saved_run', `/api/unified-checkout/${RUN}`, 403, ['INVALID_HOST', 'LOCAL_TEST_ONLY'], { headers: { host: 'guard-probe.invalid' } });
    await denied('bad_origin_saved_run', `/api/unified-checkout/${RUN}`, 403, ['ORIGIN_DENIED'], { headers: { origin: 'https://guard-probe.invalid' } });
    for (let index = 0; index < targets.length; index++) {
      const scoped = await switchScope(targets[index].brandId);
      result(`store_${[2, 4, 6][index]}_scope_selected`, scoped.response.status, 200, scoped.verified);
      if (!scoped.verified) throw new Error('LOCAL_SETUP_UNVERIFIED');
      await denied(`store_${[2, 4, 6][index]}_owner_endpoint_denied`, `/api/unified-checkout/${RUN}`, 403, ['ADMIN_REQUIRED']);
      await denied(`store_${[2, 4, 6][index]}_owner_mutation_denied`, `/api/unified-checkout/${RUN}/reconcile`, 403, ['ADMIN_REQUIRED'],
        { method: 'POST', body: probeBody });
      for (let foreign = 0; foreign < targets.length; foreign++) if (foreign !== index)
        await denied(`store_${[2, 4, 6][index]}_cannot_read_store_${[2, 4, 6][foreign]}_bag`, `/api/bags/${targets[foreign].bagId}`,
          [403, 404], ['NOT_FOUND', 'TENANT_MISMATCH']);
    }
    // Intentionally malformed, never a real HMAC. No inbox/order event may be queued.
    for (let index = 0; index < SHOPS.length; index++)
      await denied(`store_${[2, 4, 6][index]}_invalid_shopify_signature`, '/webhooks/shopify', 401, ['INVALID_SIGNATURE'],
        { method: 'POST', authenticated: false, body: { id: 'synthetic_guard_probe_not_an_order' },
          headers: { 'x-shopify-shop-domain': SHOPS[index], 'x-shopify-topic': 'orders/updated', 'x-shopify-hmac-sha256': 'INVALID_SYNTHETIC_SIGNATURE' } });
  } catch {
    result('probe_prerequisites', null, 200, false, 'PREREQUISITE_FAILED');
  } finally {
    if (sessionCreated && csrf) {
      try {
        const restored = await switchScope(null);
        result('independent_session_restored_admin', restored.response.status, 200, restored.verified, restored.verified ? null : 'RESTORE_UNVERIFIED');
      } catch { result('independent_session_restored_admin', null, 200, false, 'RESTORE_UNVERIFIED'); }
    }
    cookie = ''; csrf = ''; targets = null;
  }
  return { source: 'actual_local_HTTP_not_provider_acceptance', testOnly: true, externalRequests: 0,
    providerAcceptancePassed: false, existingRunMutationsRequested: 0,
    summary: { total: cases.length, passed: cases.filter(value => value.pass).length, failed: cases.filter(value => !value.pass).length }, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw new Error('LOCAL_BASE_URL_REQUIRED');
    const report = await runLocalHttpGuards({ baseUrl: guardBaseUrl(process.argv[2]) });
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.summary.failed ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ source: 'actual_local_HTTP_not_provider_acceptance', providerAcceptancePassed: false,
      cases: [{ caseId: 'local_base_url_guard', status: null, expected: 200, pass: false, errorCode: 'LOCAL_REQUEST_FAILED' }] }));
    process.exitCode = 1;
  }
}
