import { closeSync, constants, fsyncSync, ftruncateSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareStateDir, safePath, syncDirectory } from '../deepseek-web/atomic-state';
import type { CollectorStore } from '../store';

const HOUR = 3_600_000;
const KST = 9 * HOUR;
export const kstMidnight = (time: number) => (Math.floor((time + KST) / (24 * HOUR)) + 1) * 24 * HOUR - KST;
const kst = (time: number) => new Date(time + KST).toISOString().replace('Z', '+09:00');
type Event = { id: string; at: number; kind: string; data: string };
type Usage = { model: string; input: number | null; output: number | null; total: number | null; cost: number | null; currency: string | null; rate_basis: string | null };
type EventData = {
  scan: object;
  product: { product: string };
  verified: { product: string };
  rejected: { product: string; gates: string[] };
  model: Usage;
  publication: { committed_at: string };
  instagram_stop: { reason: 'rate_limited' | 'checkpoint' | 'identity' | 'two_factor'; resume_at: number };
};
export function offerEvent<K extends keyof EventData>(store: CollectorStore, id: string, kind: K, data: EventData[K], at = store.now()) {
  store.db.prepare('INSERT OR IGNORE INTO offer_metric_events(id,at,kind,data) VALUES (?,?,?,?)').run(id, at, kind, JSON.stringify(data));
}

function hourRecord(events: Event[], start: number) {
  const models: Record<string, { calls: number; input_tokens: number; output_tokens: number; total_tokens: number; unknown_usage: number; unknown_cost: number; costs: Record<string, number> }> = Object.create(null);
  const products = new Set<string>(), verified = new Set<string>(), rejected = new Set<string>();
  const gates = new Map<string, Set<string>>();
  let sources = 0, published = 0;
  for (const event of events) {
    if (event.kind === 'scan') sources++;
    if (event.kind === 'publication') published++;
    if (event.kind === 'product') products.add((JSON.parse(event.data) as EventData['product']).product);
    if (event.kind === 'verified') verified.add((JSON.parse(event.data) as EventData['verified']).product);
    if (event.kind === 'rejected') {
      const entry = JSON.parse(event.data) as EventData['rejected'];
      rejected.add(entry.product);
      for (const reason of entry.gates) {
        if (!gates.has(reason)) gates.set(reason, new Set());
        gates.get(reason)!.add(entry.product);
      }
    }
    if (event.kind === 'model') {
      const usage = JSON.parse(event.data) as Usage;
      const model = models[usage.model] ??= { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, unknown_usage: 0, unknown_cost: 0, costs: {} };
      model.calls++;
      model.input_tokens += usage.input ?? 0;
      model.output_tokens += usage.output ?? 0;
      model.total_tokens += usage.total ?? 0;
      if (usage.input === null || usage.output === null || usage.total === null) model.unknown_usage++;
      if (usage.cost === null || usage.currency === null || usage.rate_basis === null) model.unknown_cost++;
      else {
        const key = `${usage.currency}:${usage.rate_basis}`;
        model.costs[key] = (model.costs[key] ?? 0) + usage.cost;
      }
    }
  }
  return { id: `hour:${start}`, type: 'hour', start_kst: kst(start), end_kst: kst(start + HOUR),
    sources_scanned: sources, candidates: products.size, verified: verified.size, published,
    rejected: rejected.size, rejected_by_gate: Object.fromEntries([...gates].map(([gate, products]) => [gate, products.size])), models };
}

export function exportOfferMetrics(store: CollectorStore, dir: string) {
  dir = prepareStateDir(dir);
  const file = safePath(join(dir, 'metrics-hourly.jsonl'));
  // SQLite serializes the daemon exporter and the immediate v2 alert writer.
  // The file is authoritative across a crash between append/fsync and commit.
  store.transaction(() => {
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const previous = readFileSync(fd);
      const end = previous.lastIndexOf(10) + 1;
      if (end !== previous.length) ftruncateSync(fd, end);
      const ids = new Set<string>(Buffer.from(previous.subarray(0, end)).toString('utf8').split('\n').filter(Boolean).map((line: string) => (JSON.parse(line) as { id: string }).id));
      const append = (entry: { id: string }) => {
        if (ids.has(entry.id)) return;
        writeFileSync(fd, JSON.stringify(entry) + '\n');
        ids.add(entry.id);
      };
      const unfinished = store.db.prepare(`SELECT min(at) AS at FROM offer_metric_events
        WHERE kind='model' AND json_extract(data,'$.pending_until')>?`).get(store.now()) as { at: number | null };
      const current = Math.floor(Math.min(store.now(), unfinished.at ?? Infinity) / HOUR) * HOUR;
      const marker = store.db.prepare("SELECT value FROM offer_runtime WHERE key='metrics_cursor'").get() as { value: string } | undefined;
      const earliest = store.db.prepare('SELECT min(at) AS earliest FROM offer_metric_events').get() as { earliest: number | null };
      const flushed = [...ids].filter(id => id.startsWith('hour:')).map(id => Number(id.slice(5)));
      const lower = Math.min(earliest.earliest ?? current, marker ? Number(marker.value) : current);
      const from = Math.min(marker ? Number(marker.value) : Infinity,
        flushed.length ? Math.max(...flushed) + HOUR : Math.floor(lower / HOUR) * HOUR);
      const rows = store.db.prepare("SELECT * FROM offer_metric_events WHERE at >= ? AND at < ? AND kind <> 'instagram_stop' ORDER BY at");
      for (let hour = from; hour < current; hour += HOUR) append(hourRecord(rows.all(hour, hour + HOUR) as Event[], hour));
      for (const alert of store.db.prepare("SELECT * FROM offer_metric_events WHERE kind='instagram_stop' ORDER BY at").iterate() as Iterable<Event>) {
        const { reason, resume_at } = JSON.parse(alert.data) as EventData['instagram_stop'];
        append({ id: alert.id, type: 'instagram_stop', reason, at_kst: kst(alert.at), resume_kst: kst(resume_at) } as { id: string });
      }
      fsyncSync(fd);
      syncDirectory(dir);
      store.db.prepare("INSERT INTO offer_runtime(key,value) VALUES ('metrics_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(current));
    } finally { closeSync(fd); }
  });
}
