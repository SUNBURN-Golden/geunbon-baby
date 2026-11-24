import { threadsOrigins, threadsPost } from '../../../shared/threads-url';
import { parseHtml, selectAll, decodeEntities, type El } from '../../lib/external/parse';
import { ParseBudget } from '../../lib/external/parse-budget';
import { sendItem, type IngestReceipt } from '../../lib/ingest';
import { SourceRegistryStore } from '../source-registry/store';
import type { CollectorStore } from '../store';
import type { SourcePolicy } from '../source-policy';
import { captureText, type PriceVerifier } from './verify';

const fields = ['brand', 'model', 'generation', 'bundle_components', 'clue_price', 'group_buy_terms'] as const;
const sourceId = (origin: string) => `social:${new URL(origin).hostname}`;

const adapters: SourcePolicy[] = threadsOrigins.map(origin => ({
  id: sourceId(origin), origin, brand: 'Threads', kind: 'unknown', paths: ['/'], query_keys: [], entries: [],
  adapter: 'links', browser: false, selector: '', official_fields: [...fields], full_text_allowed: false,
  recheck_ms: 3_600_000, max_pages: 1, enabled: true,
}));
export const threadsRegistry = (store: CollectorStore) => new SourceRegistryStore(store, adapters);
type Decision = Pick<SourceRegistryStore, 'decide'>;
export function threadsAdmission(registry: Decision, url: string) {
  const post = threadsPost(url);
  return post && registry.decide(sourceId(post.origin), url, fields).allowed ? post : null;
}
type Post = NonNullable<ReturnType<typeof threadsPost>>;
type ThreadsResult = { outcome: 'captured'; text: string; post: Post } | { outcome: 'source_inaccessible' };

function postBody(html: string, post: Post) {
  const root = parseHtml(html, new ParseBudget());
  const articles = selectAll(root, 'article').filter(article => {
    if (article.attrs['data-post-id'] !== post.id) return false;
    for (let parent: El | null | undefined = article; parent; parent = parent.parent) {
      if ('hidden' in parent.attrs || 'data-login-wall' in parent.attrs || parent.attrs['aria-hidden'] === 'true' ||
          /display\s*:\s*none|visibility\s*:\s*hidden/i.test(parent.attrs.style ?? '') ||
          parent !== article && ['article','iframe','aside','template'].includes(parent.tag)) return false;
    }
    const author = article.attrs['data-author']?.replace(/^@/, '').toLowerCase();
    return author === post.account;
  });
  if (articles.length !== 1) return '';
  const body = selectAll(articles[0], '[data-post-body]');
  if (body.length !== 1) return '';
  const read = (node: El | string): string => {
    if (typeof node === 'string') return decodeEntities(node);
    if (['script', 'style', 'form', 'nav', 'aside', 'article', 'iframe'].includes(node.tag) ||
        'hidden' in node.attrs || node.attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.attrs.style ?? '')) return '';
    const content = node.children.map(read).join('');
    return /^(?:p|div|span|li|br)$/.test(node.tag) ? `\n${content}\n` : content;
  };
  return captureText(read(body[0]));
}

async function boundedHtml(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [], decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 768_000) return '';
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function fetchThreadsPost(url: string, registry: Decision, fetchImpl = fetch, beforeRequest?: (url: string) => void): Promise<ThreadsResult> {
  const requested = threadsPost(url);
  const denied = { outcome: 'source_inaccessible' } as const;
  if (!requested) return denied;
  let next = url;
  try {
    for (let redirects = 0; redirects < 3; redirects++) {
      const post = threadsPost(next);
      if (!post || post.account !== requested.account || post.id !== requested.id ||
          !threadsAdmission(registry, next)) return denied;
      beforeRequest?.(next);
      const response = await fetchImpl(next, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15_000) });
      if (response.redirected) return denied;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) return denied;
        next = new URL(location, next).href;
        continue;
      }
      if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel().catch(() => {});
        return denied;
      }
      const text = postBody(await boundedHtml(response), requested);
      if (text) return { outcome: 'captured', text, post: requested };
      return denied;
    }
  } catch { return denied; }
  return denied;
}

export async function collectThreadsPost(url: string, deps: {
  registry: Decision; verify: PriceVerifier; api: URL; token: string; fetchImpl?: typeof fetch; send?: typeof sendItem;
  now?: () => number; beforeRequest?: (url: string) => void; verificationRequest?: (url: string) => void;
}): Promise<{ outcome: 'source_inaccessible' } | { outcome: 'pending_review'; receipt: IngestReceipt }> {
  const captured = await fetchThreadsPost(url, deps.registry, deps.fetchImpl, deps.beforeRequest);
  if (captured.outcome !== 'captured') return captured;
  const at = new Date((deps.now ?? Date.now)()).toISOString(), { post, text } = captured;
  // Official-page fetches (and their redirects/robots) consume the same bounded
  // request allowance as the Threads post fetch.
  const price_evidence = await deps.verify(post.url, text, at, undefined, deps.verificationRequest);
  const receipt = await (deps.send ?? sendItem)(deps.api, deps.token, {
    platform: 'threads', kind: 'threads_post', source_url: post.url, account: post.account, text, captured_at: at, price_evidence,
  });
  return { outcome: 'pending_review', receipt };
}
