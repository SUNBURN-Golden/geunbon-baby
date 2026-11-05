import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { parseItems, parseItemsDetailed, type ParsedItem } from '../crawler/lib/external/parse';
import { buildPayload, eligibilityReason, evaluatePayload } from '../crawler/lib/external/filter';
import { config, type SourcePolicy } from '../crawler/src/source-policy';
import { measurePage } from '../crawler/src/discovery/measure';
import { RunHealth, formatLine } from '../crawler/src/discovery/health';
import { diagnosticContext, eligibilityLog, emptyRunDiagnostics, reportEligibilityPage, serializeEligibilityEvent, type DiagnosticTotals, type EligibilityEvent, type RunEligibilityDiagnostics } from '../crawler/src/discovery/eligibility-diagnostics';
import { DiscoveryRunner } from '../crawler/src/discovery/run';
import { Scheduler, type NetworkResponse } from '../crawler/src/scheduler';
import { fixture } from './helpers/collector';

const now=new Date('2026-11-05T01:13:02.762Z');
// Only this test copy is enabled. Production source activation remains untouched.
const source:SourcePolicy={...config.sources.find(s=>s.id==='snapup')!,enabled:true};
const load=(name:string)=>readFileSync(new URL(`./fixtures/external/snapup/${name}.html`,import.meta.url),'utf8');
const response=(body:string):NetworkResponse=>({body,status:200,headers:{'content-type':'text/html'}});
const measured=(body:string,s=source)=>measurePage(body,s.entries[0],s,{...config,sources:[s]},now,{listing:true});
const card=(title:string,id=1)=>`<section class="card"><a href="/public-products/${id}">${title}</a></section>`;
function reconcile(d:DiagnosticTotals){
  expect(d.selected).toBe(d.parsed+d.skipped_no_text+d.skipped_no_allowed_link);
  expect(d.parsed).toBe(d.examined);
  expect(d.examined).toBe(d.accepted+d.rejected);
  expect(d.rejected).toBe(Object.values(d.rejection_reason_counts).reduce((a,b)=>a+b,0));
}
function reconcileRun(d:RunEligibilityDiagnostics){
  reconcile(d);
  expect(d.diagnostic_pages_attempted).toBe(d.diagnostic_pages_measured+d.diagnostic_pages_unmeasured);
  expect(d.diagnostic_pages_measured).toBe(d.diagnostic_measured_pages_ok+d.diagnostic_measured_pages_failed);
}
function privacy(events:EligibilityEvent[],health:unknown){
  const output=JSON.stringify(events.map(serializeEligibilityEvent))+JSON.stringify(health);
  expect(output).not.toMatch(/https?:|@|유모차|트립트랩|기저귀|분유|synthetic_seller|secret|credential|329,?000|<main|a > b|public-products/);
  for(const e of events){
    const safe=serializeEligibilityEvent(e);
    expect(safe.run_ref).toMatch(/^[a-f0-9]{64}$/);expect(safe.page_ref).toMatch(/^[a-f0-9]{64}$/);expect(safe.attempt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(safe.execution_revision).toMatch(/^(?:[a-f0-9]{40,64}|unavailable)$/);
    expect(safe.parser_version).toBe('generic-2');expect(safe.extraction_mode).toBe('server_html');
  }
}
async function run(dry:boolean,body:string,options:{selector?:string;depth?:number;entries?:string[];maxPages?:number;failSubmit?:boolean;failTransport?:boolean;failScheduling?:boolean;bodyFor?:(url:URL)=>string}={}){
  const s={...source,...(options.selector!==undefined?{selector:options.selector}:{}),...(options.entries?{entries:options.entries}:{}),max_pages:options.maxPages??20};
  const settings=structuredClone({...config,sources:[s]});
  const f=fixture(settings);f.settings.limits.max_depth=options.depth??0;
  const events:EligibilityEvent[]=[];
  try {
    if(options.failSubmit){
      const submit=f.store.submit.bind(f.store);let count=0;
      vi.spyOn(f.store,'submit').mockImplementation((...args)=>{expect(events.filter(e=>e.event==='item')).toHaveLength(3);expect(events.some(e=>e.event==='page_summary')).toBe(true);if(++count===2)throw new Error('secret https://credential.invalid @synthetic_seller');return submit(...args);});
    }
    if(options.failScheduling)vi.spyOn(f.store,'discover').mockImplementation(()=>{throw new Error('secret');});
    const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,async url=>{
      if(options.failTransport)throw new Error('secret');
      return response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':options.bodyFor?.(url)??body);
    },async ms=>{f.advance(ms);}),()=>{},e=>{
      // Measurement events must precede any submission, including failed attempts.
      events.push(structuredClone(e));
    });
    if(!dry)runner.seed();
    const result=await runner.run(dry,'synthetic-run');const h=result.sources[0];
    privacy(events,h);privacy(events,formatLine(h,{at:0}));
    reconcileRun(h.eligibility_diagnostics!);
    const terminal=events.filter(e=>e.event==='page_terminal');
    expect(terminal).toHaveLength(h.pages_attempted);
    expect(new Set(terminal.map(e=>e.attempt_ref)).size).toBe(terminal.length);
    expect(events.filter(e=>e.event==='run_summary')).toHaveLength(1);
    if(dry)for(const table of ['collection_records','collection_jobs','evidence_assertions','seller_candidates','intake_reservations','sync_outbox'] as const)expect(f.store.list(table)).toHaveLength(0);
    return {h,events};
  }finally{f.close();}
}

