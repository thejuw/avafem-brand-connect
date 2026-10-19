import http from 'node:http';

/** A tunnel must target this listener, NOT the owner dashboard. Nothing is
 * exposed by constructing it. Only two POST paths and signature headers can
 * reach the fixed loopback backend; cookies/auth/forwarded headers never do. */
export function createWebhookIngress({ backendPort = 4317, request: forward = http.request } = {}) {
  if (!Number.isSafeInteger(backendPort) || backendPort < 1024 || backendPort > 65535) throw new Error('Invalid loopback backend port.');
  const allowed = new Set(['/webhooks/shopify', '/webhooks/stripe']);
  const headers = ['content-type', 'x-shopify-hmac-sha256', 'x-shopify-shop-domain', 'x-shopify-topic',
    'x-shopify-webhook-id', 'x-shopify-triggered-at', 'stripe-signature'];
  return http.createServer((incoming, response) => {
    const reject = (status, code) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ error: { code } })); incoming.resume();
    };
    if (incoming.method !== 'POST' || !allowed.has(incoming.url)) return reject(404, 'NOT_FOUND');
    if (!/^application\/json(?:;|$)/i.test(String(incoming.headers['content-type'] ?? ''))
      || incoming.headers['content-encoding']) return reject(415, 'JSON_REQUIRED');
    const chunks = []; let bytes = 0; let rejected = false;
    incoming.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { if (!rejected) reject(413, 'BODY_TOO_LARGE'); rejected = true; return; }
      if (!rejected) chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (rejected) return;
      const body = Buffer.concat(chunks);
      const forwarded = { host: `127.0.0.1:${backendPort}`, 'content-length': String(body.length) };
      for (const name of headers) if (typeof incoming.headers[name] === 'string') forwarded[name] = incoming.headers[name];
      const outgoing = forward({ hostname: '127.0.0.1', port: backendPort, method: 'POST', path: incoming.url, headers: forwarded,
        timeout: 20_000, agent: false }, upstream => {
        response.writeHead(upstream.statusCode || 502, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const interrupted = () => { upstream.unpipe(response); if (!response.writableEnded) response.destroy(); };
        upstream.on('error', interrupted); upstream.on('aborted', interrupted);
        upstream.pipe(response);
      });
      outgoing.on('timeout', () => outgoing.destroy());
      outgoing.on('error', () => { if (!response.headersSent) reject(502, 'INGRESS_BACKEND_UNAVAILABLE'); else response.end(); });
      outgoing.end(body);
    });
    incoming.on('error', () => { if (!response.headersSent) reject(400, 'INVALID_BODY'); });
  });
}
