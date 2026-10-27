import { expect, test } from 'vitest';
import { canonicalUrl } from '../shared/privacy-rules';
import { candidateUrl, validateCandidateUrl } from '../crawler/src/source-discovery/url-policy';
import { productPolicies, discoveryAsset } from './helpers/source-discovery';
import { extractDocument } from '../crawler/src/discovery/document';
const policies=productPolicies();
test.each([['/item','product_no'],['/sku','sku']])('exact approved host/path preserves case and distinguishes %s product identity',(path,key)=>{
 const base=`https://new-gear.example.org${path}`,a=candidateUrl(`${base}?utm_source=fixture&${key}=Ab%2D1`,policies),b=candidateUrl(`${base}?${key}=B`,policies);
 expect(a.identity).toBe('preserved');expect(a.canonical_url).toBe(`${base}?${key}=Ab-1`);expect(b.canonical_url).not.toBe(a.canonical_url);
 expect(candidateUrl(`${base}?${key}=Ab-1&utm_source=other`,policies)).toEqual(a);
 expect(validateCandidateUrl(a.canonical_url!,policies)).toBe(a.canonical_url);
 expect(canonicalUrl(a.canonical_url!)).toBe(base);
 expect(candidateUrl(`https://other.example.org${path}?${key}=A`,policies).identity).toBe('identity_loss');
});
test.each(['product_no=A&product_no=B','product_no=A&unknown=fixture','product_no=%2Fprivate','sku=A','product_no=A#product=B','product_no=A&token=synthetic_private_value','product_no=A&session_id=synthetic_private_value','product_no=A&email=fixture%40example.org'])('loss is explicit and secrets never remain: %s',query=>{
 const d=candidateUrl(`https://new-gear.example.org/item?${query}`,policies);
 expect(d.identity).toBe('identity_loss');expect(d.canonical_url).toBeNull();expect(JSON.stringify(d)).not.toContain('synthetic_private_value');expect(JSON.stringify(d)).not.toContain('fixture@');
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
