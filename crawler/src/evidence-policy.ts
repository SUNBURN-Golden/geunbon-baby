import type { CollectionRecord } from '../../shared/collection-schema';
import { PRIVACY_VERSION } from '../../shared/privacy-rules';
import { LINUX_PRIVACY_VERSION } from './privacy-filter';
import { digest, stable } from './dedup';
import { axesOf, contradictoryAxes } from './merge-rules';
import { EVIDENCE_POLICY_VERSION, evaluateConflictSet, validClaim } from './conflict-policy';
import type { Group, Evidence, Conflict } from './store';
export * from './conflict-policy';
export const REVIEW_POLICY_VERSION='review-scope@1';
export type ReviewScopeSnapshot={root:string;groups:Group[];documents:CollectionRecord[];evidence:{group_id:string;claims:Evidence[];resolutions:Conflict[]}[];links:unknown[];provenance:unknown[];reviews:{id:string;group_id:string;decision:string;review_scope_digest:string;policy_version:string}[];policy:number;epoch:number;complete:boolean};

// Pure: all members and recursively linked owner groups share one asOf and input
// snapshot. Cache versions, materialized statuses and report counters are excluded.
export function reviewScopeValidity(scope:ReviewScopeSnapshot,asOf:number){
  const documents=scope.documents.map(r=>({id:r.id,url:r.url,group:r.dedup_group_id,target:r.target_model_id,privacy:r.privacy_filter_version,collected_at:r.collected_at,last_checked_at:r.last_checked_at,next_recheck_at:r.next_recheck_at,
    fresh:!!r.last_checked_at&&Number.isFinite(Date.parse(r.next_recheck_at??''))&&Date.parse(r.next_recheck_at!)>asOf})).sort((a,b)=>a.id.localeCompare(b.id));
  const evaluations=scope.evidence.map(g=>({group_id:g.group_id,...evaluateConflictSet(g.claims.map(e=>({...e,...(!documents.find(r=>r.id===e.record_id)?.fresh?{unavailable_reason:'source_expired'}:{})})),g.resolutions,asOf)}));
  const claims=[...new Map(scope.evidence.flatMap(g=>g.claims).map(e=>[e.id,e])).values()];
  const active=claims.filter(e=>!e.withdrawn&&!e.superseded_by);
  const axes=axesOf(active),merge_safe=!contradictoryAxes(axes).length;
  const unresolved=evaluations.some(g=>g.pending||g.reopened.length>0||g.pairs.some(p=>p.result==='conflict'&&!p.resolution));
  const selected=evaluations.flatMap(g=>g.pairs.flatMap(p=>p.resolution?.selected?[p.resolution.selected]:[]));
  const excluded=new Set(evaluations.flatMap(g=>g.pairs.flatMap(p=>p.resolution?p.assertions.filter(id=>id!==p.resolution!.selected):[])));
  const evidence_valid=active.length>0&&active.every(e=>e.locator&&e.quote&&validClaim(e));
  const requirements=scope.complete&&documents.length>0&&documents.every(r=>r.fresh&&r.privacy===PRIVACY_VERSION)&&merge_safe&&evidence_valid&&!unresolved&&!selected.some(id=>excluded.has(id));
  const semantic={version:REVIEW_POLICY_VERSION,conflict_policy:EVIDENCE_POLICY_VERSION,privacy:LINUX_PRIVACY_VERSION,policy:scope.policy,epoch:scope.epoch,complete:scope.complete,root:scope.root,
    groups:scope.groups.map(g=>({id:g.id,retired:!!g.retired,representative:g.representative})).sort((a,b)=>a.id.localeCompare(b.id)),documents,
    claims:claims.sort((a,b)=>a.id.localeCompare(b.id)),links:scope.links,provenance:scope.provenance,
    conflicts:evaluations.map(g=>({group:g.group_id,input:g.input_digest,reopened:g.reopened,pairs:g.pairs.map(p=>({assertions:p.assertions,result:p.result,resolution:p.resolution??null}))}))};
  const scope_digest=digest(semantic),root=scope.groups.find(g=>g.id===scope.root);
  const reviewed=requirements&&scope.reviews.some(e=>e.group_id===scope.root&&e.decision==='verify'&&e.review_scope_digest===scope_digest&&e.policy_version===REVIEW_POLICY_VERSION)&&root?.review_policy_version===REVIEW_POLICY_VERSION&&root.verified_scope_digest===scope_digest&&root.verified_evidence_version!==null;
  const ready=reviewed&&root?.ready_scope_digest===scope_digest&&root.ready_evidence_version!==null;
  const approvals=scope.groups.map(g=>({id:g.id,policy:g.review_policy_version??null,verified:g.verified_scope_digest??null,ready:g.ready_scope_digest??null})).sort((a,b)=>a.id.localeCompare(b.id));
  return {scope_digest,input_digest:digest([semantic,approvals,scope.reviews]),requirements,reviewed:!!reviewed,ready:!!ready,merge_safe,documents,evaluations,
    next_boundary:Math.min(Infinity,...documents.flatMap(r=>r.fresh?[Date.parse(r.next_recheck_at!)]:[]),...evaluations.map(g=>g.next_boundary)),
    reasons:[...(!scope.complete?['scope_incomplete']:[]),...(documents.some(r=>!r.fresh)?['scope_document_expired']:[]),...(!merge_safe?['merge_axes_conflict']:[]),...(unresolved?['scope_conflict_or_pending']:[])]};
}

export const ordered=<T>(items:T[])=>items.sort((a,b)=>stable(a).localeCompare(stable(b)));
