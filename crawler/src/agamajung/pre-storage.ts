import { validFactCheck, validateCheckedText, sourceHash, FACT_CHECK_VERSION, CHECKED_SCHEMA_VERSION, INTERPRETATION_POLICY } from '../../lib/deal-fact-check';
import { checkExternalRegion, checkedExternalAssertions, externalValues, sanitizedRegion } from '../../lib/external/checked';
// Linux acquisition boundary: original documents never escape this call.
import { URL_IDENTITY_VERSION, canonicalUrl, filterChanged, filterText, PRIVACY_VERSION } from '../../../shared/privacy-rules';
import type { InspectedArtifact, FetchResponse, RenderPort, ToolAdapter } from '../../engine';
import { extractPdf, extractImage, renderDocument } from '../../engine';
import { ParseBudget } from '../../lib/external/parse-budget';
import { decodeEntities, parseHtml, selectAll, textOf, linesOf, pruneProductRegion } from '../../lib/external/parse';
import { extractPangpang, isPangpang, pangpangIdentityAllowed, PANGPANG_VERSION } from '../../lib/external/pangpang';
import { extractDocument } from '../discovery/document';
import { discoverLinks } from '../discovery/adapters';
import { candidateUrl } from '../source-discovery/url-policy';
import type { DiscoveryConfig } from '../source-discovery/config';
import type { DocumentLinks } from '../source-discovery/types';
import { LINUX_PRIVACY_VERSION, privacyFilter } from '../privacy-filter';
import { visitAllowed, type SourcePolicy } from '../source-policy';
import { digest, stable } from '../dedup';
import type { Parsed } from './pipeline';

