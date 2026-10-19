/** Token-link prefixes never fall through to the operations bootstrap. */
export function resolveAccessRoute(pathname) {
  const match = String(pathname).match(/^\/(handoff|onboard)(?:\/([^/]*))?(?:\/.*)?$/);
  if (!match) return null;
  let token = match[2] || '';
  try { token = decodeURIComponent(token); } catch { /* Invalid tokens stay on the restricted entry page. */ }
  return { kind: match[1] === 'handoff' ? 'handoff' : 'invite', token };
}
