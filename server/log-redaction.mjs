/** Capability tokens belong in neither routine HTTP logs nor diagnostics. */
export function redactedRequestPath(value) {
  return String(value || '').split('?')[0]
    .replace(/^\/(onboard|handoff)\/[^/]+/,'/$1/[redacted]')
    .replace(/^\/api\/(onboarding\/)?(invites|handoffs)\/[^/]+/,'/api/$1$2/[redacted]');
}
