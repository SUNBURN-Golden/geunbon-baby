import { CollectorError } from '../store';
import type { SourcePolicy } from '../source-policy';

export function failureCode(error:unknown):string {
  const code=error instanceof CollectorError?error.code:error instanceof Error?error.message:'';
  return /^[a-z_]{1,40}$/.test(code)?code:'error';
}
export const BLOCKED_CODES = new Set(['robots_denied','robots_unavailable','visit_not_allowed','domain_stopped','source_blocked','source_cooldown','private_network']);
export type PageKind = 'listing'|'feed'|'recalls'|'browser';
export type PageMeasure = {kind:PageKind;links_found:number;parsed:number;eligible:number;price_checked:number;price_hints:number};
type PageFinding = 'zero_parsed'|'zero_eligible'|'zero_price_hints';
export type HealthFlag = 'failed'|'blocked'|'not_attempted'|PageFinding|'subrequest_failed';
export type HealthNote = 'price_not_assessed'|'price_not_applicable';
export type SourceHealth = {
  source_id:string;mode:'run'|'dry_run';status:'ok'|'review';flags:HealthFlag[];notes:HealthNote[];
  pages_attempted:number;pages_ok:number;pages_failed:number;pages_review:number;
  page_findings:Partial<Record<PageFinding,number>>;
  links_found:number;parsed:number;eligible:number;price_checked:number;price_hints:number;sent:number;
  blocked:number;blocked_reasons:Record<string,number>;failures:Record<string,number>;subrequest_failures:Record<string,number>;
};

export function hasNumericPrice(value:unknown):boolean {
  if(typeof value==='object'&&value!==null&&'amount' in value)return typeof value.amount==='number'&&Number.isSafeInteger(value.amount)&&value.amount>0;
  if(typeof value==='string'){
    if(!/^\s*([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)\s*원?\s*$/.test(value))return false;
    value=Number(value.replace(/[,원\s]/g,''));
  }
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
}
function increment(counts:Record<string,number>,code:string,n=1) {
  const key=/^[a-z_]{1,40}$/.test(code)?code:'error';
  Object.defineProperty(counts,key,{value:(Object.hasOwn(counts,key)?counts[key]:0)+n,enumerable:true,writable:true,configurable:true});
}
function findings(m:Pick<PageMeasure,'parsed'|'eligible'|'price_checked'|'price_hints'>):PageFinding[] {
  const out:PageFinding[]=[];
  if(m.parsed===0)out.push('zero_parsed');
  if(m.parsed>0&&m.eligible===0)out.push('zero_eligible');
  if(m.price_checked>0&&m.price_hints===0)out.push('zero_price_hints');
  return out;
}
export class RunHealth {
  private sources=new Map<string,SourceHealth>();
  source(id:string,mode:SourceHealth['mode']):SourceHealth {
    let h=this.sources.get(id);
    if(!h){
      h={source_id:id,mode,status:'ok',flags:[],notes:[],pages_attempted:0,pages_ok:0,pages_failed:0,pages_review:0,page_findings:{},links_found:0,parsed:0,eligible:0,price_checked:0,price_hints:0,sent:0,blocked:0,blocked_reasons:{},failures:{},subrequest_failures:{}};
      this.sources.set(id,h);
    }
    return h;
  }
  pageOk(id:string,m:PageMeasure) {
    const h=this.sources.get(id)!;h.pages_attempted++;h.pages_ok++;
    for(const key of ['links_found','parsed','eligible','price_checked','price_hints'] as const)h[key]+=m[key];
    const flags=findings(m);if(flags.length)h.pages_review++;
    for(const flag of flags)h.page_findings[flag]=(h.page_findings[flag]??0)+1;
  }
  pageFailed(id:string,code:string){const h=this.sources.get(id)!;h.pages_attempted++;h.pages_failed++;increment(h.failures,code);}
  sent(id:string,n=1){this.sources.get(id)!.sent+=n;}
  subrequestFailed(id:string,code:string){increment(this.sources.get(id)!.subrequest_failures,code);}
  finish(blocked:Map<string,Record<string,number>>,adapters:Map<string,SourcePolicy['adapter']|'browser'>):SourceHealth[] {
    return [...this.sources.values()].map(h=>{
      h.blocked_reasons={};for(const [code,n] of Object.entries(blocked.get(h.source_id)??{}))increment(h.blocked_reasons,code,n);
      h.blocked=Object.values(h.blocked_reasons).reduce((a,b)=>a+b,0);
      const flags=new Set<HealthFlag>();
      if(h.pages_failed)flags.add('failed');if(h.blocked)flags.add('blocked');if(!h.pages_ok)flags.add('not_attempted');
      for(const flag of [...Object.keys(h.page_findings) as PageFinding[],...findings(h)])flags.add(flag);
      if(Object.keys(h.subrequest_failures).length)flags.add('subrequest_failed');
      h.flags=[...flags];h.status=h.flags.length?'review':'ok';
      h.notes=adapters.get(h.source_id)==='cpsc'?['price_not_applicable']:h.price_checked===0&&h.eligible>0?['price_not_assessed']:[];
      return h;
    });
  }
}
export function formatLine(h:SourceHealth):string {
  const reason=Object.entries(h.failures).sort((a,b)=>b[1]-a[1])[0]?.[0]??'error';
  return `discover source=${h.source_id} status=${h.status} pages=${h.pages_ok}/${h.pages_attempted} review_pages=${h.pages_review} links=${h.links_found} parsed=${h.parsed} eligible=${h.eligible} price_checked=${h.price_checked} price_hints=${h.price_hints} sent=${h.sent} blocked=${h.blocked} failed=${h.pages_failed} subrequest_failed=${Object.values(h.subrequest_failures).reduce((a,b)=>a+b,0)}${h.pages_failed?` reason=${/^[a-z_]{1,40}$/.test(reason)?reason:'error'}`:''} flags=${h.flags.join(',')}`;
}
