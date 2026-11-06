// This function is serialized into an isolated browser world. Keep it self-contained.
export type ExtractionOptions = {expectedUrl:string;urlIdentityVersion:number;mode:'identity'|'region'|'snapshot';selector?:string;selectionOnly?:boolean;reportErrors?:boolean};
export function extractRegion(options:ExtractionOptions):{checkedUrl:string;text:string;title:string;locator:string;html?:string;documentOrigin?:string;error?:string} {
  try {
  // Mirror shared/privacy-rules.ts here: Chrome serializes only this function.
  // Parity tests protect the URL identity contract without external dependencies.
  const injection = /ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s*prompt|execute\s+(this|the)\s+command|이전\s*(지시|명령).*무시|이\s*명령.*실행|지시를\s*무시/i;
  const privateContext = /(?:(?:우리|저희)\s*(?:아이|아기|딸|아들)|(?:아기|아이|자녀|딸|아들)\s*(?:이름|생일|나이|사진|얼굴)|\d+\s*(?:개월|살)\s*(?:아기|아이)|(?:이름|성명)\s*[:：]|\b(?:secret|token|api[_-]?key|credential)\s*[:=]|아이\s*이름|생년월일|주민등록|계좌\s*번호|진료|진단받|병력|대출|카드\s*번호|비밀번호|password|authorization|bearer\s|access[_-]?token|session[_-]?id|cookie\s*[:=])/i;
  function filterText(value: string, max = 300): string {
    return value.normalize('NFKC').split(/[\n\r]+/).filter(line => !injection.test(line) && !privateContext.test(line))
      .join(' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
      .replace(/\b\d{6}\s*[-–]?\s*[1-4]\d{6}\b/g, '[redacted]')
      .replace(/(?:\+?82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/g, '[redacted]')
      .replace(/\b0\d{1,2}[- .]\d{3,4}[- .]\d{4}\b/g, '[redacted]')
      .replace(/(?:[가-힣]+(?:시|도)\s*)?[가-힣]+(?:구|군)\s+[가-힣\d]+(?:로|길|동)\s*[\d가-힣 -]+/g, '[redacted]')
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[redacted]').trim().slice(0,max);
  }
  function canonicalUrl(raw: string): string {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('unsafe_url');
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('unsafe_url'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || /(?:^|\.)gonggumoa\.com$/.test(u.hostname)) throw new Error('unsafe_url');
    let path: string, host: string;
    try { path = decodeURIComponent(u.pathname); host = decodeURIComponent(u.hostname); } catch { throw new Error('unsafe_url'); }
    if (/\/(?:api|my|auth|login|logout|signin|signup|admin|account|member|mypage|oauth|session|messages|direct|mail|profile)(?:\/|$)/i.test(path) || filterText(path,4096) !== path) throw new Error('private_url');
    const entries = [...u.searchParams];
    const pangpang = u.origin === 'https://09pangpang.com' && /^\/post\/\d+\/?$/.test(u.pathname) && entries.length === 1 && entries[0][0] === 'source' && entries[0][1] === 'home';
    const params: [string,string][] = [];
    for (const [k,v] of entries) {
      if (pangpang || /^(?:utm_.+|fbclid|gclid|igshid|ref|from|share)$/i.test(k)) continue;
      if (!/^(?:id|p|page|lang|recallid|format|productname|title)$/i.test(k) || !/^[\p{L}\p{N}_.-]{1,60}$/u.test(v)) throw new Error('unsafe_url');
      if (filterText(v,200) !== v) throw new Error('private_url');
      params.push([k,v]);
    }
    params.sort(([a],[b])=>a.localeCompare(b));
    u.search = new URLSearchParams(params).toString(); u.hash=''; u.hostname=u.hostname.toLowerCase();
    if(filterText(host,4096)!==host)throw new Error('unsafe_url');
    u.pathname=u.pathname.replace(/\/{2,}/g,'/').replace(/\/$/,'') || '/';
    return u.href;
  }
  if (!options || options.urlIdentityVersion !== 2 || !options.expectedUrl) throw new Error('url_identity_changed');
  const checkedUrl = canonicalUrl(options.expectedUrl);
  if (checkedUrl !== canonicalUrl(location.href)) throw new Error('document_changed');
  if (options.mode === 'identity') return {checkedUrl,text:'',title:'',locator:''};
  if (options.mode === 'snapshot') {
    const password=!!document.querySelector('input[type=password]');
    const clone=document.body?.cloneNode(true) as HTMLElement|undefined;
    clone?.querySelectorAll('input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"],nav,header,footer,[data-private],.profile,.comments,.messages,script,style,iframe').forEach(el=>el.remove());
    const text=clone?.textContent?.slice(0,20000)??'';
    return {checkedUrl,text,html:password?'<input type="password">':text,title:'',locator:''};
  }
  if (options.mode !== 'region') throw new Error('url_identity_changed');
  const {selector='',selectionOnly=false}=options;
  if(document.querySelector('input[type=password], [data-private-page]'))throw new Error('private_page');
  const forbidden='input,textarea,select,[contenteditable], [hidden], [aria-hidden="true"], nav,header,footer,[data-private],.profile,.comments,.messages,script,style,iframe';
  if(/\/(direct|messages|mail|account|member|profile|login)(\/|$)/i.test(location.pathname))throw new Error('private_page');
  const selection=window.getSelection();const range=selection?.rangeCount?selection.getRangeAt(0):null;
  const root=selectionOnly?range?.commonAncestorContainer:(selector?document.querySelector(selector):null);
  if(!root)throw new Error('region_required');
  const element=root.nodeType===Node.ELEMENT_NODE?root as Element:root.parentElement;
  if(!element||element.closest(forbidden)||element.querySelector('[type=password]'))throw new Error('private_region');
  if(range&&selectionOnly&&[...document.querySelectorAll(forbidden)].some(el=>range.intersectsNode(el)))throw new Error('private_selection');
  const clone=element.cloneNode(true) as Element;clone.querySelectorAll(`${forbidden},script,style,img,video,canvas,svg,iframe`).forEach(el=>el.remove());
  // Text nodes only, never values, attributes, HTML, cookies, images or page.content().
  const walker=document.createTreeWalker(clone,NodeFilter.SHOW_TEXT);const lines:string[]=[];while(walker.nextNode())lines.push(walker.currentNode.textContent??'');
  const text=selectionOnly?selection!.toString():lines.join('\n');
  // Canonical metadata alone is not an explicit republication relationship.
  const documentOrigin=document.querySelector<HTMLLinkElement>('link[rel=original]')?.href;
  return {checkedUrl,documentOrigin,text:text.slice(0,4000),title:clone.querySelector('h1,h2')?.textContent?.slice(0,200)??'',locator:selectionOnly?'user-selection':selector};
  } catch(e) {
    // Browser RPC wraps thrown messages. Return only known codes when requested,
    // so callers can discard snapshots without parsing transport exception text.
    const code=e instanceof Error?e.message:'';
    if(options?.reportErrors&&['url_identity_changed','unsafe_url','private_url','document_changed','private_page','private_region','private_selection','region_required'].includes(code))return {error:code,checkedUrl:'',text:'',title:'',locator:''};
    throw e;
  }
}
