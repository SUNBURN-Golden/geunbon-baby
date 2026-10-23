import { expect, test, vi } from 'vitest';
import { extractRegion } from '../shared/dom-extract';

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
