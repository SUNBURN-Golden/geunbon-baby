import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fixture } from './helpers/collector';
import { CollectorError } from '../crawler/src/store';
import { parseStatusAck, syncStatus } from '../crawler/src/status-sync';
import type { Snapshot } from '../shared/collection-schema';

const TOKEN = 'offline-collector-token-private';
const MARKER = 'BODY_SECRET_MARKER';
const ENDPOINT = 'https://site.invalid';
let f: ReturnType<typeof fixture>;
let snapshot: Snapshot;
const receipt = (worker_id: unknown = snapshot.worker_id, version: unknown = snapshot.version) => ({ data: { worker_id, version }, private: MARKER });
const raw = (body: BodyInit | null, headers: HeadersInit = { 'content-type': 'application/json' }) => new Response(body, { headers });
const flagged = (key: string, value: unknown) => Object.defineProperty(Response.json(receipt()), key, { value });
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
