// Pure provenance policy for local seed validation; no seed or network dependency.
export type OfficialSource = { hosts: Record<string, { product_path?: string }>; blocked_paths: string[] };
export function isOfficialSource(raw: string, source: OfficialSource, product = false): boolean {
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || u.hash) return false;
    const rule = source.hosts[u.hostname];
    const path = decodeURIComponent(u.pathname);
    if (!rule || source.blocked_paths.some(p => path.toLowerCase().includes(p.toLowerCase()))) return false;
    return !product || (path !== '/' && (!rule.product_path || new RegExp(rule.product_path).test(path)));
  } catch { return false; }
}
