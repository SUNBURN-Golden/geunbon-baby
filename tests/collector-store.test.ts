import { expect, test } from 'vitest';
import { statSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CollectorStore, type Group, type Evidence } from '../crawler/src/store';
import { aggregateCollectionStatus } from '../shared/collection-status';
import { fixture, binding, price, intake, expected, ready, source } from './helpers/collector';
import type { CollectionRecord } from '../shared/collection-schema';

test('all five counts are real, approvals are explicit, nonrepresentatives retain their evidence',()=>{
 const f=fixture();try{
  f.store.discover('https://blog.example.org/clue');
  const a=intake(f.store,`${source.origin}/a`,price());
  intake(f.store,`${source.origin}/b`,price());
  const g=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  expect(f.store.report().counts).toMatchObject({discovered:1,source_check_needed:1,dedup_excluded:1,verified_waiting:0,ready_to_publish:0});
  f.store.review(g,{...expected(f.store,g),decision:'verify',reviewer:'test'});
  expect(f.store.report().counts.verified_waiting).toBe(1);
  f.store.review(g,{...expected(f.store,g),decision:'ready',reviewer:'test'});
  expect(f.store.report().counts.ready_to_publish).toBe(1);
  expect(f.store.scope(g).evidence).toHaveLength(2);
  const r=f.reopen().report();expect(r.total).toBe(3);expect(r.unique).toBe(2);
  expect(aggregateCollectionStatus(f.store.list('collection_records'))).toMatchObject({counts:r.counts,total:r.total,groups:r.groups});
 }finally{f.close();}
});

test.each(['price','recall'])('nonrepresentative new %s invalidates the whole ready group atomically and rejects stale review',kind=>{
 const f=fixture();try{
  const a=intake(f.store,`${source.origin}/a`,price());intake(f.store,`${source.origin}/b`,price());
  const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;ready(f.store,group);const stale=expected(f.store,group);
  intake(f.store,`${source.origin}/b`,kind==='price'?price(999000):{target_model_id:'model-1',assertions:[{field:'recalls',value:{id:'recall-fixture'},quote:'리콜 공지',locator:'#recall'}]});
  const scope=f.store.scope(group);expect(scope.group.evidence_version).toBeGreaterThan(stale.expected_evidence_version);expect(scope.group.verified_evidence_version).toBeNull();expect(scope.group.ready_evidence_version).toBeNull();
  expect(scope.members.find(r=>r.id===a.record_id)?.verification_status).toBe('source_check_needed');expect(scope.members.filter(r=>r.verification_status==='dedup_excluded')).toHaveLength(1);
  expect(scope.conflicts.length>0).toBe(kind==='price');expect(scope.evidence).toHaveLength(3);
  expect(()=>f.store.review(group,{...stale,decision:'ready',reviewer:'test'})).toThrow('stale_review');
  expect(f.reopen().report().counts.ready_to_publish).toBe(0);
 }finally{f.close();}
});

test('idempotent receipt survives lost ACK and does not grow rows, seller hits, version, budgets, or outbox',()=>{
 const f=fixture();try{
  const b=binding(),r=f.store.reserve('fixture-client',b);f.store.start('fixture-client',r.id);const p={...price(),seller_handle:'public_shop'};
  const ack=f.store.submit('fixture-client',r.id,p),before={report:f.store.report(),budgets:f.store.list('daily_budgets'),outbox:f.store.list('sync_outbox')};
  f.reopen();expect(f.store.submit('fixture-client',r.id,p)).toEqual(ack);expect(f.store.report()).toEqual(before.report);expect(f.store.list('daily_budgets')).toEqual(before.budgets);expect(f.store.list('sync_outbox')).toEqual(before.outbox);
  expect(f.store.list<{hits:number}>('seller_candidates')[0].hits).toBe(1);expect(f.store.list('evidence_assertions')).toHaveLength(1);
  expect(()=>f.store.submit('fixture-client',r.id,price(42))).toThrow('payload_changed');
  expect(()=>f.store.reserve('fixture-client',{...b,url:`${source.origin}/changed`})).toThrow('binding_changed');
 }finally{f.close();}
});

