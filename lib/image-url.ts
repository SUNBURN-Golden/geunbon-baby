// Protocol-only validation: safe to import from the Linux crawler and Workers.
// Return a predicate rather than a normalized URL: CDN signatures are opaque.
export function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) || /[\s\\#\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (value.slice(value.indexOf('//') + 2).split(/[/?]/, 1)[0].includes('@')) return false;
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port &&
      ['cdninstagram.com', 'fbcdn.net'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
