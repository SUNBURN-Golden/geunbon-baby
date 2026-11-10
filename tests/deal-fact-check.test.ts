import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { checkDealFacts, checkedFacts, validFactCheck, validateCheckedText, publishDate, interpretSchedule, type FactCandidates } from '../crawler/lib/deal-fact-check';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
import { checkExtraction, validateExtraction, validateCheckedExtraction } from '../crawler/src/deepseek-web/extract';
const source = 'https://fixture.example/deal';
const at = '2026-11-10T12:00:00+09:00';
const check = (text: string, candidate: FactCandidates) => checkDealFacts(candidate, text, source, at);
const cases = JSON.parse(readFileSync(new URL('./fixtures/deal-facts/cases.json', import.meta.url), 'utf8')) as {name:string;text:string;candidate:FactCandidates;price:number|null;regular?:number|null;start?:number|null;end?:number|null}[];
test.each(cases)('$name', fixture => {
  const c = check(fixture.text, fixture.candidate);
  expect(c.fields.gonggu_price.value).toBe(fixture.price);
  if ('regular' in fixture) expect(c.fields.regular_price.value).toBe(fixture.regular);
  if ('start' in fixture) expect(c.fields.start_date.value?.day ?? null).toBe(fixture.start);
  if ('end' in fixture) expect(c.fields.end_date.value?.day ?? null).toBe(fixture.end);
  expect(validFactCheck(c)).toBe(true);
  validateCheckedText(c, fixture.text);
});
test('source-supported year and exact sanitized spans, including Unicode forms', () => {
  const text = '스토케 트립트랩 공구\n공구가 ₩３９０，０００\n기간 2026년 11월 10일–11월 15일';
  const c = check(text, {gonggu_price:'39만원',period:'2026-11-10–2026-11-15'});
  expect(c.fields.gonggu_price.value).toBe(390000);
  expect(c.fields.end_date.value).toMatchObject({year:2026,month:11,day:15,precision:'day'});
  for (const f of Object.values(c.fields)) if (f.evidence) expect(text.slice(f.evidence.start, f.evidence.end)).toBe(f.evidence.quote);
  expect(publishDate(c.fields.start_date.value)).toBe('2026-11-09T15:00:00.000Z');
  expect(publishDate(c.fields.end_date.value,true)).toBe('2026-11-15T14:59:59.999Z');
  const corrupt = structuredClone(c); corrupt.fields.gonggu_price.value = 350000;
  expect(validFactCheck(corrupt)).toBe(false);
  expect(() => validateCheckedText(c,text+'changed')).toThrow('extraction_result_invalid');
});
test('unsupported inferred years and impossible dates become null', () => {
  const unsupported = check('11.10–11.15',{period:'2026-11-10–2026-11-15'});
  expect(unsupported.fields.start_date.value).toBeNull(); expect(unsupported.fields.end_date.value).toBeNull();
  for (const period of ['2026-02-29','2026-04-31','13.10','11.31']) expect(check(period,{period}).fields.start_date).toMatchObject({value:null,reason:'invalid'});
  expect(check('20260-11-10',{period:'20260-11-10'}).fields.start_date.value).toBeNull();
  expect(check('02.29',{period:'02.29'}).fields.start_date.value).toMatchObject({year:null,month:2,day:29});
});
test('contradictory ranges invalidate schedule with diagnostic evidence', () => {
  for (const period of ['11.15–11.10','2026-11-15–2026-11-10']) {
    const c = check(period,{period});
    expect(c.fields.start_date).toMatchObject({value:null,reason:'contradictory_range'});
    expect(c.fields.end_date).toMatchObject({value:null,reason:'contradictory_range'});
    expect(validFactCheck(c)).toBe(true);
  }
});
test('independent explicit endpoint candidates and end-only schedules survive', () => {
  const c = check('시작 11.10\n마감 11.15',{start_date:'11.09',end_date:'11.15'});
  expect(c.fields.start_date.value).toBeNull(); expect(c.fields.end_date.value?.day).toBe(15);
  expect(check('마감 11.15',{period:'마감 11.15'}).fields.end_date.value?.day).toBe(15);
});
test('year ambiguity stays in interpretation and never creates publishable years', () => {
  const c = check('12.31–01.02',{period:'12.31–01.02'});
  expect(c.fields.start_date.value?.year).toBeNull(); expect(c.fields.end_date.value?.year).toBeNull();
  expect(interpretSchedule(c)).toEqual({start:{at:null,year_ambiguous:true},end:{at:null,year_ambiguous:true}});
  expect(publishDate(c.fields.start_date.value)).toBeNull();
  const december = checkDealFacts({period:'01.02'},'01.02',source,'2026-12-10T00:00:00+09:00');
  expect(interpretSchedule(december).start.year_ambiguous).toBe(true);
});
test('explicit time precision is retained and invalid times are missing', () => {
  for (const [value,precision] of [['2026-11-10 12시','hour'],['2026-11-10 12:30','minute'],['2026-11-10T12:30:45','second']] as const) {
    const c=check(value,{period:value}); expect(c.fields.start_date.value?.precision).toBe(precision); expect(validFactCheck(c)).toBe(true);
  }
  expect(check('2026-11-10 25:00',{period:'2026-11-10 25:00'}).fields.start_date.value).toBeNull();
});
test('only the bounded prepared text can establish evidence', () => {
  const page = preparePage(`<article><h1>스토케 트립트랩 공구</h1><p>${'x'.repeat(12500)}</p><p>공구가 390,000원</p></article>`, source);
  const c=checkDealFacts({gonggu_price:'390000'},page.text,source,at,page.truncated);
  expect(c.truncated).toBe(true); expect(c.fields.gonggu_price.value).toBeNull();
});
test('existing sample-page/mock-completion is positive source evidence', () => {
  const page=preparePage(readFileSync(new URL('./fixtures/deepseek-web/sample-page.txt',import.meta.url),'utf8'),source);
  const mock=JSON.parse(readFileSync(new URL('./fixtures/deepseek-web/mock-completion.json',import.meta.url),'utf8'));
  const result=checkExtraction(validateExtraction(mock.content,source,'2026-11-10'),page,at);
  expect(result).toMatchObject({gonggu_price:390000,regular_price:430000,start_date:{year:2026,month:10,day:25},end_date:{year:2026,month:10,day:28}});
  validateCheckedExtraction(result); expect(checkedFacts(result.fact_check).regular_price).toBe(430000);
});
test.each([null,'','   ','정보 없음'])('raw missing fact candidate %j is permitted but checked nulls are actual JSON nulls', value => {
  const page=preparePage('<article><h1>스토케 트립트랩 공구</h1></article>',source);
  const mock=JSON.parse(readFileSync(new URL('./fixtures/deepseek-web/mock-completion.json',import.meta.url),'utf8'));
  const raw=JSON.parse(mock.content); raw.gonggu_price=value; raw.regular_price=value; raw.period=value;
  const result=checkExtraction(validateExtraction(JSON.stringify(raw),source,'2026-11-10'),page,at);
  expect(result.gonggu_price).toBeNull(); expect(result.start_date).toBeNull();
  raw.brand=''; expect(()=>validateExtraction(JSON.stringify(raw),source,'2026-11-10')).toThrow('extraction_result_invalid');
});

test('new observation dates and screening years use KST across UTC midnight/year boundaries',()=>{
  const c=checkDealFacts({period:'01.02'},'01.02',source,'2026-12-31T15:01:00.000Z');
  expect(c.observation_year_kst).toBe(2027);
  expect(c.observed_at).toBe('2026-12-31T15:01:00.000Z');
  expect(interpretSchedule(c).start.at).toBe(Date.parse('2027-01-02T00:00:00+09:00'));
});