test.each(['reservation','start','evidence','intake','before_commit'])('a failure at %s rolls back the actual file transaction',point=>{
 const f=fixture();let store=f.store;try{
  const b=binding();const r=store.reserve('fixture-client',b);store.start('fixture-client',r.id);const baseline={records:store.list('collection_records'),budgets:store.list('daily_budgets'),outbox:store.list('sync_outbox')};
  store.close();let armed=false;store=new CollectorStore(f.file,f.settings,()=>Date.parse('2026-10-23T01:00:00Z'),p=>{if(armed&&p===point){armed=false;throw new Error('injected');}});armed=true;
  if(point==='reservation')expect(()=>store.reserve('fixture-client',binding(`${source.origin}/new`))).toThrow('injected');
  else if(point==='start'){const next=store.reserve('fixture-client',binding(`${source.origin}/held`));const held=store.list('daily_budgets');expect(()=>store.start('fixture-client',next.id)).toThrow('injected');expect(store.list('daily_budgets')).toEqual(held);}
  else expect(()=>store.submit('fixture-client',r.id,{...price(),seller_handle:'test_shop'})).toThrow('injected');
  expect(store.list('evidence_assertions')).toHaveLength(0);expect(store.list('intake_receipts')).toHaveLength(0);expect(store.list('seller_candidates')).toHaveLength(0);
  if(point!=='start'){expect(store.list('daily_budgets')).toEqual(baseline.budgets);expect(store.list('collection_records')).toEqual(baseline.records);expect(store.list('sync_outbox')).toEqual(baseline.outbox);}
 }finally{store.close(); // fixture handle was already closed above
  remove(f.dir,{recursive:true,force:true});
 }
});
import { rmSync as remove } from 'node:fs';

test('KST midnight expires only held reservations; spent attempts never refund; new attempts share durable caps',()=>{
 const f=fixture({...fixtureSettings(),limits:{...fixtureSettings().limits,new_body:2}});try{
  const b=binding(),r=f.store.reserve('fixture-client',b);expect(f.store.reserve('fixture-client',b).id).toBe(r.id);
  const second=f.store.reserve('fixture-client',binding(`${source.origin}/second`));f.store.start('fixture-client',second.id);
  expect(()=>f.store.reserve('fixture-client',binding(`${source.origin}/third`))).toThrow('daily_limit');
  f.advance(600001);expect(f.store.start.bind(f.store,'fixture-client',r.id)).toThrow('reservation_expired');
  expect(f.store.start('fixture-client',second.id).phase).toBe('started');
  f.advance(86400000);f.reopen();expect(f.store.reserve('fixture-client',binding(`${source.origin}/tomorrow`)).phase).toBe('held');
  expect(()=>f.store.reserve('fixture-client',{...binding('https://blog.example.org/unseen'),operation:'recheck'})).toThrow('invalid_recheck');
 }finally{f.close();}
});
import { config } from '../crawler/src/source-policy';
function fixtureSettings(){return {...config,sources:[source]};}

test('permissions, corruption and exclusive lock fail closed; open WAL and SHM are private',()=>{
 const f=fixture();try{
  expect(()=>new CollectorStore(f.file,f.settings)).toThrow();
  for(const suffix of ['','-wal','-shm'])expect(statSync(f.file+suffix).mode&0o777).toBe(0o600);
  f.reopen();expect(statSync(f.dir).mode&0o777).toBe(0o700);
  const bad=f.file+'.bad';writeFileSync(bad,'not SQLite',{mode:0o600});expect(()=>new CollectorStore(bad,f.settings)).toThrow();expect(readFileSync(bad,'utf8')).toBe('not SQLite');
  chmodSync(bad,0o644);expect(()=>new CollectorStore(bad,f.settings)).toThrow('unsafe_file');
 }finally{f.close();}
});

