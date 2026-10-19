/** Only pending dispatches can expose a local single-bag capability link. */
export function pendingHandoffLink(message) {
  if (message?.status !== 'pending') return null;
  const path = message.body?.handoffPath;
  return typeof path === 'string' && /^\/handoff\/[A-Za-z0-9_-]+$/.test(path) ? path : null;
}
