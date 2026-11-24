// Pure core: no Node, browser, AI, or network dependency. Never retain rejected text.
export const PRIVACY_VERSION = 1;
export const URL_IDENTITY_VERSION = 2;
export const SUPPORTED_QUERY_KEY = /^(?:id|p|page|lang|recallid|format|productname|title)$/i;
export const isUrlRejection = (e: unknown): boolean => e instanceof Error && ['unsafe_url','private_url'].includes(e.message);
const injection = /ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s*prompt|execute\s+(this|the)\s+command|이전\s*(지시|명령).*무시|이\s*명령.*실행|지시를\s*무시/i;
const privateContext = /(?:(?:우리|저희)\s*(?:아이|아기|딸|아들)|(?:아기|아이|자녀|딸|아들)\s*(?:이름|생일|나이|사진|얼굴)|\d+\s*(?:개월|살)\s*(?:아기|아이)|(?:이름|성명)\s*[:：]|\b(?:secret|token|api[_-]?key|credential)\s*[:=]|아이\s*이름|생년월일|주민등록|계좌\s*번호|진료|진단받|병력|대출|카드\s*번호|비밀번호|password|authorization|bearer\s|access[_-]?token|session[_-]?id|cookie\s*[:=])/i;
export function filterText(value: string, max = 300): string {
  return value.normalize('NFKC').split(/[\n\r]+/).filter(line => !injection.test(line) && !privateContext.test(line))
    .join(' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b\d{6}\s*[-–]?\s*[1-4]\d{6}\b/g, '[redacted]')
    .replace(/(?:\+?82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/g, '[redacted]')
    .replace(/\b0\d{1,2}[- .]\d{3,4}[- .]\d{4}\b/g, '[redacted]')
    .replace(/(?:[가-힣]+(?:시|도)\s*)?[가-힣]+(?:구|군)\s+[가-힣\d]+(?:로|길|동)\s*[\d가-힣 -]+/g, '[redacted]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted]').trim().slice(0,max);
}
// True when privacy filtering would redact, drop, or otherwise alter a value.
// Callers compare this against the original extraction, never a cleaned value.
export function filterChanged(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return filterText(value, Number.MAX_SAFE_INTEGER) !== normalized;
}
export function canonicalUrl(raw: string, offer = false): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('unsafe_url');
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('unsafe_url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || !offer && /(?:^|\.)gonggumoa\.com$/.test(u.hostname)) throw new Error('unsafe_url');
  let path: string, host: string;
  try { path = decodeURIComponent(u.pathname); host = decodeURIComponent(u.hostname); } catch { throw new Error('unsafe_url'); }
  const publicStore = offer && u.origin === 'https://09pangpang.com' && /^\/account\/\d+\/?$/.test(path);
  if (!publicStore && /\/(?:api|my|auth|login|logout|signin|signup|admin|account|member|mypage|oauth|session|messages|direct|mail|profile)(?:\/|$)/i.test(path) || filterText(path,4096) !== path) throw new Error('private_url');
  const entries = [...u.searchParams];
  const pangpangPost = u.origin === 'https://09pangpang.com' && /^\/post\/\d+\/?$/.test(u.pathname);
  const pangpangTrack = pangpangPost && (() => {
    if (entries.length === 0) return true;
    const keys = new Set(entries.map(([k]) => k));
    if (entries.length !== keys.size) return false;
    const source = u.searchParams.get('source');
    if (keys.size === 1 && keys.has('source')) return source === 'home' || source === 'search';
    if (keys.size === 2 && keys.has('source') && keys.has('pid')) {
      return source === 'search' && /^\d+$/.test(u.searchParams.get('pid') ?? '');
    }
    return false;
  })();
  if (pangpangTrack) {
    u.search = '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    if (filterText(host, 4096) !== host) throw new Error('unsafe_url');
    return u.href;
  }
  const pangpang = pangpangPost && entries.length === 1 && entries[0][0] === 'source' && entries[0][1] === 'home';
  const params: [string,string][] = [];
  for (const [k,v] of entries) {
    if (pangpang || /^(?:utm_.+|fbclid|gclid|igshid|ref|from|share)$/i.test(k)) continue;
    const productKey = offer && /^(?:product_?id|product_no|goods_?no|item_?id|pack_content_id|iniCategory|thisCategory|variant|sku|option_id|categoryId|nt_detail)$/i.test(k);
    const publicSearch = offer && /(?:^|\.)threads\.(?:net|com)$/.test(u.hostname) && u.pathname === '/search' && k === 'q';
    if (!(SUPPORTED_QUERY_KEY.test(k) || productKey || publicSearch) ||
        !(publicSearch ? /^[\p{L}\p{N}_ .#-]{1,60}$/u : /^[\p{L}\p{N}_.-]{1,60}$/u).test(v)) throw new Error('unsafe_url');
    if (filterText(v,200) !== v) throw new Error('private_url');
    params.push([k,v]);
  }
  params.sort(([a],[b])=>a.localeCompare(b));
  u.search = new URLSearchParams(params).toString(); u.hash=''; u.hostname=u.hostname.toLowerCase();
  if(filterText(host,4096)!==host)throw new Error('unsafe_url');
  u.pathname=u.pathname.replace(/\/{2,}/g,'/').replace(/\/$/,'') || '/';
  return u.href;
}
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) throw new Error('payload_depth');
  if (typeof value === 'string') return /^https?:/i.test(value) ? canonicalUrl(value) : filterText(value);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value) && value.length <= 30) return value.map(v=>sanitizeValue(v,depth+1));
  if (value && typeof value === 'object') {
    const allowed = new Set(['amount','currency','market','option','bundle','effective_at','id','name','url','date','terms','value']);
    return Object.fromEntries(Object.entries(value).filter(([k])=>allowed.has(k)).map(([k,v])=>[k,k==='url'?canonicalUrl(v as string):sanitizeValue(v,depth+1)]));
  }
  throw new Error('payload_value');
}
