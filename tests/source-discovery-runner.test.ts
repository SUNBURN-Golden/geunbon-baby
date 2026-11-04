import { expect, test, vi } from 'vitest';
import { collectedDerivative, discover, discoveryAsset, discoveryFixture, rows } from './helpers/source-discovery';
import { SourceDiscoveryRunner } from '../crawler/src/source-discovery/runner';
import { SourceCandidateStore } from '../crawler/src/source-discovery/store';
import { SqliteStorage } from '../crawler/engine/storage';
test('search discovers unseeded product URLs without visiting them; rerun reuses captures and leaves intake/outbox untouched',async()=>{
 const f=discoveryFixture();try{
  const baseline=['collection_records','dedup_groups','sync_outbox','engine_extracted','engine_labels','intake_receipts'].map(t=>rows(f,t));
  const r=await discover(f);expect(f.runner.engine.run(r)?.state).toBe('finished');
  expect(f.calls).toHaveLength(1);expect(f.calls[0].url).toContain('search.example.org');expect(rows(f,'source_candidates').map(c=>c.canonical_url)).toEqual(['https://new-gear.example.org/item?product_no=A','https://new-gear.example.org/item?product_no=B']);
  expect(rows(f,'source_candidates').every(c=>c.status==='discovered')).toBe(true);expect(rows(f,'source_candidate_evidence').every(e=>e.fact_status==='unverified')).toBe(true);
  expect(['collection_records','dedup_groups','sync_outbox','engine_extracted','engine_labels','intake_receipts'].map(t=>rows(f,t))).toEqual(baseline);
  const before=rows(f,'source_candidate_evidence');await discover(f,'two');expect(f.calls).toHaveLength(1);expect(rows(f,'source_candidate_evidence')).toEqual(before);expect(rows(f,'source_candidates').every(c=>c.observation_count===1)).toBe(true);
  expect(rows(f,'engine_runs').every(r=>r.profile_id==='agamajung-source-discovery')).toBe(true);expect(rows(f,'engine_costs').some(r=>String(r.scope).endsWith(':agamajung-source-discovery'))).toBe(false);
 }finally{f.close();}
});
test('approved sitemap index and RSS/list pagination discover external sources with locators and bounded cyclic traversal',async()=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];f.cfg.source_ids=['fixture'];f.cfg.source_hints={fixture:'유모차 KR 2026'};f.settings.sources[0].entries=['https://gear.example.org/index.xml','https://gear.example.org/feed.xml','https://gear.example.org/list'];
  f.response(url=>({status:200,headers:{'content-type':url.pathname.endsWith('.xml')?'application/xml':'text/html'},body:url.pathname==='/index.xml'?discoveryAsset('index.xml'):url.pathname==='/map.xml'?discoveryAsset('sitemap.xml'):url.pathname==='/feed.xml'?discoveryAsset('feed.xml'):discoveryAsset('list.html')}));
  await discover(f);
  expect(f.calls.every(c=>new URL(c.url).hostname==='gear.example.org')).toBe(true);expect(f.calls.filter(c=>new URL(c.url).pathname==='/index.xml')).toHaveLength(1);
  expect(f.calls.some(c=>c.url.endsWith('/list?page=2'))).toBe(true);expect(rows(f,'source_candidates').some(c=>String(c.canonical_url).endsWith('/stroller-2026'))).toBe(true);
  expect(rows(f,'source_candidate_evidence').some(e=>String(e.locator).startsWith('urlset/url'))).toBe(true);expect(rows(f,'source_candidate_evidence').some(e=>String(e.locator).startsWith('entry'))).toBe(true);
  const paths=rows(f,'source_discovery_paths');expect(paths.some(p=>p.depth===2)).toBe(true);expect(paths.some(p=>p.deferred_reason==='approval_required')).toBe(true);
  expect(rows(f,'source_candidate_evidence').map(e=>e.relation)).toEqual(expect.arrayContaining(['social','order','attachment','pagination']));
 }finally{f.close();}
});
test('default depth two is enforced across links, query feedback and pagination; truncation remains visible',async()=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];f.cfg.source_ids=['fixture'];f.settings.sources[0].entries=['https://gear.example.org/level0'];
  f.response(url=>({status:200,headers:{'content-type':'text/html'},body:`<main><h1>유모차 2026 신제품</h1><a href="/level${Number(url.pathname.slice(-1))+1}">유모차 신제품 2026</a></main>`}));
  await discover(f);expect(f.calls.filter(c=>new URL(c.url).pathname!=='/robots.txt')).toHaveLength(3);expect(f.calls.some(c=>c.url.endsWith('/level3'))).toBe(false);
  expect(rows(f,'source_discovery_paths').some(p=>p.depth===3&&p.deferred_reason==='depth_limit')).toBe(true);
 }finally{f.close();}
});
test.each(['login','empty','challenge','forbidden'])('restricted %s document persists a halt and is not cleared by a new run or retry',async kind=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];f.cfg.source_ids=['fixture'];f.response(()=>({status:kind==='forbidden'?403:200,headers:{'content-type':'text/html'},body:kind==='login'?discoveryAsset('login.html'):kind==='empty'?'<html></html>':'<main>challenge required</main>'}));
  const run=await discover(f);expect(f.runner.engine.run(run)?.state).toBe('halted');expect(rows(f,'engine_captures')[0]).toMatchObject({status:'restricted'});
  const count=f.calls.length;f.reopen();expect(await discover(f,'next')).toBe(run);expect(f.calls).toHaveLength(count);
  expect(()=>f.runner.engine.retryFailure(String(rows(f,'engine_failures')[0].id))).toThrow('failure_not_found');
 }finally{f.close();}
});
test('normal empty JSON results succeed; unconfirmed or denied providers send no requests',async()=>{
 const f=discoveryFixture();try{
  f.response(()=>({status:200,headers:{'content-type':'application/json'},body:'{"results":[]}'}));const r=await discover(f);expect(f.runner.engine.run(r)?.state).toBe('finished');expect(rows(f,'source_candidates')).toHaveLength(0);
  f.cfg.providers[0].terms.status='denied';await discover(f,'two');expect(f.calls).toHaveLength(1);
  f.cfg.providers[0].terms.status='unconfirmed';await discover(f,'three');expect(f.calls).toHaveLength(1);
 }finally{f.close();}
});
test('search redirect never forwards auth, secrets and unknown cursor/URL data do not enter DB, and repeated cursors terminate',async()=>{
 const f=discoveryFixture();try{
  vi.stubEnv('COLLECTOR_SEARCH_FIXTURE','synthetic_private_value');f.cfg.providers[0].auth_env='COLLECTOR_SEARCH_FIXTURE';
  f.response(()=>({status:302,headers:{'content-type':'application/json',location:'https://elsewhere.example.org/'},body:'{}'}));await discover(f);
  expect(f.calls).toHaveLength(1);expect(f.calls[0].headers.authorization).toBe('Bearer synthetic_private_value');expect(rows(f,'engine_failures')[0].reason).toBe('search_redirect');
  f.response(()=>({status:200,headers:{'content-type':'application/json'},body:JSON.stringify({results:[{url:'https://new-gear.example.org/item?product_no=A&token=synthetic_private_value',title:'token: synthetic_private_value',summary:'email fixture@example.org'}],next:'page2'})}));
  f.cfg.max_queries=4;f.profile.categories=f.profile.categories.slice(0,1);f.cfg.languages=['ko'];f.cfg.events=f.cfg.events.slice(0,1);f.advance(86400000);await discover(f,'two');expect(f.calls).toHaveLength(3);
  const data=['engine_runs','engine_captures','engine_checkpoints','engine_cache','engine_failures','source_candidates','source_candidate_evidence','source_discovery_queries'].map(t=>rows(f,t));
  expect(JSON.stringify(data)).not.toContain('synthetic_private_value');expect(JSON.stringify(data)).not.toContain('fixture@example.org');expect(JSON.stringify(data)).not.toContain('?q=');
 }finally{f.close();}
});
test('durable response checkpoint survives apply crash and reopening without another request',async()=>{
 const f=discoveryFixture();try{
  const id=f.runner.start({kind:'test',at:'one'});f.runner.seed(id);
  await f.runner.engine.step(id);await f.runner.engine.step(id); // plan, request
  expect(rows(f,'engine_captures')).toHaveLength(1);const fault=vi.fn(()=>{throw new Error('injected');});
  const crashed=new SourceDiscoveryRunner(f.store,f.cfg,{scheduler:f.scheduler(),profile:f.profile,fault});
  await expect(crashed.engine.step(id)).rejects.toThrow('engine_crash');f.advance(180001);f.reopen();await f.runner.run(f.runner.resume(id));
  expect(f.calls).toHaveLength(1);expect(rows(f,'source_candidates')).toHaveLength(2);
  expect(rows(f,'engine_cost_holds')).toHaveLength(0);
 }finally{f.close();}
});
test('external existing capture cache preserves product identifiers into candidates and detailed output',async()=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];
  const run=f.store.transaction(()=>{f.store.db.prepare("INSERT INTO engine_runs VALUES('collected','agamajung','test','one','finished','2026-10-23',NULL,'{}')").run();return 'collected';});
  const storage=new SqliteStorage(f.store),prepared=await collectedDerivative(f,discoveryAsset('list.html')),hash=prepared.hash;
  f.store.transaction(()=>{storage.capture({id:'collected-capture',run_id:run,source_id:'fixture',url_norm:'https://gear.example.org/list',fetched_at:'2026-10-23T01:00:00.000Z',status:'ok',content_type:'text/html',content_hash:hash,data:prepared.data});storage.cache(hash,'parse',prepared.parseTool,prepared.parsed);storage.cache(hash,'source-links',prepared.linkTool,prepared.links);});
  await discover(f);expect(f.calls).toHaveLength(0);
  const c=rows(f,'source_candidates').find(c=>String(c.canonical_url).includes('product_no=A'))!;expect(c).toBeTruthy();
  expect(JSON.stringify(new SourceCandidateStore(f.store,f.cfg).list(String(c.id)))).toContain('product_no=A');
 }finally{f.close();}
});

