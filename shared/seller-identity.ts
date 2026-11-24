import { httpsSource } from './deal-price-evidence';

export function sellerIdentity(value: unknown) {
  if (!httpsSource(value)) return null;
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./,'');
  const path = url.pathname.replace(/\/$/,'');
  if (host === 'instagram.com' || host === 'threads.net' || host === 'threads.com') {
    const platform = host === 'instagram.com' ? 'instagram' : 'threads';
    const pattern = platform === 'instagram' ? /^\/([a-z0-9._]{1,30})$/i : /^\/@([a-z0-9._]{1,30})$/i;
    const handle = pattern.exec(path)?.[1].toLowerCase();
    if (!handle || url.search || ['p','reel','stories','explore','accounts'].includes(handle)) return null;
    return { platform, identity:handle, handle,
      url: platform === 'instagram' ? `https://www.instagram.com/${handle}/` : `https://www.threads.com/@${handle}` };
  }
  if (!path || url.search || /^\/(?:products?|goods|item|post|stores?)(?:\/|$)/i.test(path)) return null;
  return { platform:'storefront', identity:url.origin + path, handle:path.split('/')[1].toLowerCase(), url:url.origin + path };
}
