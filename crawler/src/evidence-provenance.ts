import { URL_IDENTITY_VERSION, canonicalUrl } from '../../shared/privacy-rules';
import type { AssertionInput, ClipPayload } from '../../shared/collection-schema';
import type { CollectorStore, Evidence } from './store';
import { digest, stable } from './dedup';
import { privacyFilter } from './privacy-filter';
export const PROVENANCE_VERSION='extracted-service@1';
export type ExtractedFact={id:string;capture_id:string;subject_ref:string;field:string;source_url:string;locator:string;quote:string|null;collected_at:string;effective_from:string;effective_from_basis:string;fact_status:string;extractor:string;data:string};
export type ProvenanceInput={capture_id:string;extractor:string;ids:string[]};
export function assertionDigest(a:AssertionInput){return digest(privacyFilter({assertions:[a]}).assertions);}
export function validateProvenance(store:CollectorStore,p:ClipPayload,input:ProvenanceInput,url:string){
  const cap=store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(input.capture_id) as {url_norm:string;fetched_at:string;status:string;data:string}|undefined;
  if(cap&&(JSON.parse(cap.data).url_identity_version!==URL_IDENTITY_VERSION||canonicalUrl(cap.url_norm)!==cap.url_norm))throw new Error('url_identity_changed');
  if(!cap||cap.url_norm!==url||!['ok','not_modified'].includes(cap.status)||input.ids.length!==p.assertions.length||new Set(input.ids).size!==input.ids.length)throw new Error('provenance_invalid');
  return input.ids.map((id,index)=>{
    const fact=store.db.prepare('SELECT * FROM engine_extracted WHERE id=?').get(id) as ExtractedFact|undefined;
    if(!fact||fact.capture_id!==input.capture_id||fact.extractor!==input.extractor||fact.source_url!==url||fact.collected_at!==cap.fetched_at||!['verified','source_claim'].includes(fact.fact_status)||fact.locator!==p.assertions[index].locator||fact.quote!==p.assertions[index].quote||assertionDigest(JSON.parse(fact.data).assertion)!==assertionDigest(p.assertions[index]))throw new Error('provenance_invalid');
    return fact;
  });
}
// The caller owns the intake/backfill transaction. No value/URL similarity matching.
export function linkExtractedInside(store:CollectorStore,fact:ExtractedFact,e:Evidence,receipt:string|null,basis='native'){
  const a=JSON.parse(fact.data).assertion as AssertionInput;
  const transformed={...a,field:e.field,...(basis==='legacy_id'&&a.msrp_explicit===undefined?{msrp_explicit:e.msrp_explicit}:{})};
  if(fact.source_url!==e.url||fact.locator!==e.locator||fact.quote!==e.quote||assertionDigest(transformed)!==assertionDigest(e))throw new Error('provenance_invalid');
  const data={claim_digest:assertionDigest(e),version:PROVENANCE_VERSION,basis,field_transform:{from:a.field,to:e.field}};
  const old=store.db.prepare('SELECT assertion_id,receipt_id,data FROM extracted_assertion_links WHERE extracted_id=?').get(fact.id) as {assertion_id:string;receipt_id:string|null;data:string}|undefined;
  if(old){if(old.assertion_id!==e.id||old.receipt_id!==receipt||old.data!==stable(data))throw new Error('provenance_reused');return;}
  store.db.prepare('INSERT INTO extracted_assertion_links VALUES(?,?,?,?,?,?)').run(fact.id,e.id,receipt,digest(data),new Date(store.now()).toISOString(),stable(data));
}
export function recoverLegacyLinksInside(store:CollectorStore){
  const facts=store.db.prepare("SELECT * FROM engine_extracted WHERE json_type(data,'$.legacy_id')='text' ORDER BY id").all() as unknown as ExtractedFact[];
  for(const f of facts){
    const e=store.get<Evidence>('evidence_assertions',JSON.parse(f.data).legacy_id);if(!e)continue;
    if(store.db.prepare('SELECT 1 FROM extracted_assertion_links WHERE assertion_id=? OR extracted_id=?').get(e.id,f.id))continue;
    try{linkExtractedInside(store,f,e,null,'legacy_id');}catch(error){if(!(error instanceof Error)||error.message!=='provenance_invalid')throw error;}
  }
}
