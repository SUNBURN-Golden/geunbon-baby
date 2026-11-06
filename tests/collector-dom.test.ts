import { expect, test, vi } from 'vitest';
import { extractRegion } from '../shared/dom-extract';
import { canonicalUrl } from '../shared/privacy-rules';
import { clipperDom } from './helpers/clipper-dom';

test('browser ignores canonical-only metadata and accepts only an explicit original relationship',()=>{
 let original:string|undefined;
 const clone={querySelectorAll:()=>[],querySelector:()=>null};
 const region={nodeType:1,closest:()=>null,querySelector:()=>null,cloneNode:()=>clone};
 vi.stubGlobal('Node',{ELEMENT_NODE:1});vi.stubGlobal('NodeFilter',{SHOW_TEXT:4});
 vi.stubGlobal('window',{getSelection:()=>null});vi.stubGlobal('location',{href:'https://gear.example.org/article',pathname:'/article'});
 vi.stubGlobal('document',{
  querySelector:(selector:string)=>selector==='main'?region:selector.includes('link[rel=canonical]')?{href:'https://gear.example.org/'}:selector==='link[rel=original]'&&original?{href:original}:null,
  createTreeWalker:()=>({nextNode:()=>false}),
 });
 try{
  expect(extractRegion({mode:'region',selector:'main',expectedUrl:'https://gear.example.org/article',urlIdentityVersion:2}).documentOrigin).toBeUndefined();original='https://press.example.org/original';
  expect(extractRegion({mode:'region',selector:'main',expectedUrl:'https://gear.example.org/article',urlIdentityVersion:2}).documentOrigin).toBe(original);
 }finally{vi.unstubAllGlobals();}
});

const product='https://gear.example.org/product';
const identityCases:[string,string,boolean][]=[
 ['?id=A','?id=B',false],
 ['?id=A','',false],
 ['', '?id=A',false],
 ['?id=A&page=1','?id=A&page=2',false],
 ['?id=A&p=1','?id=A&p=2',false],
 ['?id=A&lang=ko','?id=A&lang=en',false],
 ['?recallid=A','?recallid=B',false],
 ['?format=A','?format=B',false],
 ['?productname=A','?productname=B',false],
 ['?title=A','?title=B',false],
 ['?id=A&page=1','?page=1&id=A',true],
 ['?id=A&utm_source=old&fbclid=old','?gclid=new&utm_source=new&id=A#details',true],
 ['?id=A','?id=%41',true],
 ['?id=한글','?id=%ED%95%9C%EA%B8%80',true],
 ['?ID=A','?id=A',false], // Canonicalization retains query-key casing.
 ['?id=A&id=B&page=1','?page=1&id=A&id=B',true],
 ['?id=A&id=B','?id=B&id=A',false], // Stable key sorting preserves duplicate order.
 ['?id=A&id=A','?id=A',false],

];
test.each(identityCases)('serialized extraction compares canonical queries %s → %s (same: %s)',(reserved,current,same)=>{
 const expected=product+reserved,href=product+current,dom=clipperDom(href);
 expect(canonicalUrl(expected)===canonicalUrl(href)).toBe(same);
 if(same){expect(dom.run([{mode:'region',selector:'main',expectedUrl:expected,urlIdentityVersion:2}]).text).toBe('가격: 123000원');expect(dom.reads).toHaveBeenCalled();}
 else {expect(()=>dom.run([{mode:'region',selector:'main',expectedUrl:expected,urlIdentityVersion:2}])).toThrow('document_changed');expect(dom.reads).not.toHaveBeenCalled();}
});

test.each([
 ['https://GEAR.example.org//product/?id=A#old',product+'?id=A',true],
 [product+'?id=A','https://gear.example.org/other?id=A',false],
 [product+'?id=A','https://other.example.org/product?id=A',false],
] as const)('serialized path and origin parity: %s → %s',(reserved,current,same)=>{
 const dom=clipperDom(current);
 expect(canonicalUrl(reserved)===canonicalUrl(current)).toBe(same);
 if(same)expect(dom.run([{mode:'region',selector:'main',expectedUrl:reserved,urlIdentityVersion:2}]).text).toBe('가격: 123000원');
 else {expect(()=>dom.run([{mode:'region',selector:'main',expectedUrl:reserved,urlIdentityVersion:2}])).toThrow('document_changed');expect(dom.reads).not.toHaveBeenCalled();}
});

