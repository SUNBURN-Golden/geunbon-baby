export const threadsOrigins = ['https://www.threads.com', 'https://www.threads.net'] as const;
export function threadsPost(value: unknown, account?: unknown) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const u = new URL(value);
    if (!(threadsOrigins as readonly string[]).includes(u.origin) || u.username || u.password || u.search || u.hash || u.href !== value) return null;
    const match = /^\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]{1,100})\/?$/.exec(u.pathname);
    if (!match || (account !== undefined && (typeof account !== 'string' || account.replace(/^@/, '').toLowerCase() !== match[1].toLowerCase()))) return null;
    return { url: `${u.origin}/@${match[1].toLowerCase()}/post/${match[2]}`, origin: u.origin, account: match[1].toLowerCase(), id: match[2] };
  } catch { return null; }
}
