import { config, validateConfig } from '../crawler/src/source-policy';
import { source } from './helpers/collector';
import { loadDiscoveryConfig, validateDiscoveryConfig } from '../crawler/src/source-discovery/config';
import { expect, test } from 'vitest';
import { canonicalUrl } from '../shared/privacy-rules';
import { candidateUrl, validateCandidateUrl } from '../crawler/src/source-discovery/url-policy';
import { productPolicies, discoveryAsset } from './helpers/source-discovery';
import { extractDocument } from '../crawler/src/discovery/document';
const policies=productPolicies();
test.each([['/item','id'],['/sku','p']])('exact approved host/path preserves case and distinguishes %s product identity',(path,key)=>{
 const base=`https://new-gear.example.org${path}`,a=candidateUrl(`${base}?utm_source=fixture&${key}=Ab%2D1`,policies),b=candidateUrl(`${base}?${key}=B`,policies);
 expect(a.identity).toBe('preserved');expect(a.canonical_url).toBe(`${base}?${key}=Ab-1`);expect(b.canonical_url).not.toBe(a.canonical_url);
 expect(candidateUrl(`${base}?${key}=Ab-1&utm_source=other`,policies)).toEqual(a);
 expect(validateCandidateUrl(a.canonical_url!,policies)).toBe(a.canonical_url);
 expect(canonicalUrl(a.canonical_url!)).toBe(a.canonical_url);
 expect(candidateUrl(`https://other.example.org${path}?${key}=A`,policies).identity).toBe('preserved');
});
test.each(['product_no=101','product_no=202','sku=A','id=A&id=B','id=A&unknown=fixture','id=%2Fprivate','sku=A','id=A#product=B','id=A&token=synthetic_private_value','id=A&session_id=synthetic_private_value','id=A&email=fixture%40example.org'])('loss is explicit and secrets never remain: %s',query=>{
 const d=candidateUrl(`https://new-gear.example.org/item?${query}`,policies);
 expect(d.identity).not.toBe('preserved');expect(d.display_url).toBeNull();expect(d.canonical_url).toBeNull();expect(JSON.stringify(d)).not.toContain('synthetic_private_value');expect(JSON.stringify(d)).not.toContain('fixture@');
});
test.each(['https://localhost/item','https://127.0.0.1/item','https://fixture:synthetic_private_value@new-gear.example.org/item','https://new-gear.example.org/login','https://new-gear.example.org/%2561uth/path','https://gonggumoa.com/item'])('unsafe destinations retain only reason codes',url=>{
 expect(candidateUrl(url,policies)).toMatchObject({identity:'rejected',display_url:null,canonical_url:null,reasons:['unsafe_url']});
});
test('HTML, RSS and sitemap extract identifiers before canonicalization, report locators, and ignore private regions',()=>{
 for(const [asset,adapter] of [['list.html','links'],['sitemap.xml','sitemap'],['feed.xml','rss']] as const){
  const doc=extractDocument(discoveryAsset(asset),'https://gear.example.org/list',adapter,policies);
  expect(doc.links[0].destination.identity).toBe('preserved');expect(doc.links[0].locator).toBeTruthy();
 }
 const doc=extractDocument('<main><script><a href="https://bad.example.org/">bad</a></script><div data-private><a href="https://private.example.org/">private</a></div>'+Array.from({length:501},(_,i)=>`<a href="https://new.example.org/${i}">유모차</a>`).join('')+'</main>','https://gear.example.org/','links');
 expect(doc.links).toHaveLength(500);expect(doc.truncated).toBe(true);expect(JSON.stringify(doc)).not.toMatch(/bad.example|private.example/);
});

test('configuration cannot grant product_no or sku support',()=>{
 for(const key of ['product_no','sku']){
  const cfg=loadDiscoveryConfig();cfg.url_policies=[{host:'new-gear.example.org',path:'/item',version:'fixture@1',keys:{[key]:{format:'code',max_length:40}},required_keys:[key],duplicates:'reject'}];
  expect(()=>validateDiscoveryConfig(cfg)).toThrow('invalid_discovery_config');
  expect(candidateUrl(`https://new-gear.example.org/item?${key}=101`,cfg.url_policies)).toMatchObject({canonical_url:null,display_url:null});
  expect(()=>validateConfig({...structuredClone(config),sources:[{...source,query_keys:[key]}]})).toThrow('invalid_source');
 }
});
