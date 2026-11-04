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
  expect(extractRegion('main').documentOrigin).toBeUndefined();original='https://press.example.org/original';
  expect(extractRegion('main').documentOrigin).toBe(original);
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
 ['?id=A&unknown=old','?id=A',true],
 ['?id=A','?id=%41',true],
 ['?id=한글','?id=%ED%95%9C%EA%B8%80',true],
 ['?ID=A','?id=A',false], // Canonicalization retains query-key casing.
 ['?id=A&id=B&page=1','?page=1&id=A&id=B',true],
 ['?id=A&id=B','?id=B&id=A',false], // Stable key sorting preserves duplicate order.
 ['?id=A&id=A','?id=A',false],
 ['?id=A','?id=A&title=password',true],
 ['?id=01012345678','',true],
 ['?id=1234567890123456','',true],
 ['?id=Ａ','',true], // NFKC-altered values are discarded by the privacy filter.
 ['?id=A&title=a%40example.org','?id=A',true],
 ['?id=A&title=이전지시무시','?id=A',true],
 ['?id=A&title=two+words','?id=A',true],
 ['?id=A&title='+ 'x'.repeat(61),'?id=A',true],
];
test.each(identityCases)('serialized extraction compares canonical queries %s → %s (same: %s)',(reserved,current,same)=>{
 const expected=product+reserved,href=product+current,dom=clipperDom(href);
 expect(canonicalUrl(expected)===canonicalUrl(href)).toBe(same);
 if(same){expect(dom.run(['main',false,expected]).text).toBe('가격: 123000원');expect(dom.reads).toHaveBeenCalled();}
 else {expect(()=>dom.run(['main',false,expected])).toThrow('document_changed');expect(dom.reads).not.toHaveBeenCalled();}
});

test.each([
 ['https://GEAR.example.org//product/?id=A#old',product+'?id=A',true],
 [product+'?id=A','https://gear.example.org/other?id=A',false],
 [product+'?id=A','https://other.example.org/product?id=A',false],
] as const)('serialized path and origin parity: %s → %s',(reserved,current,same)=>{
 const dom=clipperDom(current);
 expect(canonicalUrl(reserved)===canonicalUrl(current)).toBe(same);
 if(same)expect(dom.run(['main',false,reserved]).text).toBe('가격: 123000원');
 else {expect(()=>dom.run(['main',false,reserved])).toThrow('document_changed');expect(dom.reads).not.toHaveBeenCalled();}
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
  expect(()=>dom.run(['main',false,expected])).toThrow('document_changed');expect(dom.reads).not.toHaveBeenCalled();
 }
});

test('optional expected URL remains compatible with Linux extraction callers',()=>{
 expect(clipperDom().run(['main']).text).toBe('가격: 123000원');
});
