// Synthetic DOM tree for offline Playwright identity/scoping callbacks. Child
// queries traverse descendants; they cannot resolve anchors elsewhere on page.
import { MediaElement, asElement } from './media-dom';
import { mockPage, type Node } from './page';
import { POST_ANCHORS, PROFILE_ARTICLES } from '../../crawler/lib/selectors';
export const POST_ARTICLES = 'main article, [role="main"] article, [role="dialog"] article';
export class PostElement extends MediaElement {
  children: PostElement[] = [];
  constructor(tag: string, parent?: PostElement, attrs: Record<string, string> = {}) {
    super(tag.toUpperCase(), parent);
    this.attrs = attrs;
    parent?.children.push(this);
  }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const key = part.trim();
      const tag = /^\w+/.exec(key)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      return [...key.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]*)")?\]/g)].every(([, attr, op, value]) =>
        op === '=' ? this.attrs[attr] === value : op === '*=' ? (this.attrs[attr] ?? '').includes(value) : attr in this.attrs);
    });
  }
  closest(selector: string): PostElement | null {
    if (this.matches(selector)) return this;
    for (let node = this.parentElement as PostElement | null; node; node = node.parentElement as PostElement | null) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): PostElement[] {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector.split(',').some(part => {
      const pieces = part.trim().split(/\s+/);
      if (!child.matches(pieces.pop()!)) return false;
      let ancestor = child.parentElement as PostElement | null;
      while (pieces.length) {
        const piece = pieces.pop()!;
        while (ancestor && !ancestor.matches(piece)) ancestor = ancestor.parentElement as PostElement | null;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement as PostElement | null;
      }
      return true;
    }));
  }
  querySelector(selector: string): PostElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}
export const node = (dom: PostElement): Node => ({ dom: asElement(dom) });
export function postTree(author?: string) {
  const main = new PostElement('main');
  const article = new PostElement('article', main);
  if (author) new PostElement('a', new PostElement('header', article), { href: `/${author}/` });
  return { main, article };
}
// Existing success fixtures explicitly opt in to a matching grid and header.
export function mockProfilePostPage(account: string, resolve: (selector: string) => Node[] = () => []) {
  const grid = postTree();
  const post = postTree(account);
  return mockPage(selector => {
    if (selector === PROFILE_ARTICLES) return [{ ...node(grid.article), children: child => child === POST_ANCHORS ? resolve(child) : [] }];
    if (selector === POST_ARTICLES) return [node(post.article)];
    return resolve(selector);
  });
}
