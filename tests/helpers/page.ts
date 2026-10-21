import { vi } from 'vitest';
import type { Locator, Page } from 'playwright';
export type Node = { name?: string; text?: string; href?: string; visible?: boolean; click?: () => Promise<void> | void; screenshot?: (path: string) => Promise<void>; throws?: boolean };
export function mockLocator(nodes: () => Node[]): Locator {
  const view = {
    count: vi.fn(async () => nodes().length),
    nth: (i: number) => mockLocator(() => nodes().slice(i, i + 1)),
    first: () => mockLocator(() => nodes().slice(0, 1)),
    isVisible: vi.fn(async () => { if (nodes()[0]?.throws) throw new Error('detached'); return nodes()[0]?.visible !== false; }),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => { if (nodes()[0]?.throws) throw new Error('detached'); await nodes()[0]?.click?.(); }),
    innerText: vi.fn(async () => nodes()[0]?.text ?? ''),
    getAttribute: vi.fn(async () => nodes()[0]?.href ?? null),
    screenshot: vi.fn(async (options: { path: string }) => { await nodes()[0]?.screenshot?.(options.path); }),
    evaluateAll: vi.fn(async (fn: (elements: { getAttribute: () => string }[]) => unknown) => fn(nodes().map(node => ({ getAttribute: () => node.href ?? '' })))),
    locator: () => mockLocator(nodes),
    filter: () => mockLocator(nodes),
  };
  return view as unknown as Locator;
}
export function mockPage(resolve: (selector: string) => Node[] = () => []) {
  let current = 'https://www.instagram.com/';
  const page = {
    goto: vi.fn(async (url: string) => { current = url; }),
    url: vi.fn(() => current),
    locator: vi.fn((selector: string) => mockLocator(() => resolve(selector))),
    getByRole: vi.fn((role: string, options?: { name?: RegExp }) => mockLocator(() => resolve(`role:${role}`).filter(node => !options?.name || options.name.test(node.name ?? '')))),
    getByText: vi.fn((pattern: RegExp) => mockLocator(() => resolve('text').filter(node => pattern.test(node.text ?? '')))),
    getByLabel: vi.fn(() => mockLocator(() => [])),
  };
  return { page: page as unknown as Page, goto: page.goto, setUrl: (url: string) => { current = url; } };
}
