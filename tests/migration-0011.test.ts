import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { execute, legacy, migrate } from './helpers/deal-timestamps';
import { memoryD1 } from './helpers/sqlite';

test('0011 preserves every legacy column and creates one original publish revision per deal', async () => {
  const memory = memoryD1();
  try {
    await migrate(memory.db, '0010');
    for (const id of ['legacy-a', 'legacy-b']) await legacy(memory.db, id, '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z');
    const before = (await memory.db.prepare('SELECT * FROM deals ORDER BY id').all()).results;
    const evidence = (await memory.db.prepare('SELECT * FROM ingested_items ORDER BY id').all()).results;
    await execute(memory.db, await readFile(new URL('../migrations/0011_deal_lifecycle.sql', import.meta.url), 'utf8'));
    const after = (await memory.db.prepare('SELECT * FROM deals ORDER BY id').all()).results;
    for (const [index, original] of before.entries()) expect(after[index]).toEqual({ ...original, status: 'published', version: 1, updated_at: null, withdrawn_at: null });
    const revisions = (await memory.db.prepare('SELECT * FROM deal_revisions ORDER BY deal_id').all()).results;
    expect(revisions).toHaveLength(2);
    for (const [index, revision] of revisions.entries()) {
      expect(revision).toMatchObject({ deal_id: before[index].id, version: 1, action: 'publish', request_id: 'migration-0011', request_hash: 'baseline', reason: null, status: 'published', created_at: before[index].checked });
      for (const field of ['model_id','seller_id','title','price','starts_at','ends_at','image_url','checked']) expect(revision[field]).toEqual(before[index][field]);
    }
    expect((await memory.db.prepare('SELECT * FROM ingested_items ORDER BY id').all()).results).toEqual(evidence);
  } finally { memory.close(); }
});