test('detailed parser selects each candidate once and preserves legacy results and skip precedence',()=>{
  const html='<main><div class="card"><a href="/x"></a></div><div class="card">text<a href="/api/private">bad</a></div>'+card('에그 유모차')+'<div class="card"><a href="mailto:a@example.invalid">text</a></div></main>';
  const parsed=parseItemsDetailed(html,source.entries[0],source.origin,'.card',now);
  expect(parsed.selected).toBe(4);
  expect(parsed.outcomes).toEqual([{candidate_index:0,reason:'no_text'},{candidate_index:1,reason:'no_allowed_link'},{candidate_index:2,reason:'parsed',item_index:0},{candidate_index:3,reason:'no_allowed_link'}]);
  expect(parsed.items).toEqual(parseItems(html,source.entries[0],source.origin,'.card',now));
  const m=measured(html,{...source,selector:'.card'});
  expect(m.eligibility_diagnostics).toMatchObject({selected:4,parsed:1,examined:1,accepted:1,rejected:0,skipped_no_text:1,skipped_no_allowed_link:2});reconcile(m.eligibility_diagnostics!);
  const empty=measured('<div></div>');expect(empty.eligibility_diagnostics).toMatchObject({selected:0,skips:[],items:[]});reconcile(empty.eligibility_diagnostics!);
});

test.each([false,true])('shipped main selection exposes heading collapse and contamination without claiming a product mapping (dry=%s)',async dry=>{
  expect(source.selector).toBe('main');expect(config.sources.find(s=>s.id==='snapup')?.enabled).toBe(false);
  for(const [file,reason] of [['heading-collapse','not_baby_item'],['contamination','excluded_category']] as const){
    const {h,events}=await run(dry,load(file));
    expect(h).toMatchObject({pages_ok:1,parsed:1,eligible:0,price_checked:0,sent:0,flags:['zero_eligible']});
    expect(h.eligibility_diagnostics).toMatchObject({selected:1,examined:1,rejected:1,rejection_reason_counts:{[reason]:1}});
    const item=events.find(e=>e.event==='item');
    expect(item).toMatchObject({reason,has_title:true,has_category:false,has_price:false,has_period:false,configured_selector_is_main:true});
    if(file==='contamination')expect(item).toMatchObject({excluded_title:true,excluded_category:false,excluded_text:true});
    // Comparing synthetic card scopes demonstrates the mechanism, not real Snapup DOM.
    const scoped=measured(load(file),{...source,selector:'.card'});
    expect(scoped.eligible).toBe(file==='heading-collapse'?5:1);
  }
});

test.each(['에그 유모차','스토케 트립트랩','브라이텍스 카시트','베이비뵨 아기띠','아기 체육관','모빌'])('unchanged source-label classification accepts %s without prices or periods',title=>{
  const m=measured(`<main><a href="/public-products/1">${title}</a></main>`);
  expect(m).toMatchObject({parsed:1,eligible:1,price_checked:1,price_hints:0});
  expect(m.listing![0].legacy).toMatchObject({price_hint:null,starts_at:null,ends_at:null});
  expect(m.eligibility_diagnostics?.items[0]).toMatchObject({reason:'accepted',has_price:false,has_period:false});
});

test('typed evaluation and compatibility payload obey exclusion precedence and empty title order',()=>{
  const base:ParsedItem={source_url:source.entries[0],title:'스토케 트립트랩',category_text:'',text:'',price:null,dates:null,seller_handle:null,seller_url:null};
  for(const item of [base,{...base,title:'뷰티 클렌저'},{...base,title:'유모차 기저귀'},{...base,category_text:'분유'},{...base,text:'formula'},{...base,title:'',category_text:'유모차'},{...base,title:''}]){
    const e=evaluatePayload('snapup',item,now);
    expect(buildPayload('snapup',item,now)).toEqual(e.accepted?e.payload:null);
    if(!e.accepted)expect(e.reason).toBe(eligibilityReason(item)??'empty_title');
  }
  const m=measured('<main>'+card('스토케 트립트랩')+'</main>',{...source,selector:'.card'});
  expect(m.eligibility_diagnostics?.items[0]).toMatchObject({model_threshold_match:true,has_model_category:true});
  const rejected=measured('<main>'+card('스토케 트립트랩 기저귀')+'</main>',{...source,selector:'.card'});
  expect(rejected.eligibility_diagnostics?.items[0]).toMatchObject({reason:'excluded_category',model_threshold_match:true,has_model_category:true,excluded_title:true});
});

