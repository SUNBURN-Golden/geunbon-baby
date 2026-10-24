import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture, intake, price, ready, expected, source } from './helpers/collector';
import { memoryD1 } from './helpers/sqlite';
import { handleApi } from '../lib/api';
import type { Env } from '../lib/db';
import { CollectorError } from '../crawler/src/store';
import { parseStatusAck, STATUS_HEARTBEAT_MS, syncStatus } from '../crawler/src/status-sync';
import type { Snapshot } from '../shared/collection-schema';
import { parseSnapshot } from '../shared/collection-status';

const TOKEN = 'offline-collector-token-private';
const MARKER = 'BODY_SECRET_MARKER';
const ENDPOINT = 'https://site.invalid';
let f: ReturnType<typeof fixture>;
let snapshot: Snapshot;
const receipt = (worker_id: unknown = snapshot.worker_id, version: unknown = snapshot.version) => ({ data: { worker_id, version }, private: MARKER });
const raw = (body: BodyInit | null, headers: HeadersInit = { 'content-type': 'application/json' }) => new Response(body, { headers });
const flagged = (key: string, value: unknown) => Object.defineProperty(Response.json(receipt()), key, { value });
describe('acknowledgments', () => {
beforeEach(() => { f = fixture(); snapshot = f.store.report(); });
afterEach(() => { f.close(); });

function expectSafeError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(CollectorError);
  const failure = error as CollectorError;
  expect(failure.code).toBe(code);
  expect(failure.status).toBe(502);
  expect(failure.message).toBe(code);
  expect(failure.code).toMatch(/^[a-z_]+$/);
  expect(failure.cause).toBeUndefined();
  for (const secret of [TOKEN, MARKER]) {
    expect(String(failure)).not.toContain(secret);
    expect(failure.stack).not.toContain(secret);
  }
}
async function expectRetryable(send: typeof fetch, code: string) {
  const before = f.store.list<Snapshot>('sync_outbox');
  const error = await syncStatus(f.store, ENDPOINT, TOKEN, send).then(() => null, error => error);
  expectSafeError(error, code);
  expect(f.store.list('sync_outbox')).toEqual(before);
}
const failures: [string, () => Response, string][] = [
  ['HTML success', () => raw(`<html>${MARKER}</html>`, { 'content-type': 'text/html' }), 'sync_content_type'],
  ['missing content type', () => { const response = raw(JSON.stringify(receipt()), new Headers()); response.headers.delete('content-type'); return response; }, 'sync_content_type'],
  ['malformed JSON', () => raw(`{"data":${MARKER}`), 'sync_receipt'],
  ['invalid UTF-8', () => raw(new Uint8Array([0xff])), 'sync_receipt'],
  ['missing body', () => raw(null), 'sync_body'],
  ['empty data', () => Response.json({ data: {}, private: MARKER }), 'sync_worker_mismatch'],
  ...[null, [], {}, { data: null }, { data: [] }].map((value, i): [string, () => Response, string] => [`invalid envelope ${i}`, () => Response.json(value), 'sync_receipt']),
  ...['other-worker', 7, null].map((worker, i): [string, () => Response, string] => [`worker mismatch ${i}`, () => Response.json(receipt(worker)), 'sync_worker_mismatch']),
  ...['7', 7.5, null, NaN, Number.MAX_SAFE_INTEGER + 1, -1].map((version, i): [string, () => Response, string] => [`invalid version ${i}`, () => Response.json(receipt(snapshot.worker_id, version)), 'sync_version_regressed']),
  ['regressed version', () => Response.json(receipt(snapshot.worker_id, snapshot.version - 1)), 'sync_version_regressed'],
  ['redirect status', () => new Response(MARKER, { status: 302 }), 'sync_redirect'],
  ['redirected response', () => flagged('redirected', true), 'sync_redirect'],
  ['opaque redirect', () => flagged('type', 'opaqueredirect'), 'sync_redirect'],
  ...[202, 400, 401, 409, 503].map((status): [string, () => Response, string] => [`HTTP ${status}`, () => Response.json({ error: 'version_payload_mismatch', private: MARKER }, { status }), 'sync_failed']),
];
test.each(failures)('%s retains the outbox and emits only a fixed code', async (_name, makeResponse, code) => {
  const send = vi.fn<typeof fetch>(async () => makeResponse());
  await expectRetryable(send, code);
  expect(send.mock.calls[0][1]?.redirect).toBe('error');
});
test('lost response discards raw transport errors and keeps the snapshot', async () => {
  await expectRetryable(async () => { throw new Error(`Bearer ${TOKEN} ${MARKER}`); }, 'sync_transport');
});
test('body stream failure after headers discards raw errors and keeps the snapshot', async () => {
  let reads = 0;
  await expectRetryable(async () => raw(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`{"private":"${MARKER}","data":`));
      else controller.error(new Error(`Bearer ${TOKEN} ${MARKER}`));
    },
  })), 'sync_body');
});
test('streamed JSON over 4 KB cancels the body and sanitizes cancellation errors', async () => {
  const cancel = vi.fn(() => { throw new Error(`Bearer ${TOKEN} ${MARKER}`); });
  const chunks = [JSON.stringify(receipt()).slice(0, -1) + ',"padding":"', 'x'.repeat(4096), '"}'];
  await expectRetryable(async () => raw(new ReadableStream<Uint8Array>({
    pull(controller) { if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()!)); else controller.close(); }, cancel,
  })), 'sync_oversized');
  expect(cancel).toHaveBeenCalledOnce();
});
test('matching acknowledgment deletes the snapshot and accepts JSON charset/casing', async () => {
  const send = vi.fn<typeof fetch>(async () => raw(JSON.stringify(receipt()), { 'content-type': ' Application/JSON ; charset=utf-8' }));
  expect(await syncStatus(f.store, ENDPOINT, TOKEN, send)).toEqual({ sent: 1 });
  expect(f.store.list('sync_outbox')).toHaveLength(0);
  expect(send.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'POST', signal: expect.any(AbortSignal) });
});
test('lost acknowledgment retries the exact persisted payload after restart', async () => {
  const seen: string[] = [];
  const send: typeof fetch = async (_url, init) => {
    seen.push(init!.body as string);
    if (seen.length === 1) throw new Error(`Bearer ${TOKEN} ${MARKER}`);
    return Response.json(receipt());
  };
  await expectRetryable(send, 'sync_transport');
  f.reopen();
  expect(await syncStatus(f.store, ENDPOINT, TOKEN, send)).toEqual({ sent: 1 });
  expect(seen[1]).toBe(seen[0]);
  expect(f.store.list('sync_outbox')).toHaveLength(0);
});
function queueVersions(versions: number[], localVersion: number) {
  f.store.transaction(() => {
    f.store.db.prepare('DELETE FROM sync_outbox').run();
    for (const version of versions) f.store.put('sync_outbox', String(version), { ...snapshot, version });
    f.store.put('collector_meta', 'version', localVersion);
  });
}
test('higher site acknowledgment within the local counter is valid without a warning', async () => {
  queueVersions([5], 7);
  expect(await syncStatus(f.store, ENDPOINT, TOKEN, async () => Response.json(receipt(snapshot.worker_id, 7)))).toEqual({ sent: 1 });
  expect(f.store.list('sync_outbox')).toHaveLength(0);
});
test('site ahead of a restored counter acknowledges every entry and reports its highest version', async () => {
  queueVersions([6, 7], 7);
  const versions: number[] = [];
  const send: typeof fetch = async (_url, init) => {
    versions.push((JSON.parse(init!.body as string) as Snapshot).version);
    return Response.json(receipt(snapshot.worker_id, versions.length === 1 ? 10 : 9));
  };
  expect(await syncStatus(f.store, ENDPOINT, TOKEN, send)).toEqual({ sent: 2, site_version_ahead: true, site_version: 10 });
  expect(versions).toEqual([6, 7]);
  expect(f.store.list('sync_outbox')).toHaveLength(0);
  expect(f.store.get('collector_meta', 'version')).toBe(7);
});
test('failure on the second entry deletes only the first and leaves later entries untouched', async () => {
  queueVersions([3, 1, 2], 3);
  const versions: number[] = [];
  const send: typeof fetch = async (_url, init) => {
    const s = JSON.parse(init!.body as string) as Snapshot;
    versions.push(s.version);
    return s.version === 2 ? Response.json({ data: {} }) : Response.json(receipt(s.worker_id, s.version));
  };
  const error = await syncStatus(f.store, ENDPOINT, TOKEN, send).then(() => null, error => error);
  expectSafeError(error, 'sync_worker_mismatch');
  expect(versions).toEqual([1, 2]);
  expect(f.store.list<Snapshot>('sync_outbox').map(s => s.version)).toEqual([2, 3]);
});
test('pure acknowledgment parser rejects invalid types and accepts any safe monotonic version', () => {
  for (const version of [snapshot.version, snapshot.version + 10, Number.MAX_SAFE_INTEGER]) {
    expect(parseStatusAck(receipt(snapshot.worker_id, version), snapshot)).toEqual({ worker_id: snapshot.worker_id, version });
  }
  for (const version of [NaN, Infinity, '7', 7.5, null, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    let error: unknown;
    try { parseStatusAck({ data: { worker_id: snapshot.worker_id, version } }, snapshot); } catch (caught) { error = caught; }
    expectSafeError(error, 'sync_version_regressed');
  }
  for (const value of [null, [], {}, { data: null }, { data: [] }]) expect(() => parseStatusAck(value, snapshot)).toThrow('sync_receipt');
});
});

