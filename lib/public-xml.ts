export const siteOrigin = 'https://agamajoong.soulbound.co.kr';
export const xml = (value: string) => Array.from(value).filter(char => {
  const cp = char.codePointAt(0)!;
  return cp === 9 || cp === 10 || cp === 13 || cp >= 32 && cp !== 0xFFFE && cp !== 0xFFFF;
}).join('').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
export const dealUrl = (id: string) => `${siteOrigin}/deals/${encodeURIComponent(id)}`;
export function xmlResponse(body: string, type: string) {
  return new Response(`<?xml version="1.0" encoding="utf-8"?>\n${body}`, {
    headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
