import { runInNewContext } from 'node:vm';
import { vi } from 'vitest';
import { extractRegion } from '../../shared/dom-extract';

// Each invocation serializes the function into a fresh browser-like VM. No module
// helpers or Node globals are available inside it; all DOM access is observed.
export function clipperDom(href='https://gear.example.org/product?id=A') {
  let url=href, body='가격: 123000원';
  const reads=vi.fn();
  const observed=<T extends object>(name:string,value:T):T=>new Proxy(value,{get(target,key,receiver){reads(`${name}.${String(key)}`);return Reflect.get(target,key,receiver);}});
  const clone=observed('clone', {querySelectorAll:()=>[],querySelector:()=>observed('heading',{get textContent(){return 'Product';}})});
  const region=observed('region',{nodeType:1,closest:()=>null,querySelector:()=>null,cloneNode:()=>clone});
  const selection=observed('selection',{rangeCount:1,getRangeAt:()=>observed('range',{commonAncestorContainer:region,intersectsNode:()=>false}),toString:()=>body});
  const document=observed('document',{
    querySelector:(selector:string)=>selector==='main'?region:null,
    querySelectorAll:()=>[],
    createTreeWalker:()=>{let done=false;return observed('walker',{nextNode:()=>{if(done)return false;done=true;return true;},get currentNode(){return observed('text',{get textContent(){return body;}});}});},
  });
  const window=observed('window',{getSelection:()=>selection});
  return {
    reads,
    navigate:(next:string,text=body)=>{url=next;body=text;},
    run:(args:Parameters<typeof extractRegion>,func:typeof extractRegion=extractRegion):ReturnType<typeof extractRegion>=>{
      const context:Record<string,unknown>={URL,URLSearchParams,args,location:{get href(){return url;},get pathname(){return new URL(url).pathname;}}};
      for(const [key,value] of Object.entries({document,window,Node:{ELEMENT_NODE:1},NodeFilter:{SHOW_TEXT:4}})){
        Object.defineProperty(context,key,{get(){reads(key);return value;},configurable:true});
      }
      return runInNewContext(`(${func.toString()})(...args)`,context);
    },
  };
}
