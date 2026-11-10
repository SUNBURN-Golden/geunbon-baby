import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { checkDealFacts, checkedFacts, type FactCandidates } from '../crawler/lib/deal-fact-check';
import { weeklyReview, formatWeeklyReview } from '../crawler/src/deepseek-web/weekly-review';
import { deepSeekWebCli } from '../crawler/src/deepseek-web/cli';
import { kstDate } from '../crawler/lib/kst';
import type { ReviewQueueItem } from '../crawler/src/deepseek-web/types';
const now=Date.parse('2026-11-10T12:00:00+09:00'), at=new Date(now).toISOString();
const dirs:string[]=[];
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'weekly-review-'));dirs.push(d);return d;};
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function row(id:string,text:string,candidates:FactCandidates={},url=`https://fixture.example/deal?id=${id}`):ReviewQueueItem {
  const fact_check=checkDealFacts(candidates,text,url,at);
  return {id,status:'pending',created_at:at,source_kind:'public_web',verify_level:'model_extract',extraction:{brand:'Stokke',model:'트립트랩',category:'high_chair',period:String(candidates.period??'정보 없음'),gifts:'정보 없음',conditions:'정보 없음',seller:'정보 없음',url,checked_date:kstDate(at),in_scope:true,...checkedFacts(fact_check),fact_check}};
}
const save=(d:string,rows:ReviewQueueItem[])=>writeFileSync(join(d,'review-queue.jsonl'),rows.map(r=>JSON.stringify(r)+'\n').join(''));
test('acceptance week: future bundle, past deadline, open-ended KST day ages, Sunday and Monday',async()=>{
  const d=dir(); save(d,[
    row('missing','스토케 공구',{gonggu_price:'390000'}),
    row('wrong','공구가 390,000원',{gonggu_price:'350000'}),
    row('future','11.30–12.04',{period:'11.30–12.04'}),
    row('ended','마감 2026-11-09',{period:'마감 2026-11-09'}),
    row('old','시작 11.01',{period:'시작 11.01'}),
    row('seven','시작 11.03',{period:'시작 11.03'}),
    row('eight','시작 11.02',{period:'시작 11.02'}),
    row('today','마감 2026-11-10',{period:'마감 2026-11-10'}),
    row('sunday','시작 11.15',{period:'시작 11.15'}),
    row('monday','시작 11.16',{period:'시작 11.16'}),
  ]);
  const packet=await weeklyReview(d,now);
  expect(packet.week_kst).toEqual({start:'2026-11-09T00:00:00+09:00',end_exclusive:'2026-11-16T00:00:00+09:00'});
  expect(packet.excluded.map(r=>[r.id,r.reasons])).toEqual([['future',['future_week']],['ended',['ended']],['monday',['future_week']]]);
  expect(packet.deals.find(r=>r.id==='old')?.warnings).toContain('possibly_ended');
  expect(packet.deals.find(r=>r.id==='seven')?.warnings).not.toContain('possibly_ended');
  expect(packet.deals.find(r=>r.id==='eight')?.warnings).toContain('possibly_ended');
  expect(packet.deals.find(r=>r.id==='today')).toBeDefined();
  expect(packet.deals.find(r=>r.id==='missing')?.facts.gonggu_price).toBeNull();
  expect(packet.counts).toMatchObject({latest:10,reviewable:7,excluded:3,reasons:{future_week:2,ended:1}});
  expect(formatWeeklyReview(packet)).toContain('가격 미확인'); expect(formatWeeklyReview(packet)).toContain('마감일 미확인');
});
test('known endpoint excludes even if another field failed, while ambiguous years do not',async()=>{
  const d=dir();save(d,[row('end','11.01–11.02',{period:'11.03–11.02'}),row('cross','12.31–01.02',{period:'12.31–01.02'})]);
  const p=await weeklyReview(d,now);
  expect(p.excluded[0]).toMatchObject({id:'end',reasons:['ended']});
  expect(p.deals[0]).toMatchObject({id:'cross',warnings:['year_ambiguous']});
});
test('eligibility ages cached facts against each invocation, and date-only ends last through KST midnight',async()=>{
  const d=dir();save(d,[row('time','마감 2026-11-10 12:00',{period:'마감 2026-11-10 12:00'}),row('day','마감 2026-11-10',{period:'마감 2026-11-10'}),row('start','시작 11.03',{period:'시작 11.03'})]);
  expect((await weeklyReview(d,now)).excluded).toHaveLength(0);
  expect((await weeklyReview(d,now+1)).excluded.map(r=>r.id)).toEqual(['time']);
  const midnight=Date.parse('2026-11-11T00:00:00+09:00');
  expect((await weeklyReview(d,midnight-1)).deals.map(r=>r.id)).toContain('day');
  const later=await weeklyReview(d,midnight);
  expect(later.excluded.map(r=>r.id)).toContain('day');
  expect(later.deals.find(r=>r.id==='start')?.warnings).toContain('possibly_ended');
});
test('latest approved/rejected/out-of-scope rows suppress older pending rows; legacy is projected only',async()=>{
  const d=dir(), older=row('older','11.10',{period:'11.10'});
  const approved={...older,id:'approved',status:'approved' as const};
  const rejected={...row('rejected',''),status:'rejected' as const};
  const out=row('out','');out.extraction.in_scope=false;
  const legacy=row('legacy','');delete legacy.extraction.fact_check;delete legacy.extraction.start_date;delete legacy.extraction.end_date;legacy.extraction.gonggu_price='390,000원';legacy.extraction.regular_price='정보 없음';legacy.extraction.period='11.30–12.04';
  save(d,[older,approved,rejected,out,legacy]);const before=readFileSync(join(d,'review-queue.jsonl'));
  const p=await weeklyReview(d,now);
  expect(p.deals).toHaveLength(1);expect(p.deals[0]).toMatchObject({id:'legacy',facts:{gonggu_price:null,start_date:null,end_date:null},warnings:['needs_fact_check']});
  expect(p.counts.omitted).toEqual({decisions:2,out_of_scope:1});expect(readFileSync(join(d,'review-queue.jsonl'))).toEqual(before);
});
test('one excluded record may have two reasons; reason counts overlap',async()=>{
  const d=dir();save(d,[row('both','시작 11.30\n마감 2025-12-31',{period:'시작 11.30\n마감 2025-12-31'})]);
  const p=await weeklyReview(d,now);
  expect(p.counts).toMatchObject({excluded:1,reasons:{future_week:1,ended:1}});
});
test('CLI accepts weekly command before runner/store initialization and rejects extra arguments',async()=>{
  const d=dir(), network=vi.fn(()=>{throw new Error('forbidden');});
  const result=await deepSeekWebCli(['weekly-review','--json'],{stateDir:d,now:()=>now,fetchImpl:network});
  expect(result.counts.reviewable).toBe(0);expect(network).not.toHaveBeenCalled();expect(readdirSync(d)).toEqual([]);
  await expect(deepSeekWebCli(['weekly-review','extra'],{stateDir:d})).rejects.toThrow('weekly_review_invalid_arguments');
});
function child(d:string,args=['weekly-review','--json']) {
  return spawnSync(process.execPath,['--import','./tests/helpers/weekly-review-readonly.mjs','--import','tsx','crawler/deepseek-web/run.mjs',...args],{cwd:process.cwd(),env:{NODE_ENV:'test',PATH:process.env.PATH,HOME:process.env.HOME,DEEPSEEK_WEB_STATE_DIR:d,TSX_DISABLE_CACHE:'1'},encoding:'utf8',timeout:20000});
}
test('executable uses no runtime store, SQLite, model, network or writer and leaves all bytes/entries unchanged',()=>{
  const d=dir();save(d,[row('one','')]);writeFileSync(join(d,'memory.json'),'intentionally unused');mkdirSync(join(d,'extraction-cache'));writeFileSync(join(d,'extraction-cache','unused'),'untouched');
  const names=readdirSync(d),before=readFileSync(join(d,'review-queue.jsonl'));chmodSync(d,0o555);
  try {const r=child(d);expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).version).toBe('weekly-review@1');expect(readdirSync(d)).toEqual(names);expect(readFileSync(join(d,'review-queue.jsonl'))).toEqual(before);expect(readFileSync(join(d,'memory.json'),'utf8')).toBe('intentionally unused');expect(readdirSync(join(d,'extraction-cache'))).toEqual(['unused']);}
  finally{chmodSync(d,0o755);}
});
test('absent queues stay absent; corrupt/incomplete state produces a fixed error, no partial output or repairs',()=>{
  const parent=dir(),missing=join(parent,'absent');const empty=child(missing);expect(empty.status,empty.stderr).toBe(0);expect(JSON.parse(empty.stdout).counts.reviewable).toBe(0);expect(readdirSync(parent)).toEqual([]);
  for(const invalid of ['{bad}\n',JSON.stringify(row('one',''))]){writeFileSync(join(parent,'review-queue.jsonl'),invalid);const result=child(parent);expect(result.status).toBe(2);expect(result.stdout).toBe('');expect(result.stderr.trim()).toBe('weekly_review_unavailable');expect(readFileSync(join(parent,'review-queue.jsonl'),'utf8')).toBe(invalid);expect(readdirSync(parent)).toEqual(['review-queue.jsonl']);}
  const invalid=child(parent,['weekly-review','--wat']);expect(invalid.status).toBe(2);expect(invalid.stderr.trim()).toBe('weekly_review_invalid_arguments');
});
