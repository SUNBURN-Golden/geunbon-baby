import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { models } from '../seed/models.json';
import { models as before } from './fixtures/models-before-0008.json';
import { memoryD1 } from './helpers/sqlite';
const quote = (v: string | number | null) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

test('0008 updates all reviewed columns including importer, is idempotent and preserves unrelated rows', async () => {
  const memory = memoryD1();
  const execute = async (sql: string) => { for (const s of sql.split(';').filter(s => s.trim())) await memory.db.prepare(s).run(); };
  try {
    await execute(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    for (const [i, m] of before.entries()) {
      await execute(`INSERT INTO models (id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES (${[`model-${i+1}`, m.brand, m.model, m.category, m.kr_importer, m.kr_official_price_krw, m.source_url, m.checked, m.verify_level, m.note].map(quote).join(',')})`);
    }
    await execute("INSERT INTO models (id,brand,name,category,importer,source_url,checked,verify_level,note) VALUES ('unrelated','Other','Other','stroller','unchanged','https://example.com/product','2026-10-20','manual','reviewed')");
    const unrelated = await memory.db.prepare("SELECT * FROM models WHERE id = 'unrelated'").first();
    const migration = await readFile(new URL('../migrations/0008_official_evidence.sql', import.meta.url), 'utf8');
    const statements = migration.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim());
    expect(statements).toHaveLength(41);
    expect(statements.every(s => /^\s*UPDATE\s+models\s+SET\s/i.test(s))).toBe(true);
    for (const s of statements) {
      for (const column of ['importer', 'official_price', 'source_url', 'checked', 'verify_level', 'note']) expect(s).toContain(`${column} = `);
      expect(s).toMatch(/WHERE brand = .+ AND name = /);
    }
    await execute(migration);
    for (const [i, m] of models.entries()) {
      expect(await memory.db.prepare('SELECT importer,official_price,source_url,checked,verify_level,note FROM models WHERE id = ?').bind(`model-${i+1}`).first())
        .toEqual({ importer: m.kr_importer_status === 'recheck_failed' ? `${m.kr_importer} (기존 정보, 재확인 실패)` : m.kr_importer, official_price: m.kr_official_price_krw, source_url: m.source_url, checked: m.checked, verify_level: m.verify_level, note: m.note });
    }
    const once = await memory.db.prepare('SELECT * FROM models ORDER BY id').all();
    await execute(migration);
    expect(await memory.db.prepare('SELECT * FROM models ORDER BY id').all()).toEqual(once);
    expect(await memory.db.prepare("SELECT * FROM models WHERE id = 'unrelated'").first()).toEqual(unrelated);
  } finally { memory.close(); }
});