test.each([false,true])('normal and dry-run reconcile mixed skips, all rejected and zero selected pages (dry=%s)',async dry=>{
  const html='<main><section class="card"></section><section class="card">text</section>'+card('뷰티 클렌저')+card('아기 분유',2)+'</main>';
  const {h,events}=await run(dry,html,{selector:'.card'});
  expect(h.eligibility_diagnostics).toMatchObject({selected:4,parsed:2,skipped_no_text:1,skipped_no_allowed_link:1,accepted:0,rejected:2,rejection_reason_counts:{not_baby_item:1,excluded_category:1}});
  expect(events.filter(e=>e.event==='candidate_skip')).toHaveLength(2);
  expect(events.filter(e=>e.event==='item')).toHaveLength(2);
  const empty=await run(dry,'<div>empty</div>');
  expect(empty.h.eligibility_diagnostics).toMatchObject({selected:0,parsed:0,diagnostic_pages_measured:1});
  expect(empty.events.filter(e=>e.event==='candidate_skip')).toHaveLength(0);
  expect(empty.events.filter(e=>e.event==='page_summary')).toHaveLength(1);
  expect(empty.h.flags).toContain('zero_parsed');
});

test('later submission failure preserves every measured occurrence and the earlier completed submission',async()=>{
  const body='<main>'+card('유모차',1)+card('아기띠',2)+card('카시트',3)+'</main>';
  const {h,events}=await run(false,body,{selector:'.card',failSubmit:true});
  expect(h).toMatchObject({pages_attempted:1,pages_ok:0,pages_failed:1,sent:1,parsed:0,eligible:0});
  expect(h.eligibility_diagnostics).toMatchObject({selected:3,parsed:3,examined:3,accepted:3,rejected:0,diagnostic_pages_measured:1,diagnostic_measured_pages_failed:1,measured_failure_counts:{error:1}});
  expect(events.filter(e=>e.event==='item')).toHaveLength(3);
  expect(events.find(e=>e.event==='page_terminal')).toMatchObject({measured:true,outcome:'failed',stage:'submission',reason:'error'});
  expect(events.findIndex(e=>e.event==='page_summary')).toBeLessThan(events.findIndex(e=>e.event==='page_terminal'));
  expect(formatLine(h,{at:0})).toContain('diagnostic_accepted=3');
});

test('scheduling failure also leaves full measurement available',async()=>{
  const {h}=await run(false,'<main>'+card('유모차')+'</main>',{failScheduling:true});
  expect(h).toMatchObject({pages_failed:1,sent:0});expect(h.eligibility_diagnostics).toMatchObject({accepted:1,diagnostic_measured_pages_failed:1});
});

test.each([false,true])('transport and extraction failures are unmeasured and never fabricated skips (dry=%s)',async dry=>{
  for(const [options,stage,reason] of [[{failTransport:true},'transport','error'],[{selector:'a > b'},'extraction','selector_invalid']] as const){
    const {h,events}=await run(dry,'<main>text</main>',options);
    expect(h.eligibility_diagnostics).toMatchObject({selected:0,parsed:0,diagnostic_pages_attempted:1,diagnostic_pages_measured:0,diagnostic_pages_unmeasured:1,unmeasured_failures:{[stage]:{[reason]:1}}});
    expect(events.some(e=>['item','candidate_skip','page_summary'].includes(e.event))).toBe(false);
    expect(events.find(e=>e.event==='page_terminal')).toMatchObject({measured:false,stage,reason,outcome:'failed'});
  }
});

test('normal and dry-run make identical decisions while the probe budget stays at two children',async()=>{
  const html='<main><h1>공동구매 일정</h1>'+card('유모차')+card('카시트',2)+card('모빌',3)+card('아기띠',4)+'</main>';
  const normal=await run(false,html,{depth:1});const dry=await run(true,html,{depth:1});
  expect(normal.h.pages_attempted).toBe(5);expect(dry.h.pages_attempted).toBe(3);
  const decisions=(events:EligibilityEvent[])=>events.filter(e=>e.event==='item').map(e=>serializeEligibilityEvent(e)).map(e=>({reason:e.reason,keyword_match:e.keyword_match,excluded_text:e.excluded_text}));
  expect(decisions(normal.events).slice(0,3)).toEqual(decisions(dry.events));
  // Same parsed occurrence repeats on every page, without deduplication of counters.
  expect(normal.h.eligibility_diagnostics).toMatchObject({parsed:5,rejected:5});
  expect(dry.h.eligibility_diagnostics).toMatchObject({parsed:3,rejected:3});
});