test('small candidate day cap commits a prefix, resumes from its cached capture next KST day, and replays no evidence',async()=>{
 const f=discoveryFixture();try{
  f.cfg.max_candidates_day=1;
  const id=await discover(f);expect(f.runner.engine.run(id)?.state).toBe('cost_wait');expect(rows(f,'source_candidates')).toHaveLength(1);expect(rows(f,'source_candidate_evidence')).toHaveLength(1);
  f.advance(86400000);f.reopen();await f.runner.run(f.runner.resume(id));expect(f.runner.engine.run(id)?.state).toBe('finished');expect(rows(f,'source_candidates')).toHaveLength(2);expect(rows(f,'source_candidate_evidence')).toHaveLength(2);expect(f.calls).toHaveLength(1);
 }finally{f.close();}
});
test('explicit source entities produce depth-one reverse queries without filling product facts',async()=>{
 const f=discoveryFixture();try{
  f.cfg.source_ids=['fixture'];f.cfg.max_queries=40;f.profile.categories=f.profile.categories.slice(0,1);f.cfg.languages=['ko'];f.cfg.events=f.cfg.events.slice(0,1);
  f.response(url=>({status:200,headers:{'content-type':url.hostname==='search.example.org'?'application/json':'text/html'},body:url.hostname==='search.example.org'?'{"results":[]}':discoveryAsset('entities.html')}));
  await discover(f);expect(rows(f,'source_discovery_queries').some(q=>q.query_text==='Example Line EX-100 2026 body KR Blue Example Shop KC 인증번호')).toBe(true);
  const reverse=rows(f,'engine_checkpoints').find(c=>c.stage==='request'&&JSON.parse(String(c.data)).query?.text==='Example Line EX-100 2026 body KR Blue Example Shop KC 인증번호');expect(JSON.parse(String(reverse!.data)).depth).toBe(1);
  expect(rows(f,'engine_extracted')).toHaveLength(0);expect(rows(f,'engine_labels')).toHaveLength(0);expect(rows(f,'collection_records')).toHaveLength(0);
 }finally{f.close();}
});
test('same collected link and locator fan out to known model conditions without merging years, configurations or markets',async()=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];
  f.store.transaction(()=>f.store.db.prepare("INSERT INTO engine_runs VALUES('collected','agamajung','test','one','finished','2026-10-23',NULL,'{}')").run());
  const storage=new SqliteStorage(f.store),prepared=await collectedDerivative(f,'<main><a href="https://new-gear.example.org/item?product_no=A">유모차 2026 신제품</a></main>'),hash=prepared.hash;
  f.store.transaction(()=>{
    storage.capture({id:'collected-capture',run_id:'collected',source_id:'fixture',url_norm:'https://gear.example.org/list',fetched_at:'2026-10-23T01:00:00.000Z',status:'ok',content_type:'text/html',content_hash:hash,data:prepared.data});
    storage.cache(hash,'parse',prepared.parseTool,prepared.parsed);storage.cache(hash,'source-links',prepared.linkTool,prepared.links);
    for(const [i,conditions] of [{release_year:'2025',bundle:'body',market:'KR'},{release_year:'2025',bundle:'set',market:'KR'},{release_year:'2026',bundle:'body',market:'KR'},{release_year:'2026',bundle:'body',market:'overseas'}].entries())storage.extracted({id:`fact-${i}`,capture_id:'collected-capture',subject_ref:'model-X',field:'model',conditions_key:JSON.stringify(conditions),claim_slot:0,source_url:'https://gear.example.org/list',locator:'link[0]',collected_at:'2026-10-23T01:00:00.000Z',effective_from:'2026-10-23T01:00:00.000Z',effective_from_basis:'observed',fact_status:'source_claim',extractor:'fixture@1',data:{assertion:{value:'EX-100'}}});
  });
  await discover(f);expect(rows(f,'source_candidates')).toHaveLength(1);expect(rows(f,'source_candidate_evidence')).toHaveLength(4);await discover(f,'two');expect(rows(f,'source_candidate_evidence')).toHaveLength(4);expect(rows(f,'source_candidates')[0].observation_count).toBe(1);
 }finally{f.close();}
});

