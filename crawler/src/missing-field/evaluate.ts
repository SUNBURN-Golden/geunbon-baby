import type { CollectionRecord } from '../../../shared/collection-schema';
import type { CollectorStore, Evidence } from '../store';
import type { ExtractedFact } from '../evidence-provenance';
import { LINUX_PRIVACY_VERSION } from '../privacy-filter';
import { assertionDigest } from '../evidence-provenance';
import { digest, stable } from '../dedup';
import { EVIDENCE_POLICY_VERSION, comparisons, validClaim, scopeConditions, OFFER_FIELDS, offerScope } from '../evidence-policy';
import { ruleDiagnostics } from '../agamajung/rules';
import type { Parsed } from '../agamajung/pipeline';
import { EXPLORER_VERSION, type Assessment, type Diagnosis, type Slot } from './types';
type Capture={id:string;source_id:string;url_norm:string;content_hash:string|null;status:string;fetched_at:string;data:string};
const accessCodes=['source_blocked','login_required','access_restricted','empty_page','robots_denied','visit_not_allowed'];
function captureAccessFailure(store:CollectorStore,cap:Capture):string|undefined {
  if(['blocked','restricted','skipped_policy'].includes(cap.status)){
    const reason=JSON.parse(cap.data).reason;
    return accessCodes.includes(reason)?reason:cap.status;
  }
  // Rendering can fail after a successful HTTP capture. Bind that failure to its
  // exact capture, and ignore checkpoints that have since completed on resume.
  const failure=store.db.prepare("SELECT error_code FROM engine_checkpoints WHERE json_extract(data,'$.capture_id')=? AND phase='failed' AND error_code IN ('source_blocked','login_required','access_restricted','empty_page','robots_denied','visit_not_allowed') ORDER BY rowid DESC LIMIT 1").get(cap.id);
  return failure?String(failure.error_code):undefined;
}
export function parsedFor(store:CollectorStore,cap:Capture,fact?:ExtractedFact):Parsed|undefined {
  const tool=fact?JSON.parse(fact.data).parse_tool:undefined;
  if(tool){const row=store.db.prepare("SELECT data FROM engine_cache WHERE content_hash=? AND stage='parse' AND tool=?").get(cap.content_hash,tool) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  // Absence assessments require one unambiguous, versioned cache; old caches cannot prove absence.
  const rows=store.db.prepare("SELECT data FROM engine_cache WHERE content_hash=? AND stage='parse' AND instr(tool,?)>0").all(cap.content_hash,`:${cap.source_id}:`) as {data:string}[];
  const parsed=rows.map(r=>JSON.parse(r.data) as Parsed).filter(p=>p.inspection?.version==='inspection@1');
  return parsed.length===1?parsed[0]:undefined;
}
function matching(slot:Slot,e:Evidence,r:CollectionRecord){
  const c={...slot.conditions},ec={...scopeConditions(e),...(OFFER_FIELDS.includes(e.field)?offerScope(e):{})};
  for(const [k,v] of Object.entries(ec))if(k!=='scheme'&&c[k]!==v)return false;
  for(const k of ['effective_at','effective_until'])if((e.conditions?.[k]??'')!==(c[k]??''))return false;
  // A member's independently stated model axes apply only within that member.
  return slot.record_ids.includes(r.id)&&e.field===slot.field;
}
export function inputDigest(store:CollectorStore,slot:Slot,asOf=store.asOf){
  const records=slot.record_ids.map(id=>store.get<CollectionRecord>('collection_records',id));
  const groups=[...new Set(records.flatMap(r=>r?[r.dedup_group_id]:[]))].sort().map(id=>[id,store.reviewValidity(id,asOf).input_digest]);
  const captures=records.flatMap(r=>r?store.db.prepare('SELECT * FROM engine_captures WHERE url_norm=? ORDER BY fetched_at,id').all(r.url):[]) as Capture[];
  const facts=captures.flatMap(c=>store.db.prepare('SELECT * FROM engine_extracted WHERE capture_id=? ORDER BY id').all(c.id));
  const links=facts.flatMap(f=>store.db.prepare('SELECT * FROM extracted_assertion_links WHERE extracted_id=?').all(f.id));
  const caches=captures.flatMap(c=>store.db.prepare("SELECT * FROM engine_cache WHERE content_hash=? AND stage='parse' ORDER BY tool").all(c.content_hash));
  const accessFailures=captures.map(c=>[c.id,captureAccessFailure(store,c)??null]);
  return digest([EXPLORER_VERSION,EVIDENCE_POLICY_VERSION,LINUX_PRIVACY_VERSION,slot,records.map(r=>r?{id:r.id,url:r.url,target:r.target_model_id,group:r.dedup_group_id,collected:r.collected_at,checked:r.last_checked_at,recheck:r.next_recheck_at,privacy:r.privacy_filter_version}:null),records.map(r=>!!r?.next_recheck_at&&Date.parse(r.next_recheck_at)>asOf),groups,captures,facts,facts.map(f=>factExpired(store,f as unknown as ExtractedFact,asOf)),links,caches,accessFailures,store.settings.policy_version]);
}
function factExpired(store:CollectorStore,fact:ExtractedFact,asOf:number){
  const source=store.settings.sources.find(s=>s.id===String(store.db.prepare('SELECT source_id FROM engine_captures WHERE id=?').get(fact.capture_id)?.source_id));
  const c=JSON.parse(fact.data).assertion?.conditions??{};
  return !source||Date.parse(fact.collected_at)+source.recheck_ms<=asOf||c.effective_until&&Date.parse(c.effective_until)<=asOf||c.effective_at&&Date.parse(c.effective_at)>asOf;
}
function eligible(store:CollectorStore,e:Evidence):{ok:boolean;reason:string;fact?:ExtractedFact}{
  const document=store.get<CollectionRecord>('collection_records',e.record_id);
  if(!document?.last_checked_at||!document.next_recheck_at||Date.parse(document.next_recheck_at)<=store.asOf||e.conditions?.effective_until&&Date.parse(e.conditions.effective_until)<=store.asOf)return {ok:false,reason:'evidence_expired'};
  const fact=store.db.prepare('SELECT x.* FROM engine_extracted x JOIN extracted_assertion_links l ON l.extracted_id=x.id WHERE l.assertion_id=?').get(e.id) as ExtractedFact|undefined;
  if(!fact)return {ok:false,reason:'provenance_unlinked'};
  const cap=store.db.prepare('SELECT * FROM engine_captures WHERE id=?').get(fact.capture_id) as Capture|undefined;
  if(factExpired(store,fact,store.asOf))return {ok:false,reason:'evidence_expired',fact};
  if(!cap||!['ok','not_modified'].includes(cap.status)||!cap.content_hash||fact.source_url!==cap.url_norm||fact.source_url!==e.url||fact.locator!==e.locator||fact.quote!==e.quote||fact.collected_at!==cap.fetched_at)return {ok:false,reason:'capture_unavailable',fact};
  if(!['verified','source_claim'].includes(fact.fact_status)||!fact.extractor||!Number.isFinite(Date.parse(fact.effective_from))||!['stated','observed'].includes(fact.effective_from_basis))return {ok:false,reason:'ineligible_fact_status',fact};
  const assertion=JSON.parse(fact.data).assertion;
  if(assertionDigest({...assertion,field:e.field})!==assertionDigest(e)||!validClaim(e))return {ok:false,reason:'invalid_claim',fact};
  const parsed=parsedFor(store,cap,fact),line=/:line:(\d+)$/.exec(e.locator);
  if(!parsed||!line||!parsed.inspection||e.locator!==`${parsed.inspection.locator_base}:line:${line[1]}`||!parsed.text.split('\n')[Number(line[1])-1]?.includes(e.quote))return {ok:false,reason:'locator_unverifiable',fact};
  // Reuse the rule diagnostics to check that the quoted segment actually asserts this value.
  const candidates=ruleDiagnostics(parsed.text,parsed.inspection.locator_base).candidates;
  if(!candidates.some(({assertion:a})=>a.locator===e.locator&&(a.field===e.field||a.field==='official_msrp'&&e.field==='clue_price')&&assertionDigest({...a,field:e.field})===assertionDigest(e)))return {ok:false,reason:'claim_not_supported',fact};
  if(e.field==='official_msrp'&&(e.level!=='authorized'||!e.msrp_explicit||!['manufacturer','importer'].includes(e.source_kind)))return {ok:false,reason:'msrp_authority_missing',fact};
  if(e.field==='certifications'&&(e.conditions?.scheme!=='KC'||e.conditions?.market!=='KR'))return {ok:false,reason:'applicability_unknown',fact};
  return {ok:true,reason:'eligible',fact};
}
export function evaluateSlot(store:CollectorStore,slot:Slot):Assessment {return store.readSnapshot(()=>evaluateInside(store,slot));}
function evaluateInside(store:CollectorStore,slot:Slot):Assessment {
  const input=inputDigest(store,slot),id=digest([EXPLORER_VERSION,slot.id,input]);
  const prior=store.db.prepare('SELECT data FROM missing_field_assessments WHERE id=?').get(id) as {data:string}|undefined;
  if(prior)return JSON.parse(prior.data);
  const diagnoses:Diagnosis[]=[],accepted:Evidence[]=[],records=slot.record_ids.map(id=>store.get<CollectionRecord>('collection_records',id)).filter((r):r is CollectionRecord=>!!r);
  let blocked=false;
  for(const r of records){
    const scope=store.scope(r.dedup_group_id),claims=scope.evidence.filter(e=>!e.withdrawn&&!e.superseded_by&&slot.record_ids.includes(e.record_id)&&matching(slot,e,r));
    const conflicts=scope.conflicts.filter(c=>c.assertions.some(id=>claims.some(e=>e.id===id)));
    const excluded=new Set(conflicts.filter(c=>c.resolved).flatMap(c=>c.assertions.filter(id=>id!==c.selected)));
    const selected=new Set(conflicts.filter(c=>c.resolved&&c.selected).map(c=>c.selected!));
    const inconsistent=[...selected].some(id=>excluded.has(id));
    const undecided=store.policyComparisons(r.dedup_group_id).some(p=>p.result==='assessment_pending'&&p.a.field===slot.field&&p.assertions.some(id=>claims.some(e=>e.id===id)&&!excluded.has(id)));
    const unresolved=conflicts.some(c=>!c.resolved)||inconsistent;
    if(!store.groupMergeSafe(r.dedup_group_id)||undecided||unresolved){
      blocked=true;diagnoses.push({source_id:r.source,capture_id:null,cause:unresolved?'conflict':null,reason:unresolved?'unresolved_conflict':undecided?'scope_ambiguous':'merge_axes_conflict',refs:conflicts.map(c=>c.id)});
    }
    for(const e of claims){
      if(excluded.has(e.id))continue;
      const check=eligible(store,e);
      if(check.ok)accepted.push(e);
      else diagnoses.push({source_id:r.source,capture_id:check.fact?.capture_id??null,cause:null,reason:check.reason,refs:[e.id]});
    }
    const cap=store.db.prepare('SELECT * FROM engine_captures WHERE url_norm=? ORDER BY fetched_at DESC,rowid DESC LIMIT 1').get(r.url) as Capture|undefined;
    const accessFailure=cap?captureAccessFailure(store,cap):undefined;
    if(cap&&accessFailure){
      diagnoses.push({source_id:r.source,capture_id:cap.id,cause:'inaccessible',reason:accessFailure});continue;
    }
    if(claims.length)continue;
    if(!cap){diagnoses.push({source_id:r.source,capture_id:null,cause:null,reason:'capture_unavailable'});continue;}
    const parsed=parsedFor(store,cap),inspection=parsed?.inspection;
    if(!parsed||!inspection||!inspection.complete||inspection.truncated||inspection.tool_status!=='supported'){
      diagnoses.push({source_id:r.source,capture_id:cap.id,cause:null,reason:'inspection_incomplete',scope:inspection??null});continue;
    }
    const existing=store.db.prepare('SELECT 1 FROM engine_extracted WHERE capture_id=? AND field=? LIMIT 1').get(cap.id,slot.field);
    if(existing){diagnoses.push({source_id:r.source,capture_id:cap.id,cause:null,reason:'provenance_unlinked'});continue;}
    const diagnostics=ruleDiagnostics(parsed.text,inspection.locator_base),fieldCandidates=diagnostics.candidates.filter(c=>c.assertion.field===slot.field);
    const candidates=fieldCandidates.filter(c=>validClaim(c.assertion));
    if(candidates.length)diagnoses.push({source_id:r.source,capture_id:cap.id,cause:'unextracted',reason:'rule_candidate_without_fact',scope:inspection,refs:candidates.map(c=>c.assertion.locator)});
    else if(fieldCandidates.length||diagnostics.rejected.some(c=>c.field===slot.field))diagnoses.push({source_id:r.source,capture_id:cap.id,cause:null,reason:'field_candidate_rejected',scope:inspection,refs:[...new Set([...fieldCandidates.map(c=>c.assertion.locator),...diagnostics.rejected.filter(c=>c.field===slot.field).map(c=>c.locator)])]});
    else diagnoses.push({source_id:r.source,capture_id:cap.id,cause:'not_in_source',reason:'inspected_region_absent',scope:inspection});
  }
  const unique=[...new Map(accepted.map(e=>[e.id,e])).values()];
  if(comparisons(unique).some(p=>['conflict','assessment_pending'].includes(p.result))){blocked=true;diagnoses.push({source_id:'multiple',capture_id:null,cause:comparisons(unique).some(p=>p.result==='conflict')?'conflict':null,reason:'cross_scope_review_required',refs:unique.map(e=>e.id)});}
  // A conflict in a compatibility/certification subclaim blocks the whole required slot.
  const fulfilled=!blocked&&unique.length>0;
  const reviewed=fulfilled&&records.every(r=>store.reviewValidity(r.dedup_group_id).reviewed)&&unique.every(e=>{
    const r=store.get<CollectionRecord>('collection_records',e.record_id)!;return store.reviewValidity(r.dedup_group_id).reviewed;
  });
  const previous=store.db.prepare('SELECT a.data FROM missing_field_slots s JOIN missing_field_assessments a ON a.id=s.assessment_id WHERE s.id=?').get(slot.id) as {data:string}|undefined;
  return {id,slot_id:slot.id,input_digest:input,version:EXPLORER_VERSION,assessed_at:new Date(store.asOf).toISOString(),fulfilled,reviewed,value:fulfilled?unique.map(e=>e.value):null,assertion_ids:fulfilled?unique.map(e=>e.id).sort():[],diagnoses:[...new Map(diagnoses.map(d=>[stable(d),d])).values()],state:fulfilled?'fulfilled':diagnoses.some(d=>d.cause===null)?'assessment_pending':'missing',reopened:!!previous&&JSON.parse(previous.data).fulfilled&&!fulfilled};
}
