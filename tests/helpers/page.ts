import { vi } from 'vitest';
import type { Locator, Page } from 'playwright';
export type Node = { dom?: Element; name?: string; text?: string; href?: string; visible?: boolean; click?: () => Promise<void> | void; fill?: (value: string) => Promise<void> | void; children?: (selector: string) => Node[]; evaluate?: () => unknown; screenshot?: (path: string) => Promise<void>; throws?: boolean };
export function mockLocator(nodes: () => Node[]): Locator {
  // Reuse dynamic locators as Playwright does; long fake-clock waits must not
  // allocate thousands of independent spy trees for identical selector reads.
  const children = new Map<string, Locator>();
  const cached = (key: string, resolve: () => Node[]) => {
    if (!children.has(key)) children.set(key, mockLocator(resolve));
    return children.get(key)!;
  };
  const view = {
    count: vi.fn(async () => nodes().length),
    nth: (i: number) => cached(`nth:${i}`, () => nodes().slice(i, i + 1)),
    first: () => cached('first', () => nodes().slice(0, 1)),
    isVisible: vi.fn(async () => { if (nodes()[0]?.throws) throw new Error('detached'); return nodes()[0]?.visible !== false; }),
    fill: vi.fn(async (value: string) => { await nodes()[0]?.fill?.(value); }),
    click: vi.fn(async () => { if (nodes()[0]?.throws) throw new Error('detached'); await nodes()[0]?.click?.(); }),
    innerText: vi.fn(async () => nodes()[0]?.text ?? ''),
    getAttribute: vi.fn(async () => nodes()[0]?.href ?? null),
    elementHandle: vi.fn(async () => {
      const pinned = nodes()[0];
      return pinned ? {
        evaluate: vi.fn(async (fn: (element: Element) => unknown) => fn(pinned.dom!)),
        screenshot: vi.fn(async (options: { path: string }) => { await pinned.screenshot?.(options.path); }),
        dispose: vi.fn(async () => {}),
      } : null;
    }),
    screenshot: vi.fn(async (options: { path: string }) => { await nodes()[0]?.screenshot?.(options.path); }),
    evaluateAll: vi.fn(async (fn: (elements: Element[], arg?: unknown) => unknown, arg?: unknown) => fn(nodes().map(node => node.dom ?? ({ getAttribute: () => node.href ?? '' } as unknown as Element)), arg)),
    evaluate: vi.fn(async (fn: (element: Element) => unknown) => nodes()[0]?.evaluate ? nodes()[0].evaluate!() : nodes()[0]?.dom ? fn(nodes()[0].dom!) : undefined),
    locator: () => cached('locator', nodes),
    getByRole: (role: string, options?: { name?: RegExp }) => cached(`role:${role}:${options?.name}`, () => nodes().flatMap(node => node.children?.(`role:${role}`) ?? []).filter(node => !options?.name || options.name.test(node.name ?? ''))),
    filter: (options?: { hasText?: RegExp }) => cached(`filter:${options?.hasText}`, () => nodes().filter(node => !options?.hasText || options.hasText.test(node.text ?? ''))),
  };
  return view as unknown as Locator;
}
export function mockPage(resolve: (selector: string) => Node[] = () => []) {
  let current = 'https://www.instagram.com/';
  const locators = new Map<string, Locator>();
  const cached = (key: string, nodes: () => Node[]) => {
    if (!locators.has(key)) locators.set(key, mockLocator(nodes));
    return locators.get(key)!;
  };
  const page = {
    goto: vi.fn(async (url: string) => { current = url; }),
    url: vi.fn(() => current),
    waitForFunction: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => cached(selector, () => resolve(selector))),
    getByRole: vi.fn((role: string, options?: { name?: RegExp }) => cached(`role:${role}:${options?.name}`, () => resolve(`role:${role}`).filter(node => !options?.name || options.name.test(node.name ?? '')))),
    getByText: vi.fn((pattern: RegExp) => cached(`text:${pattern}`, () => resolve('text').filter(node => pattern.test(node.text ?? '')))),
    getByLabel: vi.fn(() => cached('label', () => [])),
  };
  return { page: page as unknown as Page, goto: page.goto, setUrl: (url: string) => { current = url; } };
}
