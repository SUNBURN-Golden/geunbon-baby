import { hashBytes } from '../../../engine/util';
import type { SearchQuery } from '../types';
import { filterText } from '../../../../shared/privacy-rules';
export type SearchHit={url:string;title?:string;summary?:string;locator?:string};
export type SearchPage={results:SearchHit[];nextCursor?:string;truncated?:boolean;capture:{contentHash:string;byteLength:number}};
export interface SearchProvider {id:string;search(query:SearchQuery,cursor?:string):Promise<SearchPage>}
export type JsonProviderConfig={id:string;enabled:boolean;endpoint:string;query_param:string;cursor_param:string;results_path:string;url_path:string;title_path:string;summary_path:string;next_cursor_path?:string;auth_env?:string;terms:{status:'unconfirmed'|'approved'|'denied';basis:string;checked_at:string;storage:'none'|'urls'|'snippets';cursor_storage:boolean}};
export function providerApproved(p:JsonProviderConfig){return p.enabled&&p.terms.status==='approved'&&!!p.terms.basis&&Number.isFinite(Date.parse(p.terms.checked_at))&&p.terms.storage!=='none';}
export const validCursor=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)&&filterText(v,128)===v;
// Fixture transport still goes through Scheduler and the same meters in runner tests.
export class FixtureSearchProvider implements SearchProvider {
  constructor(readonly id:string,readonly pages:Record<string,SearchPage>){}
  async search(query:SearchQuery,cursor=''){return structuredClone(this.pages[`${query.text}:${cursor}`]??{results:[],capture:{contentHash:hashBytes(Buffer.from('{"results":[]}')),byteLength:14}});}
}
