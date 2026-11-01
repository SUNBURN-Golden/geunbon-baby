import { expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Route } from 'playwright';
import { fixture, source } from './helpers/collector';
import { config, type SourcePolicy } from '../crawler/src/source-policy';
import { Scheduler, pinnedRequest, type NetworkResponse } from '../crawler/src/scheduler';
import { DiscoveryRunner } from '../crawler/src/discovery/run';
import { formatLine, hasNumericPrice, RunHealth, type SourceHealth } from '../crawler/src/discovery/health';
import { measurePage } from '../crawler/src/discovery/measure';
import { main } from '../crawler/src/local-worker';

vi.mock('../crawler/src/scheduler',async importOriginal=>({...await importOriginal<typeof import('../crawler/src/scheduler')>(),pinnedRequest:vi.fn()}));
const load=(file:string)=>readFileSync(new URL(`./fixtures/external/${file}`,import.meta.url),'utf8');
const html=load('pangpang.html'),empty=load('empty.html');
const response=(body:string,status=200,headers:Record<string,string>={}):NetworkResponse=>({body,status,headers});
function setup(sources:SourcePolicy[]=[source],depth=0,maxPages=20){
  const settings=structuredClone({...config,sources,limits:{...config.limits,max_depth:Math.max(1,depth),max_pages:maxPages}});
  const f=fixture(settings);f.settings.limits.max_depth=depth;return f;
}
function leakGuard(sources:SourceHealth[]){
  const output=JSON.stringify(sources)+sources.filter(s=>s.pages_attempted>0).map(h=>formatLine(h,{at:0})).join('\n');
  expect(output).not.toMatch(/https:|스토케|트립트랩|베이비뵨|Synthetic recall|synthetic_seller|@handle|a > b|329|390|259|9,007/);
  for(const h of sources)for(const code of [...h.flags,...h.notes,...Object.keys(h.failures),...Object.keys(h.blocked_reasons),...Object.keys(h.subrequest_failures)])expect(code).toMatch(/^[a-z_]{1,40}$/);
}
async function collect(dry:boolean,options:{body?:string;transport?:(url:URL)=>Promise<NetworkResponse>;sources?:SourcePolicy[];depth?:number;maxPages?:number}={}){
  const f=setup(options.sources,options.depth,options.maxPages);
  try{
    const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,options.transport??(async url=>response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':options.body??html)),async ms=>{f.advance(ms);}));
    if(!dry)runner.seed();
    const health=await runner.run(dry);leakGuard(health.sources);
    if(dry){
      for(const table of ['collection_records','evidence_assertions','collection_jobs','seller_candidates','intake_reservations','sync_outbox'] as const)expect(f.store.list(table)).toHaveLength(0);
      expect(health.sources.every(h=>h.sent===0)).toBe(true);
    }
    return health;
  }finally{f.close();}
}
function mockBrowser(text='가격: 329,000원',options:{requests?:{path:string;type:string;method?:string}[];evaluateError?:string;launchError?:boolean}={}){
  if(options.launchError){vi.mocked(chromium.launch).mockRejectedValueOnce(new Error('https://secret.invalid @handle'));return;}
  let handler:(route:Route)=>Promise<unknown>=async()=>{};
  let navigationAborted=false;
  vi.mocked(chromium.launch).mockResolvedValueOnce({
    newContext:async()=>({
      routeWebSocket:async()=>{},route:async(_pattern:string,h:typeof handler)=>{handler=h;},
      newPage:async()=>({
        goto:async()=>{
          for(const req of [{path:'/',type:'document'},...(options.requests??[])])await handler({
            request:()=>({resourceType:()=>req.type,method:()=>('method' in req?req.method:'GET'),url:()=>source.origin+req.path}),
            abort:async()=>{if(req.path==='/'&&req.type==='document')navigationAborted=true;},fulfill:async()=>{},
          } as unknown as Route);
          if(navigationAborted)throw new Error('https://secret.invalid @handle navigation failed');
        },
        url:()=>source.entries[0],evaluate:async()=>{
          if(options.evaluateError)throw new Error(options.evaluateError);
          return {title:'스토케 트립트랩',documentOrigin:source.origin,text,locator:'.card'};
        },
      }),
    }),close:vi.fn(),
  } as never);
}

test('numeric price hints require one positive safe-integer amount',()=>{
  for(const value of [1,329000,Number.MAX_SAFE_INTEGER,{amount:329000},'329,000원',' 329000 원 '])expect(hasNumericPrice(value)).toBe(true);
  for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,null,undefined,{}, {amount:'329000'},'가격: 문의','상담 후 결정','329,000원~359,000원','9,007,199,254,740,993원','0원','01원','329.50원','329,00원'])expect(hasNumericPrice(value),String(value)).toBe(false);
});