test.each([false,true])('process termination leaves %s committed state and no partial SQL writes',commit=>{
 const f=fixture();const file=f.file,dir=f.dir;f.store.close();try{
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import { CollectorStore } from './crawler/src/store.ts';
    const store=new CollectorStore(process.env.COLLECTOR_TEST_DB);
    store.db.exec('BEGIN IMMEDIATE');store.put('collector_meta','crash_marker',{safe:true});
    ${commit?"store.db.exec('COMMIT');":''}
    process.kill(process.pid,'SIGKILL');
  `],{cwd:process.cwd(),env:{...process.env,COLLECTOR_TEST_DB:file},encoding:'utf8',timeout:10000});
  expect(result.signal).toBe('SIGKILL');unlinkSync(file+'.lock');
  const restored=new CollectorStore(file);try{expect(!!restored.get('collector_meta','crash_marker')).toBe(commit);}finally{restored.close();}
 }finally{remove(dir,{recursive:true,force:true});}
});

test('merge, split, replacement and linked withdrawal never copy review approvals',()=>{
 const f=fixture();try{
  const a=intake(f.store,`${source.origin}/a`,price()),b=intake(f.store,`${source.origin}/b`,price());const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  ready(f.store,group);f.store.changeGroup(group,'representative',{record_id:b.record_id},expected(f.store,group));expect(f.store.scope(group).group.ready_evidence_version).toBeNull();
  ready(f.store,group);f.store.changeGroup(group,'split',{record_id:b.record_id},expected(f.store,group));const other=f.store.get<CollectionRecord>('collection_records',b.record_id)!.dedup_group_id;expect(other).not.toBe(group);
  f.store.changeGroup(group,'merge',{other_group:other,other_expected:expected(f.store,other)},expected(f.store,group));expect(f.store.get<Group>('dedup_groups',other)?.retired).toBe(true);
  ready(f.store,group);const assertion=f.store.list<Evidence>('evidence_assertions')[0];f.store.changeGroup(group,'withdraw',{assertion_id:assertion.id},expected(f.store,group));expect(f.store.scope(group).group.ready_evidence_version).toBeNull();
 }finally{f.close();}
});

test('rechecks supersede their own observations while retaining history and cross-page disagreement',()=>{
 const f=fixture();try{
  const a=intake(f.store,`${source.origin}/a`,price(390000));const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  intake(f.store,`${source.origin}/a`,price(400000));
  expect(f.store.scope(group).evidence).toHaveLength(2);expect(f.store.scope(group).evidence.filter(e=>e.superseded_by)).toHaveLength(1);
  expect(f.store.scope(group).conflicts).toHaveLength(0);ready(f.store,group);
  intake(f.store,`${source.origin}/b`,price(390000));expect(f.store.scope(group).conflicts).toHaveLength(1);
  intake(f.store,`${source.origin}/b`,price(400000));expect(f.store.scope(group).conflicts).toHaveLength(0);
  expect(f.store.report().unresolved_conflicts).toBe(0);ready(f.store,group);
 }finally{f.close();}
});

test('price representations normalize and separate sellers keep independent offer conditions',()=>{
 const f=fixture();try{
  const payload=(value:unknown,seller?:string)=>({target_model_id:'model-1',seller_handle:seller,assertions:[{field:'clue_price' as const,value,quote:'가격 근거',locator:'main'},{field:'group_buy_terms' as const,value:seller??'same offer',quote:'조건 근거',locator:'main'}]});
  const a=intake(f.store,`${source.origin}/a`,payload(390000));const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  intake(f.store,`${source.origin}/b`,payload('390,000원'));expect(f.store.scope(group).conflicts).toHaveLength(0);
  intake(f.store,`${source.origin}/seller-a`,payload(400000,'seller_a'));intake(f.store,`${source.origin}/seller-b`,payload(500000,'seller_b'));
  expect(f.store.scope(group).conflicts).toHaveLength(0);
  intake(f.store,`${source.origin}/seller-a-copy`,payload(410000,'seller_a'));expect(f.store.scope(group).conflicts).toHaveLength(1);
 }finally{f.close();}
});

test('site-root document identity cannot merge unrelated pages',()=>{
 const f=fixture();try{
  intake(f.store,`${source.origin}/one`,{document_origin:`${source.origin}/`,assertions:[]});
  intake(f.store,`${source.origin}/two`,{document_origin:`${source.origin}/`,assertions:[]});
  expect(f.store.report()).toMatchObject({total:2,groups:2,unique:2});
 }finally{f.close();}
});

test('indexed hot paths do not deserialize unrelated record, evidence, group, or link tables',()=>{
 const f=fixture();try{
  for(let i=0;i<15;i++)f.store.discover(`${source.origin}/unrelated-${i}`);
  const list=f.store.list.bind(f.store);
  f.store.list=((table:Parameters<typeof list>[0])=>{if(['collection_records','evidence_assertions','group_evidence_links','dedup_groups'].includes(table))throw new Error('full_scan');return list(table);}) as typeof f.store.list;
  const a=intake(f.store,`${source.origin}/new`,price());const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  expect(f.store.recordByUrl(`${source.origin}/new`)?.id).toBe(a.record_id);ready(f.store,group);f.advance(86400001);expect(f.store.report().counts.ready_to_publish).toBe(0);
 }finally{f.close();}
});

test('index migration backfills document keys without changing records or review history',()=>{
 const f=fixture();try{
  const a=intake(f.store,`${source.origin}/original`,price());const group=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  ready(f.store,group);const baseline=f.store.report();
  f.store.db.exec('DROP TABLE dedup_keys; PRAGMA user_version=1;');f.reopen();expect(f.store.report()).toEqual(baseline);
  intake(f.store,`${source.origin}/translation`,{document_origin:`${source.origin}/original`,assertions:[]});
  expect(f.store.report().groups).toBe(1);expect(f.store.scope(group).group.ready_evidence_version).toBeNull();
 }finally{f.close();}
});
