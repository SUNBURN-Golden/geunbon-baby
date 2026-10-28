import { expect, test } from 'vitest';
import { discoveryFixture, rows } from './helpers/source-discovery';
import { SourceCandidateStore, type CandidateObservation } from '../crawler/src/source-discovery/store';
import { candidateUrl } from '../crawler/src/source-discovery/url-policy';
import { JobEngine } from '../crawler/engine/state-machine';
import { SqliteStorage } from '../crawler/engine/storage';
import { noop } from './helpers/engine';
function setup(){
 const f=discoveryFixture(),engine=new JobEngine(f.store,'fixture',['a'],{a:noop()}),run=engine.startRun({kind:'test',at:'one'});
 f.store.transaction(()=>new SqliteStorage(f.store).capture({id:'fixture-capture',run_id:run,source_id:'fixture',url_norm:'https://gear.example.org/catalog',fetched_at:'2026-10-23T01:00:00.000Z',status:'ok',data:{}}));
 return f;
}
function observation(f:ReturnType<typeof discoveryFixture>,conditions:Record<string,string>,subject='model-X',quote='명시적 행사'):CandidateObservation {
 return {destination:candidateUrl('https://new-gear.example.org/item?product_no=A',f.cfg.url_policies),score:60,evidence:{capture_id:'fixture-capture',source_url:'https://gear.example.org/catalog',collected_at:'2026-10-23T01:00:00.000Z',locator:'main a[0]',relation:'link',subject_ref:subject,conditions,quote,depth:1,fact_status:'source_claim',extractor_version:'fixture@1'}};
}
test('one URL retains different subjects, years, body/set, markets and conflicting claims; replay and ordering are idempotent',()=>{
 const f=setup();try{
  const s=new SourceCandidateStore(f.store,f.cfg),input=[observation(f,{release_year:'2025',bundle:'body',market:'KR'}),observation(f,{market:'KR',bundle:'set',release_year:'2025'}),observation(f,{market:'KR',bundle:'body',release_year:'2026'}),observation(f,{market:'overseas',bundle:'body',release_year:'2026'}),observation(f,{market:'KR',bundle:'body',release_year:'2026'},'model-Y'),observation(f,{market:'KR',bundle:'body',release_year:'2026'},'model-X','상충 행사')];
  f.store.transaction(()=>s.recordInside([...input,input[0]]));expect(rows(f,'source_candidates')).toHaveLength(1);expect(rows(f,'source_candidate_evidence')).toHaveLength(6);
  const before=rows(f,'source_candidate_evidence');f.advance(1000);
  f.store.transaction(()=>s.recordInside(input.slice().reverse().map(o=>({...o,evidence:{...o.evidence,conditions:Object.fromEntries(Object.entries(o.evidence.conditions).reverse().map(([k,v])=>[k,` ${v} `]))}}))));
  expect(rows(f,'source_candidate_evidence')).toEqual(before);expect(rows(f,'source_candidates')[0]).toMatchObject({observation_count:1,first_seen:'2026-10-23T01:00:00.000Z',last_seen:'2026-10-23T01:00:00.000Z'});
  expect(()=>f.store.transaction(()=>s.recordInside([observation(f,{release_year:'2025',bundle:'body',market:'KR'},'model-X','changed claim')]))).toThrow('immutable_id_conflict');
  expect(()=>f.store.db.prepare("UPDATE source_candidate_evidence SET locator='changed'").run()).toThrow('immutable_id_conflict');
  expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{f.close();}
});
test('identity loss never merges by display URL; new-candidate cap is atomic and replay consumes no new slots',()=>{
 const f=setup();try{
  f.cfg.max_candidates_day=1;const s=new SourceCandidateStore(f.store,f.cfg),a=observation(f,{});
  f.store.transaction(()=>s.recordInside([a]));f.store.transaction(()=>s.recordInside([a]));expect(rows(f,'source_candidates')).toHaveLength(1);
  const lost={...a,destination:candidateUrl('https://new-gear.example.org/item?unknown=fixture',f.cfg.url_policies)};
  expect(()=>f.store.transaction(()=>s.recordInside([lost]))).toThrow('cost_day');expect(rows(f,'source_candidate_evidence')).toHaveLength(1);
  f.cfg.max_candidates_day=3;f.store.transaction(()=>s.recordInside([lost,{...lost,evidence:{...lost.evidence,locator:'main a[1]'}}]));
  expect(rows(f,'source_candidates')).toHaveLength(3);expect(rows(f,'source_candidates').filter(r=>r.canonical_url===null)).toHaveLength(2);
 }finally{f.close();}
});

test('stored URL policy remains valid on lookup after configuration changes; duplicate claims retain every path',()=>{
 const f=setup();try{
  const s=new SourceCandidateStore(f.store,f.cfg),a=observation(f,{});
  f.store.transaction(()=>s.recordInside([a,{...a,evidence:{...a.evidence,depth:2}}]));expect(rows(f,'source_candidate_evidence')).toHaveLength(1);expect(rows(f,'source_discovery_paths')).toHaveLength(2);
  f.cfg.url_policies=[];expect(new SourceCandidateStore(f.store,f.cfg).list()[0].canonical_url).toBe('https://new-gear.example.org/item?product_no=A');
 }finally{f.close();}
});

test('capture provenance and candidate ancestry persist independently when a claim is replayed on multiple paths',()=>{
 const f=setup();try{
  const s=new SourceCandidateStore(f.store,f.cfg),a=observation(f,{});
  const parent={...a,destination:candidateUrl('https://new-gear.example.org/item?product_no=P',f.cfg.url_policies)};
  const [parentId]=f.store.transaction(()=>s.recordInside([parent]));
  const run=rows(f,'engine_runs')[0];
  f.store.transaction(()=>new SqliteStorage(f.store).capture({id:'origin-b',run_id:run.id,source_id:'fixture',url_norm:'https://gear.example.org/b',fetched_at:'2026-10-23T01:00:00.000Z',status:'ok',data:{}}));
  const paths=['fixture-capture','origin-b'].map(origin_capture=>({...a,evidence:{...a.evidence,parent_id:parentId,origin_capture}}));
  f.store.transaction(()=>s.recordInside(paths));
  const before=rows(f,'source_discovery_paths');
  f.store.transaction(()=>s.recordInside(paths.slice().reverse()));
  expect(rows(f,'source_discovery_paths')).toEqual(before);
  const [child]=s.list(s.candidateId(a.destination,a.evidence));
  expect(child.evidence).toHaveLength(1);
  expect(child.evidence![0].paths).toEqual(expect.arrayContaining([
   expect.objectContaining({parent_id:parentId,origin_capture:'fixture-capture'}),
   expect.objectContaining({parent_id:parentId,origin_capture:'origin-b'})
  ]));
  expect(child.evidence![0].paths).toHaveLength(2);
  expect(()=>f.store.transaction(()=>s.recordInside([{...a,evidence:{...a.evidence,origin_capture:'absent-capture'}}]))).toThrow('candidate_provenance_invalid');
  expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{f.close();}
});
