import { canonicalUrl } from '../../../shared/privacy-rules';
import type { CollectorStore } from '../store';
import { normalizedConditions } from '../agamajung/subject';
import { dayKey, digest, stable } from '../../engine/util';
import { CostCapError } from '../../engine/types';
import { cleanText } from '../discovery/document';
import { candidateUrl, validateCandidateUrl } from './url-policy';
import type { DiscoveryConfig } from './config';
import type { Destination, EvidenceInput, SearchQuery } from './types';
export const discoveryConditions=(c:Record<string,string>)=>normalizedConditions('source_candidate',Object.fromEntries(Object.entries(c).map(([k,v])=>[cleanText(k,60),cleanText(v,100)]).filter(([k])=>!!k)));
export type CandidateObservation={destination:Destination;evidence:EvidenceInput;score:number};
type CandidateRow={id:string;profile_id:string;canonical_url:string|null;display_url:string|null;identity:Destination['identity'];status:'discovered';policy_version:string;reasons:string;relevance:number;relevance_version:string;first_seen:string;last_seen:string;observation_count:number;added_day:string;url_policy:string};
export class SourceCandidateStore {
  constructor(readonly store:CollectorStore,readonly config:DiscoveryConfig,readonly profileId='agamajung'){}
  candidateId(d:Destination,e:EvidenceInput){return digest(d.canonical_url?[this.profileId,d.canonical_url]:[this.profileId,'lost',e.capture_id,e.locator]);}
  // Caller owns BEGIN IMMEDIATE, allowing candidate/query/checkpoint completion to be atomic.
  recordInside(observations:CandidateObservation[]) {
    const groups=new Map<string,{id:string;destination:Destination;score:number;claims:EvidenceInput[]}>();
    for(const {destination:d,evidence:e,score} of observations){
      if(d.canonical_url)validateCandidateUrl(d.canonical_url,this.config.url_policies);
      if(d.display_url&&candidateUrl(d.display_url,this.config.url_policies).display_url!==d.display_url)throw new Error('candidate_url_invalid');
      if(!Number.isSafeInteger(e.depth)||e.depth<0||!e.subject_ref||!(/^(?:entity:[a-f0-9]{64}|profile:agamajung)$/.test(e.subject_ref)||/^[A-Za-z0-9_.:-]{1,200}$/.test(e.subject_ref)&&cleanText(e.subject_ref,200)===e.subject_ref)||!e.locator||cleanText(e.locator,200)!==e.locator||cleanText(e.extractor_version,100)!==e.extractor_version)throw new Error('candidate_evidence_invalid');
      const cap=this.store.db.prepare('SELECT url_norm,fetched_at,data FROM engine_captures WHERE id=?').get(e.capture_id) as {url_norm:string;fetched_at:string;data:string}|undefined;
      if(!cap||e.collected_at!==cap.fetched_at||e.source_url!==(JSON.parse(cap.data).final_url??cap.url_norm))throw new Error('candidate_provenance_invalid');
      if(!this.config.providers.some(p=>p.endpoint===e.source_url)&&canonicalUrl(e.source_url)!==e.source_url&&candidateUrl(e.source_url,this.config.url_policies).canonical_url!==e.source_url)throw new Error('candidate_source_invalid');
      const allowedReasons=['unsafe_url','fragment_identity','sensitive_parameter','duplicate_identifier','unknown_parameter','invalid_identifier','missing_identifier'];
      if(d.reasons.some(r=>!allowedReasons.includes(r))||cleanText(d.policy_version,100)!==d.policy_version)throw new Error('candidate_url_invalid');
      const id=this.candidateId(d,e),key=stable([id,e.capture_id,e.locator,e.relation,e.subject_ref,discoveryConditions(e.conditions),e.extractor_version]);
      const g=groups.get(key)??{id,destination:d,score,claims:[]};g.claims.push(e);groups.set(key,g);
    }
    const ids:string[]=[];
    for(const g of groups.values()){
      const d=g.destination,claims=new Map<string,EvidenceInput[]>();
      for(const e of g.claims){const claim={quote:cleanText(e.quote),title:cleanText(e.title??'',200),effective_at:e.effective_at??e.collected_at,effective_basis:e.effective_basis??'observed',fact_status:e.fact_status,source_url:e.source_url,collected_at:e.collected_at};const key=stable(claim),same=claims.get(key)??[];same.push(e);claims.set(key,same);}
      const sample=g.claims[0];
      if(!this.store.db.prepare('SELECT id FROM source_candidates WHERE id=?').get(g.id)){
        const n=this.store.db.prepare('SELECT count(*) n FROM source_candidates WHERE profile_id=? AND added_day=?').get(this.profileId,dayKey(this.store.now())) as {n:number};
        if(n.n>=this.config.max_candidates_day)throw new CostCapError('day',true,'discovery_candidates');
        this.store.db.prepare("INSERT INTO source_candidates VALUES(?,?,?,?,?,'discovered',?,?,?,?,?,?,0,?,?)").run(g.id,this.profileId,d.canonical_url,d.display_url,d.identity,d.policy_version,stable(d.reasons),g.score,'relevance@1',sample.collected_at,sample.collected_at,dayKey(this.store.now()),stable(this.config.url_policies));
      }
      for(const [slot,[claim,same]] of [...claims.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).entries()){
        const e=same[0];
        const conditions=discoveryConditions(e.conditions),conditions_key=stable(conditions),subject=e.subject_ref;
        const id=digest([g.id,e.capture_id,e.locator,e.relation,subject,conditions_key,slot,e.extractor_version]);
        const inserted=this.store.db.prepare('INSERT INTO source_candidate_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,g.id,e.capture_id,e.locator,e.relation,subject,conditions_key,slot,e.extractor_version,e.source_url,e.collected_at,e.effective_at??e.collected_at,e.effective_basis??'observed',e.fact_status,stable({claim:JSON.parse(claim),conditions}));
        for(const pathEvidence of same){
        const path={query_id:pathEvidence.query_id??null,parent_id:pathEvidence.parent_id??null,depth:pathEvidence.depth,deferred_reason:pathEvidence.deferred_reason??null};
        const pid=digest([id,path]);
        const old=this.store.db.prepare('SELECT data FROM source_discovery_paths WHERE id=?').get(pid) as {data:string}|undefined;
        if(old&&old.data!==stable(path))throw new Error('immutable_id_conflict');
        if(!old)this.store.db.prepare('INSERT INTO source_discovery_paths VALUES(?,?,?,?,?,?,?)').run(pid,id,path.query_id,path.parent_id,path.depth,path.deferred_reason,stable(path));
        }
        if(inserted.changes)this.store.db.prepare('UPDATE source_candidates SET first_seen=min(first_seen,?),last_seen=max(last_seen,?),relevance=max(relevance,?),observation_count=(SELECT count(DISTINCT capture_id) FROM source_candidate_evidence WHERE candidate_id=?) WHERE id=?').run(e.collected_at,e.collected_at,g.score,g.id,g.id);
      }
      ids.push(g.id);
    }
    return ids;
  }
  queryInside(provider:string,q:SearchQuery){
    const old=this.store.db.prepare('SELECT data FROM source_discovery_queries WHERE id=?').get(q.id) as {data:string}|undefined;
    if(old&&old.data!==stable(q))throw new Error('immutable_id_conflict');
    if(!old)this.store.db.prepare('INSERT INTO source_discovery_queries(id,profile_id,provider_id,query_text,subject_ref,conditions_key,data) VALUES(?,?,?,?,?,?,?)').run(q.id,this.profileId,provider,q.text,q.subject_ref,stable(discoveryConditions(q.conditions)),stable(q));
  }
  list(id?:string){
    const rows=(id?this.store.db.prepare('SELECT * FROM source_candidates WHERE id=?').all(id):this.store.db.prepare('SELECT * FROM source_candidates ORDER BY first_seen,id LIMIT 500').all()) as CandidateRow[];
    return rows.map(r=>{
      const {url_policy,...row}=r,policies=JSON.parse(String(url_policy));
      if(row.canonical_url)validateCandidateUrl(String(row.canonical_url),policies);
      if(row.display_url&&candidateUrl(String(row.display_url),policies).display_url!==row.display_url)throw new Error('candidate_url_invalid');
      const evidence=id?this.store.db.prepare('SELECT * FROM source_candidate_evidence WHERE candidate_id=? ORDER BY id').all(String(row.id)).map(e=>({
        ...e,data:JSON.parse(String(e.data)),
        capture:this.store.db.prepare('SELECT content_hash,raw_ref,status,fetched_at FROM engine_captures WHERE id=?').get(String(e.capture_id)),
        paths:this.store.db.prepare('SELECT query_id,parent_id,depth,deferred_reason FROM source_discovery_paths WHERE evidence_id=? ORDER BY id').all(String(e.id))
      })):undefined;
      return {...row,reasons:JSON.parse(String(row.reasons)),...(evidence?{evidence}:{})};
    });
  }
}
