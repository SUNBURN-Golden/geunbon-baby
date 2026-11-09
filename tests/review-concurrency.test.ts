import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, approval, migrate, pending } from './helpers/deal-timestamps';
import { LOSER_TIME, WINNER_TIME, rejectionGate, reviewSnapshot } from './helpers/review-race';
import { memoryD1 } from './helpers/sqlite';

let memory: ReturnType<typeof memoryD1>;
const id = 'review-race';
const path = `admin/review/${id}`;
const approve = () => approval('2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z');
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LOSER_TIME);
  memory = memoryD1();
  await migrate(memory.db);
  await pending(memory.db, id);
});
afterEach(() => { vi.useRealTimers(); memory.close(); });

test.each(['approve', 'reject'] as const)('%s wins after rejection reads pending; losing rejection returns 409 without writes', async action => {
  const gate = rejectionGate(memory.db);
  const loser = api(gate.db)(path, { action: 'reject' });
  let won!: Awaited<ReturnType<typeof reviewSnapshot>>;
  try {
    await gate.reached;
    expect((await reviewSnapshot(memory.db, id)).item).toMatchObject({ status: 'pending', reviewed_at: null });
    vi.setSystemTime(WINNER_TIME);
    const winner = await api(memory.db)(path, action === 'approve' ? approve() : { action });
    expect(winner.status).toBe(200);
    expect(await winner.json()).toEqual({ data: action === 'approve' ? { status: 'approved' } : { changed: 1 } });
    won = await reviewSnapshot(memory.db, id);
    expect(won.item).toMatchObject({ status: action === 'approve' ? 'approved' : 'rejected', reviewed_at: WINNER_TIME });
    if (action === 'approve') {
      expect(won.deal).toMatchObject({ id, status: 'published', version: 1, withdrawn_at: null });
      expect(won.revisions).toHaveLength(1);
      expect(won.revisions[0]).toMatchObject({ deal_id: id, action: 'publish', version: 1, created_at: WINNER_TIME });
      for (const field of ['model_id', 'seller_id', 'title', 'price', 'starts_at', 'ends_at', 'image_url', 'checked', 'status', 'version']) {
        expect(won.revisions[0][field]).toEqual(won.deal![field]);
      }
    } else {
      expect(won.deal).toBeNull();
      expect(won.revisions).toEqual([]);
    }
  } finally { gate.release(); }
  const response = await loser;
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: '이미 검수된 항목' });
  expect(await reviewSnapshot(memory.db, id)).toEqual(won);
});

test('uncontested rejection retains its successful response contract', async () => {
  const response = await api(memory.db)(path, { action: 'reject' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { changed: 1 } });
  expect(await reviewSnapshot(memory.db, id)).toMatchObject({
    item: { status: 'rejected', reviewed_at: LOSER_TIME }, deal: null, revisions: [],
  });
});

test.each(['approve', 'reject'] as const)('already reviewed via %s returns 409 through the initial read guard', async action => {
  expect((await api(memory.db)(path, action === 'approve' ? approve() : { action })).status).toBe(200);
  const before = await reviewSnapshot(memory.db, id);
  const gate = rejectionGate(memory.db);
  const response = await api(gate.db)(path, { action: 'reject' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: '이미 검수된 항목' });
  expect(await reviewSnapshot(memory.db, id)).toEqual(before);
});

test('rejection database errors propagate without reporting a conflict or success', async () => {
  const before = await reviewSnapshot(memory.db, id);
  const prepare = memory.db.prepare.bind(memory.db);
  vi.spyOn(memory.db, 'prepare').mockImplementation(sql => {
    if (sql.startsWith("UPDATE ingested_items SET status = 'rejected'")) throw new Error('Injected rejection failure');
    return prepare(sql);
  });
  await expect(api(memory.db)(path, { action: 'reject' })).rejects.toThrow('Injected rejection failure');
  expect(await reviewSnapshot(memory.db, id)).toEqual(before);
});
