// Local Linux diagnostics only. Every emitted field is copied through an allowlist.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_PARSER_VERSION, type DetailedParse } from '../../lib/external/parse';
import { eligibilitySignals, type EligibilitySignals, type PayloadEvaluation, type RejectionReason } from '../../lib/external/filter';
import { digest } from '../dedup';
import type { SourcePolicy } from '../source-policy';
import { failureCode } from './health';
import { CollectorError } from '../store';

export const REJECTION_REASONS = ['excluded_category','not_baby_item','empty_title'] as const;
export type DiagnosticTotals = {
  selected:number; parsed:number; skipped_no_text:number; skipped_no_allowed_link:number;
  examined:number; accepted:number; rejected:number; rejection_reason_counts:Record<RejectionReason,number>;
};
export type ItemDiagnostic = EligibilitySignals & {
  candidate_index:number; item_index:number; reason:'accepted'|RejectionReason;
  has_title:boolean; has_category:boolean; has_price:boolean; has_period:boolean;
};
export type PageEligibilityDiagnostics = DiagnosticTotals & {
  skips:{candidate_index:number;reason:'no_text'|'no_allowed_link'}[]; items:ItemDiagnostic[];
};
export type RunEligibilityDiagnostics = DiagnosticTotals & {
  diagnostic_pages_attempted:number; diagnostic_pages_measured:number; diagnostic_pages_unmeasured:number;
  diagnostic_measured_pages_ok:number; diagnostic_measured_pages_failed:number;
  unmeasured_failures:{transport:Record<string,number>;extraction:Record<string,number>};
  measured_failure_counts:Record<string,number>;
};
export const emptyDiagnosticTotals = ():DiagnosticTotals => ({selected:0,parsed:0,skipped_no_text:0,skipped_no_allowed_link:0,examined:0,accepted:0,rejected:0,
  rejection_reason_counts:{excluded_category:0,not_baby_item:0,empty_title:0}});
export const emptyRunDiagnostics = ():RunEligibilityDiagnostics => ({...emptyDiagnosticTotals(),diagnostic_pages_attempted:0,diagnostic_pages_measured:0,diagnostic_pages_unmeasured:0,
  diagnostic_measured_pages_ok:0,diagnostic_measured_pages_failed:0,unmeasured_failures:{transport:{},extraction:{}},measured_failure_counts:{}});
