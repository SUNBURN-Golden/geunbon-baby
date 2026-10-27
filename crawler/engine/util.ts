import { createHash } from 'node:crypto';
export function stable(v:unknown):string {
  if(Array.isArray(v))return `[${v.map(stable).join(',')}]`;
  if(v&&typeof v==='object')return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  return JSON.stringify(v);
}
export const digest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
export const hashBytes=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
export const dayKey=(t:number)=>new Date(t+9*3600000).toISOString().slice(0,10);
export const midnight=(t:number)=>Date.parse(`${dayKey(t)}T00:00:00+09:00`)+86400000;
