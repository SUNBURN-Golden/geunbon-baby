import { BLOCKED_CODES, failureCode } from './health';
import { chromium } from 'playwright';
import { extractFacts } from '../../../shared/fact-extract';
import { extractRegion } from '../../../shared/dom-extract';
import { privacyFilter } from '../privacy-filter';
import { Scheduler } from '../scheduler';
import { CollectorError, requireThat } from '../store';
import type { SourcePolicy } from '../source-policy';
export async function browserExtract(url:string,source:SourcePolicy,scheduler:Scheduler,onRequestFailure?:(code:string)=>void) {
  requireThat(source.browser&&source.selector,'browser_not_approved',403);
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
    await context.routeWebSocket(/.*/,ws=>{void ws.close();});
    let navFailure:string|undefined;
    await context.route('**/*',async route=>{
      if(!['document','xhr','fetch','script','stylesheet'].includes(route.request().resourceType())||route.request().method()!=='GET')return route.abort();
      try {
        // Fulfill through the pinned transport. Browser DNS/redirects cannot bypass policy.
        const response=await scheduler.get(route.request().url(),source);
        await route.fulfill({status:response.status,headers:{'content-type':response.headers['content-type']??'text/plain'},body:response.body});
      } catch(e) {
        const code=failureCode(e);
        if(route.request().resourceType()==='document'&&route.request().url()===url)navFailure=code;
        else if(!BLOCKED_CODES.has(code))onRequestFailure?.(code);
        await route.abort();
      }
    });
    const page=await context.newPage();
    try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});}catch(e){if(navFailure)throw new CollectorError(navFailure);throw e;}
    requireThat(new URL(page.url()).origin===source.origin,'document_changed');
    const region=await page.evaluate(extractRegion,source.selector);
    return privacyFilter({title:region.title,document_origin:region.documentOrigin,assertions:extractFacts(region.text,region.locator)});
  } finally {await browser.close();}
}
