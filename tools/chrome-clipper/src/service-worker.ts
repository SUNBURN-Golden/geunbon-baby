import { createClip, resumeClip, type ClipJob, type DeliveryDeps, DeliveryError, localErrorCode } from './delivery';
import { extractFacts } from '../../../shared/fact-extract';
import { extractRegion } from '../../../shared/dom-extract';
import { canonicalUrl, URL_IDENTITY_VERSION, isUrlRejection } from '../../../shared/privacy-rules';
import { approved, policies, policyVersion } from './approved';
const base='http://127.0.0.1:4318';
function stable(v:unknown):string {
  if(Array.isArray(v))return `[${v.map(stable).join(',')}]`;
  if(v&&typeof v==='object')return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
async function apiError(response:Response):Promise<unknown> {
  const reader=response.body?.getReader();if(!reader)return;
  let raw='';const decoder=new TextDecoder();let bytes=0;
  try {
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>256){await reader.cancel();return;}raw+=decoder.decode(part.value,{stream:true});}
    raw+=decoder.decode();return (JSON.parse(raw) as {error?:unknown}).error;
  }catch{return;}
}
let tail:Promise<unknown>=Promise.resolve();
function serial(task:()=>Promise<void>){tail=tail.catch(()=>{}).then(task).catch(async()=>{await chrome.action.setBadgeText({text:'대기'});});}
async function deps():Promise<DeliveryDeps>{
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const settings=(await chrome.storage.local.get('settings')).settings as {token?:string}|undefined;
  if(!settings?.token||settings.token.length<24)throw new Error('pairing_required');
  return {
    client:`chrome-extension://${chrome.runtime.id}`,
    now:Date.now,
    checkIdentity:async job=>{
      const result=await chrome.scripting.executeScript({target:{tabId:job.tab_id},world:'ISOLATED',func:extractRegion,args:[{expectedUrl:job.url,urlIdentityVersion:job.url_identity_version,mode:'identity',reportErrors:true}]}).catch(()=>{throw new Error('document_changed');});
      if(!result[0]?.result)throw new Error('url_identity_changed');
      if(result[0].result.error)throw new Error(localErrorCode(result[0].result.error)??'document_changed');
    },
    save:async job=>{await chrome.storage.local.set({[`clip:${job.clip_id}`]:job});await chrome.action.setBadgeText({text:job.phase==='complete'?'접수':job.phase==='needs_reclick'?'재클릭':job.phase==='failed'||job.phase==='expired'?'실패':'대기'});},
    hash:async(payload,format)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(format==='legacy'?JSON.stringify(payload):stable(payload))))).map(n=>n.toString(16).padStart(2,'0')).join(''),
    call:async(path,body)=>{let r:Response;try{r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${settings.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),credentials:'omit',redirect:'error'});}catch{throw new DeliveryError(0);}if(!r.ok){const retry=r.headers.get('retry-after');const code=await apiError(r);throw new DeliveryError(r.status,retry?Math.max(0,/^\d+$/.test(retry)?Number(retry)*1000:(Date.parse(retry)-Date.now()||0)):0,code);}return (await r.json() as {data:unknown}).data;},
    extract:async job=>{
      const source=approved.find(s=>new URL(job.url).origin===s.origin);
      if(job.collection_method==='browser_extract'&&(!source||!await chrome.permissions.contains({origins:[`${source.origin}/*`]})))throw new Error('permission_revoked');
      const expectedUrl=canonicalUrl(job.url);
      // Bind extraction to the durable reservation, including identity query parameters.
      // The injected function checks location.href before reading any DOM.
      const result=await chrome.scripting.executeScript({target:{tabId:job.tab_id},world:'ISOLATED',func:extractRegion,args:[{mode:'region',selector:source?.selector??'',selectionOnly:!source,expectedUrl,urlIdentityVersion:job.url_identity_version,reportErrors:true}]});
      const region=result[0]?.result;if(region?.error)throw new Error(region.error);if(!region)throw new Error('region_missing');
      return {title:region.title,document_origin:region.documentOrigin,assertions:extractFacts(region.text,region.locator)};
    },
  };
}
async function recover(){const d=await deps();const all=await chrome.storage.local.get(null);for(const [key,value] of Object.entries(all))if(key.startsWith('clip:')){const job=value as ClipJob;try{await resumeClip(job,d);}catch{/* Only already persisted progress is used at the next alarm. */}}}
chrome.action.onClicked.addListener(tab=>serial(async()=>{
  if(tab.id===undefined||!tab.url)return;
  const url=canonicalUrl(tab.url),parsed=new URL(url),source=policies.find(s=>s.origin===parsed.origin&&s.paths.some(p=>p===parsed.pathname||p.endsWith('/')&&parsed.pathname.startsWith(p))&&[...parsed.searchParams.keys()].every(k=>s.query_keys.includes(k))),d=await deps();
  const job=await createClip({clip_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),url,brand:source?.brand??'unknown',collection_method:'manual_clip',operation:'new_body',policy_version:policyVersion,url_identity_version:URL_IDENTITY_VERSION},tab.id,d);
  await resumeClip(job,d);
}));
chrome.alarms.onAlarm.addListener(()=>serial(async()=>{
  await recover();
  const settings=(await chrome.storage.local.get('settings')).settings as {unattended?:boolean}|undefined;
  if(!settings?.unattended)return;
  const d=await deps();
  for(const source of approved){if(!await chrome.permissions.contains({origins:[`${source.origin}/*`]}))continue;
    for(const tab of await chrome.tabs.query({url:`${source.origin}/*`})){
      try {
      if(tab.id===undefined||!tab.url)continue;const url=canonicalUrl(tab.url);
      const key=`observed:${URL_IDENTITY_VERSION}:${url}`;if((await chrome.storage.local.get(key))[key])continue;
      const job=await createClip({clip_id:crypto.randomUUID(),attempt_id:crypto.randomUUID(),url,brand:source.brand,collection_method:'browser_extract',operation:'new_body',policy_version:policyVersion,url_identity_version:URL_IDENTITY_VERSION},tab.id,d);
      await chrome.storage.local.set({[key]:job.clip_id});await resumeClip(job,d);
      }catch(e){if(!isUrlRejection(e))throw e;}
    }
  }
}));
chrome.permissions.onRemoved.addListener(()=>serial(recover));
chrome.runtime.onStartup.addListener(()=>serial(recover));
chrome.runtime.onInstalled.addListener(()=>serial(async()=>{await chrome.alarms.create('delivery',{periodInMinutes:1});await recover();}));
// Every worker instance reconciles durable progress; no reliance on previous globals.
serial(async()=>{await chrome.alarms.create('delivery',{periodInMinutes:1});await recover();});
