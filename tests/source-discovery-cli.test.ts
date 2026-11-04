import { expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as collectorDefaults } from '../crawler/src/source-policy';
import { main } from '../crawler/src/local-worker';
import { discoveryAsset, discoveryFixture, discover, rows } from './helpers/source-discovery';
import { AgamajungPipeline } from '../crawler/src/agamajung/pipeline';
import { asset } from './helpers/engine';
import { SourceDiscoveryRunner } from '../crawler/src/source-discovery/runner';
function environment(f:ReturnType<typeof discoveryFixture>){
 const config=join(f.dir,'config.json'),discovery=join(f.dir,'discovery.json');writeFileSync(config,JSON.stringify({...f.settings,sources:[...f.settings.sources,...collectorDefaults.sources.filter(s=>!f.settings.sources.some(x=>x.id===s.id))]}),{mode:0o600});writeFileSync(discovery,JSON.stringify(f.cfg),{mode:0o600});
 vi.stubEnv('COLLECTOR_DB',f.file);vi.stubEnv('COLLECTOR_RAW_DIR',f.raw.root);vi.stubEnv('COLLECTOR_CONFIG',config);vi.stubEnv('COLLECTOR_DISCOVERY_CONFIG',discovery);return {config,discovery};
}
test('offline dry-run spends nothing, recovers no orphan holds, inserts no candidates or runs, and shares the crawl lock',async()=>{
 const f=discoveryFixture(),argv=process.argv;try{
  const id=f.runner.start({kind:'test',at:'hold'});f.runner.ledger.hold(10);const before=rows(f,'engine_costs');environment(f);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});process.argv=['node','local-worker.ts','discover-sources','--dry-run'];await main();
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({dry_run:true,max_depth:2,shared_owner:'agamajung'});expect(rows(f,'source_candidates')).toHaveLength(0);expect(rows(f,'engine_runs')).toHaveLength(1);expect(rows(f,'engine_costs')).toEqual(before);expect(rows(f,'engine_cost_holds')).toHaveLength(1);
  const skipped=vi.spyOn(console,'error').mockImplementation(()=>{}),run=vi.spyOn(SourceDiscoveryRunner.prototype,'run'),preview=vi.spyOn(SourceDiscoveryRunner.prototype,'preview'),calls=log.mock.calls.length;
  f.store.runLock('crawl');await expect(main()).resolves.toBeUndefined();expect(f.runner.engine.run(id)).toBeTruthy();
  expect(skipped.mock.calls).toHaveLength(2);expect(skipped.mock.calls[0][0]).toMatch(/^collector_start at=.+\+09:00 job=discover-sources /);expect(skipped.mock.calls[1][0]).toMatch(/^collector_end .+ outcome=skipped reason=run_locked$/);
  expect(log.mock.calls).toHaveLength(calls);expect(run).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();
 }finally{process.argv=argv;f.close();}
});
test('real collect extraction → sanitized link cache → discovery → DB → CLI preserves product identity',async()=>{
 const f=discoveryFixture(),argv=process.argv;try{
  f.cfg.providers=[];f.response(()=>({status:200,headers:{'content-type':'text/html'},body:asset('spec.html').replace('</main>',discoveryAsset('list.html')+'</main>')}));
  const pipeline=new AgamajungPipeline(f.store,f.raw,f.profile,{scheduler:f.scheduler(),discoveryConfig:f.cfg});
  const collect=pipeline.start({kind:'test',at:'collect'});pipeline.seed(collect);await pipeline.run(collect);const calls=f.calls.length;
  expect(rows(f,'engine_cache').some(r=>r.stage==='source-links'&&String(r.data).includes('product_no=A'))).toBe(true);
  const before=['collection_records','dedup_groups','sync_outbox','engine_extracted','engine_labels'].map(t=>rows(f,t));await discover(f);
  expect(f.calls).toHaveLength(calls);expect(['collection_records','dedup_groups','sync_outbox','engine_extracted','engine_labels'].map(t=>rows(f,t))).toEqual(before);
  const candidate=rows(f,'source_candidates').find(c=>String(c.canonical_url).includes('product_no=A'))!;expect(candidate).toBeTruthy();environment(f);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});process.argv=['node','local-worker.ts','source-candidates','--id',String(candidate.id)];await main();
  expect(JSON.parse(log.mock.calls.at(-1)![0])[0]).toMatchObject({canonical_url:'https://new-gear.example.org/item?product_no=A',status:'discovered'});
 }finally{process.argv=argv;f.close();}
});
test('failure retry CLI routes discovery failures to its runner and preserves lineage',async()=>{
 const f=discoveryFixture(),argv=process.argv;try{
  f.response(()=>({status:200,headers:{'content-type':'application/json'},body:'{"wrong":[]}'}));const original=await discover(f),failure=rows(f,'engine_failures')[0];environment(f);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});process.argv=['node','local-worker.ts','failures','retry',String(failure.id)];await main();
  const manual=String(JSON.parse(log.mock.calls.at(-1)![0]).run_id),run=f.runner.engine.run(manual)!;expect(run.profile_id).toBe('agamajung-source-discovery');expect(JSON.parse(run.data).parent_run).toBe(original);
  f.cfg.enabled=false;const offline=new SourceDiscoveryRunner(f.store,f.cfg,{offline:true,profile:f.profile});expect(offline.preview().enabled).toBe(false);
 }finally{process.argv=argv;f.close();}
});

test('collect requests a fresh body when product URL policy changes regardless of historical response files',async()=>{
 const f=discoveryFixture();try{
  f.response(()=>({status:200,headers:{'content-type':'text/html',etag:'"fixture"'},body:asset('spec.html').replace('</main>',discoveryAsset('list.html')+'</main>')}));
  const old=structuredClone(f.cfg);old.url_policies=[];
  const first=new AgamajungPipeline(f.store,f.raw,f.profile,{scheduler:f.scheduler(),discoveryConfig:old});let id=first.start({kind:'test',at:'first'});first.seed(id);await first.run(id);
  const second=new AgamajungPipeline(f.store,f.raw,f.profile,{scheduler:f.scheduler(),discoveryConfig:f.cfg});id=second.start({kind:'test',at:'second'});second.seed(id);await second.run(id);
  expect(f.calls.filter(c=>new URL(c.url).pathname==='/list').at(-1)?.headers).toEqual({});
  const {linkCacheTool}=await import('../crawler/src/source-discovery/config');
  const cache=rows(f,'engine_cache').find(c=>c.stage==='source-links'&&String(c.tool).startsWith(linkCacheTool(f.cfg,'https://gear.example.org/list','fixture')+':'+second.parseVersion));
  expect(String(cache?.data)).toContain('product_no=A');
  await discover(f);expect(rows(f,'source_candidates').some(c=>String(c.canonical_url).includes('product_no=A'))).toBe(true);
 }finally{f.close();}
});
