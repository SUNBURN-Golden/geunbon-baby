import { expect, test } from 'vitest';
import raw from '../crawler/config/external-sources.json';
import { loadExternalSettings, parseExternalSettings } from '../crawler/lib/external/sources';

const clone = () => structuredClone(raw) as Record<string, unknown> & { sources: Record<string, unknown>[] };
const withSource = (patch: Record<string, unknown>, index = 0) => { const value = clone(); Object.assign(value.sources[index], patch); return value; };

test('the shipped config is valid: BUYG is off by default, others follow the priority order', async () => {
  const settings = parseExternalSettings(raw);
  expect(settings.sources.map(source => source.id)).toEqual(['pangpang', 'momcalendar', 'buyg', 'snapup']);
  expect(settings.sources.find(source => source.id === 'buyg')!.enabled).toBe(false);
  expect(settings.min_interval_ms).toBeGreaterThanOrEqual(1000);
  expect(settings.sources.find(source => source.id === 'buyg')!.entries).toEqual(['/']);
  expect((await loadExternalSettings(new URL('../crawler', import.meta.url).pathname)).sources).toHaveLength(4);
});

test('source order is fixed regardless of file order', () => {
  const value = clone();
  value.sources.reverse();
  expect(parseExternalSettings(value).sources.map(source => source.id)).toEqual(['pangpang', 'momcalendar', 'buyg', 'snapup']);
});

test.each([
  ['interval below 1000ms', { ...clone(), min_interval_ms: 999 }],
  ['http origin', withSource({ origin: 'http://09pangpang.com' })],
  ['gonggumoa origin', withSource({ origin: 'https://gonggumoa.com' })],
  ['gonggumoa subdomain', withSource({ origin: 'https://www.gonggumoa.com' })],
  ['origin of a different site', withSource({ origin: 'https://example.com' })],
  ['origin with a path', withSource({ origin: 'https://09pangpang.com/x' })],
  ['origin with credentials', withSource({ origin: 'https://user:pw@09pangpang.com' })],
  ['api entry', withSource({ entries: ['/api/v1/list'] })],
  ['login entry', withSource({ entries: ['/login'] })],
  ['my entry', withSource({ entries: ['/my/orders'] })],
  ['protocol-relative entry', withSource({ entries: ['//evil.example.invalid/'] })],
  ['relative entry', withSource({ entries: ['list'] })],
  ['unsupported source id', withSource({ id: 'gonggumoa' })],
  ['duplicate source id', withSource({ id: 'momcalendar' })],
  ['invalid render', withSource({ render: 'yes' })],
  ['invalid enabled', withSource({ enabled: 'true' })],
  ['empty sources', { ...clone(), sources: [] }],
  ['bad jitter', { ...clone(), jitter_ms: [5, 1] }],
  ['non-boolean follow_detail_links', { ...clone(), follow_detail_links: 'no' }],
])('invalid configuration is rejected before running: %s', (_name, value) => {
  expect(() => parseExternalSettings(value)).toThrow();
});

test('render accepts true, false and "auto"', () => {
  for (const render of [true, false, 'auto']) expect(parseExternalSettings(withSource({ render })).sources[0].render).toBe(render);
});