export const PREPARATION_VERSION=`prepared@3:${URL_IDENTITY_VERSION}:${PRIVACY_VERSION}:${LINUX_PRIVACY_VERSION}:budget@1:${FACT_CHECK_VERSION}:${CHECKED_SCHEMA_VERSION}:${INTERPRETATION_POLICY}`;
export const MAX_DERIVATIVE_BYTES=2097152;
export type Prepared={version:string;mode:'static'|'rendered'|'pdf'|'ocr';parsed:Parsed;links:DocumentLinks;hash:string};
const keys=new Set(('fact_checks schema_version interpretation_policy observation_year_kst observed_at source_hash text_length fields gonggu_price regular_price start_date end_date year month day hour minute second precision evidence start end source version mode parsed links hash inspection text eligible title document_origin assertions pangpang complete truncated region tool_status locator_base locator_space filter_changed field value quote locator conditions msrp_explicit amount currency market option bundle effective_at id name url date terms seller price_kind channel scheme offer effective_until release_year generation shipping_region purchase_condition unit list_complete detail products outcomes links_encountered index reason product_index source_url category_text price dates starts_at ends_at raw confidence seller_handle seller_name seller_url link_index destination canonical_url display_url identity reasons policy_version relation kind depth source_id').split(' '));
const urlKeys=new Set(['url','source_url','document_origin','seller_url']);
function shape(value:unknown,allowed:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('preparation_schema');
}
export function cleanField(raw:string,max=1000){return filterText(decodeEntities(raw),Number.MAX_SAFE_INTEGER).replace(/https?:\/\/[^\s<>"']+/gi,url=>{try{return canonicalUrl(url);}catch{return '';}}).slice(0,max);}
// Full bounded values are inspected before any truncation. Keys are schema data too.
function inspect(value:unknown,key='',depth=0,allowance={bytes:0}):unknown {
  const charge=(v:unknown)=>{allowance.bytes+=typeof v==='string'?Buffer.byteLength(v)+2:8;if(allowance.bytes>MAX_DERIVATIVE_BYTES)throw new Error('preparation_limit');return v;};
  if(depth>16)throw new Error('preparation_schema');
  if(typeof value==='string'){
    if(urlKeys.has(key)){try{return charge(canonicalUrl(value));}catch(e){if((e as Error).message==='preparation_limit')throw e;return null;}}
    if(key==='canonical_url'||key==='display_url')return charge(value); // separately validated candidate identities
    if(key==='text')return charge(value.split(/[\r\n]+/).map(l=>cleanField(l)).filter(Boolean).join('\n').slice(0,20000));
    return charge(cleanField(value,key==='title'?200:key==='quote'?300:key==='locator'?160:1000));
  }
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(key==='fact_checks'){
    if(!Array.isArray(value)||value.length>4||value.some(c=>!validFactCheck(c)))throw new Error('preparation_schema');
    charge(JSON.stringify(value));return structuredClone(value);
  }
  if(Array.isArray(value)){if(value.length>4096)throw new Error('preparation_limit');return value.map(v=>inspect(v,key,depth+1,allowance));}
  if(!value||typeof value!=='object')throw new Error('preparation_schema');
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(value)){if(!keys.has(k))throw new Error('preparation_schema');if(v!==undefined)out[k]=inspect(v,k,depth+1,allowance);}
  return out;
}
export function inspectDocument(doc:DocumentLinks,cfg:DiscoveryConfig,maxLinks=500):DocumentLinks {
  shape(doc,['kind','links','text','truncated']);
  if(!doc||!Array.isArray(doc.links)||doc.links.length>maxLinks||typeof doc.text!=='string'||typeof doc.truncated!=='boolean'||!['html','rss','sitemap','sitemap_index'].includes(doc.kind))throw new Error('preparation_schema');
  const clean=inspect(doc) as DocumentLinks;
  clean.links=clean.links.map(link=>{
    shape(link,['destination','title','quote','locator','relation']);
    if(typeof link.title!=='string'||typeof link.quote!=='string'||typeof link.locator!=='string')throw new Error('preparation_schema');
    if(!['search_result','link','sitemap','feed','pagination','social','order','attachment'].includes(link.relation))throw new Error('preparation_schema');
    const d=link.destination;
    shape(d,['canonical_url','display_url','identity','reasons','policy_version']);
    if(!d||!['preserved','identity_loss','rejected'].includes(d.identity))throw new Error('preparation_schema');
    if(!Array.isArray(d.reasons)||typeof d.policy_version!=='string'||!/^candidate-url@2:identity@2(?::[-a-zA-Z0-9_.@]+)?$/.test(d.policy_version)||(d.identity==='preserved')!==!!d.canonical_url)throw new Error('preparation_schema');
    if(d.identity!=='preserved'&&(d.display_url!==null||d.canonical_url!==null))throw new Error('preparation_schema');
    if(d.identity==='preserved'&&(d.display_url!==d.canonical_url||d.reasons.length))throw new Error('preparation_schema');
    // Never promote identity-loss destinations back to preserved identifiers.
    if(d.canonical_url){const safe=candidateUrl(d.canonical_url,cfg.url_policies);if(safe.identity!=='preserved'||safe.canonical_url!==d.canonical_url)throw new Error('preparation_schema');}
    if(d.display_url&&candidateUrl(d.display_url,cfg.url_policies).display_url!==d.display_url)throw new Error('preparation_schema');
    if(d.reasons.some(r=>!['unsafe_url','fragment_identity','sensitive_parameter','duplicate_identifier','unknown_parameter','invalid_identifier','missing_identifier'].includes(r)))throw new Error('preparation_schema');
    return link;
  });
  if(Buffer.byteLength(stable(clean))>MAX_DERIVATIVE_BYTES)throw new Error('preparation_limit');
  return clean;
}
export function validatePrepared(p:Prepared,cfg:DiscoveryConfig):void {
  shape(p,['version','mode','parsed','links','hash']);
  if(!p||p.version!==PREPARATION_VERSION||!['static','rendered','pdf','ocr'].includes(p.mode)||!p.parsed||typeof p.parsed.text!=='string'||!p.parsed.inspection||p.parsed.inspection.version!=='inspection@2')throw new Error('preparation_schema');
  const parsed=inspect(p.parsed) as Parsed;
  shape(parsed,['text','eligible','title','document_origin','assertions','fact_checks','pangpang','inspection']);
  const scope=parsed.inspection!;
  shape(scope,['version','complete','truncated','region','tool_status','locator_base','locator_space','filter_changed']);
  if(typeof scope.complete!=='boolean'||typeof scope.truncated!=='boolean'||typeof scope.filter_changed!=='boolean'||scope.complete&&(scope.truncated||scope.filter_changed)||!['supported','partial_table'].includes(scope.tool_status)||scope.locator_space!=='sanitized_text')throw new Error('preparation_schema');
  if(parsed.eligible!==undefined&&typeof parsed.eligible!=='boolean')throw new Error('preparation_schema');
  if(parsed.pangpang){
    const page=parsed.pangpang;
    shape(page,['version','detail','products','outcomes','links_encountered']);
    if(page.version!==PANGPANG_VERSION||typeof page.detail!=='boolean'||!Array.isArray(page.products)||!Array.isArray(page.outcomes)||!Number.isSafeInteger(page.links_encountered)||page.links_encountered>4096||page.outcomes.length!==page.links_encountered)throw new Error('preparation_schema');
    const reasons=['accepted_product','duplicate_product','non_product_link','invalid_url','policy_block','missing_title','ambiguous_container','excluded_category','not_baby_item','profile_category_mismatch','deferred_limit'];
    for(const outcome of page.outcomes){shape(outcome,['index','reason','product_index']);if(!reasons.includes(outcome.reason)||!Number.isSafeInteger(outcome.index))throw new Error('preparation_schema');}
    for(const product of page.products){
      shape(product,['source_url','title','text','category_text','price','dates','seller_handle','seller_url','seller_name','locator','link_index','fact_checks']);
      if(typeof product.source_url!=='string'||typeof product.title!=='string'||typeof product.text!=='string'||typeof product.locator!=='string'||product.price!==null)throw new Error('preparation_schema');
      if(product.dates)shape(product.dates,['starts_at','ends_at','raw','confidence']);
      if (!product.fact_checks || product.fact_checks.length !== 1 || !validFactCheck(product.fact_checks[0]) || product.fact_checks[0].source_hash !== sourceHash(product.text) || stable(externalValues(product.fact_checks).dates) !== stable(product.dates)) throw new Error('preparation_schema');
      try { validateCheckedText(product.fact_checks[0],product.text); } catch { throw new Error('preparation_schema'); }
    }
  }
  if(parsed.fact_checks && (parsed.fact_checks.length > 4 || parsed.fact_checks.some(c => !validFactCheck(c) || c.source_hash !== sourceHash(parsed.text)))) throw new Error('preparation_schema');
  if(parsed.fact_checks)for(const c of parsed.fact_checks){try{validateCheckedText(c,parsed.text);}catch{throw new Error('preparation_schema');}}
  if(parsed.fact_checks && stable(parsed.assertions) !== stable(privacyFilter({assertions:checkedExternalAssertions(parsed.fact_checks,'checked-region')}).assertions)) throw new Error('preparation_schema');
  if(parsed.assertions&&stable(privacyFilter({assertions:parsed.assertions}).assertions)!==stable(parsed.assertions))throw new Error('preparation_schema');
  if(stable(parsed)!==stable(p.parsed)||stable(inspectDocument(p.links,cfg,p.parsed.pangpang?4096:500))!==stable(p.links)||digest([p.version,p.mode,p.parsed,p.links])!==p.hash)throw new Error('preparation_schema');
  if(Buffer.byteLength(stable(p))>MAX_DERIVATIVE_BYTES)throw new Error('preparation_limit');
}
export function validateArtifact(a:InspectedArtifact){
  if(typeof a.text!=='string'||!a.text||a.text.length>20000||Buffer.byteLength(a.text)>80000||a.text!==a.text.split('\n').map(l=>cleanField(l)).filter(Boolean).join('\n')||!a.permissionBasis||cleanField(a.permissionBasis)!==a.permissionBasis)throw new Error('artifact_invalid');
}
export { safeEtag, safeModified } from './http-validators';
export function requireMemoryRenderer(required:boolean,renderer?:RenderPort){
  if(required&&(renderer?.capability?.nonpersistent!==true||!/^[-a-zA-Z0-9_.@]{1,80}$/.test(renderer.capability.version)))throw Object.assign(new Error('unsupported'),{tool:'renderer'});
}
export async function prepare(input:{bytes:Buffer;document:FetchResponse;url:string;type:string;source:SourcePolicy;render:boolean;renderer?:RenderPort;tools:ToolAdapter;config:DiscoveryConfig;now:Date;maxBytes:number;eligible:(text:string)=>boolean}):Promise<Prepared>{
  const {source:s,config:cfg}=input,budget=new ParseBudget(input.maxBytes);
  if(input.bytes.length>input.maxBytes)throw new Error('preparation_limit');
  requireMemoryRenderer(input.render,input.renderer);
  const expectedUrl=canonicalUrl(input.url),finalUrl=canonicalUrl(input.document.finalUrl??input.url);
  if(!visitAllowed(finalUrl,s)||isPangpang(s)&&!pangpangIdentityAllowed(input.url,input.document.finalUrl??input.url))throw new Error('redirect_identity');
  if(finalUrl!==expectedUrl)throw new Error('document_changed');
  if(!/^(?:text\/(?:html|plain|xml)|application\/(?:pdf|xml|rss\+xml|atom\+xml)|image\/[a-z0-9.+-]+)$/.test(input.type)&&!(s.adapter==='cpsc'&&input.type==='application/json'))throw Object.assign(new Error('unsupported'),{tool:'unknown'});
  let body=input.bytes.toString(),mode:Prepared['mode']='static',parsed:Parsed;
  let originalText='',toolStatus='supported';
  if(input.render){
    const snap=await renderDocument(input.renderer!,finalUrl,input.document,true,input.maxBytes);
    if(canonicalUrl(snap.finalUrl)!==finalUrl)throw new Error('redirect_identity');
    // Only rendered markup is parsed; tool text/metadata are independently inspected.
    body=snap.html;mode='rendered';
    for(const field of [snap.text,snap.regionText,snap.title,snap.documentOrigin])if(field&&Buffer.byteLength(field)>input.maxBytes)throw new Error('preparation_limit');
  }
  let links:DocumentLinks={kind:'html',links:[],text:'',truncated:false};
  if(/pdf|^image\//.test(input.type)){
    mode=input.type==='application/pdf'?'pdf':'ocr';
    const r=mode==='pdf'?await extractPdf(input.tools,input.bytes,input.maxBytes):await extractImage(input.tools,input.bytes,input.maxBytes);
    if(r.status==='unsupported')throw Object.assign(new Error('unsupported'),{tool:r.tool});
    originalText=r.text;parsed={text:r.text};
  }else if(s.adapter==='cpsc'){
    const found=discoverLinks(body,input.url,'cpsc',budget).filter(f=>input.eligible(`${f.title??''} ${f.recall?.name??''}`));
    originalText=found.map(f=>`Recall: ${f.title??f.recall?.name??''}`).join('\n');
    // Keep the raw extraction in memory so inspection can report whether it changed it.
    parsed={text:originalText,assertions:found.filter(f=>f.recall).slice(0,30).map(f=>({field:'recalls',value:f.recall,quote:f.title??f.recall!.name,locator:`$.Recall[RecallID=${f.recall!.id}]`}))};
  }else if(isPangpang(s)){
    const page=extractPangpang(body,finalUrl,input.now,url=>visitAllowed(url,s),budget),product=page.detail?page.products[0]:undefined;
    if(page.detail&&!product)throw new Error('region_missing');
    originalText=product?.text??'';
    parsed={text:originalText,eligible:!!product&&input.eligible(`${product.title} ${product.category_text}`),...(product?{title:product.title}:{}),pangpang:page,assertions:product?.fact_checks?checkedExternalAssertions(product.fact_checks,'checked-region'):[],...(product?.fact_checks?{fact_checks:product.fact_checks}:{})};
    links={kind:'html',text:'',truncated:false,links:page.products.map(p=>({destination:candidateUrl(p.source_url,cfg.url_policies),title:p.title,quote:p.text,locator:p.locator,relation:'link'}))};
  }else{
    const root=parseHtml(body,budget),region=s.selector?selectAll(root,s.selector)[0]:root;
    if(!region)throw new Error('region_missing');
    if (s.kind === 'event') pruneProductRegion(region);
    const rows=selectAll(region,'tr');
    originalText=rows.length?[...selectAll(region,'h1,h2').map(textOf),...rows.map(row=>selectAll(row,'th,td').map(cell=>textOf(cell).trim()).join(' | '))].join('\n'):linesOf(region).join('\n');
    toolStatus=rows.length?'partial_table':'supported';
    parsed={text:originalText,title:(selectAll(root,'h1,h2,title').map(textOf)[0]??'').replace(/\s+/g,' ').trim()};
    const origin=selectAll(root,'link[rel=original]')[0]?.attrs.href;
    if(origin){try{parsed.document_origin=canonicalUrl(new URL(origin,input.url).href);}catch{/* discard rejected original */}}
    links=extractDocument(body,finalUrl,s.adapter,cfg.url_policies,cfg.pagination_selectors?.[s.id],budget);
  }
  // Inspection compares against the original in-memory extraction, never against
  // an already-cleaned value, so filter_changed reflects real filtering work.
  const rawParsed=parsed,rawLinks=links;
  const filtered:Parsed={...rawParsed,...(rawParsed.assertions?{assertions:privacyFilter({assertions:rawParsed.assertions}).assertions}:{})};
  const cleaned=inspect(filtered) as Parsed,cleanLinks=inspectDocument(links,cfg,parsed.pangpang?4096:500);
  const changed=stable(cleaned)!==stable(rawParsed)||stable(cleanLinks)!==stable(rawLinks)||(isPangpang(s)&&filterChanged(decodeEntities(body)));
  if (s.kind === 'event' && !isPangpang(s)) {
    // Evidence offsets refer to the sanitized region, so store exactly that text:
    // validatePrepared re-hashes parsed.text and re-slices every quote against it.
    // Table cells join with ' | ', so empty cells would otherwise leave runs of
    // whitespace that the check never saw.
    cleaned.text = sanitizedRegion(cleaned.text);
    // A configured document/table with several identities is not a product scope.
    const root = parseHtml(body, budget); pruneProductRegion(root);
    const regions = selectAll(root, '[itemtype],article,main').filter(e => e.tag === 'article' || e.tag === 'main' || /(?:^|\/)Product$/.test(e.attrs.itemtype ?? ''));
    const headings = selectAll(s.selector ? selectAll(root,s.selector)[0] ?? root : root, 'h1,h2,h3');
    const scoped = regions.length === 1 && headings.length === 1;
    const check = checkExternalRegion(cleaned.text, finalUrl, input.now, scoped ? undefined : { gonggu_price:null, period:null });
    cleaned.fact_checks = [check];
    cleaned.assertions = privacyFilter({assertions:checkedExternalAssertions([check],'checked-region')}).assertions;
  }
  // Pangpang's extractor filters fields before returning, so compare its raw
  // response too; other extractors return raw values and compare directly.
  const truncated=rawLinks.truncated||originalText.length>20000||originalText.split(/[\r\n]+/).some(l=>l.length>1000);
  cleaned.inspection={version:'inspection@2',complete:!changed&&!truncated&&toolStatus==='supported',filter_changed:changed,truncated,region:s.selector||'document',locator_base:s.selector||'document',locator_space:'sanitized_text',tool_status:toolStatus};
  const p:Prepared={version:PREPARATION_VERSION,mode,parsed:cleaned,links:cleanLinks,hash:digest([PREPARATION_VERSION,mode,cleaned,cleanLinks])};
  validatePrepared(p,cfg);return p;
}
