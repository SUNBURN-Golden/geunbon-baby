import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvironment } from '../crawler/lib/config';
import { failureDetails } from '../crawler/lib/failure';

test('startup loads the root secret file and preserves injected environment values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crawler-env-'));
  vi.stubEnv('AGAMAJUNG_API_URL', undefined);
  vi.stubEnv('INGEST_TOKEN', 'injected-token');
  try {
    await writeFile(join(root, '.env.crawler'), 'AGAMAJUNG_API_URL=https://offline.invalid\nINGEST_TOKEN=file-token\n');
    loadEnvironment(join(root, 'crawler'));
    expect(process.env.AGAMAJUNG_API_URL).toBe('https://offline.invalid');
    expect(process.env.INGEST_TOKEN).toBe('injected-token');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing secret file is optional, but other file errors stop startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crawler-env-'));
  try {
    expect(() => loadEnvironment(join(root, 'crawler'))).not.toThrow();
    await mkdir(join(root, '.env.crawler'));
    expect(() => loadEnvironment(join(root, 'crawler'))).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure diagnostics retain the exception and stack while removing credentials and request data', () => {
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'offline fill password');
  vi.stubEnv('INGEST_TOKEN', 'offline/token+value');
  vi.stubEnv('SERVICE_API_KEY', 'offline-api-key');
  const error = Object.assign(new TypeError([
    'startup failed', 'offline fill password', 'offline/token+value',
    encodeURIComponent('offline/token+value'), 'offline-api-key',
    'Bearer unknown-bearer', 'password=unknown-password',
    'sessionid=unknown-session; csrftoken=unknown-csrf',
    'Cookie: arbitrary=unknown-cookie',
    'https://user:unknown-userinfo@offline.invalid/path?other=unknown-query#unknown-fragment',
    'private@example.invalid',
  ].join('\n')), { code: 'EINVAL', input: 'uninspected-input', cause: { private: 'uninspected-cause' } });
  const details = failureDetails(error);
  expect(details).toMatchObject({ error_name: 'TypeError', error_code: 'EINVAL' });
  expect(details.error_message).toContain('startup failed');
  expect(details.error_stack).toContain('crawler-startup.test.ts');
  const output = JSON.stringify(details);
  for (const value of ['offline fill password', 'offline/token+value', encodeURIComponent('offline/token+value'), 'offline-api-key',
    'unknown-bearer', 'unknown-password', 'unknown-session', 'unknown-csrf', 'unknown-cookie',
    'unknown-userinfo', 'unknown-query', 'unknown-fragment', 'private@example.invalid', 'uninspected-input', 'uninspected-cause']) {
    expect(output).not.toContain(value);
  }
  expect(failureDetails({ password: 'uninspected-object' })).toEqual({ error_name: 'NonError', error_message: '[non-Error exception]' });
});
