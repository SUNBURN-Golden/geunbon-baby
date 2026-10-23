import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture, source } from './helpers/collector';
import { Scheduler } from '../crawler/src/scheduler';
import { DiscoveryRunner } from '../crawler/src/discovery/run';
import type { Seller } from '../crawler/src/store';
import type { CollectionRecord } from '../shared/collection-schema';
const html=readFileSync(new URL('./fixtures/external/pangpang.html',import.meta.url),'utf8');
test('public collection writes facts and seller evidence locally; never sends ingest or auto follows',async()=>{
 const f=fixture();try{
  const scheduler=new Scheduler(f.store,async url=>({status:200,headers:{},body:url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':url.pathname==='/'?html:'<main></main>'}),async ms=>{f.advance(ms);});
  const runner=new DiscoveryRunner(f.store,scheduler);runner.seed();await runner.run();
  const seller=f.store.list<Seller>('seller_candidates').find(s=>s.handle==='synthetic_seller');expect(seller).toMatchObject({found_via:'fixture',hits:1,status:'pending'});expect(seller?.sample_urls).toContain(`${source.origin}/deal/101?id=7`);
  const records=f.store.list<CollectionRecord>('collection_records');expect(records.some(r=>r.extracted_facts.clue_price?.length)).toBe(true);expect(records.every(r=>!['ready_to_publish','verified_waiting'].includes(r.verification_status))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();const before=f.store.list('seller_candidate_sources');f.reopen();await new DiscoveryRunner(f.store,scheduler).run();expect(f.store.list('seller_candidate_sources')).toEqual(before);
 }finally{f.close();}
});
test('dry-run keeps business data and jobs untouched while enforcing persistent domain pacing',async()=>{
 const f=fixture();try{
  const transport=vi.fn(async(url:URL)=>({status:200,headers:{},body:url.pathname==='/robots.txt'?'User-agent: *\nAllow: /':html}));
  const runner=new DiscoveryRunner(f.store,new Scheduler(f.store,transport,async ms=>{f.advance(ms);}));await runner.run(true);
  expect(transport).toHaveBeenCalled();for(const table of ['collection_records','evidence_assertions','collection_jobs','seller_candidates','intake_reservations','sync_outbox'] as const)expect(f.store.list(table)).toHaveLength(0);expect(f.store.list('domain_state')).toHaveLength(1);expect(fetch).not.toHaveBeenCalled();
 }finally{f.close();}
});
