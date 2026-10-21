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
  const innerText = vi.fn(async () => text);
  const page = {
    url: () => 'https://www.instagram.com/accounts/login/?access_token=url-private&next=%2F',
    locator: vi.fn(() => ({ innerText })),
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

test('full innerText redaction covers credentials assembled across DOM nodes in files and previews', async () => {
  const nodes = ['Visible: ', 'p@ss+', 'word$[]', ' ', 'ingest-', 'private', ' end'];
  const { page } = diagnosticPage(nodes.join(''));
  await captureHalt(dir, 'login', page);
  expect(page.locator).toHaveBeenCalledWith('body');
  const file = (await readdir(join(dir, 'logs'))).find(file => file.endsWith('.txt'))!;
  const text = await readFile(join(dir, 'logs', file), 'utf8');
  expect(text).toContain('Visible: [redacted] [redacted] end');
  expect((await events())[0].preview).toBe('Visible: [redacted] [redacted] end');
  for (const secret of ['p@ss+word$[]', 'ingest-private']) expect(text).not.toContain(secret);
});

test.each(['text', 'mask', 'screenshot'] as const)('aborting during %s stops subsequent diagnostic work and PNG writes', async phase => {
  const controller = new AbortController();
  const { page, evaluate, screenshot } = diagnosticPage('safe text');
  if (phase === 'text') vi.mocked(page.locator('body').innerText).mockImplementation(async () => { controller.abort(); return 'safe'; });
  if (phase === 'mask') evaluate.mockImplementation(async () => { controller.abort(); });
  if (phase === 'screenshot') screenshot.mockImplementation(async () => { controller.abort(); return Buffer.from('must-not-save'); });
  await captureHalt(dir, 'blocked', page, controller.signal);
  if (phase === 'text') expect(evaluate).not.toHaveBeenCalled();
  if (phase !== 'screenshot') expect(screenshot).not.toHaveBeenCalled();
  expect((await readdir(join(dir, 'logs'))).filter(file => file.endsWith('.png'))).toEqual([]);
  expect((await events())[0]).toMatchObject({ event: 'halt', reason: 'blocked' });
});

test('already aborted diagnostics log the halt without accessing the browser', async () => {
  const { page, evaluate, screenshot } = diagnosticPage('private text');
  await captureHalt(dir, 'challenge', page, AbortSignal.abort());
  expect(page.locator).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
  expect(screenshot).not.toHaveBeenCalled();
  expect((await events())[0]).toMatchObject({ event: 'halt', reason: 'challenge' });
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
    attrs = new Map([['type', 'password'], ['placeholder', 'other-private'], ['aria-label', 'token=aria-private']]);
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
  expect(input.style.setProperty).toHaveBeenCalledWith('opacity', '0', 'important');
});

test.each([
  ['p@ss+word$[]', false], ['ingest-private', false],
  ['p@ss+word$[]', true], ['ingest-private', true],
] as const)('screenshot masks containers with split secret %s (shadow=%s) before leaf redaction', (secret, inShadow) => {
  const node = (text: string) => ({ textContent: text, parentElement: { closest: () => null } });
  const nodes = [node(secret.slice(0, 4)), node(secret.slice(4, 7)), node(secret.slice(7))];
  const nested = {
    get textContent() { return nodes.slice(1).map(node => node.textContent).join(''); },
    style: { setProperty: vi.fn() }, getAttribute: () => null,
  };
  const container = {
    get textContent() { return nodes[0].textContent + nested.textContent; },
    style: { setProperty: vi.fn() }, getAttribute: () => null,
  };
  // Also include an intact secret to catch mutations before the container pass.
  const intact = node(secret);
  const intactContainer = {
    get textContent() { return intact.textContent; },
    style: { setProperty: vi.fn() }, getAttribute: () => null,
  };
  const root = { nodes: [...nodes, intact], querySelectorAll: () => [container, nested, intactContainer] };
  const shadow = inShadow ? root : null;
  const host = { textContent: '', getAttribute: () => null, shadowRoot: shadow };
  const document = {
    nodes: inShadow ? [] : root.nodes,
    querySelectorAll: () => inShadow ? [host] : root.querySelectorAll(),
    createTreeWalker: (root: { nodes: typeof nodes }) => {
      let index = -1;
      return { nextNode: () => ++index < root.nodes.length, get currentNode() { return root.nodes[index]; } };
    },
  };
  runInNewContext(`(${redactDiagnosticPage.toString()})(rules)`, {
    document, NodeFilter: { SHOW_TEXT: 4 }, HTMLInputElement: class {},
    HTMLTextAreaElement: class {}, rules: redactionRules(),
  });
  expect(nodes.every(node => !node.textContent.includes(secret))).toBe(true);
  expect(intact.textContent).toBe('[redacted]');
  for (const element of [intactContainer, container]) {
    expect(element.style.setProperty).toHaveBeenCalledWith('visibility', 'hidden', 'important');
    expect(element.style.setProperty).toHaveBeenCalledWith('opacity', '0', 'important');
  }
  expect(nested.style.setProperty).not.toHaveBeenCalled();
});