test.each([18,19])('twenty successfully processed pages with %s parsed occurrences retain zero_parsed',async count=>{
  const entries=Array.from({length:20},(_,i)=>`${source.origin}/page-${i}`);
  const {h}=await run(false,'',{entries,bodyFor:url=>Number(url.pathname.split('-')[1])<count?'<main>'+card('뷰티 클렌저')+'</main>':'<div></div>'});
  expect(h).toMatchObject({pages_attempted:20,pages_ok:20,parsed:count,eligible:0,page_findings:{zero_parsed:20-count}});
  expect(h.flags).toContain('zero_parsed');expect(h.flags).toContain('zero_eligible');
  expect(h.eligibility_diagnostics).toMatchObject({diagnostic_pages_measured:20,examined:count,rejected:count});
});

test('health ingests a measurement and a terminal outcome at most once per attempt',()=>{
  const health=new RunHealth();health.source('snapup','run');const d=measured('<main>'+card('유모차')+'</main>').eligibility_diagnostics!;
  expect(health.diagnosticAttempt('snapup','opaque')).toBe(true);expect(health.diagnosticAttempt('snapup','opaque')).toBe(false);
  expect(health.diagnosticMeasured('snapup','opaque',d)).toBe(true);expect(health.diagnosticMeasured('snapup','opaque',d)).toBe(false);
  expect(health.diagnosticTerminal('snapup','opaque')).toEqual({measured:true});expect(health.diagnosticTerminal('snapup','opaque')).toBeNull();
  health.pageOk('snapup',measured('<main>'+card('유모차')+'</main>'));
  const h=health.finish(new Map(),new Map([['snapup','links']]))[0];expect(h.eligibility_diagnostics).toMatchObject({accepted:1,diagnostic_pages_measured:1,diagnostic_measured_pages_ok:1});reconcileRun(h.eligibility_diagnostics!);
});

test('every serializer branch drops extra fields and sanitizes codes, references and dictionary keys',()=>{
  const context=diagnosticContext('run','secret https://credential.invalid','@synthetic_seller','secret',now.getTime(),{...source,selector:'secret'},1);
  const d=emptyRunDiagnostics();d.unmeasured_failures.transport={'credentialneverprint':1,constructor:2,'https://secret.invalid':1};d.measured_failure_counts={'@synthetic_seller':1};
  const events:EligibilityEvent[]=[];
  const m=measured('<main>'+card('유모차 @synthetic_seller 329,000원')+'</main>');
  reportEligibilityPage(m.eligibility_diagnostics!,context,e=>events.push(e));
  events.push({...context,event:'attempt'},{...context,event:'candidate_skip',candidate_index:0,reason:'no_text'},
    {...context,event:'page_terminal',measured:false,outcome:'failed',stage:'transport',reason:'credentialneverprint'},
    {...context,event:'page_terminal',measured:true,outcome:'ok'}, {...context,event:'run_summary',totals:d});
  const stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
  for(const event of events){
    const poisoned={...event,run_ref:'secret',page_ref:'@synthetic_seller',attempt_ref:'https://secret.invalid',execution_revision:'credentialneverprint',captured_at:'secret',raw:'secret',selector:'secret',title:'secret'};
    eligibilityLog(poisoned);const safe=serializeEligibilityEvent(poisoned);
    expect(JSON.stringify(safe)).not.toMatch(/secret|credential|synthetic_seller|https?:|@/);
    expect(safe).not.toHaveProperty('raw');expect(safe).not.toHaveProperty('title');expect(safe).not.toHaveProperty('selector');
  }
  expect(stderr.mock.calls.flat().join('')).not.toMatch(/secret|credential|synthetic_seller|https?:|@/);
  privacy(events,{});
});

test('enabled idle Snapup still finalizes one zero-valued run summary',async()=>{
  const f=fixture({...config,sources:[source]});const events:EligibilityEvent[]=[];
  try {
    const runner=new DiscoveryRunner(f.store,undefined,()=>{},e=>events.push(e));
    const result=await runner.run(false);expect(result.status).toBe('idle');
    expect(events).toHaveLength(1);expect(events[0].event).toBe('run_summary');
    reconcileRun(result.sources[0].eligibility_diagnostics!);
    expect(result.sources[0].eligibility_diagnostics?.diagnostic_pages_attempted).toBe(0);
  }finally{f.close();}
});
