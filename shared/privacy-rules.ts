// Pure core: no Node, browser, AI, or network dependency. Never retain rejected text.
export const PRIVACY_VERSION = 1;
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
export function canonicalUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('unsafe_url');
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || /(?:^|\.)gonggumoa\.com$/.test(u.hostname)) throw new Error('unsafe_url');
  let path: string; try { path = decodeURIComponent(u.pathname); } catch { throw new Error('unsafe_url'); }
  if (/\/(?:api|my|auth|login|logout|signin|signup|admin|account|member|mypage|oauth|session|messages|direct|mail|profile)(?:\/|$)/i.test(path) || filterText(path,4096) !== path) throw new Error('private_url');
  // Queries are identifiers only. Unknown values can contain secrets/PII: drop, never persist.
  const allowed = /^(?:id|p|page|lang|recallid|format|productname|title)$/i;
  const params = [...u.searchParams].filter(([k,v]) => allowed.test(k) && /^[\p{L}\p{N}_.-]{1,60}$/u.test(v) && filterText(v,200) === v).sort(([a],[b])=>a.localeCompare(b));
  u.search = new URLSearchParams(params).toString(); u.hash=''; u.hostname=u.hostname.toLowerCase();
  if(filterText(decodeURIComponent(u.hostname),4096)!==decodeURIComponent(u.hostname))throw new Error('unsafe_url');
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
    return Object.fromEntries(Object.entries(value).filter(([k])=>allowed.has(k)).map(([k,v])=>[k,sanitizeValue(v,depth+1)]));
  }
  throw new Error('payload_value');
}
