// Small synthetic DOM fixture: exercises the serialized selector without launching
// Playwright or making requests. Geometry includes clipping ancestors/carousels.
import { vi } from 'vitest';
export class MediaElement {
  parentElement: MediaElement | null = null;
  attrs: Record<string, string> = {};
  style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
  rect = { left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400 };
  currentSrc = '';
  src = 'https://scontent.cdninstagram.com/fixture.jpg?sig=synthetic%2Bvalue&x=1';
  complete = true;
  naturalWidth = 1000;
  readyState = 2;
  poster = '';
  constructor(public tagName: string, parent?: MediaElement) { this.parentElement = parent ?? null; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return name in this.attrs; }
  getBoundingClientRect() { return this.rect; }
  closest(selector: string): MediaElement | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let node: MediaElement | null = this; node; node = node.parentElement) {
      if (selector.split(',').some(part => {
        const key = part.trim();
        return key === node!.tagName.toLowerCase() ||
          (key === 'a[href]' && node!.tagName === 'A' && node!.hasAttribute('href')) ||
          (key === '[role="dialog"]' && node!.attrs.role === 'dialog') ||
          (key === '[role="banner"]' && node!.attrs.role === 'banner');
      })) return node;
    }
    return null;
  }
}
export function mediaDOM(articles: MediaElement[] = []) {
  vi.stubGlobal('document', { querySelectorAll: () => articles });
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('getComputedStyle', (element: MediaElement) => element.style);
}
export const asElement = (element: MediaElement) => element as unknown as Element;
