import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../../../shared/deal-price-evidence';
import { atomicState, prepareStateDir, readState } from '../deepseek-web/atomic-state';
import type { CollectorStore } from '../store';
import { sendItem, type IngestReceipt, type ThreadsItem } from '../../lib/ingest';
import { collectThreadsPost, threadsAdmission, threadsRegistry } from './threads';
import type { PriceVerifier } from './verify';

const hour = 3_600_000;
// One permalink may use at most this many HTTP requests per scheduled visit:
// the post itself (with up to three redirects) plus robots, redirects and the
// official product page fetched by the price verifier.
const REQUEST_LIMIT = 8;
type Task = { url: string; nextDue: number; receipt: IngestReceipt | null; outcome: string; pending?: ThreadsItem };
const taskDir = (dir: string) => join(dir, 'threads-posts');

export async function registerThreadsPost(dir: string, registry: ReturnType<typeof threadsRegistry>, url: string) {
  const post = threadsAdmission(registry, url);
  if (!post || post.url !== url) throw new Error('threads_source_not_admitted');
  const path = join(taskDir(dir), await digest(url) + '.json');
  try { readState(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    atomicState(path, { url, nextDue: 0, receipt: null, outcome: 'registered' } satisfies Task);
  }
}

export async function runThreadsRevisit(dir: string, store: CollectorStore, deps: {
  api: URL; token: string; verify: PriceVerifier; now: () => number; fetchImpl?: typeof fetch;
}) {
  const directory = prepareStateDir(taskDir(dir));
  const now = deps.now();
  const registry = threadsRegistry(store);
  const tasks = readdirSync(directory).filter(file => /^[0-9a-f]{64}\.json$/.test(file)).map(file => {
    const path = join(directory, file);
    return { path, task: JSON.parse(readState(path)) as Task };
  }).filter(({ task }) => task.nextDue <= now && task.receipt?.status !== 'rejected' && !task.receipt?.price_target_closed);
  tasks.sort((a, b) => a.task.nextDue - b.task.nextDue || a.path.localeCompare(b.path));
  const due = tasks[0];
  if (!due) return false;
  const { path, task } = due;
  const policy = registry.get('social:' + new URL(task.url).hostname);
  const refresh = Math.max(hour, policy?.refresh_ms ?? hour);
  task.nextDue = now + refresh;
  task.outcome = 'started';
  atomicState(path, task);
  let requests = 0;
  // Every HTTP attempt, including redirects and the official-page fetch, spends
  // one unit of this visit's request allowance.
  const charge = () => { if (++requests > REQUEST_LIMIT) throw new Error('threads_request_limit'); };
  const hosts = new Set<string>();
  try {
    if (task.pending && threadsAdmission(registry, task.url)) {
      task.receipt = await sendItem(deps.api, deps.token, task.pending, deps.fetchImpl);
      task.outcome = 'pending_review';
      delete task.pending;
      atomicState(path, task);
      return true;
    }
    delete task.pending;
    const result = await collectThreadsPost(task.url, { ...deps, registry,
      beforeRequest(url) {
        charge();
        const host = new URL(url).hostname;
        if (hosts.has(host)) return;
        const marker = join(directory, 'host-' + host + '.json');
        let last = -Infinity;
        try { last = Number(readState(marker)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (now - last < refresh) throw new Error('threads_host_limit');
        atomicState(marker, now);
        hosts.add(host);
      },
      verificationRequest: charge,
      async send(api, token, item) {
        if (item.kind !== 'threads_post') throw new Error('threads_invalid_delivery');
        task.pending = item;
        atomicState(path, task);
        const receipt = await sendItem(api, token, item, deps.fetchImpl);
        delete task.pending;
        return receipt;
      },
    });
    task.outcome = result.outcome;
    if (result.outcome === 'pending_review') task.receipt = result.receipt;
  } catch { task.outcome = 'collection_retryable'; }
  atomicState(path, task);
  return true;
}
