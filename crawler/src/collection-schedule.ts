import { readFileSync } from 'node:fs';
import { digest } from './dedup';
import { requireThat } from './store';
export const JOBS = ['discover','collect','discover-sources','backfill-engine'] as const;
export type CollectionJob = typeof JOBS[number];
export type JobSchedule = {job:CollectionJob;enabled:boolean;times:string[]};
export type SlotBatch = {version:string;first:number;target:number;count:number};
const DAY=86400000, KST=9*3600000;
export const kstDay=(at:number)=>new Date(at+KST).toISOString().slice(0,10);
export const kstTime=(at:number)=>new Date(at+KST).toISOString().replace('Z','+09:00');
export function validateSchedule(value:unknown):JobSchedule[] {
  const jobs=(value as {jobs?:JobSchedule[]})?.jobs;
  requireThat(Array.isArray(jobs)&&jobs.length===JOBS.length,'schedule_config');
  requireThat(new Set(jobs!.map(s=>s.job)).size===JOBS.length,'schedule_config');
  for(const s of jobs!)requireThat(JOBS.includes(s.job)&&typeof s.enabled==='boolean'&&Array.isArray(s.times)&&s.times.length>0&&s.times.every(t=>typeof t==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))&&new Set(s.times).size===s.times.length,'schedule_config');
  return jobs!.map(s=>({...s,times:[...s.times].sort()}));
}
export const loadSchedule=()=>validateSchedule(JSON.parse(readFileSync(new URL('../config/schedule.json',import.meta.url),'utf8')));
// Arithmetic over fixed KST days: independent of host TZ, DST and elapsed timer ticks.
export function dueSlots(schedule:JobSchedule,now:number,after?:number):SlotBatch|undefined {
  requireThat(Number.isFinite(now)&&(after===undefined||Number.isFinite(after)),'schedule_clock');
  const offsets=schedule.times.map(t=>(Number(t.slice(0,2))*60+Number(t.slice(3)))*60000).sort((a,b)=>a-b);
  const day=Math.floor((now+KST)/DAY)*DAY-KST;
  const today=offsets.filter(t=>day+t<=now);
  const target=today.length?day+today.at(-1)!:day-DAY+offsets.at(-1)!;
  if(after!==undefined&&target<=after)return;
  const rank=(t:number)=>{const d=Math.floor((t+KST)/DAY);return d*offsets.length+offsets.filter(o=>d*DAY-KST+o<=t).length;};
  const count=after===undefined?1:rank(target)-rank(after);
  const afterDay=after===undefined?day:Math.floor((after+KST)/DAY)*DAY-KST;
  const next=after===undefined?target:offsets.map(o=>afterDay+o).find(t=>t>after)??afterDay+DAY+offsets[0];
  return {version:digest([schedule.job,schedule.times]),first:next,target,count};
}
