import { canonicalUrl, filterText, SUPPORTED_QUERY_KEY, URL_IDENTITY_VERSION } from '../../../shared/privacy-rules';
import type { CandidateUrl, Destination } from './types';
export type ProductUrlPolicy={host:string;path:string;version:string;keys:Record<string,{format:'code'|'digits';max_length:number}>;required_keys:string[];duplicates:'reject'};
export const CANDIDATE_URL_VERSION=`candidate-url@2:identity@${URL_IDENTITY_VERSION}`;
const tracking=/^(?:utm_.+|fbclid|gclid|igshid|ref|from|share)$/i;
const sensitive=/(?:token|session|auth|secret|cookie|signature|credential|password|email|phone|address|user|customer|member|name|key)/i;
const generic=SUPPORTED_QUERY_KEY;
export function candidateUrl(raw:string,policies:ProductUrlPolicy[]=[]):Destination {
  const rejected=():Destination=>({canonical_url:null,display_url:null,identity:'rejected',reasons:['unsafe_url'],policy_version:CANDIDATE_URL_VERSION});
  try {
    if(typeof raw!=='string'||raw.length>2048)return rejected();
    canonicalUrl(raw);
    const u=new URL(raw),originalPath=decodeURIComponent(u.pathname);
    // Reuse the existing host/path/privacy validator without widening canonicalUrl queries.
    canonicalUrl(`${u.origin}${u.pathname}`);
    if(u.username||u.password||u.port||u.protocol!=='https:'||/%[0-9a-f]{2}|[;=\\]|[\u0000-\u001f\u007f]/i.test(originalPath))return rejected();
    const p=policies.find(p=>p.host===u.hostname&&p.path===u.pathname);
    const reasons=new Set<string>();if(u.hash)reasons.add('fragment_identity');
    const params:[string,string][]=[],seen=new Set<string>();
    for(const [k,v] of u.searchParams){
      if(tracking.test(k)||u.origin==='https://09pangpang.com'&&/^\/post\/\d+\/?$/.test(u.pathname)&&[...u.searchParams].length===1&&k==='source'&&v==='home')continue;
      if(!generic.test(k)&&sensitive.test(k)){reasons.add('sensitive_parameter');continue;}
      if(seen.has(k)){reasons.add('duplicate_identifier');continue;}seen.add(k);
      const rule=p?.keys[k];
      if(!generic.test(k)||(p&&!rule)){reasons.add('unknown_parameter');continue;}
      const valid=(rule?.format==='digits'?/^\d+$/:/^[\p{L}\p{N}_.-]+$/u).test(v)&&v.length<=(rule?.max_length??60)&&v.length>0&&filterText(v,200)===v;
      if(!valid){reasons.add('invalid_identifier');continue;}
      params.push([k,v]);
    }
    for(const key of p?.required_keys??[])if(!params.some(([k])=>k===key))reasons.add('missing_identifier');
    const base=new URL(canonicalUrl(`${u.origin}${u.pathname}`));
    base.pathname=base.pathname.split('/').map(s=>encodeURIComponent(decodeURIComponent(s))).join('/');
    base.search=new URLSearchParams(params.sort(([a],[b])=>a<b?-1:a>b?1:0)).toString();
    const display=canonicalUrl(base.href) as CandidateUrl;
    return {canonical_url:reasons.size?null:display,display_url:reasons.size?null:display,identity:reasons.size?'identity_loss':'preserved',reasons:[...reasons].sort(),policy_version:`${CANDIDATE_URL_VERSION}:${p?.version??'base'}`};
  } catch {return rejected();}
}
export function validateCandidateUrl(url:string,policies:ProductUrlPolicy[]):CandidateUrl {
  const d=candidateUrl(url,policies);if(d.identity!=='preserved'||d.canonical_url!==url)throw new Error('candidate_url_invalid');return d.canonical_url!;
}
