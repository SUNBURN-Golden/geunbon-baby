import { expect, test } from 'vitest';
import { Scheduler, publicAddress, type DomainState } from '../crawler/src/scheduler';
import { discoverLinks } from '../crawler/src/discovery/adapters';
import { fixture, source } from './helpers/collector';
import { sourceFor } from '../crawler/src/source-policy';
test('same-domain slot remains held until body completion, respecting slower Crawl-delay',async()=>{
 const f=fixture();try{
  let release=()=>{};const slow=new Promise<void>(resolve=>{release=resolve;});let entered=0;
  const scheduler=new Scheduler(f.store,async url=>{entered++;if(url.pathname==='/robots.txt')return {status:200,headers:{},body:'User-agent: *\nAllow: /\nCrawl-delay: 8'};await slow;return {status:200,headers:{},body:'fixture'};},async ms=>{f.advance(ms);});
  await scheduler.robotsFor(source);const one=scheduler.get(`${source.origin}/one`,source),two=scheduler.get(`${source.origin}/two`,source);
  for(let n=0;n<10;n++)await Promise.resolve();expect(entered).toBe(2);release();await Promise.all([one,two]);expect(entered).toBe(3);expect(f.store.get<DomainState>('domain_state',new URL(source.origin).host)?.crawl_delay).toBe(8000);
 }finally{f.close();}
});
test.each([403,429,500])('response %s persists stop or cooldown across restart',async status=>{
 const f=fixture();try{
  const scheduler=new Scheduler(f.store,async()=>({status,headers:{'retry-after':'120'},body:'fixture'}),async ms=>{f.advance(ms);});await expect(scheduler.get(source.origin+'/',source)).rejects.toThrow();
  const before=f.store.list<DomainState>('domain_state')[0];expect(before.stopped).toBe(status===403);expect(before.next_at).toBeGreaterThan(f.store.now());f.reopen();expect(f.store.list('domain_state')).toEqual([before]);
 }finally{f.close();}
});
test('SSRF, redirect, discovery and adapter policies remain separate',async()=>{
 for(const address of ['198.18.0.1','198.19.255.255','127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'])expect(publicAddress(address)).toBe(false);
 expect(publicAddress('8.8.8.8')).toBe(true);
 expect(discoverLinks('<rss><link>https://press.example.org/story</link></rss>',source.origin,'rss')).toEqual([{url:'https://press.example.org/story'}]);
 expect(discoverLinks('<sitemapindex><sitemap><loc>https://gear.example.org/map.xml</loc></sitemap></sitemapindex>',source.origin,'sitemap')).toHaveLength(1);
 expect(discoverLinks('[{"RecallID":1,"URL":"https://www.cpsc.gov/Recalls/fixture","Title":"Fixture recall","RecallDate":"2026-01-01","Products":[{"Name":"Fixture stroller"}]}]',source.origin,'cpsc')[0].recall?.id).toBe('1');
 const f=fixture();try{expect(sourceFor('https://press.example.org/story',f.settings)).toBeUndefined();const scheduler=new Scheduler(f.store,async url=>({status:url.pathname==='/robots.txt'?404:302,headers:{location:'https://private.example.org/x'},body:''}),async ms=>{f.advance(ms);});await expect(scheduler.get(source.origin+'/',source)).rejects.toThrow('visit_not_allowed');}finally{f.close();}
});

import { DiscoveryRunner } from '../crawler/src/discovery/run';
import { config } from '../crawler/src/source-policy';
test('a disabled source job cannot stall an enabled pending job',async()=>{
 const disabled={...source,id:'disabled',origin:'https://disabled.example.org',entries:['https://disabled.example.org/'],enabled:false};
 const f=fixture({...config,sources:[disabled,source]});try{
  const visited:string[]=[];const scheduler=new Scheduler(f.store,async url=>{visited.push(url.href);return {status:url.pathname==='/robots.txt'?404:200,headers:{},body:'<main>public fixture</main>'};},async ms=>{f.advance(ms);});
  const runner=new DiscoveryRunner(f.store,scheduler);runner.enqueue(disabled.entries[0],disabled);runner.enqueue(source.entries[0],source);
  await runner.run();expect(visited).toContain(source.entries[0]);expect(visited.every(url=>!url.includes('disabled.example.org'))).toBe(true);
  expect(f.store.list<{source_id:string;phase:string}>('collection_jobs').find(j=>j.source_id===source.id)?.phase).toBe('done');
 }finally{f.close();}
});
