import { expect, test } from 'vitest';
import { fixture, binding, source, price, intake, expected, ready } from './helpers/collector';
import type { CollectionRecord } from '../shared/collection-schema';
import { syncStatus } from '../crawler/src/status-sync';
import type { Snapshot } from '../shared/collection-schema';
test('500th discovery and 200th body attempt succeed; 501/201 fail including after restart',()=>{
 const f=fixture();try{
  for(let n=0;n<500;n++)f.store.discover(`${source.origin}/candidate-${n}`);
  expect(()=>f.store.discover(`${source.origin}/overflow`)).toThrow('daily_limit');
  // Attempts against existing candidates do not consume more discovery quota.
  for(let n=0;n<200;n++){const r=f.store.reserve('fixture',binding(`${source.origin}/candidate-${n}`));f.store.start('fixture',r.id);}
  f.reopen();expect(()=>f.store.reserve('fixture',binding(`${source.origin}/candidate-400`))).toThrow('daily_limit');expect(f.store.report().total).toBe(500);
 }finally{f.close();}
},20000);
test('unknown-brand budgets are shared across hosts and rechecks use their own cap',()=>{
 const f=fixture({...fixtureConfig(),limits:{...fixtureConfig().limits,discovered:2,new_body:1,recheck:1}});try{
  intake(f.store,'https://blog.example.org/a',price());expect(()=>f.store.reserve('fixture',binding('https://press.example.org/b'))).toThrow('daily_limit');
  const r=f.store.reserve('fixture',{...binding('https://blog.example.org/a'),operation:'recheck'});f.store.start('fixture',r.id);f.store.submit('fixture',r.id,price());
  expect(()=>f.store.reserve('fixture',{...binding('https://blog.example.org/a'),operation:'recheck'})).toThrow('daily_limit');expect(f.store.report().total).toBe(1);
 }finally{f.close();}
});
import { config } from '../crawler/src/source-policy';
function fixtureConfig(){return {...config,sources:[source]};}
test('review before mutation and mutation before review both leave only current evidence eligible',()=>{
 const f=fixture();try{
  const a=intake(f.store,source.origin+'/a',price());const id=f.store.get<CollectionRecord>('collection_records',a.record_id)!.dedup_group_id;
  const stale=expected(f.store,id);f.store.review(id,{...stale,decision:'verify',reviewer:'test'});intake(f.store,source.origin+'/a',price());expect(f.store.scope(id).group.verified_evidence_version).toBeNull();
  expect(()=>f.store.review(id,{...stale,decision:'verify',reviewer:'test'})).toThrow('stale_review');ready(f.store,id);f.advance(86400001);expect(f.store.report().counts.ready_to_publish).toBe(0);expect(f.store.report().recheck_due).toBe(1);
 }finally{f.close();}
});
test('outbox survives a site commit with lost response and reuses exactly the same version/payload',async()=>{
 const f=fixture();try{
  f.store.report();const seen:Snapshot[]=[];const send:typeof fetch=async(_url,init)=>{seen.push(JSON.parse(String(init?.body)));if(seen.length===1)throw new Error('ack_lost');const s=seen[seen.length-1];return Response.json({data:{worker_id:s.worker_id,version:s.version}});};
  await expect(syncStatus(f.store,'https://site.example.org','fixture-status-token-long-enough',send)).rejects.toMatchObject({code:'sync_transport'});expect(f.store.list('sync_outbox')).toHaveLength(1);f.reopen();await syncStatus(f.store,'https://site.example.org','fixture-status-token-long-enough',send);expect(seen[1]).toEqual(seen[0]);expect(f.store.list('sync_outbox')).toHaveLength(0);
 }finally{f.close();}
});
