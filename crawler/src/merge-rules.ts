import type { AssertionInput } from '../../shared/collection-schema';
import { filterText } from '../../shared/privacy-rules';
export const MERGE_AXES=['release_year','generation','bundle','market'] as const;
export type Axes=Partial<Record<typeof MERGE_AXES[number],string[]>>;
type Claim=AssertionInput&{withdrawn?:boolean;superseded_by?:string};
export function normalizeAxis(axis:string,value:unknown):string|undefined {
  const v=String(value??'').trim().normalize('NFKC');
  if(axis==='release_year')return /^(?:19|20)\d{2}$/.test(v)?v:undefined;
  if(axis==='generation')return v.length<=60&&/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(v)&&filterText(v)===v?v.toLowerCase():undefined;
  if(axis==='bundle')return ['body','set'].includes(v)?v:undefined;
  if(axis==='market')return ['KR','overseas'].includes(v)?v:undefined;
}
export function axesOf(evidence:Claim[]):Axes {
  const axes:Axes={};
  for(const a of evidence.filter(a=>!a.withdrawn&&!a.superseded_by))for(const axis of MERGE_AXES){
    const candidates=[a.conditions?.[axis],...(a.field===axis?[a.value]:[])];
    for(const raw of candidates){const value=normalizeAxis(axis,raw);if(value)(axes[axis]??=[]).push(value);}
  }
  for(const axis of MERGE_AXES)if(axes[axis])axes[axis]=[...new Set(axes[axis])].sort();
  return axes;
}
export const contradictoryAxes=(a:Axes)=>MERGE_AXES.filter(axis=>(a[axis]?.length??0)>1);
export function conflictAxes(a:Axes,b:Axes){return MERGE_AXES.filter(axis=>(a[axis]?.length??0)>1||(b[axis]?.length??0)>1||a[axis]?.length&&b[axis]?.length&&a[axis]!.some(x=>b[axis]!.some(y=>x!==y)));}
export const mergeConflict=(a:Axes,b:Axes)=>conflictAxes(a,b).length>0;
