import { CostCapError } from '../../engine/types';
import { HALT_CODES } from '../../engine/retry';
import type { FetchResponse, RenderSnapshot } from '../../engine/types';
import { BLOCKED_CODES, failureCode } from './health';
import { chromium } from 'playwright';
import { extractFacts } from '../../../shared/fact-extract';
import { extractRegion } from '../../../shared/dom-extract';
import { privacyFilter } from '../privacy-filter';
import { Scheduler } from '../scheduler';
import { CollectorError, requireThat } from '../store';
import type { SourcePolicy } from '../source-policy';
export async function renderDocument(url:string,source:SourcePolicy,scheduler:Scheduler,options:{document?:FetchResponse;onRequestFailure?:(code:string)=>void;legacy?:boolean}={}):Promise<RenderSnapshot> {
  requireThat(source.browser&&source.selector,'browser_not_approved',403);
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
    await context.routeWebSocket(/.*/,ws=>{void ws.close();});
    let navFailure:string|undefined;let fatalFailure:unknown;
    await context.route('**/*',async route=>{
      if(!['document','xhr','fetch','script','stylesheet'].includes(route.request().resourceType())||route.request().method()!=='GET')return route.abort();
      try {
        // Fulfill through the pinned transport. Browser DNS/redirects cannot bypass policy.
        const main=route.request().resourceType()==='document'&&route.request().url()===url;
        const response=main&&options.document?options.document:await scheduler.get(route.request().url(),source);
        await route.fulfill({status:response.status,headers:{'content-type':response.headers['content-type']??'text/plain'},body:response.bytes??response.body});
      } catch(e) {
        const code=failureCode(e);
        if(e instanceof CostCapError||!options.legacy&&(HALT_CODES.has(code)||code==='source_cooldown'))fatalFailure=e;
        if(route.request().resourceType()==='document'&&route.request().url()===url)navFailure=code;
        else if(!BLOCKED_CODES.has(code))options.onRequestFailure?.(code);
        await route.abort();
      }
    });
    const page=await context.newPage();
    try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});}catch(e){if(fatalFailure)throw fatalFailure;if(navFailure)throw new CollectorError(navFailure);throw e;}
    if(fatalFailure)throw fatalFailure;
    requireThat(new URL(page.url()).origin===source.origin,'document_changed');
    if(options.legacy){const region=await page.evaluate(extractRegion,source.selector);return {finalUrl:page.url(),html:'',text:region.text,regionText:region.text,title:region.title,documentOrigin:region.documentOrigin};}
    const snapshot=await page.evaluate(()=>{
      const password=!!document.querySelector('input[type=password]');
      const clone=document.body?.cloneNode(true) as HTMLElement|undefined;
      clone?.querySelectorAll('input,textarea,select,[contenteditable],[hidden],[aria-hidden="true"],nav,header,footer,[data-private],.profile,.comments,.messages,script,style,iframe').forEach(el=>el.remove());
      const text=clone?.textContent?.slice(0,20000)??'';
      return {text,html:password?'<input type="password">':text};
    });
    try {
      const region=await page.evaluate(extractRegion,source.selector);
      if(fatalFailure)throw fatalFailure;
      return {...snapshot,finalUrl:page.url(),regionText:region.text,title:region.title,documentOrigin:region.documentOrigin};
    } catch(e){if(fatalFailure)throw fatalFailure;return {...snapshot,finalUrl:page.url(),regionError:failureCode(e)};}

  } finally {await browser.close();}
}

export async function browserExtract(url:string,source:SourcePolicy,scheduler:Scheduler,onRequestFailure?:(code:string)=>void) {
  const snapshot=await renderDocument(url,source,scheduler,{onRequestFailure,legacy:true});
  if(snapshot.regionError)throw new CollectorError(snapshot.regionError);
  return privacyFilter({title:snapshot.title,document_origin:snapshot.documentOrigin,assertions:extractFacts(snapshot.regionText??'',source.selector)});
}