describe('status heartbeat through the site API', () => {
  let memory: ReturnType<typeof memoryD1>;
  let env: Env;
  let bodies: string[];
  let send: typeof fetch;
  const queued = () => f.store.list<Snapshot>('sync_outbox');
  const persisted = () => f.store.db.prepare('SELECT id,data FROM sync_outbox ORDER BY id').all();
  const sync = () => syncStatus(f.store, ENDPOINT, TOKEN, send);
  async function adminStatus() {
    const response = await handleApi(new Request(`${ENDPOINT}/api/v1/admin/collection-status`, {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    }), ['admin', 'collection-status'], env);
    expect(response.status).toBe(200);
    return (await response.json() as { data: { synced: boolean; workers: { snapshot: Snapshot; stale: boolean }[] } }).data;
  }
  beforeEach(async () => {
    f = fixture();
    memory = memoryD1();
    vi.spyOn(Date, 'now').mockImplementation(() => f.now());
    for (const sql of readFileSync(new URL('../migrations/0007_collector_status.sql', import.meta.url), 'utf8').split(';').filter(v => v.trim())) {
      await memory.db.prepare(sql).run();
    }
    env = { DB: memory.db, IMAGES: {} as R2Bucket, ADMIN_TOKEN: 'fixture-admin-token-separation-0001', INGEST_TOKEN: 'fixture-ingest-token-separation-0002', COLLECTOR_STATUS_TOKEN: TOKEN };
    bodies = [];
    send = async (url, init) => {
      bodies.push(init!.body as string);
      const body = JSON.parse(init!.body as string);
      expect(Object.keys(body).sort()).toEqual(['worker_id', 'version', 'generated_at', 'counts', 'total', 'unique', 'groups', 'unresolved_conflicts', 'recheck_due'].sort());
      expect(parseSnapshot(body)).toEqual(body);
      return handleApi(new Request(url, init), ['collector', 'status'], env);
    };
  });
  afterEach(() => { f.close(); memory.close(); });

  test('first sync sends version 1 with zero counts without a report', async () => {
    expect(queued()).toEqual([]);
    expect(await adminStatus()).toEqual({ synced: false, workers: [] });
    expect(await sync()).toEqual({ sent: 1 });
    const result = await adminStatus();
    expect(result.synced).toBe(true);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]).toMatchObject({ stale: false, snapshot: { version: 1, total: 0, unique: 0, groups: 0, unresolved_conflicts: 0, recheck_due: 0 } });
    expect(Object.values(result.workers[0].snapshot.counts)).toEqual([0, 0, 0, 0, 0]);
    expect(queued()).toEqual([]);
  });

  test('unchanged counts refresh after an hour while syncs within the cadence do not create versions', async () => {
    await sync();
    const original = (await adminStatus()).workers[0].snapshot;
    f.advance(5 * 60_000);
    expect(await sync()).toEqual({ sent: 0 });
    expect((await adminStatus()).workers[0].snapshot).toEqual(original);
    f.advance(56 * 60_000);
    // Reading the local status retains its cached version regardless of age.
    expect(f.store.report()).toEqual(original);
    expect(await sync()).toEqual({ sent: 1 });
    const worker = (await adminStatus()).workers[0];
    expect(worker.stale).toBe(false);
    expect(worker.snapshot).toEqual({ ...original, version: original.version + 1, generated_at: new Date(f.now()).toISOString() });
  });

  test('periodic idle syncs remain fresh across multiple stale windows', async () => {
    await sync();
    for (let version = 2; version <= 10; version++) {
      f.advance(STATUS_HEARTBEAT_MS);
      expect(await sync()).toEqual({ sent: 1 });
      expect((await adminStatus()).workers[0]).toMatchObject({ stale: false, snapshot: { version, total: 0 } });
    }
  });

  test.each(['verified_waiting', 'ready_to_publish'] as const)('sync expires %s evidence without a report', async status => {
    const url = `${source.origin}/approval`;
    intake(f.store, url, price());
    const group = f.store.recordByUrl(url)!.dedup_group_id;
    if (status === 'ready_to_publish') ready(f.store, group);
    else f.store.review(group, { ...expected(f.store, group), decision: 'verify', reviewer: 'fixture-reviewer' });
    await sync();
    expect((await adminStatus()).workers[0].snapshot.counts[status]).toBe(1);
    f.advance(86_400_001);
    expect(await sync()).toEqual({ sent: 1 });
    expect((await adminStatus()).workers[0]).toMatchObject({ stale: false, snapshot: {
      counts: { ready_to_publish: 0, verified_waiting: 0, source_check_needed: 1 }, recheck_due: 1,
    } });
  });

  test('lost acknowledgment retries identical persisted bytes after restart before sending the heartbeat', async () => {
    const original = f.store.report();
    const before = persisted();
    const error = await syncStatus(f.store, ENDPOINT, TOKEN, async (url, init) => {
      const response = await send(url, init);
      expect(response.status).toBe(200);
      throw new Error('lost acknowledgment');
    }).catch(error => error);
    expect(error).toMatchObject({ code: 'sync_transport' });
    expect(persisted()).toEqual(before);
    expect((await adminStatus()).workers[0].snapshot).toEqual(original);
    f.reopen();
    f.advance(STATUS_HEARTBEAT_MS);
    expect(await sync()).toEqual({ sent: 2 });
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies.map(body => JSON.parse(body).version)).toEqual([1, 1, 2]);
    expect(queued()).toEqual([]);
    expect((await adminStatus()).workers[0]).toMatchObject({ stale: false, snapshot: { version: 2 } });
  });

  test('out-of-order delivery keeps the newer snapshot and acknowledges older entries within the local counter', async () => {
    const older = f.store.report();
    f.advance(STATUS_HEARTBEAT_MS);
    const newer = f.store.heartbeat(STATUS_HEARTBEAT_MS);
    const post = (snapshot: Snapshot) => send(ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(snapshot) });
    expect((await post(newer)).status).toBe(200);
    const response = await post(older);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { worker_id: newer.worker_id, version: newer.version } });
    expect((await adminStatus()).workers[0].snapshot).toEqual(newer);
    bodies.length = 0;
    expect(await sync()).toEqual({ sent: 2 });
    expect(bodies.map(body => JSON.parse(body).version)).toEqual([older.version, newer.version]);
    expect(queued()).toEqual([]);
    expect((await adminStatus()).workers[0].snapshot).toEqual(newer);
  });

  test('missed sync becomes stale after one hour and the next sync clears it', async () => {
    await sync();
    f.advance(61 * 60_000);
    expect((await adminStatus()).workers[0].stale).toBe(true);
    expect(await sync()).toEqual({ sent: 1 });
    expect((await adminStatus()).workers[0].stale).toBe(false);
  });

  test('failed sync adds at most one immutable row per heartbeat interval', async () => {
    const fail: typeof fetch = async () => { throw new Error('offline'); };
    const failedSync = () => expect(syncStatus(f.store, ENDPOINT, TOKEN, fail)).rejects.toMatchObject({ code: 'sync_transport' });
    await failedSync();
    const first = persisted();
    expect(first).toHaveLength(1);
    f.advance(STATUS_HEARTBEAT_MS - 1);
    await failedSync();
    expect(persisted()).toEqual(first);
    f.advance(1);
    await failedSync();
    const second = persisted();
    expect(second).toHaveLength(2);
    expect(second.slice(0, 1)).toEqual(first);
    await failedSync();
    expect(persisted()).toEqual(second);
  });

  test.each([
    ['http://site.invalid', TOKEN],
    [ENDPOINT, 'short'],
  ])('invalid config %s creates no outbox rows even when a heartbeat is due', async (endpoint, token) => {
    const transport = vi.fn(send);
    for (const initialized of [false, true]) {
      if (initialized) { f.store.report(); f.advance(STATUS_HEARTBEAT_MS); }
      const before = persisted();
      await expect(syncStatus(f.store, endpoint, token, transport)).rejects.toMatchObject({ code: 'sync_config' });
      expect(persisted()).toEqual(before);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid heartbeat %s creates no snapshot', async heartbeatMs => {
    await expect(syncStatus(f.store, ENDPOINT, TOKEN, send, heartbeatMs)).rejects.toMatchObject({ code: 'sync_config' });
    expect(queued()).toEqual([]);
    expect(bodies).toEqual([]);
  });

  test('an explicit cadence and a backwards clock each refresh the snapshot', async () => {
    await sync();
    f.advance(1000);
    expect(await syncStatus(f.store, ENDPOINT, TOKEN, send, 1000)).toEqual({ sent: 1 });
    f.advance(-1);
    expect(await sync()).toEqual({ sent: 1 });
    expect((await adminStatus()).workers[0].snapshot).toMatchObject({ version: 3, generated_at: new Date(f.now()).toISOString() });
  });

  test('a failed record invariant prevents heartbeat creation and sending', async () => {
    f.store.discover(`${source.origin}/invalid`);
    const before = persisted();
    f.store.db.prepare("UPDATE collection_records SET status='dedup_excluded'").run();
    f.advance(STATUS_HEARTBEAT_MS);
    await expect(sync()).rejects.toMatchObject({ code: 'representative_invariant' });
    expect(persisted()).toEqual(before);
    expect(bodies).toEqual([]);
  });
});