export const TOTAL_KEYS = ['selected','parsed','skipped_no_text','skipped_no_allowed_link','examined','accepted','rejected'] as const;
export function pageEligibilityDiagnostics(parsed:DetailedParse,evaluations:PayloadEvaluation[]):PageEligibilityDiagnostics {
  const d:PageEligibilityDiagnostics={...emptyDiagnosticTotals(),selected:parsed.selected,parsed:parsed.items.length,examined:parsed.items.length,skips:[],items:[]};
  for(const o of parsed.outcomes){
    if(o.reason!=='parsed'){
      d.skips.push({candidate_index:o.candidate_index,reason:o.reason});
      if(o.reason==='no_text')d.skipped_no_text++;else d.skipped_no_allowed_link++;
      continue;
    }
    const item=parsed.items[o.item_index],evaluation=evaluations[o.item_index];
    if(evaluation.accepted)d.accepted++;else {d.rejected++;d.rejection_reason_counts[evaluation.reason]++;}
    d.items.push({candidate_index:o.candidate_index,item_index:o.item_index,reason:evaluation.accepted?'accepted':evaluation.reason,
      has_title:!!item.title.trim(),has_category:!!item.category_text.trim(),has_price:item.price!==null,has_period:item.dates!==null,
      ...eligibilitySignals(item)});
  }
  return d;
}
export const isSnapup = (source:SourcePolicy) => source.id==='snapup'&&source.origin==='https://snapup.co.kr';
export type DiagnosticContext = {
  mode:'run'|'dry_run';run_ref:string;page_ref:string;attempt_ref:string;captured_at:string;
  execution_revision:string;policy_version:number;configured_selector_is_main:boolean;
};
export type DiagnosticStage='transport'|'extraction'|'submission';
export type EligibilityEvent = DiagnosticContext & (
  {event:'attempt'} |
  {event:'candidate_skip';candidate_index:number;reason:'no_text'|'no_allowed_link'} |
  ({event:'item'} & ItemDiagnostic) |
  {event:'page_summary';totals:DiagnosticTotals} |
  {event:'page_terminal';measured:boolean;outcome:'ok'|'failed';stage?:DiagnosticStage;reason?:string} |
  {event:'run_summary';totals:RunEligibilityDiagnostics}
);
export type EligibilityLog=(event:EligibilityEvent)=>void;
let revision:string|undefined;
function executionRevision():string {
  if(revision!==undefined)return revision;
  try {const value=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1000}).trim();revision=/^[a-f0-9]{40,64}$/.test(value)?value:'unavailable';}
  catch {revision='unavailable';}
  return revision;
}
export function diagnosticContext(mode:DiagnosticContext['mode'],run:string,page:string,attempt:string,at:number,source:SourcePolicy,policyVersion:number):DiagnosticContext {
  return {mode,run_ref:digest(run),page_ref:digest([run,page]),attempt_ref:digest([run,attempt]),captured_at:new Date(at).toISOString(),execution_revision:executionRevision(),policy_version:policyVersion,configured_selector_is_main:source.selector==='main'};
}
const integer=(v:number)=>Number.isSafeInteger(v)&&v>=0?v:0;
const rejection=(v:string):RejectionReason=>REJECTION_REASONS.includes(v as RejectionReason)?v as RejectionReason:'not_baby_item';
function totals(d:DiagnosticTotals):DiagnosticTotals {
  return {selected:integer(d.selected),parsed:integer(d.parsed),skipped_no_text:integer(d.skipped_no_text),skipped_no_allowed_link:integer(d.skipped_no_allowed_link),
    examined:integer(d.examined),accepted:integer(d.accepted),rejected:integer(d.rejected),rejection_reason_counts:{excluded_category:integer(d.rejection_reason_counts.excluded_category),not_baby_item:integer(d.rejection_reason_counts.not_baby_item),empty_title:integer(d.rejection_reason_counts.empty_title)}};
}
export function diagnosticFailure(code:string):string {return failureCode(new CollectorError(code));}
function failures(counts:Record<string,number>):Record<string,number> {
  const out:Record<string,number>={};for(const [code,n] of Object.entries(counts)){const key=diagnosticFailure(code);out[key]=(out[key]??0)+integer(n);}return out;
}
// Also used by tests/custom sinks: do not trust structural TypeScript types at the log boundary.
export function serializeEligibilityEvent(e:EligibilityEvent):Record<string,unknown> {
  const opaque=(s:string)=>/^[a-f0-9]{64}$/.test(s)?s:digest(s);
  const base={source:'snapup',command:'discover',diagnostic_version:1,parser_version:EXTERNAL_PARSER_VERSION,extraction_mode:'server_html',
    mode:e.mode==='dry_run'?'dry_run':'run',run_ref:opaque(e.run_ref),page_ref:opaque(e.page_ref),attempt_ref:opaque(e.attempt_ref),
    captured_at:Number.isFinite(Date.parse(e.captured_at))?new Date(e.captured_at).toISOString():new Date(0).toISOString(),
    execution_revision:/^[a-f0-9]{40,64}$/.test(e.execution_revision)?e.execution_revision:'unavailable',policy_version:integer(e.policy_version),configured_selector_is_main:e.configured_selector_is_main===true};
  switch(e.event){
    case 'attempt':return {...base,event:'attempt'};
    case 'candidate_skip':return {...base,event:'candidate_skip',candidate_index:integer(e.candidate_index),reason:e.reason==='no_text'?'no_text':'no_allowed_link'};
    case 'item':return {...base,event:'item',candidate_index:integer(e.candidate_index),item_index:integer(e.item_index),reason:e.reason==='accepted'?'accepted':rejection(e.reason),
      has_title:e.has_title===true,has_category:e.has_category===true,has_price:e.has_price===true,has_period:e.has_period===true,has_model_category:e.has_model_category===true,
      keyword_match:e.keyword_match===true,model_threshold_match:e.model_threshold_match===true,excluded_title:e.excluded_title===true,excluded_category:e.excluded_category===true,excluded_text:e.excluded_text===true};
    case 'page_summary':return {...base,event:'page_summary',...totals(e.totals)};
    case 'page_terminal':return {...base,event:'page_terminal',measured:e.measured===true,outcome:e.outcome==='ok'?'ok':'failed',
      ...(e.outcome==='failed'?{stage:e.stage==='extraction'?'extraction':e.stage==='submission'?'submission':'transport',reason:diagnosticFailure(e.reason??'error')}:{})};
    case 'run_summary':return {...base,event:'run_summary',...totals(e.totals),
      diagnostic_pages_attempted:integer(e.totals.diagnostic_pages_attempted),diagnostic_pages_measured:integer(e.totals.diagnostic_pages_measured),diagnostic_pages_unmeasured:integer(e.totals.diagnostic_pages_unmeasured),
      diagnostic_measured_pages_ok:integer(e.totals.diagnostic_measured_pages_ok),diagnostic_measured_pages_failed:integer(e.totals.diagnostic_measured_pages_failed),
      unmeasured_failures:{transport:failures(e.totals.unmeasured_failures.transport),extraction:failures(e.totals.unmeasured_failures.extraction)},measured_failure_counts:failures(e.totals.measured_failure_counts)};
    default:return {...base,event:'invalid_event'};
  }
}
export const eligibilityLog:EligibilityLog=e=>console.error(`snapup_eligibility ${JSON.stringify(serializeEligibilityEvent(e))}`);
export function reportEligibilityPage(d:PageEligibilityDiagnostics,context:DiagnosticContext,log:EligibilityLog) {
  for(const skip of d.skips)log({...context,event:'candidate_skip',...skip});
  for(const item of d.items)log({...context,event:'item',...item});
  log({...context,event:'page_summary',totals:totals(d)});
}
