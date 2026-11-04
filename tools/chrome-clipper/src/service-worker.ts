import { createClip, resumeClip, type ClipJob, type DeliveryDeps, DeliveryError } from './delivery';
import { extractFacts } from '../../../shared/fact-extract';
import { extractRegion } from '../../../shared/dom-extract';
import { canonicalUrl } from '../../../shared/privacy-rules';
import { approved, policies, policyVersion } from './approved';
const base='http://127.0.0.1:4318';
let tail:Promise<unknown>=Promise.resolve();
function serial(task:()=>Promise<void>){tail=tail.catch(()=>{}).then(task).catch(async()=>{await chrome.action.setBadgeText({text:'대기'});});}
async function deps():Promise<DeliveryDeps>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const settings=(await chrome.storage.local.get('settings')).settings as {token?:string}|undefined;
  if(!settings?.token||settings.token.length<24)throw new Error('pairing_required');
  return {
    now:Date.now,
    save:async job=>{await chrome.storage.local.set({[`clip:${job.clip_id}`]:job});await chrome.action.setBadgeText({text:job.phase==='complete'?'접수':job.phase==='needs_reclick'?'재클릭':job.phase==='failed'||job.phase==='expired'?'실패':'대기'});},
    hash:async payload=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))))).map(n=>n.toString(16).padStart(2,'0')).join(''),
    call:async(path,body)=>{let r:Response;try{r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${settings.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),credentials:'omit',redirect:'error'});}catch{throw new DeliveryError(0);}if(!r.ok){const retry=r.headers.get('retry-after');throw new DeliveryError(r.status,retry?Math.max(0,/^\d+$/.test(retry)?Number(retry)*1000:(Date.parse(retry)-Date.now()||0)):0);}return (await r.json() as {data:unknown}).data;},
    extract:async job=>{
      const source=approved.find(s=>new URL(job.url).origin===s.origin);
      if(job.collection_method==='browser_extract'&&(!source||!await chrome.permissions.contains({origins:[`${source.origin}/*`]})))throw new Error('permission_revoked');
      const expectedUrl=canonicalUrl(job.url);
      // Bind extraction to the durable reservation, including identity query parameters.
      // The injected function checks location.href before reading any DOM.
      const result=await chrome.scripting.executeScript({target:{tabId:job.tab_id},world:'ISOLATED',func:extractRegion,args:[source?.selector??'',!source,expectedUrl]});
      const region=result[0]?.result;if(!region)throw new Error('region_missing');
      return {title:region.title,document_origin:region.documentOrigin,assertions:extractFacts(region.text,region.locator)};
    },
  };
}
async function recover(){const d=await deps();const all=await chrome.storage.local.get(null);for(const [key,value] of Object.entries(all))if(key.startsWith('clip:')){const job=value as ClipJob;try{await resumeClip(job,d);}catch{/* Only already persisted progress is used at the next alarm. */}}}
chrome.action.onClicked.addListener(tab=>serial(async()=>{
  if(tab.id===undefined||!tab.url)return;
  const url=canonicalUrl(tab.url),parsed=new URL(url),source=policies.find(s=>s.origin===parsed.origin&&s.paths.some(p=>p===parsed.pathname||p.endsWith('/')&&parsed.pathname.startsWith(p))&&[...parsed.searchParams.keys()].every(k=>s.query_keys.includes(k))),d=await deps();
  const job=await createClip({clip_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),url,brand:source?.brand??'unknown',collection_method:'manual_clip',operation:'new_body',policy_version:policyVersion},tab.id,d);
  await resumeClip(job,d);
}));
chrome.alarms.onAlarm.addListener(()=>serial(async()=>{
  await recover();
  const settings=(await chrome.storage.local.get('settings')).settings as {unattended?:boolean}|undefined;
  if(!settings?.unattended)return;
  const d=await deps();
  for(const source of approved){if(!await chrome.permissions.contains({origins:[`${source.origin}/*`]}))continue;
    for(const tab of await chrome.tabs.query({url:`${source.origin}/*`})){
      if(tab.id===undefined||!tab.url)continue;const url=canonicalUrl(tab.url);
      const key=`observed:${url}`;if((await chrome.storage.local.get(key))[key])continue;
      const job=await createClip({clip_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),url,brand:source.brand,collection_method:'browser_extract',operation:'new_body',policy_version:policyVersion},tab.id,d);
      await chrome.storage.local.set({[key]:job.clip_id});await resumeClip(job,d);
    }
  }
}));
chrome.permissions.onRemoved.addListener(()=>serial(recover));
chrome.runtime.onStartup.addListener(()=>serial(recover));
chrome.runtime.onInstalled.addListener(()=>serial(async()=>{await chrome.alarms.create('delivery',{periodInMinutes:1});await recover();}));
// Every worker instance reconciles durable progress; no reliance on previous globals.
serial(async()=>{await chrome.alarms.create('delivery',{periodInMinutes:1});await recover();});
