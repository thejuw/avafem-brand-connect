import { createWebhookIngress } from '../server/webhook-ingress.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--start') {
  console.error('Usage: node scripts/start-webhook-ingress.mjs --start');
  console.error('Starts a loopback-only webhook proxy on 4318. No tunnel/public exposure is created.');
  process.exitCode = 2;
} else {
  const server = createWebhookIngress();
  server.listen(4318, '127.0.0.1', () => console.log('Webhook-only ingress listening on http://127.0.0.1:4318 (no public tunnel).'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
}
