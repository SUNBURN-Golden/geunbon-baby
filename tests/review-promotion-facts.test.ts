import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect,test } from 'vitest';
import { reviewPromotionFacts } from '../scripts/review-facts';
import { checkExtraction,validateExtraction } from '../crawler/src/deepseek-web/extract';
import { preparePage } from '../crawler/src/deepseek-web/page-content';
const at='2026-11-10T12:00:00+09:00',url='https://09pangpang.com/post/1';
const mock=JSON.parse(readFileSync(new URL('./fixtures/deepseek-web/mock-completion.json',import.meta.url),'utf8'));
test('manual review promotion maps only checked facts; legacy/mismatched facts clear old candidates',()=>{
  const raw=validateExtraction(mock.content,url,'2026-11-10');
  expect(reviewPromotionFacts(raw)).toEqual({price:null,starts_at:null,ends_at:null});
  const page=preparePage(readFileSync(new URL('./fixtures/deepseek-web/sample-page.txt',import.meta.url),'utf8'),url);
  const checked=checkExtraction(raw,page,at);
  expect(reviewPromotionFacts(checked)).toEqual({price:390000,starts_at:'2026-10-24T15:00:00.000Z',ends_at:'2026-10-28T14:59:59.999Z'});
  const yearlessRaw={...JSON.parse(mock.content),period:'11.30–12.04'};
  const yearless=checkExtraction(validateExtraction(JSON.stringify(yearlessRaw),url,'2026-11-10'),preparePage('<article><h1>스토케 트립트랩 공구</h1><p>11.30–12.04</p></article>',url),at);
  expect(reviewPromotionFacts(yearless)).toEqual({price:null,starts_at:null,ends_at:null});
});
test.each([false,true])('manual script sends checked nulls to exact acknowledged candidate; missing id=%s',missing=>{
  const dir=mkdtempSync(join(tmpdir(),'manual-promotion-'));
  try {
    const queue=join(dir,'review.jsonl'),calls=join(dir,'calls.jsonl');
    const raw=validateExtraction(mock.content,url,'2026-11-10');
    writeFileSync(queue,JSON.stringify({extraction:raw})+'\n');
    const result=spawnSync(process.execPath,['--import','./tests/helpers/promotion-child.mjs','scripts/promote-external.mjs',`--from-review-queue=${queue}`,'--line=0'],{cwd:process.cwd(),env:{NODE_ENV:'test',PATH:process.env.PATH,HOME:process.env.HOME,ADMIN_TOKEN:'fixture-only-admin',INGEST_TOKEN:'fixture-only-ingest',PROMOTE_API_ORIGIN:'https://promotion.example',PROMOTION_TEST_CALLS:calls,PROMOTION_TEST_MISSING_ID:missing?'1':'0',TSX_DISABLE_CACHE:'1'},encoding:'utf8',timeout:20000});
    const requests=readFileSync(calls,'utf8').trim().split('\n').map(l=>JSON.parse(l));
    expect(requests[0].body).toMatchObject({price_hint:null,starts_at:null,ends_at:null});
    if(missing){expect(result.status).not.toBe(0);expect(requests).toHaveLength(1);}
    else{expect(result.status,result.stderr).toBe(0);expect(requests).toHaveLength(2);expect(requests[1]).toMatchObject({url:'https://promotion.example/api/v1/admin/candidates/exact-ingested-id',body:{price:null,starts_at:null,ends_at:null}});}
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('manual promotion refuses a superseded queue line before sending an ingest request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superseded-promotion-'));
  try {
    const queue = join(dir, 'review.jsonl'), calls = join(dir, 'calls.jsonl');
    const extraction = validateExtraction(mock.content, url, '2026-11-10');
    writeFileSync(queue, [JSON.stringify({ id: 'old', extraction }), JSON.stringify({ id: 'new', extraction })].join('\n') + '\n');
    const child = spawnSync(process.execPath, ['--import', './tests/helpers/promotion-child.mjs', 'scripts/promote-external.mjs',
      `--from-review-queue=${queue}`, '--line=0'], {
      cwd: process.cwd(), env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME, ADMIN_TOKEN: 'fixture-only-admin',
        INGEST_TOKEN: 'fixture-only-ingest', PROMOTE_API_ORIGIN: 'https://promotion.example', PROMOTION_TEST_CALLS: calls, TSX_DISABLE_CACHE: '1' },
      encoding: 'utf8', timeout: 20000,
    });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('review_candidate_superseded');
    expect(existsSync(calls)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
