import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { engineFixture } from './helpers/engine';
import { provider, productPolicies } from './helpers/source-discovery';
import { MissingFieldRunner } from '../crawler/src/missing-field/runner';
import { SourceDiscoveryRunner } from '../crawler/src/source-discovery/runner';
import { loadDiscoveryConfig } from '../crawler/src/source-discovery/config';
import { Scheduler } from '../crawler/src/scheduler';

const page=readFileSync(new URL('./fixtures/missing-field/not-in-source.html',import.meta.url),'utf8');
async function collect(f:ReturnType<typeof engineFixture>,at:string){const run=f.pipeline.start({kind:'test',at});f.pipeline.seed(run);await f.pipeline.run(run);}

test.each([false,true])('reverse requests reach existing discovery with provenance; intervening collection=%s rejects stale work',async changed=>{
 const f=engineFixture(page);try{
  await collect(f,'empty');
  const cfg=loadDiscoveryConfig();cfg.enabled=true;cfg.providers=[structuredClone(provider)];cfg.url_policies=productPolicies();cfg.source_ids=[];cfg.max_queries=20;
  const explorer=new MissingFieldRunner(f.store,{discovery:cfg}),run=explorer.start();await explorer.run(run);
  const actions=explorer.storage.actions().filter(a=>a.links.some(l=>l.kind==='source_query'));
  expect(actions.length).toBeGreaterThan(0);
  const queryIds=actions.flatMap(a=>a.links.filter(l=>l.kind==='source_query').map(l=>l.ref));
  if(changed){f.advance(1000);f.response(()=>({status:200,headers:{'content-type':'text/html'},body:page.replace('</main>','<p>배송비: 무료</p></main>')}));await collect(f,'updated');}
  const before=f.store.db.prepare('SELECT * FROM extracted_assertion_links ORDER BY extracted_id').all();
  const requests:string[]=[];
  const scheduler=new Scheduler(f.store,async url=>{requests.push(url.href);return {status:200,headers:{'content-type':'application/json'},body:'{"results":[{"url":"https://new-gear.example.org/item?product_no=A","title":"유모차 신제품 2026","summary":"Example stroller example_only"}]}'};},async ms=>f.advance(ms));
  const discovery=new SourceDiscoveryRunner(f.store,f.raw,cfg,{scheduler,profile:f.profile}),discoveryRun=discovery.start({kind:'test',at:'reverse'});
  discovery.seed(discoveryRun);
  const linked=f.store.db.prepare("SELECT data FROM missing_field_action_links WHERE kind='discovery_run'").all();
  if(changed){expect(linked).toEqual([]);}else{
    expect(linked.length).toBeGreaterThan(0);
    const work=f.store.db.prepare("SELECT data FROM engine_checkpoints WHERE run_id=? AND stage='request'").all(discoveryRun).map(r=>JSON.parse(String(r.data)));
    expect(work.some(w=>queryIds.includes(w.query?.id)&&w.depth===1)).toBe(true);
    await discovery.run(discoveryRun);expect(requests.length).toBeGreaterThan(0);
    const reverseResults=f.store.db.prepare("SELECT e.capture_id,p.query_id,p.parent_id,p.data FROM source_candidate_evidence e JOIN source_discovery_paths p ON p.evidence_id=e.id").all().filter(p=>queryIds.includes(String(p.query_id)));
    expect(new Set(reverseResults.map(p=>p.query_id)).size).toBe(queryIds.length);
    const origin=f.store.db.prepare("SELECT id FROM engine_captures WHERE source_id=?").get(f.source.id)!.id;
    for(const result of reverseResults){
      expect(result.parent_id).toBeNull();
      expect(JSON.parse(String(result.data)).origin_capture).toBe(origin);
      expect(result.capture_id).not.toBe(origin);
    }
    expect(f.store.db.prepare("SELECT error_code FROM engine_checkpoints WHERE run_id=? AND phase='failed'").all(discoveryRun)).toEqual([]);
    expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.store.db.prepare('SELECT id FROM source_candidates').all().length).toBeGreaterThan(0);
    expect(explorer.currentMetrics(run).evidence.numerator).toBe(0);
    expect(f.store.db.prepare('SELECT * FROM extracted_assertion_links ORDER BY extracted_id').all()).toEqual(before);
  }
 }finally{f.close();}
});

test('reverse queries retain explicitly named option and seller when slots omit them or contain an empty seller',async()=>{
 const f=engineFixture(page.replace('</main>','<p>옵션: Blue</p><p>판매처: Example Shop</p></main>'));try{
  await collect(f,'conditions');
  const cfg=loadDiscoveryConfig();cfg.enabled=true;cfg.providers=[structuredClone(provider)];
  const explorer=new MissingFieldRunner(f.store,{discovery:cfg}),run=explorer.start();await explorer.run(run);
  const queries=f.store.db.prepare('SELECT data FROM source_discovery_queries').all().map(q=>JSON.parse(String(q.data)));
  expect(queries).toHaveLength(7);
  for(const q of queries){
    expect(q.text).toContain('Blue');expect(q.text).toContain('Example Shop');
    expect(q.conditions).toMatchObject({option:'Blue',seller:'Example Shop'});
  }
  const offers=explorer.storage.current().filter(s=>s.slot.kind==='offer');
  expect(offers.every(s=>s.slot.conditions.seller==='')).toBe(true);
  expect(explorer.currentMetrics(run).evidence.numerator).toBe(0);
 }finally{f.close();}
});
