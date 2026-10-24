import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { models } from '../seed/models.json';
import { models as before } from './fixtures/models-before-0008.json';
import { memoryD1 } from './helpers/sqlite';

test('0012 separates importer status, preserves unknown importers and constrains future rows', async () => {
  const memory = memoryD1();
  const execute = async (sql: string) => {
    for (const statement of sql.split(';').filter(s => s.trim())) await memory.db.prepare(statement).run();
  };
  const dir = new URL('../migrations/', import.meta.url);
  try {
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql') && f.slice(0, 4) <= '0011').sort()) {
      await execute(await readFile(new URL(file, dir), 'utf8'));
      if (file === '0001_initial.sql') {
        for (const [i, m] of before.entries()) {
          await memory.db.prepare('INSERT INTO models (id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .bind(`model-${i + 1}`, m.brand, m.model, m.category, m.kr_importer, m.kr_official_price_krw, m.source_url, m.checked, m.verify_level, m.note).run();
        }
        await execute("INSERT INTO models (id,brand,name,category,importer,source_url,checked,verify_level,note) VALUES ('unrelated','Other','Other','stroller','unchanged','https://example.com/product','2026-10-20','manual','reviewed')");
      }
    }
    const migration = await readFile(new URL('0012_importer_status.sql', dir), 'utf8');
    const statements = migration.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim());
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^\s*ALTER TABLE models ADD COLUMN importer_status\s/i);
    expect(statements.slice(1).every(s => /^\s*UPDATE\s/i.test(s))).toBe(true);
    expect(statements.join('\n')).not.toMatch(/\bDROP\b|\bCREATE TABLE\b/i);
    await execute(migration);

    const rows = (await memory.db.prepare("SELECT importer, importer_status FROM models WHERE id != 'unrelated' ORDER BY CAST(SUBSTR(id, 7) AS INTEGER)").all()).results;
    expect(rows).toEqual(models.map(m => ({ importer: m.kr_importer, importer_status: m.kr_importer_status })));
    for (const row of rows) {
      expect(row.importer).toBeTruthy();
      expect(row.importer).not.toMatch(/재확인 실패/);
      if (row.importer_status === 'unconfirmed') expect(row.importer).toBe('미확인');
    }
    const groups = (await memory.db.prepare("SELECT importer, importer_status, COUNT(*) AS count FROM models WHERE id != 'unrelated' GROUP BY 1,2").all<{ importer: string; importer_status: string; count: number }>()).results;
    expect(groups).toHaveLength(12);
    for (const [status, count] of Object.entries({ confirmed: 23, recheck_failed: 15, unconfirmed: 3 })) {
      expect(groups.filter(g => g.importer_status === status).reduce((sum, g) => sum + g.count, 0)).toBe(count);
    }
    expect(await memory.db.prepare("SELECT importer, importer_status FROM models WHERE id = 'unrelated'").first())
      .toEqual({ importer: 'unchanged', importer_status: 'unconfirmed' });

    const once = await memory.db.prepare('SELECT * FROM models ORDER BY id').all();
    await execute(statements.slice(1).join(';'));
    expect(await memory.db.prepare('SELECT * FROM models ORDER BY id').all()).toEqual(once);
    await expect(execute("UPDATE models SET importer_status = 'bogus' WHERE id = 'unrelated'"))
      .rejects.toThrow(/CHECK constraint failed/i);
    await execute("INSERT INTO models (id,brand,name,category,importer,source_url,checked,verify_level,note) VALUES ('new','Stokke','New','stroller','스토케코리아','','2026-10-25','manual','')");
    expect(await memory.db.prepare("SELECT importer_status FROM models WHERE id = 'new'").first())
      .toEqual({ importer_status: 'unconfirmed' });
  } finally { memory.close(); }
});