test.each([false,true])('listing findings and healthy counts (dry=%s)',async dry=>{
  for(const [file,flag,counts] of [
    ['empty.html','zero_parsed',{parsed:0,eligible:0,price_checked:0,price_hints:0}],
    ['irrelevant.html','zero_eligible',{parsed:3,eligible:0,price_checked:0,price_hints:0}],
    ['no-price.html','zero_price_hints',{parsed:2,eligible:2,price_checked:2,price_hints:0}],
  ] as const){
    const h=await collect(dry,{body:load(file)});
    expect(h.status).toBe('review');expect(h.review).toEqual(['fixture']);
    expect(h.sources[0]).toMatchObject({...counts,status:'review',pages_attempted:1,pages_ok:1,pages_failed:0,pages_review:1,page_findings:{[flag]:1}});
    expect(h.sources[0].flags).toContain(flag);
  }
  const h=await collect(dry);
  expect(h.status).toBe('ok');expect(h.sources[0]).toMatchObject({status:'ok',flags:[],pages_review:0,parsed:3,eligible:2,price_checked:2,price_hints:2,sent:dry?0:2});
});

test.each([false,true])('one empty detail page cannot hide behind healthy totals (dry=%s)',async dry=>{
  const h=await collect(dry,{depth:1,transport:async url=>response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':url.pathname==='/'?html:empty)});
  expect(h.status).toBe('review');const s=h.sources[0];expect(s.parsed).toBeGreaterThan(0);expect(s.eligible).toBeGreaterThan(0);
  expect(s.page_findings.zero_parsed).toBeGreaterThanOrEqual(1);expect(s.pages_review).toBeGreaterThanOrEqual(1);expect(s.flags).toContain('zero_parsed');expect(s.status).toBe('review');
});

test.each([false,true])('CPSC JSON and XML count recalls before submit, without prices (dry=%s)',async dry=>{
  for(const file of ['cpsc.json','cpsc.xml']){
    const h=await collect(dry,{body:load(file),sources:[{...source,adapter:'cpsc'}]});
    expect(h.status).toBe('ok');expect(h.sources[0]).toMatchObject({parsed:2,eligible:2,price_checked:0,price_hints:0,sent:dry?0:2,notes:['price_not_applicable'],flags:[]});
  }
});

test.each([false,true])('RSS and sitemap measure feeds and item pages (dry=%s)',async dry=>{
  for(const [adapter,file] of [['rss','feed.rss'],['sitemap','sitemap.xml']] as const){
    const s={...source,adapter},body=load(file);
    expect(measurePage(body,source.entries[0],s,{...config,sources:[s]},new Date(),{listing:false})).toMatchObject({kind:'feed',parsed:2,eligible:2,price_checked:0});
    const h=await collect(dry,{sources:[s],depth:1,transport:async url=>response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':url.pathname==='/'?body:html)});
    expect(h.status).toBe('ok');expect(h.sources[0]).toMatchObject({pages_attempted:3,parsed:8,eligible:6,price_checked:4,price_hints:4,notes:[]});
  }
});

test.each([false,true])('out-of-scope feed entries, no price assessment and malformed feeds (dry=%s)',async dry=>{
  const sources:SourcePolicy[]=[{...source,adapter:'rss'}];
  const out=await collect(dry,{sources,body:'<rss><link>https://other.example.org/item</link></rss>'});
  expect(out.sources[0]).toMatchObject({parsed:1,eligible:0,flags:['zero_eligible']});
  const noProbe=await collect(dry,{sources,body:load('feed.rss')});
  expect(noProbe.sources[0]).toMatchObject({parsed:2,eligible:2,price_checked:0,notes:['price_not_assessed']});
  for(const [body,code] of [['{}','cpsc_schema'],['{','error']] as const){
    const h=await collect(dry,{sources:[{...source,adapter:'cpsc'}],body});expect(h.sources[0].failures).toEqual({[code]:1});
  }
  const fallback=await collect(dry,{sources,body:'<main><a href="/deal/101">detail</a></main>'});
  expect(fallback.sources[0]).toMatchObject({parsed:1,eligible:1,notes:['price_not_assessed']});
});

test('dry-run probes at most two items and respects the shared page budget',async()=>{
  for(const [maxPages,expected] of [[1,1],[2,2],[20,3]]){
    const h=await collect(true,{depth:1,maxPages});expect(h.sources[0].pages_attempted).toBe(expected);
  }
});

test.each([false,true])('browser numeric price checks use filtered assertions (dry=%s)',async dry=>{
  for(const [text,hints] of [['가격: 문의',0],['가격: 329,000원\n가격은 329,000원',2],['가격: 9,007,199,254,740,993원',0],['가격: 329,000원~359,000원',0]] as const){
    mockBrowser(text);
    const h=await collect(dry,{sources:[{...source,browser:true}]});
    expect(h.sources[0]).toMatchObject({parsed:1,eligible:1,price_hints:hints,pages_failed:0});
    expect(h.sources[0].price_checked).toBeGreaterThan(0);expect(h.status).toBe(hints?'ok':'review');
    if(!hints)expect(h.sources[0].flags).toContain('zero_price_hints');
  }
});

test.each([false,true])('blocked requests have distinct reasons and redirects count once (dry=%s)',async dry=>{
  for(const [kind,code] of [['robots','robots_denied'],['robots_unavailable','robots_unavailable'],['403','source_blocked'],['captcha','source_blocked'],['429','source_cooldown'],['500','source_cooldown'],['redirect','visit_not_allowed'],['private','private_network']] as const){
    const h=await collect(dry,{transport:async url=>{
      if(kind==='private')throw new Error('private_network');
      if(url.pathname==='/robots.txt')return response(kind==='robots'?'User-agent: *\nDisallow: /':'User-agent: *\nAllow: /',kind==='robots_unavailable'?401:200);
      if(kind==='redirect')return response('',302,{location:url.pathname==='/'?'/redirect':'https://other.example.org/private'});
      return response(kind==='captcha'?'captcha':'',Number(kind)||200);
    }});
    expect(h.status).toBe('review');expect(h.sources[0]).toMatchObject({pages_attempted:1,pages_ok:0,pages_failed:1,blocked:1,blocked_reasons:{[code]:1},failures:{[code]:1}});
    expect(h.sources[0].flags).toEqual(expect.arrayContaining(['failed','blocked','not_attempted']));
    expect(formatLine(h.sources[0])).toContain(`failed=1 subrequest_failed=0 reason=${code}`);
  }
});

test.each([false,true])('fetch failures are isolated across sources (dry=%s)',async dry=>{
  const second={...source,id:'second',origin:'https://second.example.org',entries:['https://second.example.org/']};
  for(const code of ['network_error','request_timeout','https://secret.invalid @handle 329,000원']){
    const h=await collect(dry,{sources:[source,second],transport:async url=>{
      if(url.hostname===new URL(source.origin).hostname)throw new Error(code);
      return response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':html);
    }});
    expect(h.sources).toHaveLength(2);expect(h.sources[0].failures).toEqual({[code.startsWith('https:')?'error':code]:1});
    expect(h.sources[1]).toMatchObject({source_id:'second',status:'ok',pages_attempted:1});
  }
});

test.each([false,true])('render and navigation failures are sanitized and counted once (dry=%s)',async dry=>{
  const sources=[{...source,browser:true}];
  mockBrowser('',{evaluateError:'region_required'});
  expect((await collect(dry,{sources})).sources[0].failures).toEqual({region_required:1});
  mockBrowser('',{launchError:true});
  expect((await collect(dry,{sources})).sources[0].failures).toEqual({error:1});
  mockBrowser();
  const nav=await collect(dry,{sources,transport:async url=>{
    if(url.pathname!=='/robots.txt')throw new Error('network_error');return response('User-agent: *\nAllow: /');
  }});
  expect(nav.sources[0]).toMatchObject({pages_failed:1,failures:{network_error:1},subrequest_failures:{},blocked:0});
});

test.each([false,true])('browser subrequest failures survive successful extraction (dry=%s)',async dry=>{
  mockBrowser('가격: 329,000원',{requests:[{path:'/api.json',type:'xhr'},{path:'/app.js',type:'script'},{path:'/image.jpg',type:'image'},{path:'/write',type:'fetch',method:'POST'}]});
  const h=await collect(dry,{sources:[{...source,browser:true}],transport:async url=>{
    if(url.pathname==='/api.json')throw new Error('request_timeout');
    // source_response is a non-success response that doesn't start a cooldown.
    if(url.pathname==='/app.js')return response('',400);
    if(['/image.jpg','/write'].includes(url.pathname))throw new Error('intentional_abort_reached_transport');
    return response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':empty);
  }});
  expect(h.status).toBe('review');expect(h.sources[0]).toMatchObject({pages_ok:1,pages_failed:0,blocked:0,failures:{},subrequest_failures:{request_timeout:1,source_response:1},flags:['subrequest_failed']});
});

test.each([false,true])('blocked browser subrequests are counted separately (dry=%s)',async dry=>{
  for(const [kind,code] of [['robots','robots_denied'],['403','source_blocked'],['502','source_cooldown']] as const){
    mockBrowser('가격: 329,000원',{requests:[{path:'/private',type:'xhr'}]});
    const h=await collect(dry,{sources:[{...source,browser:true}],transport:async url=>{
      if(url.pathname==='/robots.txt')return response(kind==='robots'?'User-agent: *\nDisallow: /private':'User-agent: *\nAllow: /');
      return response(empty,url.pathname==='/private'&&kind!=='robots'?Number(kind):200);
    }});
    expect(h.sources[0]).toMatchObject({pages_ok:1,pages_failed:0,blocked:1,blocked_reasons:{[code]:1},subrequest_failures:{},flags:['blocked']});
  }
});

test.each([false,true])('unsupported selectors produce a safe failure code (dry=%s)',async dry=>{
  const h=await collect(dry,{sources:[{...source,selector:'a > b'}]});
  expect(h.sources[0].failures).toEqual({selector_invalid:1});
});

test('blocked counters reset per run and idle does not claim attempted work',async()=>{
  const f=setup();try{
    const scheduler=new Scheduler(f.store,async()=>response('User-agent: *\nDisallow: /'),async ms=>{f.advance(ms);});
    await expect(scheduler.get(source.entries[0],source)).rejects.toThrow('robots_denied');
    const runner=new DiscoveryRunner(f.store,scheduler);
    const idle=await runner.run();expect(idle.status).toBe('idle');expect(idle.sources[0]).toMatchObject({pages_attempted:0,blocked:0});
    expect((await runner.run(true)).sources[0].blocked).toBe(1);
    expect((await runner.run()).sources[0].blocked).toBe(0);
  }finally{f.close();}
});

test('health dictionaries and formatter sanitize arbitrary errors, including prototype keys',()=>{
  const h=new RunHealth();h.source('fixture','run');h.pageFailed('fixture','https://secret.invalid @handle');h.pageFailed('fixture','constructor');h.subrequestFailed('fixture','a > b');
  const sources=h.finish(new Map([['fixture',{'https://secret.invalid':1}]]),new Map([['fixture','links']]));
  expect(sources[0]).toMatchObject({failures:{error:1,constructor:1},subrequest_failures:{error:1},blocked_reasons:{error:1}});leakGuard(sources);
});

test.each([false,true])('discover CLI prints health JSON and one terminal line per attempted source (dry=%s)',async dry=>{
  const dir=mkdtempSync(join(tmpdir(),'collector-health-cli-')),argv=process.argv;
  const settings=structuredClone({...config,sources:[{...source,max_pages:1},{...source,id:'failed',origin:'https://failed.example.org',entries:['https://failed.example.org/'],max_pages:1}]});
  writeFileSync(join(dir,'config.json'),JSON.stringify(settings));
  vi.stubEnv('COLLECTOR_DB',join(dir,'collector.sqlite'));vi.stubEnv('COLLECTOR_CONFIG',join(dir,'config.json'));vi.stubEnv('COLLECTOR_TRUSTED_EGRESS_CIDRS','');
  vi.mocked(pinnedRequest).mockImplementation(async url=>{
    if(url.hostname==='failed.example.org')throw new Error('network_error');return response(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':html);
  });
  vi.spyOn(Scheduler.prototype,'slot').mockImplementation(async(_domain,task)=>task());
  const stdout=vi.spyOn(console,'log').mockImplementation(()=>{}),stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    process.argv=['node','local-worker.ts','discover',...(dry?['--dry-run']:[])];await main();
    expect(stdout).toHaveBeenCalledTimes(1);const output=JSON.parse(stdout.mock.calls[0][0]);expect(output.dry_run).toBe(dry?true:undefined);
    expect(output.health.status).toBe('review');expect(output.health.sources).toHaveLength(2);leakGuard(output.health.sources);
    const details=stderr.mock.calls.map(c=>String(c[0])).filter(line=>line.startsWith('discover at='));
    expect(details).toHaveLength(2);
    for(const h of output.health.sources)expect(details.filter(line=>line.includes(` source=${h.source_id} `))).toHaveLength(1);
    expect(details.every(line=>/at=.+\+09:00/.test(line))).toBe(true);
    expect(details[0]).toContain('status=ok');expect(details[1]).toContain('reason=network_error');
    if(!dry)expect(output.jobs.sources.failed.failures).toEqual({network_error:1});
  }finally{process.argv=argv;rmSync(dir,{recursive:true,force:true});}
});

test('lowercase exception text is never treated as a loggable reason code',async()=>{
  const {failureCode}=await import('../crawler/src/discovery/health');
  expect(failureCode(new Error('credentialneverprint'))).toBe('error');
  const health=new RunHealth();health.source('fixture','run');health.pageFailed('fixture','credentialneverprint');
  const sourceHealth=health.finish(new Map(),new Map([['fixture','links']]))[0];
  expect(formatLine(sourceHealth)).not.toContain('credentialneverprint');
});
