import { extractPangpang, pangpangIdentityAllowed, pangpangPost, pangpangQueryAllowed } from '../../lib/external/pangpang';
import { canonicalUrl } from '../../../shared/privacy-rules';
const PREMIUM = /유모차|카시트|하이체어|트립트랩|스토케|부가부|bugaboo|stokke|cybex|nuna|joie|브리타克斯|britax|막시코시|maxi-cosi|에르고|ergobaby|babybjorn|베이비뵨|아기띠|silver\s*cross|실버크로스|play\s*gym|모빌|하베브릭스|lovevery|스트라이더|stroller|tripp\s*trapp|육아용품|육아템|기저귀|유모차\/카시트/i;
export type PangpangPlan =
  | { kind: 'detail'; productCount: number }
  | { kind: 'listing'; enqueue: string[]; productCount: number; premiumCandidates: number };
export function isPangpangHost(hostname: string) {
  return hostname === '09pangpang.com' || hostname.endsWith('.09pangpang.com');
}
export function planPangpangPage(html: string, pageUrl: string, now: Date, maxDetail: number): PangpangPlan {
  const listingContext = !pangpangPost(pageUrl);
  const allowed = (url: string) => {
    try {
      const resolved = new URL(url, pageUrl);
      if (resolved.origin !== 'https://09pangpang.com') return false;
      if (!pangpangQueryAllowed(resolved)) return false;
      const abs = resolved.href;
      if (pangpangPost(abs)) return listingContext || pangpangIdentityAllowed(pageUrl, abs);
      const target = canonicalUrl(abs);
      return pangpangIdentityAllowed(pageUrl, target) || canonicalUrl(pageUrl) === target;
    } catch { return false; }
  };
  const page = extractPangpang(html, pageUrl, now, allowed);
  if (page.detail) return { kind: 'detail', productCount: page.products.length };
  const premium = page.products.filter(p => PREMIUM.test(`${p.title}\n${p.category_text}\n${p.text}`));
  const enqueue = [...new Set(premium.map(p => {
    try { return canonicalUrl(new URL(p.source_url, pageUrl).href); } catch { return p.source_url; }
  }))].slice(0, maxDetail);
  return { kind: 'listing', enqueue, productCount: page.products.length, premiumCandidates: premium.length };
}
