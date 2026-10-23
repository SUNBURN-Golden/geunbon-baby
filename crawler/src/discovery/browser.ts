import { chromium } from 'playwright';
import { extractFacts } from '../../../shared/fact-extract';
import { extractRegion } from '../../../shared/dom-extract';
import { privacyFilter } from '../privacy-filter';
import { Scheduler } from '../scheduler';
import { requireThat } from '../store';
import type { SourcePolicy } from '../source-policy';
export async function browserExtract(url:string,source:SourcePolicy,scheduler:Scheduler) {
  requireThat(source.browser&&source.selector,'browser_not_approved',403);
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
    await context.routeWebSocket(/.*/,ws=>{void ws.close();});
    await context.route('**/*',async route=>{
      if(!['document','xhr','fetch','script','stylesheet'].includes(route.request().resourceType())||route.request().method()!=='GET')return route.abort();
      try {
        // Fulfill through the pinned transport. Browser DNS/redirects cannot bypass policy.
        const response=await scheduler.get(route.request().url(),source);
        await route.fulfill({status:response.status,headers:{'content-type':response.headers['content-type']??'text/plain'},body:response.body});
      } catch {await route.abort();}
    });
    const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
    requireThat(new URL(page.url()).origin===source.origin,'document_changed');
    const region=await page.evaluate(extractRegion,source.selector);
    return privacyFilter({title:region.title,document_origin:region.documentOrigin,assertions:extractFacts(region.text,region.locator)});
  } finally {await browser.close();}
}
