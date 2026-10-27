import { cleanText } from '../../discovery/document';
import { hashBytes } from '../../../engine/util';
import type { Scheduler } from '../../scheduler';
import type { SearchQuery } from '../types';
import { providerApproved, validCursor, type JsonProviderConfig, type SearchPage, type SearchProvider } from './types';
export function field(value:unknown,path:string):unknown {
  return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as Record<string,unknown>)[k]:undefined,value);
}
export class JsonApiSearchProvider implements SearchProvider {
  readonly id:string;
  constructor(readonly config:JsonProviderConfig,readonly scheduler:Scheduler,readonly env:NodeJS.ProcessEnv=process.env){this.id=config.id;}
  async search(query:SearchQuery,cursor?:string):Promise<SearchPage> {
    const c=this.config;if(!providerApproved(c))throw new Error('search_permission');
    if(cursor&&(!c.terms.cursor_storage||!validCursor(cursor)))throw new Error('search_cursor');
    const headers:Record<string,string>={accept:'application/json'};
    const credential=c.auth_env?this.env[c.auth_env]:undefined;
    if(c.auth_env){if(!credential||credential.length>4096||/[\r\n]/.test(credential))throw new Error('search_auth_missing');headers.authorization=`Bearer ${credential}`;}
    const response=await this.scheduler.searchApi(c.endpoint,{[c.query_param]:query.text,...(cursor?{[c.cursor_param]:cursor}:{})},headers);
    let data:unknown;try{data=JSON.parse(response.body);}catch{throw new Error('search_schema');}
    const rows=field(data,c.results_path);if(!Array.isArray(rows))throw new Error('search_schema');
    const scrub=(v:unknown)=>typeof v==='string'&&(!credential||!v.includes(credential))?v:'';
    const capture={contentHash:hashBytes(response.bytes??Buffer.from(response.body)),byteLength:response.bytes?.length??Buffer.byteLength(response.body)};
    const results=rows.slice(0,500).flatMap((r,i)=>{const url=scrub(field(r,c.url_path));if(!url)return [];return [{url,title:c.terms.storage==='snippets'?cleanText(scrub(field(r,c.title_path)),200):'',summary:c.terms.storage==='snippets'?cleanText(scrub(field(r,c.summary_path))):'',locator:`${c.results_path}[${i}]`}];});
    const next=c.next_cursor_path?field(data,c.next_cursor_path):undefined;
    if(next!==undefined&&next!==null&&next!==''&&(!c.terms.cursor_storage||!validCursor(next)||!scrub(next)))return {results,truncated:true,capture};
    return {results,...(validCursor(next)?{nextCursor:next}:{}),truncated:rows.length>500,capture};
  }
}
