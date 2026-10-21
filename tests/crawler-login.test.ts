import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import settingsJson from '../crawler/config/settings.json';
import { ensureLogin, HaltError } from '../crawler/lib/browser';
import { parseSettings } from '../crawler/lib/config';
import { flushHealth, initHealth } from '../crawler/lib/health';
import { mockPage } from './helpers/page';

vi.mock('../crawler/lib/util', async importOriginal => ({ ...await importOriginal<typeof import('../crawler/lib/util')>(), sleep: vi.fn(async () => {}) }));
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crawler-login-'));
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'login-test-password');
  await initHealth(dir);
});
afterEach(async () => {
  await flushHealth();
  await rm(dir, { recursive: true, force: true });
});

async function login(options: { form: boolean; halt?: 'login' | 'challenge' | 'blocked' }) {
  const mock = mockPage(selector => {
    if (selector === 'input[name="username"]') return options.form ? [{}] : [];
    if (selector === 'input[name="password"]') return options.form ? [{}] : [];
    if (selector === 'button[type="submit"]') return options.form ? [{ click: () => {
      mock.setUrl(options.halt === 'login' ? 'https://www.instagram.com/accounts/login/' : options.halt === 'challenge' ? 'https://www.instagram.com/challenge/' : 'https://www.instagram.com/');
    } }] : [];
    if (selector === 'text' && options.halt === 'blocked') return [{ text: 'Action Blocked' }];
    return [];
  });
  const sessionFile = join(dir, 'session.json');
  const storageState = vi.fn(async () => { await writeFile(sessionFile, '{}'); });
  const promise = ensureLogin({ storageState } as unknown as BrowserContext, mock.page, parseSettings(settingsJson), 'offline-user', sessionFile);
  return { promise, storageState };
}

async function eventNames() {
  await flushHealth();
  const file = (await readdir(join(dir, 'logs'))).find(file => file.startsWith('health-'))!;
  const log = await readFile(join(dir, 'logs', file), 'utf8');
  expect(log).not.toContain('login-test-password');
  expect(log).not.toContain('offline-user');
  return log.trim().split('\n').map(line => JSON.parse(line).event);
}

test('a submitted login logs attempt then success after human checks', async () => {
  const { promise, storageState } = await login({ form: true });
  await promise;
  expect(storageState).toHaveBeenCalledTimes(1);
  expect(await eventNames()).toEqual(['login_attempt', 'login_ok']);
});

test('an authenticated session logs session_reused without a login attempt', async () => {
  const { promise, storageState } = await login({ form: false });
  await promise;
  expect(storageState).toHaveBeenCalledTimes(1);
  expect(await eventNames()).toEqual(['session_reused']);
});

test.each(['login', 'challenge', 'blocked'] as const)('failed login %s never logs success or saves a session', async halt => {
  const { promise, storageState } = await login({ form: true, halt });
  await expect(promise).rejects.toBeInstanceOf(HaltError);
  expect(storageState).not.toHaveBeenCalled();
  expect(await eventNames()).toEqual(['login_attempt']);
});
