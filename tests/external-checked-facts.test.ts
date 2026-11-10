import { expect, test } from 'vitest';
import { parseItems, parseDetail, enrichDetail, EXTERNAL_PARSER_VERSION } from '../crawler/lib/external/parse';
import { buildPayload } from '../crawler/lib/external/filter';
import { extractPangpang, PANGPANG_VERSION } from '../crawler/lib/external/pangpang';
import { validFactCheck, sourceHash, validateCheckedText } from '../crawler/lib/deal-fact-check';
import { PREPARATION_VERSION, prepare, validatePrepared } from '../crawler/src/agamajung/pre-storage';
import { source as collectorSource } from './helpers/collector';
import type { ToolAdapter } from '../crawler/engine/tools';
import { collectionParseVersion } from '../crawler/src/agamajung/pipeline';
import { digest } from '../crawler/src/dedup';
import { loadDiscoveryConfig } from '../crawler/src/source-discovery/config';
import { engineFixture } from './helpers/engine';
const now=new Date('2026-11-10T12:00:00+09:00'),source='https://shop.example';
test('generic listings are checked before payloads, preserving yearless precision and independent endpoints',()=>{
  const [item]=parseItems('<article><a href="/deal/1">스토케 트립트랩 공구</a><p>공구가 39만원</p><p>마감 2026-11-15</p><p>token: secret-fixture-value</p></article>',source,source,'article',now);
  const payload=buildPayload('fixture',item,now)!;
  expect(item.fact_checks?.every(validFactCheck)).toBe(true);expect(payload).toMatchObject({price_hint:390000,starts_at:null,ends_at:'2026-11-15T14:59:59.999Z',suggestions:{price:{value:390000},dates:{starts_at:null,ends_at:'2026-11-15T14:59:59.999Z'}}});
  expect(JSON.stringify(payload)).not.toContain('secret-fixture-value');
});
test('failed external prices and dates stay null in generated suggestions; synthesized fields supply no evidence',()=>{
  const item={source_url:source+'/deal/1',title:'스토케 트립트랩 공구',text:'스토케 트립트랩 공구\n가격 문의',category_text:'',price:{value:390000,raw:'390,000원'},dates:{starts_at:'2026-11-10T00:00:00+09:00',ends_at:'2026-11-15T23:59:59+09:00',raw:'11/10~11/15',confidence:1},seller_handle:null,seller_url:null};
  const payload=buildPayload('fixture',item,now)!;
  expect(payload).toMatchObject({price_hint:null,starts_at:null,ends_at:null,suggestions:{price:null,dates:null}});
  expect(payload.text).not.toContain('390');
});
test('detail enrichment requires one product scope and preserves each source identity',()=>{
  const [item]=parseItems('<article><a href="/deal/1">스토케 트립트랩 공구</a><p>시작 2026-11-10</p></article>',source,source,'article',now);
  const detailUrl=source+'/detail/1';
  const detail=parseDetail('<article><h1>스토케 트립트랩 공구</h1><p>공구가 390,000원</p><p>마감 2026-11-15</p></article><aside>다른 상품 120,000원</aside>',now,detailUrl,item.title);
  const enriched=enrichDetail(item,detail),p=buildPayload('fixture',enriched,now)!;
  expect(p).toMatchObject({price_hint:390000,starts_at:'2026-11-09T15:00:00.000Z',ends_at:'2026-11-15T14:59:59.999Z'});
  expect(enriched.fact_checks?.map(c=>c.source)).toEqual([source+'/',detailUrl]);
  expect(parseDetail('<article><h1>다른 상품</h1><p>390,000원</p></article>',now,detailUrl,item.title).price).toBeNull();
  expect(parseDetail('<h1>스토케 트립트랩 공구</h1><p>390,000원</p>',now,detailUrl,item.title).price).toBeNull();
  expect(parseDetail('<article><h1>A</h1><p>390,000원</p></article><article><h1>B</h1><p>400,000원</p></article>',now,detailUrl,item.title).price).toBeNull();
});
test('Pangpang uses sanitized product evidence, retains yearless dates and publishes no inferred timestamps',()=>{
  const page=extractPangpang('<article><h1>스토케 트립트랩 공구</h1><span><time>11/30</time>–<time>12/04</time></span><p class="truncate">sample_seller</p></article>','https://09pangpang.com/post/123',now,()=>true);
  const product=page.products[0],check=product.fact_checks![0];
  expect(check.source_hash).toBe(sourceHash(product.text));expect(validFactCheck(check)).toBe(true);
  expect(check.fields.start_date.value).toMatchObject({year:null,month:11,day:30});expect(check.fields.end_date.value).toMatchObject({year:null,month:12,day:4});
  expect(buildPayload('pangpang',product,now)).toMatchObject({price_hint:null,starts_at:null,ends_at:null});
});
test('Pangpang stores exactly the sanitized text its fact check hashes, including whitespace runs',async()=>{
  const url='https://09pangpang.com/post/123';
  // &nbsp; runs and an inline "  ~  " range would otherwise leave the stored
  // product.text different from the text the checker sanitized and hashed.
  const body='<article><h2>Example stroller fixture only</h2><span class="text-category">키즈&nbsp;&nbsp;&gt;&nbsp;&nbsp;유모차</span><span><time>11/30</time>  ~  <time>12/04</time></span><p class="truncate">sample_seller</p></article>';
  const page=extractPangpang(body,url,now,()=>true),product=page.products[0],check=product.fact_checks![0];
  expect(product.text).toBe('Example stroller fixture only\n키즈 > 유모차\n11/30 ~ 12/04\nsample_seller');
  expect(check.source_hash).toBe(sourceHash(product.text));
  expect(()=>validateCheckedText(check,product.text)).not.toThrow();
  const policy={...collectorSource,id:'pangpang' as const,origin:'https://09pangpang.com',kind:'event' as const,paths:['/post/'],query_keys:[],entries:[url]};
  const p=await prepare({bytes:Buffer.from(body),document:{status:200,headers:{'content-type':'text/html'},body,finalUrl:url},url,type:'text/html',source:policy,render:false,tools:{} as ToolAdapter,config:loadDiscoveryConfig(),now,maxBytes:2097152,eligible:()=>true});
  expect(p.parsed.text).toBe(product.text);
  expect(p.parsed.pangpang?.products[0].fact_checks?.[0].source_hash).toBe(sourceHash(p.parsed.pangpang!.products[0].text));
  expect(()=>validatePrepared(p,loadDiscoveryConfig())).not.toThrow();
});
test('generic listings keep the exact text their fact check hashes beyond the old 1000-char store limit',()=>{
  const filler='상세 설명 '.repeat(250);
  const html=`<article><a href="/deal/1">스토케 트립트랩 공구</a><p>공구가 390,000원</p><p>마감 2026-11-15</p><p>${filler}</p></article>`;
  const [item]=parseItems(html,source,source,'article',now);
  expect(item.text.length).toBeGreaterThan(1000);
  expect(item.fact_checks?.[0].source_hash).toBe(sourceHash(item.text));
  expect(()=>validateCheckedText(item.fact_checks![0],item.text)).not.toThrow();
  expect(item.fact_checks?.[0].fields.gonggu_price.value).toBe(390000);
});
test('event table checks hash the exact sanitized text that validatePrepared re-validates',async()=>{
  const policy={...collectorSource,kind:'event' as const,selector:'main',paths:['/deal/'],query_keys:[],entries:['https://gear.example.org/deal/1']};
  const url='https://gear.example.org/deal/1',body='<main><h1>공구</h1><table><tr><td>390,000원</td><td></td><td>11.30–12.04</td></tr></table></main>';
  const p=await prepare({bytes:Buffer.from(body),document:{status:200,headers:{'content-type':'text/html'},body,finalUrl:url},url,type:'text/html',source:policy,render:false,tools:{} as ToolAdapter,config:loadDiscoveryConfig(),now,maxBytes:2097152,eligible:()=>true});
  // The empty interior table cell would otherwise leave a double space the check never saw.
  expect(p.parsed.text).toBe('공구\n390,000원 | | 11.30–12.04');
  expect(p.parsed.fact_checks?.[0].source_hash).toBe(sourceHash(p.parsed.text));
  expect(p.parsed.fact_checks?.[0].fields.gonggu_price.value).toBe(390000);
  expect(()=>validatePrepared(p,loadDiscoveryConfig())).not.toThrow();
});
test('versioned local preparation stores bounded facts, rejects inferred-date assertions and invalidates old derivatives',async()=>{
  const body='<main><h1>Example stroller 공구</h1><p>공구가 390,000원</p><p>마감 11.15</p></main>';
  const f=engineFixture(body,{kind:'event'});try{
    const version=collectionParseVersion(f.store,f.profile),run=f.pipeline.start({kind:'test',at:'one'});f.pipeline.seed(run);await f.pipeline.run(run);
    expect(EXTERNAL_PARSER_VERSION).toBe('generic-3');expect(PANGPANG_VERSION).toBe('pangpang@2');expect(PREPARATION_VERSION).toContain('prepared@3');expect(version).toContain('parse@6:deal-facts@1');
    const cached=f.store.db.prepare("SELECT data FROM engine_cache WHERE stage='parse'").get() as {data:string};
    const parsed=JSON.parse(cached.data);expect(parsed.fact_checks[0].fields.end_date.value).toMatchObject({year:null,month:11,day:15});expect(JSON.stringify(parsed.assertions)).not.toContain('2026-11-15');
    const links=f.store.db.prepare("SELECT data FROM engine_cache WHERE stage='source-links'").get() as {data:string};
    const p={version:PREPARATION_VERSION,mode:'static' as const,parsed,links:JSON.parse(links.data),hash:''};p.hash=digest([p.version,p.mode,p.parsed,p.links]);validatePrepared(p,loadDiscoveryConfig());
    const altered=structuredClone(p);altered.parsed.assertions.push({field:'group_buy_terms',value:{date:'2026-11-15T00:00:00+09:00'},quote:'11.15',locator:'invented'});altered.hash=digest([altered.version,altered.mode,altered.parsed,altered.links]);expect(()=>validatePrepared(altered,loadDiscoveryConfig())).toThrow('preparation_schema');
    expect(()=>validatePrepared({...p,version:PREPARATION_VERSION.replace('prepared@3','prepared@2')},loadDiscoveryConfig())).toThrow('preparation_schema');
    // Captures are immutable: project the old derivative identity as a newer
    // historical row instead of rewriting the original capture.
    const cap=f.store.db.prepare('SELECT id,data FROM engine_captures ORDER BY fetched_at LIMIT 1').get() as {id:string;data:string};const meta=JSON.parse(cap.data);meta.preparation_identity=version.replace('parse@6','parse@5');
    f.store.db.prepare('INSERT INTO engine_captures(id,run_id,source_id,url_norm,fetch_seq,fetched_at,status,content_hash,content_type,byte_length,etag,last_modified,raw_ref,prev_capture_id,data) SELECT ?,run_id,source_id,url_norm,fetch_seq+1,?,status,content_hash,content_type,byte_length,etag,last_modified,raw_ref,id,? FROM engine_captures WHERE id=?').run(digest(['stale',cap.id]),'2030-01-01T00:00:00.000Z',JSON.stringify(meta),cap.id);
    f.advance(86400000);const again=f.pipeline.start({kind:'test',at:'two'});f.pipeline.seed(again);await f.pipeline.run(again);expect(f.calls.at(-1)?.headers['if-none-match']).toBeUndefined();
  }finally{f.close();}
});
