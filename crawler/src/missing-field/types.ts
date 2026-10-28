import type { FactField } from '../../../shared/collection-schema';
export const EXPLORER_VERSION='missing-field@5';
export type Cause='unextracted'|'not_in_source'|'inaccessible'|'conflict';
export type Slot={id:string;target_ref:string;field:FactField;conditions:Record<string,string>;record_ids:string[];kind:'model'|'offer'};
export type Diagnosis={source_id:string;capture_id:string|null;cause:Cause|null;reason:string;scope?:unknown;refs?:string[]};
export type Assessment={id:string;slot_id:string;input_digest:string;version:string;assessed_at:string;fulfilled:boolean;reviewed:boolean;value:unknown;assertion_ids:string[];diagnoses:Diagnosis[];state:'fulfilled'|'missing'|'assessment_pending';reopened:boolean};
export type ActionKind='improve_extractor'|'reverse_search'|'hold_access'|'review';
export type Action={id:string;slot_id:string;assessment_id:string;kind:ActionKind;diagnosis:Diagnosis};
