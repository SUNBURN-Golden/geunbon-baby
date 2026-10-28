import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { ensureLogin } from '../crawler/lib/browser';
import { flushHealth, initHealth } from '../crawler/lib/health';
import { captureFile, captureIO, captureRoot } from './helpers/login-capture-io';
import { loginFixture, loginSettings, sessionState } from './helpers/login';

vi.mock('node:fs/promises', async () => {
  const { captureIO } = await import('./helpers/login-capture-io');
  return captureIO.fs;
});

beforeEach(async () => {
  captureIO.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T11:30:00Z'));
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'login-test-password');
  vi.stubEnv('INGEST_TOKEN', 'login-test-token');
  await initHealth(captureRoot);
});
afterEach(async () => {
  await flushHealth();
  vi.useRealTimers();
  const unexpected = [...captureIO.unexpected];
  captureIO.close();
  expect(unexpected).toEqual([]);
});

async function events() {
  await flushHealth();
  const log = captureIO.files(join(captureRoot, 'logs')).filter(path => path.endsWith('.jsonl'))
    .map(path => captureIO.read(path)).join('');
  for (const secret of ['login-test-password', 'login-test-token', 'offline-user', 'offline-cookie-only', 'offline-storage-only', 'discarded-snapshot']) {
    expect(log).not.toContain(secret);
  }
  return log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event)
    .filter(event => !['login_state', 'login_recovery'].includes(event));
}

test.each(['recover', 'timeout', 'challenge', 'login', 'unknown'] as const)('a %s surface during session capture discards the temporary state and keeps the old session until verified', async scenario => {
  const mock = loginFixture({ restored: true });
  const previous = JSON.stringify(sessionState());
  captureIO.seed(previous);
  const discarded = { ...sessionState(), cookies: sessionState().cookies.map(cookie => ({ ...cookie, value: 'discarded-snapshot' })) };
  mock.storageState.mockImplementationOnce(async () => {
    mock.setStage(scenario === 'challenge' ? 'email-en' : scenario === 'login' ? 'login' : scenario === 'unknown' ? 'unknown' : 'blank');
    return discarded;
  });
  const firstCapture = captureIO.holdNext('close');
  const firstDiscard = captureIO.holdNext('unlink');
  const began = Date.now();
  const outcome = ensureLogin(mock.context, mock.page, loginSettings(), 'offline-user', captureFile).catch(error => error);

  await vi.runAllTimersAsync();
  const temporary = await firstCapture.reached;
  expect(JSON.parse(captureIO.read(temporary))).toEqual(discarded);
  expect(captureIO.read(captureFile)).toBe(previous);
  expect(await events()).toEqual([]);
  firstCapture.release();

  expect(await firstDiscard.reached).toBe(temporary);
  expect(captureIO.files(dirname(captureFile))).toEqual([captureFile]);
  expect(captureIO.read(captureFile)).toBe(previous);
  expect(mock.storageState).toHaveBeenCalledOnce();
  expect(await events()).toEqual([]);
  firstDiscard.release();

  if (scenario === 'recover') {
    // The page stays blank through verification and disposal. Only this explicit
    // transition lets the bounded login loop capture a fresh authenticated state.
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.storageState).toHaveBeenCalledOnce();
    expect(captureIO.read(captureFile)).toBe(previous);
    const secondCapture = captureIO.holdNext('close');
    mock.setStage('home');
    await vi.runAllTimersAsync();
    const freshTemporary = await secondCapture.reached;
    expect(freshTemporary).not.toBe(temporary);
    expect(JSON.parse(captureIO.read(freshTemporary))).toEqual(sessionState());
    expect(captureIO.read(captureFile)).toBe(previous);
    expect(await events()).toEqual([]);
    secondCapture.release();
    expect(await outcome).toBeUndefined();
    expect(mock.storageState).toHaveBeenCalledTimes(2);
    expect(JSON.parse(captureIO.read(captureFile))).toEqual(sessionState());
    expect(await events()).toEqual(['session_reused']);
  } else {
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ reason: scenario === 'challenge' ? 'challenge' : 'login' });
    expect(captureIO.read(captureFile)).toBe(previous);
    expect(mock.storageState).toHaveBeenCalledOnce();
    expect(await events()).toEqual([]);
    if (scenario === 'timeout') expect(Date.now() - began).toBe(120_005);
  }
  expect(captureIO.files(dirname(captureFile))).toEqual([captureFile]);
  expect(captureIO.operations.filter(item => item.operation === 'rename' && item.path === captureFile))
    .toHaveLength(scenario === 'recover' ? 1 : 0);
});
