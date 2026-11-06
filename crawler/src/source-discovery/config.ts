import defaults from '../../config/source-discovery.json';
import { readFileSync } from 'node:fs';
import { digest } from '../../engine/util';
import { parseHtml, selectAll } from '../../lib/external/parse';
import { filterText, canonicalUrl, SUPPORTED_QUERY_KEY, URL_IDENTITY_VERSION } from '../../../shared/privacy-rules';
import type { Costs } from '../../engine/types';
import type { ProductUrlPolicy } from './url-policy';
import type { JsonProviderConfig } from './providers/types';
export type DiscoveryConfig=Omit<typeof defaults,'url_policies'|'providers'|'cost_caps'|'source_ids'>&{source_ids:string[];source_hints?:Record<string,string>;pagination_selectors?:Record<string,string>;url_policies:ProductUrlPolicy[];providers:JsonProviderConfig[];cost_caps:Record<'run'|'day'|'origin'|'provider',Costs>};
export function validateDiscoveryConfig(c:DiscoveryConfig):DiscoveryConfig {
  const check=(v:unknown)=>{if(!v)throw new Error('invalid_discovery_config');};
  const clean=(s:string)=>typeof s==='string'&&s.length>0&&s.length<=100&&filterText(s,100)===s&&!/https?:|[?&=]/i.test(s);
  check(typeof c.enabled==='boolean'&&clean(c.version));
  for(const list of [c.regions,c.languages,c.years,c.source_ids])check(Array.isArray(list)&&list.length<=100&&list.every(clean)&&new Set(list).size===list.length);
  check(c.regions.length&&c.languages.length&&c.years.length&&c.languages.every(l=>['ko','en'].includes(l))&&c.years.every(y=>y==='current'||/^20\d{2}$/.test(y)));
  check(c.events.length>0&&c.events.length<=30&&c.events.every(e=>clean(e.ko)&&clean(e.en)));
  check(Object.entries(c.source_hints??{}).every(([id,hint])=>c.source_ids.includes(id)&&clean(hint)));
  for(const [id,selector] of Object.entries(c.pagination_selectors??{})){check(c.source_ids.includes(id)&&selector.length<=120);selectAll(parseHtml(''),selector);}
  for(const [k,min,max] of [['max_depth',0,10],['min_relevance',0,100],['max_queries',1,10000],['max_pages',1,20],['max_candidates_day',0,500],['requery_ms',60000,31536000000]] as const)check(Number.isSafeInteger(c[k])&&c[k]>=min&&c[k]<=max);
  check(Object.keys(c.cost_caps).sort().join(',')==='day,origin,provider,run');
  for(const cap of Object.values(c.cost_caps))check(['requests','bytes','model_calls'].every(k=>Number.isSafeInteger(cap[k as keyof Costs])&&cap[k as keyof Costs]>=0&&cap[k as keyof Costs]<=1073741824)&&cap.model_calls===0);
  check(c.providers.length<=10&&new Set(c.providers.map(p=>p.id)).size===c.providers.length);
  for(const p of c.providers){
    const u=new URL(p.endpoint);canonicalUrl(u.origin);
    check(clean(p.id)&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.href===p.endpoint&&!/(?:login|auth|session|account)/i.test(decodeURIComponent(u.pathname)));
    check(!['instagram.com','facebook.com','cdninstagram.com','fbcdn.net'].some(h=>u.hostname===h||u.hostname.endsWith(`.${h}`)));
    check([p.query_param,p.cursor_param].every(v=>/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(v))&&p.query_param!==p.cursor_param);
    for(const path of [p.results_path,p.url_path,p.title_path,p.summary_path,...(p.next_cursor_path?[p.next_cursor_path]:[])])check(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*){0,5}$/.test(path)&&!/(?:__proto__|prototype|constructor)/.test(path));
    check(!p.auth_env||/^COLLECTOR_SEARCH_[A-Z0-9_]{1,60}$/.test(p.auth_env));
    check(['unconfirmed','approved','denied'].includes(p.terms.status)&&['none','urls','snippets'].includes(p.terms.storage)&&typeof p.terms.cursor_storage==='boolean');
    check(filterText(p.terms.basis,300)===p.terms.basis&&p.terms.basis.length<=300);
  }
  check(c.url_policies.length<=100);
  check(new Set(c.url_policies.map(p=>`${p.host}${p.path}`)).size===c.url_policies.length);
  for(const p of c.url_policies){
    check(new URL(canonicalUrl(`https://${p.host}${p.path}`)).hostname===p.host&&p.path.startsWith('/')&&clean(p.version)&&p.duplicates==='reject');
    check(Object.keys(p.keys).length>0&&Object.keys(p.keys).every(k=>SUPPORTED_QUERY_KEY.test(k))&&p.required_keys.length>0&&p.required_keys.every(k=>Object.hasOwn(p.keys,k)));
    for(const rule of Object.values(p.keys))check(['code','digits'].includes(rule.format)&&Number.isSafeInteger(rule.max_length)&&rule.max_length>0&&rule.max_length<=60);
  }
  return c;
}
export const loadDiscoveryConfig=()=>validateDiscoveryConfig(process.env.COLLECTOR_DISCOVERY_CONFIG?JSON.parse(readFileSync(process.env.COLLECTOR_DISCOVERY_CONFIG,'utf8')) as DiscoveryConfig:structuredClone(defaults) as DiscoveryConfig);
export const linkCacheTool=(c:DiscoveryConfig,url:string,source:string,depth=0)=>`candidate-links@2:${URL_IDENTITY_VERSION}:${digest([c.url_policies,c.pagination_selectors??{},url,source,depth])}`;
