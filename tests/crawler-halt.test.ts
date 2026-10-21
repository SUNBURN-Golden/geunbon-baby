import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { captureHalt, redactDiagnosticPage } from '../crawler/lib/halt';
import { flushHealth, initHealth } from '../crawler/lib/health';
import { redact, redactionRules } from '../crawler/lib/redact';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crawler-halt-'));
  vi.stubEnv('AGAMAJUNG_IG_PASSWORD', 'p@ss+word$[]');
  vi.stubEnv('INGEST_TOKEN', 'ingest-private');
  vi.stubEnv('OTHER_SERVICE_TOKEN', 'other-private');
  await initHealth(dir);
});
afterEach(async () => {
  await flushHealth();
  await rm(dir, { recursive: true, force: true });
});

function diagnosticPage(text: string) {
  const evaluate = vi.fn(async () => {});
  const screenshot = vi.fn(async () => Buffer.from('offline-png-fixture'));
  const page = {
    url: () => 'https://www.instagram.com/accounts/login/?access_token=url-private&next=%2F',
    locator: vi.fn(() => ({ innerText: vi.fn(async () => text) })),
    frames: () => [{ evaluate }],
    screenshot,
  };
  return { page: page as unknown as Page, evaluate, screenshot };
}

async function events() {
  await flushHealth();
  const files = await readdir(join(dir, 'logs'));
  const file = files.find(file => file.startsWith('health-'))!;
  return (await readFile(join(dir, 'logs', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('halt saves matching private diagnostics, redacts URL/text and logs a bounded visible preview', async () => {
  const { page, evaluate, screenshot } = diagnosticPage('Login\np@ss+word$[] ingest-private other-private Bearer unknown-private token=page-private ' + '화면'.repeat(150));
  await captureHalt(dir, 'login', page);
  const files = (await readdir(join(dir, 'logs'))).filter(file => file.startsWith('halt-')).sort();
  expect(files).toHaveLength(2);
  expect(files[0].replace(/\.png$/, '')).toBe(files[1].replace(/\.txt$/, ''));
  expect(files[0]).toMatch(/^halt-.*\.png$/);
  const text = await readFile(join(dir, 'logs', files[1]), 'utf8');
  expect(text).toContain('Reason: login\nURL: https://www.instagram.com/accounts/login/?access_token=[redacted]&next=%2F');
  for (const secret of ['p@ss+word$[]', 'ingest-private', 'other-private', 'unknown-private', 'page-private', 'url-private']) expect(text).not.toContain(secret);
  expect(text).toContain('화면'.repeat(150)); // Full visible text is retained in the private file.
  expect(await readFile(join(dir, 'logs', files[0]))).toEqual(Buffer.from('offline-png-fixture'));
  for (const file of files) expect((await stat(join(dir, 'logs', file))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, 'logs'))).mode & 0o777).toBe(0o700);
  expect(evaluate).toHaveBeenCalledWith(redactDiagnosticPage, redactionRules());
  expect(evaluate.mock.invocationCallOrder[0]).toBeLessThan(screenshot.mock.invocationCallOrder[0]);
  const [event] = await events();
  expect(event).toMatchObject({ event: 'halt', reason: 'login', path: '/accounts/login/' });
  expect(event.preview).toHaveLength(200);
  expect(event.preview).toContain('[redacted]');
  expect(event.preview).not.toMatch(/[\r\n]/);
});

test.each(['challenge', 'blocked', 'login'] as const)('a failed screenshot still saves text and halt reason %s', async reason => {
  const { page, screenshot } = diagnosticPage('Offline visible page');
  screenshot.mockRejectedValue(new Error('screenshot failed with ingest-private'));
  await expect(captureHalt(dir, reason, page)).resolves.toBeUndefined();
  expect((await events()).map(event => [event.event, event.reason ?? event.scope])).toEqual([['halt', reason], ['warn', 'halt_screenshot']]);
  expect((await readdir(join(dir, 'logs'))).filter(file => file.endsWith('.txt'))).toHaveLength(1);
});

test('a failed DOM redaction never writes an unredacted screenshot', async () => {
  const { page, evaluate, screenshot } = diagnosticPage('visible');
  evaluate.mockRejectedValue(new Error('closed frame'));
  await captureHalt(dir, 'blocked', page);
  expect(screenshot).not.toHaveBeenCalled();
  expect((await readdir(join(dir, 'logs'))).filter(file => file.endsWith('.png'))).toEqual([]);
});

test('closed/missing pages and unwritable diagnostic paths still log the halt', async () => {
  await captureHalt(dir, 'login');
  const logged = await events();
  expect(logged[0]).toMatchObject({ event: 'halt', reason: 'login', path: '[unavailable]' });
  // Force an ENOTDIR without depending on the test runner's UID/permissions.
  const file = join(dir, 'not-a-directory');
  await writeFile(file, 'fixture');
  await captureHalt(file, 'challenge');
  expect((await events()).at(-1)).toMatchObject({ event: 'warn', scope: 'halt_text_write' });
});

test('redaction covers configured/encoded secrets, arbitrary token fields, Bearer, JWT and URL credentials', () => {
  const raw = 'p@ss+word$[] p%40ss%2Bword%24%5B%5D other-private ' +
    'Bearer bearer-private {"access_token":"json-private"} refresh_token=url-private&next=/ ' +
    "csrf_token='quoted private' eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature https://user:pass@example.invalid/";
  const safe = redact(raw);
  for (const secret of ['p@ss+word$[]', 'p%40ss%2Bword%24%5B%5D', 'other-private', 'bearer-private', 'json-private', 'url-private', 'quoted private', 'eyJhbGci', 'user:pass']) expect(safe).not.toContain(secret);
  expect(safe).toContain('next=/');
});

test('screenshot DOM redaction removes secrets from text, attributes, controls and shadow roots', () => {
  class Input {
    value = 'never-persist-this-input';
    style = { setProperty: vi.fn() };
    shadowRoot = null;
    attrs = new Map([['placeholder', 'other-private'], ['aria-label', 'token=aria-private']]);
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  }
  const node = (text: string) => ({ textContent: text, parentElement: { closest: () => null } });
  const mainText = node('p@ss+word$[] Bearer screenshot-private');
  const shadowText = node('token=shadow-private');
  const input = new Input();
  const shadow = { nodes: [shadowText], querySelectorAll: () => [] };
  const host = { getAttribute: () => null, shadowRoot: shadow };
  const document = {
    nodes: [mainText],
    querySelectorAll: () => [input, host],
    createTreeWalker: (root: { nodes: typeof mainText[] }) => {
      let index = -1;
      return { nextNode: () => ++index < root.nodes.length, get currentNode() { return root.nodes[index]; } };
    },
  };
  // Exercise the serialized function as Playwright does, without module helpers.
  runInNewContext(`(${redactDiagnosticPage.toString()})(rules)`, {
    document, NodeFilter: { SHOW_TEXT: 4 }, HTMLInputElement: Input,
    HTMLTextAreaElement: class {}, rules: redactionRules(),
  });
  expect(mainText.textContent).toBe('[redacted] Bearer [redacted]');
  expect(shadowText.textContent).toBe('token=[redacted]');
  expect(input.value).toBe('[redacted]');
  expect(input.attrs.get('placeholder')).toBe('[redacted]');
  expect(input.attrs.get('aria-label')).toBe('token=[redacted]');
  expect(input.style.setProperty).toHaveBeenCalledWith('visibility', 'hidden', 'important');
});
