import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { checkRecalls, main, readBounded } from '../scripts/recall-check';
const sources = { Egg: { cpsc: { query: 'egg stroller', match_terms: ['egg stroller'] } }, Stokke: { cpsc: { query: 'Stokke', match_terms: ['Stokke'] } } };
const row = { RecallID: 1, URL: 'https://www.cpsc.gov/Recalls/1', Title: 'Egg Stroller', RecallDate: '2026-10-01', Products: [{ Name: 'Egg Stroller' }] };
const fixture = { Egg: { title: [row], product: [row] }, Stokke: { error: 'blocked' } };

test('fixture mode writes honest per-brand failures and raw vs deduplicated counts without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agamajung-recall-'));
  try {
    await writeFile(join(dir, 'sources.json'), JSON.stringify(sources));
    await writeFile(join(dir, 'fixture.json'), JSON.stringify(fixture));
    const args = ['--fixture', join(dir, 'fixture.json'), '--sources', join(dir, 'sources.json'), '--out', join(dir, 'out.json')];
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/recall-check.ts', ...args], { stdio: 'pipe' });
    const result = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
    expect(result.empty_result_is_not_safety_guarantee).toBe(true);
    expect(result.brands.Egg).toMatchObject({ status: 'ok', raw_count: 2, kept: [{ recall_id: '1', matched_term: 'egg stroller' }] });
    expect(result.brands.Stokke).toMatchObject({ status: 'fetch_failed', query: 'Stokke', raw_count: null, kept: [], error: 'fixture_fetch_failed' });
    await writeFile(join(dir, 'fixture.json'), '{}');
    const before = await readFile(join(dir, 'out.json'), 'utf8');
    await expect(main(args)).rejects.toThrow('all_brands_failed');
    expect(await readFile(join(dir, 'out.json'), 'utf8')).toBe(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('schema failures are isolated and empty success is not converted into a failure', async () => {
  const result = await checkRecalls(sources, { Egg: { title: {}, product: [] }, Stokke: { title: [], product: [] } });
  expect(result.brands.Egg).toMatchObject({ status: 'fetch_failed', error: 'cpsc_schema', raw_count: null, kept: [] });
  expect(result.brands.Stokke).toMatchObject({ status: 'ok', raw_count: 0, kept: [] });
});

test('response bounds cover Content-Length and streamed bodies, HTTP failure is explicit', async () => {
  await expect(readBounded(new Response('', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }))).rejects.toThrow('response_too_large');
  await expect(readBounded(new Response('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow('response_too_large');
  await expect(readBounded(new Response('', { status: 403 }))).rejects.toThrow('http_403');
  expect(await readBounded(new Response('[]'))).toBe('[]');
});

test('every spelling and parent company is queried; distinct rejected IDs remain auditable', async () => {
  const sources = { Maxi: { cpsc: { query: 'Maxi-Cosi', match_terms: ['Maxi-Cosi', 'Maxi Cosi', 'Dorel'] } } };
  const unrelated = { ...row, RecallID: 2, Title: 'Unrelated cooker', Products: [{ Name: 'Cooker' }] };
  const dorel = { ...row, RecallID: 3, Title: 'Dorel child seats', Products: [{ Name: 'Child seats' }] };
  const result = await checkRecalls(sources, { Maxi: { queries: {
    'Maxi-Cosi': { title: [], product: [] },
    'Maxi Cosi': { title: [unrelated], product: [] },
    Dorel: { title: [dorel], product: [dorel] },
  } } });
  expect(result.brands.Maxi).toMatchObject({ status: 'ok', queries: ['Maxi-Cosi', 'Maxi Cosi', 'Dorel'], raw_count: 3,
    kept: [{ recall_id: '3', matched_term: 'Dorel' }], rejected: [{ recall_id: '2', title: 'Unrelated cooker' }] });
  expect(result.brands.Maxi.requests.map(r => [r.query, r.field])).toEqual([
    ['Maxi-Cosi', 'RecallTitle'], ['Maxi-Cosi', 'ProductName'], ['Maxi Cosi', 'RecallTitle'], ['Maxi Cosi', 'ProductName'], ['Dorel', 'RecallTitle'], ['Dorel', 'ProductName'],
  ]);
  const failed = await checkRecalls(sources, { Maxi: { queries: { 'Maxi-Cosi': { title: [], product: [] } } } });
  expect(failed.brands.Maxi.status).toBe('fetch_failed');
  expect(failed.brands.Maxi.raw_count).toBeNull();
});