test('legacy parse text without exact preparation and link identities cannot supply discovery evidence',async()=>{
 const f=discoveryFixture();try{
  f.cfg.max_queries=40;f.profile.categories=f.profile.categories.slice(0,1);f.cfg.languages=['ko'];f.cfg.events=f.cfg.events.slice(0,1);
  const {JobEngine}=await import('../crawler/engine/state-machine'),{noop}=await import('./helpers/engine'),{extractDocument}=await import('../crawler/src/discovery/document');
  const engine=new JobEngine(f.store,'agamajung',['fetch'],{fetch:noop()}),run=engine.startRun({kind:'test',at:'predecessor'}),hash='2'.repeat(64);
  const checkpoint=engine.enqueue(run,'fetch','root',{depth:0,capture_id:'predecessor-capture'});
  f.store.transaction(()=>{
    new SqliteStorage(f.store).capture({id:'predecessor-capture',run_id:run,source_id:'fixture',url_norm:'https://gear.example.org/list',fetched_at:'2026-10-23T01:00:00.000Z',status:'ok',content_hash:hash,data:{}});
    new SqliteStorage(f.store).cache(hash,'parse','legacy-parse:fixture:text',{text:extractDocument(discoveryAsset('entities.html'),'https://gear.example.org/list','links').text});
    f.store.db.prepare("UPDATE engine_checkpoints SET phase='done' WHERE id=?").run(checkpoint);f.store.db.prepare("UPDATE engine_runs SET state='finished' WHERE id=?").run(run);
  });
  await discover(f);expect(rows(f,'source_discovery_queries').some(q=>q.query_text==='Example Line EX-100 2026 body KR Blue Example Shop KC 인증번호')).toBe(false);
  expect(f.calls.every(c=>new URL(c.url).hostname==='search.example.org')).toBe(true);expect(rows(f,'engine_extracted')).toHaveLength(0);
 }finally{f.close();}
});

test.each([1,2])('approved list page limit %d stops before another request and reports an incomplete traversal',async max=>{
 const f=discoveryFixture();try{
  f.cfg.providers=[];f.cfg.source_ids=['fixture'];f.cfg.max_pages=max;
  f.response(()=>({status:200,headers:{'content-type':'text/html'},body:'<main><h1>유모차 신제품 2026</h1><a href="/a">유모차 신제품 2026</a><a rel="next" href="/b">유모차 신제품 2026</a></main>'}));
  await discover(f);
  expect(f.calls).toHaveLength(max+1);expect(rows(f,'source_discovery_paths').some(p=>p.deferred_reason==='page_limit')).toBe(true);
  expect(rows(f,'engine_checkpoints').some(c=>c.stage==='apply'&&JSON.parse(String(c.data)).stopped_reason==='page_limit'&&JSON.parse(String(c.data)).truncated)).toBe(true);
 }finally{f.close();}
});
