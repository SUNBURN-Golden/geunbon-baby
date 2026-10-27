import type { AssertionInput } from '../../shared/collection-schema';
export const MERGE_AXES=['release_year','generation','bundle','market'] as const;
export type Axes=Partial<Record<typeof MERGE_AXES[number],string[]>>;
type Claim=AssertionInput&{withdrawn?:boolean;superseded_by?:string};
export function axesOf(evidence:Claim[]):Axes {
  const axes:Axes={};
  for(const a of evidence.filter(a=>!a.withdrawn&&!a.superseded_by)){
    if(a.field==='release_year'||a.field==='generation')(axes[a.field]??=[]).push(String(a.value).trim().normalize('NFKC').toLowerCase());
    for(const axis of ['bundle','market'] as const){const value=a.conditions?.[axis];if(value&&(['body','set','KR','overseas'].includes(value)))(axes[axis]??=[]).push(value);}
  }
  for(const axis of MERGE_AXES)if(axes[axis])axes[axis]=[...new Set(axes[axis])].sort();
  return axes;
}
export function conflictAxes(a:Axes,b:Axes){return MERGE_AXES.filter(axis=>a[axis]?.length&&b[axis]?.length&&a[axis]!.some(x=>b[axis]!.some(y=>x!==y)));}
export const mergeConflict=(a:Axes,b:Axes)=>conflictAxes(a,b).length>0;
