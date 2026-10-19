import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { IntegrationError, invalid } from './errors.mjs';
import { projectOutboundEvent } from './projection.mjs';

const bodyBuffer = raw => Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

export function constantTimeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Sign exact wire bytes as HMAC-SHA256(timestamp + '.' + rawBody), not reserialized JSON. */
export function signOutboundWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  if (!secret) throw invalid('A webhook signing secret is required.');
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(bodyBuffer(rawBody)).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Verify timestamp and exact body. Event ID deduplication must still be persisted by the receiver. */
export function verifyOutboundWebhook(rawBody, signature, secret, { now = Math.floor(Date.now() / 1000), toleranceSeconds = 300 } = {}) {
  if (!secret || typeof signature !== 'string') return false;
  const timestamps = [...signature.matchAll(/(?:^|,)t=(\d+)(?=,|$)/g)];
  const digests = [...signature.matchAll(/(?:^|,)v1=([a-fA-F0-9]{64})(?=,|$)/g)];
  if (timestamps.length !== 1 || !digests.length) return false;
  const timestamp = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = signOutboundWebhook(rawBody, secret, timestamp).split('v1=')[1];
  return digests.some(([, digest]) => constantTimeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex')));
}

/** Conservative public-address predicate, including IPv4-mapped IPv6 and special-use ranges. */
export function isPublicIp(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Only global unicast 2000::/3; mapped/compatible/ULA/link-local/loopback all fail.
    if (!/^[23][0-9a-f]{3}:/.test(normalized)) return false;
    const [first, second] = normalized.split(':').map(word => Number.parseInt(word || '0', 16));
    if ((first === 0x2001 && (second < 0x200 || second === 0xdb8)) || first === 0x2002 || first === 0x3fff) return false;
    return true;
  }
  return false;
}

/**
 * Resolve every destination before every delivery. All returned IPs must be public.
 * The delivery function pins one checked address in HTTPS lookup to prevent DNS rebinding.
 */
export async function validatePublicHttpsUrl(value, { resolve = lookup } = {}) {
  let url;
  try { url = new URL(value); } catch { throw invalid('Webhook URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid('Webhook URL must use HTTPS without credentials or fragments.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || /(^|\.)(localhost|local|internal|home|test|invalid)$/.test(hostname) || hostname === 'metadata.google.internal') throw invalid('Webhook URL must target a public hostname.');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) throw invalid('Webhook URL resolves to a private or reserved network.');
  return { url, hostname, addresses };
}

export function classifyDeliveryResponse(status) {
  return { ok: status >= 200 && status < 300, retryable: status === 408 || status === 425 || status === 429 || status >= 500, status };
}

/** Jittered backoff, bounded by the 72-hour delivery window. The worker persists attempts. */
export function webhookRetryDelay(attempt, random = Math.random) {
  return Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, Math.min(attempt, 10))) * (0.8 + random() * 0.4);
}

/**
 * Explicitly deliver one allowlisted event. Never follows redirects. No automatic retries.
 * @param {{url:string, secret:string, event:object, timeoutMs?:number, resolve?:Function, request?:Function}} options
 * @returns {Promise<{ok:boolean,retryable:boolean,status:number}>}
 */
export async function deliverOutboundWebhook({ url, secret, event, timeoutMs = 10_000, resolve, request = https.request }) {
  const checked = await validatePublicHttpsUrl(url, { resolve });
  const body = Buffer.from(JSON.stringify(projectOutboundEvent(event)));
  const headers = { 'content-type': 'application/json', 'content-length': String(body.length), 'user-agent': 'Avafem-Brand-Connect/1', 'avafem-signature': signOutboundWebhook(body, secret), 'avafem-event-id': String(event.id ?? event.event_id ?? '') };
  const pinned = checked.addresses[0];
  return new Promise((resolveDelivery, reject) => {
    const req = request(checked.url, {
      method: 'POST', headers, timeout: timeoutMs, agent: false,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, res => {
      res.resume();
      resolveDelivery(classifyDeliveryResponse(res.statusCode));
    });
    req.once('timeout', () => req.destroy(new Error('Delivery timeout')));
    req.once('error', cause => reject(new IntegrationError('Outbound webhook delivery failed.', { code: 'WEBHOOK_DELIVERY_FAILED', retryable: true, cause })));
    req.end(body);
  });
}
