import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import accountsJson from '../crawler/config/accounts.json';
import settingsJson from '../crawler/config/settings.json';
import { loadConfig, parseAccounts, parseSettings } from '../crawler/lib/config';
import { discoveryTags } from '../crawler/lib/discover';

const seed = { handle: 'Seller.Mom', brand: 'Stokke', scope: 'kr', verified: true, follow: false, collect_images: false, note: 'reviewed' };
const absent = Symbol('absent');
function accountField(key: string, value: unknown) {
  const item: Record<string, unknown> = { ...seed };
  if (value === absent) delete item[key];
  else item[key] = value;
  return { seed_accounts: [item] };
}
function configError(parse: () => unknown, file: string, path: string) {
  let error: unknown;
  try { parse(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).constructor).toBe(Error);
  expect((error as Error).message).toContain(file);
  expect((error as Error).message).toContain(path);
  expect((error as Error).message).not.toContain('leak-marker');
}

test('shipped accounts and settings parse unchanged', () => {
  expect(parseAccounts(accountsJson).seed_accounts).toHaveLength(accountsJson.seed_accounts.length);
  expect(parseSettings(settingsJson)).toMatchObject({ follow: { allow_unverified: false }, discovery: { enabled: true }, ocr: { enabled: true, langs: 'kor+eng' } });
});

test.each([absent, true, false])('collect_images preserves explicit booleans and defaults only when absent: %s', value => {
  expect(parseAccounts(accountField('collect_images', value)).seed_accounts[0].collect_images).toBe(value === absent ? true : value);
});

test('optional account text defaults, handles lowercase, and omitted discovery has empty lists', () => {
  expect(parseAccounts({ seed_accounts: [{ handle: 'Seller.Mom', scope: 'global', verified: false, follow: true, $comment: 'allowed' }] }))
    .toEqual({ seed_accounts: [{ handle: 'seller.mom', scope: 'global', verified: false, follow: true, collect_images: true, brand: '', note: '' }], discovery: { hashtags: { base: [], brand: [], extra: [] } } });
  expect(parseAccounts({ seed_accounts: [] }).seed_accounts).toEqual([]);
});

const invalidAccountFields: [string, unknown[]][] = [
  ['collect_images', ['false', 'true', 0, 1, null, undefined, 'leak-marker']],
  ['verified', ['true', 1, null, absent, 'leak-marker']],
  ['follow', ['yes', 0, null, absent, 'leak-marker']],
  ['scope', ['KR', 'leak-marker', 1, null, absent]],
  ['handle', [123, '', 'bad/handle', 'leak-marker/invalid', 'x'.repeat(31), null, absent]],
  ['brand', [1, null, undefined, { value: 'leak-marker' }]],
  ['note', [{}, null, undefined, { value: 'leak-marker' }]],
];
test.each(invalidAccountFields.flatMap(([key, values]) => values.map(value => ({ key, value }))))('rejects malformed account $key=$value safely', ({ key, value }) => {
  configError(() => parseAccounts(accountField(key, value)), 'accounts.json', `seed_accounts[0].${key}`);
});

const invalidAccounts: { name: string; raw: unknown; path: string }[] = [
  { name: 'unknown account key', raw: { seed_accounts: [{ ...seed, collect_image: false }] }, path: 'seed_accounts[0]' },
  { name: 'unknown key containing sensitive text', raw: { seed_accounts: [{ ...seed, 'leak-marker': 'leak-marker' }] }, path: 'seed_accounts[0]' },
  ...[null, [], 'leak-marker'].map(item => ({ name: `item ${JSON.stringify(item)}`, raw: { seed_accounts: [item] }, path: 'seed_accounts[0]' })),
  { name: 'missing seed_accounts', raw: {}, path: 'seed_accounts' },
  ...[{}, 'leak-marker', null].map(value => ({ name: `seed_accounts ${JSON.stringify(value)}`, raw: { seed_accounts: value }, path: 'seed_accounts' })),
  ...[null, []].map(raw => ({ name: `root ${JSON.stringify(raw)}`, raw, path: 'accounts.json' })),
  ...['leak-marker', null, [], {}, { hashtags: [] }, { hashtags: null }].map(discovery => ({ name: `discovery ${JSON.stringify(discovery)}`, raw: { seed_accounts: [seed], discovery }, path: 'discovery' })),
  ...['base', 'brand', 'extra'].flatMap(key => ['leak-marker', null, [1], ['ok', { value: 'leak-marker' }]].map(value => ({ name: `hashtags ${key} ${JSON.stringify(value)}`, raw: { seed_accounts: [seed], discovery: { hashtags: { [key]: value } } }, path: `discovery.hashtags.${key}` }))),
];
test.each(invalidAccounts)('rejects malformed accounts structure: $name', ({ raw, path }) => {
  configError(() => parseAccounts(raw), 'accounts.json', path);
});