const invalidUrls=[
 'invalid','http://gear.example.org/product','https://user:pass@gear.example.org/product',
 'https://gear.example.org:444/product','https://localhost/product','https://127.0.0.1/product',
 'https://host.internal/product','https://gonggumoa.com/product','https://gear.example.org/%ZZ',
 'https://gear.example.org/account','https://gear.example.org/%EF%BC%A1',
 'https://password.example.org/product',product+'?id='+ 'x'.repeat(2048),
];
test.each(invalidUrls)('invalid current or reserved URL fails before every DOM read: %s',invalid=>{
 expect(()=>canonicalUrl(invalid)).toThrow();
 for(const [expected,href] of [[product,invalid],[invalid,product],[invalid,invalid]]){
  const dom=clipperDom(href);
  expect(()=>dom.run([{mode:'region',selector:'main',expectedUrl:expected,urlIdentityVersion:2}])).toThrow(/unsafe_url|private_url/);expect(dom.reads).not.toHaveBeenCalled();
 }
});

test.each([undefined,{}, {expectedUrl:product}, {expectedUrl:product,urlIdentityVersion:1}])('missing/stale binding reads no DOM',binding=>{
 const dom=clipperDom();
 expect(()=>dom.run([binding as Parameters<typeof extractRegion>[0]])).toThrow('url_identity_changed');
 expect(dom.reads).not.toHaveBeenCalled();
});
test('identity mode has no DOM/global access',()=>{
 const dom=clipperDom(product+'?id=A&utm_source=synthetic_private_value');
 expect(dom.run([{mode:'identity',expectedUrl:product+'?id=A',urlIdentityVersion:2}]).checkedUrl).toBe(product+'?id=A');
 expect(dom.reads).not.toHaveBeenCalled();
});
test.each(['product_no=101','product_no=202','sku=A','unknown=synthetic_private_value','id=','id=two+words','id='+ 'x'.repeat(61),'id=01012345678','id=Ａ','title=password','id=A&title=a%40example.org'])('rejected identifiers never read DOM: %s',query=>{
 const url=product+'?'+query;
 expect(()=>canonicalUrl(url)).toThrow(/unsafe_url|private_url/);
 for(const mode of ['identity','region','snapshot'] as const){
  const dom=clipperDom(url);expect(()=>dom.run([{mode,expectedUrl:product,urlIdentityVersion:2,selector:'main'}])).toThrow(/unsafe_url|private_url/);expect(dom.reads).not.toHaveBeenCalled();
  const expected=clipperDom(product);expect(()=>expected.run([{mode,expectedUrl:url,urlIdentityVersion:2}])).toThrow(/unsafe_url|private_url/);expect(expected.reads).not.toHaveBeenCalled();
 }
});

test.each([
 ['https://09pangpang.com/post/123?source=home',true],
 ['https://09pangpang.com/post/123/?source=home',true],
 ['https://09pangpang.com/post/123?source=other',false],
 ['https://09pangpang.com/post/123?source=home&source=home',false],
 ['https://09pangpang.com/post/123?source=home&utm_source=fixture',false],
 ['https://09pangpang.com/post/123?source=home&id=A',false],
 ['https://09pangpang.com/?source=home',false],
 ['https://09pangpang.com/post/a?source=home',false],
 ['https://other.example.org/post/123?source=home',false],
] as const)('Pangpang exception mirrors the global identity policy: %s',(url,accepted)=>{
 const dom=clipperDom(url),run=()=>dom.run([{mode:'identity',expectedUrl:url,urlIdentityVersion:2}]);
 if(accepted){expect(canonicalUrl(url)).toBe('https://09pangpang.com/post/123');expect(run().checkedUrl).toBe(canonicalUrl(url));}
 else{expect(()=>canonicalUrl(url)).toThrow('unsafe_url');expect(run).toThrow('unsafe_url');}
 expect(dom.reads).not.toHaveBeenCalled();
});
