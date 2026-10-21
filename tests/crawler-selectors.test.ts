import { expect, test } from 'vitest';
import { clickFirst, firstVisible, followButton, loginPrompt, parseHandle, parseStoryHandle, postLinks, visibleHandles } from '../crawler/lib/selectors';
import { canonicalPost } from '../crawler/lib/util';
import { mockLocator, mockPage } from './helpers/page';
test('visibility fallback skips missing, hidden and detached candidates, including hidden first matches', async () => {
  const click = async () => {};
  const candidates = [mockLocator(() => []), mockLocator(() => [{ visible: false }]), mockLocator(() => [{ throws: true }]), mockLocator(() => [{ visible: false }, { click }])];
  expect(await firstVisible(candidates)).not.toBeNull();
  expect(await clickFirst(candidates)).toBe(true);
  expect(await clickFirst(candidates.slice(0, 3))).toBe(false);
});
test('click fallback handles a detached target and tries the next selector', async () => {
  let clicked = false;
  const stale = mockLocator(() => [{ click: () => { throw new Error('detached during click'); } }]);
  const valid = mockLocator(() => [{ click: () => { clicked = true; } }]);
  expect(await clickFirst([stale, valid])).toBe(true);
  expect(clicked).toBe(true);
});
test('follow selectors use Korean/English accessible names and do not match unfollow', async () => {
  const { page } = mockPage(selector => selector === 'role:button' ? [{ name: 'Unfollow' }, { name: '팔로우' }] : []);
  expect(await firstVisible(followButton(page))).not.toBeNull();
  const absent = mockPage(selector => selector === 'role:button' ? [{ name: 'Unfollow' }] : []).page;
  expect(await firstVisible(followButton(absent))).toBeNull();
});
test('profile and story parsing rejects reserved paths, external origins and invalid handles', () => {
  expect(parseHandle('/Seller.Mom/')).toBe('seller.mom');
  expect(parseHandle('/privacy_mom/')).toBe('privacy_mom');
  for (const href of ['/explore/', '/p/abc/', 'https://evil.test/seller/', '/bad-handle/', 'javascript:alert(1)']) expect(parseHandle(href)).toBeNull();
  expect(parseStoryHandle('/stories/seller/123/')).toBe('seller');
  expect(parseStoryHandle('/stories/highlights/123/')).toBeNull();
  expect(parseStoryHandle('https://evil.test/stories/seller/123/')).toBeNull();
});
test('post links canonicalize tracking URLs, reject external URLs, and dedupe', async () => {
  const hrefs = ['/p/abc/?utm=1', 'https://instagram.com/p/abc', '/reel/xyz/', 'https://evil.test/p/abc/'];
  const { page } = mockPage(() => hrefs.map(href => ({ href })));
  expect(await postLinks(page)).toEqual(['https://www.instagram.com/p/abc/', 'https://www.instagram.com/reel/xyz/']);
  expect(canonicalPost('/stories/seller/123/')).toBeNull();
  expect(canonicalPost('https://user:pass@instagram.com/p/a/')).toBeNull();
});
test('handle list parsing dedupes profile links', async () => {
  const { page } = mockPage(() => ['/seller/', '/seller/', '/explore/', '/seller2/'].map(href => ({ href })));
  expect(await visibleHandles(page)).toEqual(['seller', 'seller2']);
});

test('prompt handling never selects an unrelated page-level Not now button', async () => {
  const { page } = mockPage(selector => {
    if (selector === 'text') return [{ text: 'Save your login info?' }];
    if (selector === 'role:button') return [{ name: 'Not now' }];
    return [];
  });
  expect(await loginPrompt(page)).toEqual({ kind: 'save', dismiss: null });
});

test('legacy full-page save prompt is scoped to the onetap route', async () => {
  const node = { text: 'Save your login info?', children: () => [{ name: 'Not now' }] };
  const mock = mockPage(selector => selector === 'text' || selector === 'body' ? [node] : []);
  expect((await loginPrompt(mock.page))?.dismiss).toBeNull();
  mock.setUrl('https://www.instagram.com/accounts/onetap/?next=/');
  expect((await loginPrompt(mock.page))?.dismiss).not.toBeNull();
});

test.each([
  ['이메일을 확인하세요', 'code', true],
  ['Check your email', 'numeric', true],
  ['Enter the code sent to your email', 'named', true],
  ['이메일로 보낸 코드를 입력하세요', 'named-ko', true],
  ['Check your email', 'none', false],
  ['할인 코드 / Promotional code', 'numeric', false],
  ['Email preferences', 'code', false],
] as const)('email challenge requires instructions and a control: %s / %s', async (text, control, expected) => {
  const { emailCodeChallenge } = await import('../crawler/lib/selectors');
  const { page } = mockPage(selector => {
    if (selector === 'text') return [{ text }];
    if (selector === 'role:textbox') return control === 'named' ? [{ name: 'Email code' }] : control === 'named-ko' ? [{ name: '이메일 코드' }] : [];
    if (selector.startsWith('input[name="code"]')) return control === 'code' || control === 'numeric' ? [{}] : [];
    return [];
  });
  expect(await emailCodeChallenge(page)).toBe(expected);
});

test.each([
  ['', [], true],
  ['Loading...', [], false],
  ['', [{ hidden: true }], true],
  ['', [{ hidden: false }], false],
] as const)('blank observation checks visible text and controls without returning their values', async (text, controls, expected) => {
  const { blankLoginSurface } = await import('../crawler/lib/selectors');
  const { runInNewContext } = await import('node:vm');
  const body = { innerText: text, querySelectorAll: () => controls.map(control => ({ ...control, getClientRects: () => control.hidden ? [] : [{}] })) };
  const { page } = mockPage();
  page.locator = () => ({ evaluate: async (fn: (body: unknown) => boolean) => runInNewContext(`(${fn.toString()})(body)`, {
    body, getComputedStyle: (control: { hidden: boolean }) => ({ visibility: control.hidden ? 'hidden' : 'visible', display: 'block' }),
  }) }) as unknown as import('playwright').Locator;
  expect(await blankLoginSurface(page)).toBe(expected);
});

test('DOM read failures never qualify for blank recovery and interruption still propagates', async () => {
  const { blankLoginSurface } = await import('../crawler/lib/selectors');
  const { QuietWindowError } = await import('../crawler/lib/quiet-window');
  let error: Error = new Error('detached private detail');
  const { page } = mockPage(() => [{ evaluate: () => { throw error; } }]);
  expect(await blankLoginSurface(page)).toBe(false);
  error = new QuietWindowError();
  await expect(blankLoginSurface(page)).rejects.toBe(error);
});