test('hashtag defaults and discovery normalisation remain supported', () => {
  const parsed = parseAccounts({ seed_accounts: [], discovery: { hashtags: { base: ['#공구', '', '공구', ' #스토케공구 ', '../bad'] } } });
  expect(parsed.discovery.hashtags.brand).toEqual([]);
  expect(parsed.discovery.hashtags.extra).toEqual([]);
  expect(discoveryTags(parsed)).toEqual(['공구', '스토케공구']);
});

test('duplicate handles are rejected after case normalisation', () => {
  expect(() => parseAccounts({ seed_accounts: [seed, { ...seed, handle: 'seller.mom' }] })).toThrow('중복된 핸들: seller.mom');
});

function settingsField(section: 'follow' | 'discovery' | 'ocr', key: string, value: unknown) {
  const fields: Record<string, unknown> = { ...settingsJson[section] };
  if (value === absent) delete fields[key];
  else fields[key] = value;
  return { ...settingsJson, [section]: fields };
}
const settingsFlags = [
  { section: 'follow', key: 'allow_unverified', optional: true },
  { section: 'discovery', key: 'enabled', optional: false },
  { section: 'ocr', key: 'enabled', optional: false },
] as const;
test.each(settingsFlags.flatMap(field => ['true', 'false', 1, 0, null, undefined, 'leak-marker', ...(field.optional ? [] : [absent])].map(value => ({ ...field, value }))))('rejects malformed settings $section.$key=$value safely', ({ section, key, value }) => {
  configError(() => parseSettings(settingsField(section, key, value)), 'settings.json', `${section}.${key}`);
});
test.each(settingsFlags.flatMap(field => [true, false].map(value => ({ ...field, value }))))('preserves boolean settings $section.$key=$value', ({ section, key, value }) => {
  expect(parseSettings(settingsField(section, key, value))[section]).toHaveProperty(key, value);
});
test.each([1, '', null, undefined, { value: 'leak-marker' }])('rejects malformed OCR languages: %j', value => {
  configError(() => parseSettings(settingsField('ocr', 'langs', value)), 'settings.json', 'ocr.langs');
});
test('optional settings default only when absent', () => {
  expect(parseSettings(settingsField('follow', 'allow_unverified', absent)).follow.allow_unverified).toBe(false);
  expect(parseSettings(settingsField('ocr', 'langs', absent)).ocr.langs).toBe('kor+eng');
});
test.each([[], null])('rejects a malformed settings root: %j', raw => {
  configError(() => parseSettings(raw), 'settings.json', 'settings.json');
});

test('legacy quiet windows and both env overrides still parse with strict flags', () => {
  const { quiet_windows, ...legacy } = settingsJson;
  const oldWindow = { ...quiet_windows[0], start: '22:00', end: '01:00' };
  const raw = { ...legacy, quiet_window: oldWindow };
  expect(parseSettings(raw).quiet_windows).toEqual([oldWindow]);
  for (const key of ['AGAMAJUNG_QUIET_WINDOW', 'AGAMAJUNG_QUIET_WINDOWS']) {
    expect(parseSettings(raw, { [key]: '23:30-02:15' }).quiet_windows).toEqual([{ ...oldWindow, start: '23:30', end: '02:15' }]);
  }
  configError(() => parseSettings({ ...raw, ocr: { ...raw.ocr, enabled: 'false' } }), 'settings.json', 'ocr.enabled');
});

describe('loadConfig offline', () => {
  let dir: string;
  beforeEach(async () => {
    for (const key of ['AGAMAJUNG_OCR', 'AGAMAJUNG_OCR_LANG', 'AGAMAJUNG_QUIET_WINDOWS', 'AGAMAJUNG_QUIET_WINDOW']) vi.stubEnv(key, undefined);
    dir = await mkdtemp(join(tmpdir(), 'crawler-config-'));
    await mkdir(join(dir, 'config'));
    await copyFile(resolve('crawler/config/settings.json'), join(dir, 'config/settings.json'));
    await writeFile(join(dir, 'config/accounts.json'), JSON.stringify({ seed_accounts: [seed] }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test.each([true, false].flatMap(enabled => [undefined, '', '0', '1'].map(value => ({ enabled, value }))))('OCR env=$value with file enabled=$enabled', async ({ enabled, value }) => {
    await writeFile(join(dir, 'config/settings.json'), JSON.stringify({ ...settingsJson, ocr: { ...settingsJson.ocr, enabled } }));
    vi.stubEnv('AGAMAJUNG_OCR', value);
    expect((await loadConfig(dir)).settings.ocr.enabled).toBe(value === '0' ? false : value === '1' ? true : enabled);
  });
  test.each(['false', 'true', ' 1', '2', 'leak-marker'])('rejects malformed OCR env: %j', async value => {
    vi.stubEnv('AGAMAJUNG_OCR', value);
    await expect(loadConfig(dir)).rejects.toThrow('AGAMAJUNG_OCR은 0 또는 1이어야 합니다.');
  });
  test('rejects a string image policy from disk', async () => {
    await writeFile(join(dir, 'config/accounts.json'), JSON.stringify(accountField('collect_images', 'false')));
    await expect(loadConfig(dir)).rejects.toThrow('accounts.json: seed_accounts[0].collect_images는 true 또는 false여야 합니다.');
  });
});
