import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { models } from '../seed/models.json';
import tripp from '../seed/tripp_trapp.json';
import { buildSeedSql } from '../scripts/seed-sql';
import { memoryD1 } from './helpers/sqlite';

const legacyNotes = [
  ['Stokke', '트립트랩 하이체어(오크)', 'SSG 신세계백화점에는 510,000원으로 표시돼 확인 필요'],
  ['Stokke', '익스플로리 X', '공식몰 할인가 1,390,000원 표시(재고 소진 임박)'],
  ['Bugaboo', '폭스5 리뉴', '갤러리아 5% 할인 2,223,000원'],
  ['Ergobaby', '옴니 브리즈', '검색 요약상 259,000~300,000원 범위, 단일 공식가 미확인'],
  ['Doona', '두나 카시트 겸용 유모차', '국내 공식 수입사·공식가 미확인. 비공식 판매가 701,400원(옥션, 2026-07-24 기준)'],
];
const legacy0004Result: Record<string, string> = {
  '트립트랩 하이체어(오크)': '', '익스플로리 X': '', '폭스5 리뉴': '',
  '옴니 브리즈': '단일 공식가 미확인', '두나 카시트 겸용 유모차': '국내 공식 수입사·공식가 미확인.',
};
const cleanup = new URL('../migrations/0004_official_groupbuy_only.sql', import.meta.url);

test('every non-null seeded official price has page_body verification', () => {
  for (const model of models) {
    if (model.kr_official_price_krw !== null) expect(model.verify_level, model.model).toBe('page_body');
  }
});

async function execute(db: D1Database, sql: string) {
  for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run();
}

async function schema(db: D1Database) {
  for (const name of ['0001_initial.sql', '0002_suggestions.sql', '0003_image_url.sql']) {
    await execute(db, await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

test('seed stores only domestic official prices and retailer identities', () => {
  expect(Object.keys(tripp).sort()).toEqual(['checked', 'gonggu', 'kr_official', 'kr_retailers', 'product']);
  expect(tripp.kr_retailers).toHaveLength(3);
  for (const seller of tripp.kr_retailers) expect(Object.keys(seller).sort()).toEqual(['retailer', 'source']);
  expect(tripp.gonggu.found).toEqual([]);
  expect(tripp.kr_official.find(row => row.config === '하이체어 오크')?.note).toBe('검색 요약');
  for (const model of models) {
    expect(model.note).not.toMatch(/\d/);
    if (model.verify_level === 'official_unpublished') expect(model.kr_official_price_krw).toBeNull();
  }
});

test('seed SQL can be rerun without replacing existing models, sellers or group buys', async () => {
  const memory = memoryD1();
  try {
    await schema(memory.db);
    const seed = buildSeedSql();
    await execute(memory.db, seed.sql);
    expect((await memory.db.prepare('SELECT * FROM models').all()).results).toHaveLength(models.length);
    expect((await memory.db.prepare('SELECT name, source_url FROM sellers ORDER BY id').all()).results)
      .toEqual(tripp.kr_retailers.map(s => ({ name: s.retailer, source_url: s.source })));
    const official = (await memory.db.prepare('SELECT official_price FROM models ORDER BY CAST(SUBSTR(id, 7) AS INTEGER)').all()).results;
    expect(official.map(row => row.official_price)).toEqual(models.map(m => m.kr_official_price_krw));
    await memory.db.prepare("UPDATE models SET note = 'Reviewed note' WHERE id = 'model-1'").run();
    await memory.db.prepare("UPDATE sellers SET registration_source = 'Verified seller' WHERE id = 'seller-1'").run();
    await memory.db.prepare("INSERT INTO ingested_items (id,source_url,account,text,kind,captured_at) VALUES ('deal-1','https://example.com/deal','seller','Group buy','post','2026-10-21')").run();
    await memory.db.prepare("INSERT INTO deals (id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at) VALUES ('deal-1','model-1','seller-1','Group buy',390000,'https://example.com/deal','manual','2026-10-21','2026-10-21','2026-10-22')").run();
    const before = await Promise.all(['models', 'sellers', 'ingested_items', 'deals'].map(table => memory.db.prepare(`SELECT * FROM ${table}`).all()));
    await execute(memory.db, seed.sql);
    await execute(memory.db, await readFile(cleanup, 'utf8'));
    const after = await Promise.all(['models', 'sellers', 'ingested_items', 'deals'].map(table => memory.db.prepare(`SELECT * FROM ${table}`).all()));
    expect(after).toEqual(before);
  } finally {
    memory.close();
  }
});

test('UPDATE migration cleans legacy notes, preserves other columns and notes, and is idempotent', async () => {
  const memory = memoryD1();
  try {
    await schema(memory.db);
    await execute(memory.db, buildSeedSql().sql);
    for (const [brand, name, note] of legacyNotes) {
      await memory.db.prepare('UPDATE models SET note = ? WHERE brand = ? AND name = ?')
        .bind(`${note} / Reviewed context`, brand, name).run();
    }
    // An unrelated model with the same text must not be changed.
    await memory.db.prepare('UPDATE models SET note = ? WHERE id = ?').bind(legacyNotes[0][2], 'model-1').run();
    const before = (await memory.db.prepare('SELECT * FROM models ORDER BY id').all()).results;
    const migration = await readFile(cleanup, 'utf8');
    expect(migration.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim()).every(s => /^\s*UPDATE\s/i.test(s))).toBe(true);
    await execute(memory.db, migration);
    const after = (await memory.db.prepare('SELECT * FROM models ORDER BY id').all()).results;
    expect(after).toEqual(before.map(row => {
      return legacyNotes.some(([brand, name]) => row.brand === brand && row.name === name)
        ? { ...row, note: `${legacy0004Result[String(row.name)]} / Reviewed context` } : row;
    }));
    await execute(memory.db, migration);
    expect((await memory.db.prepare('SELECT * FROM models ORDER BY id').all()).results).toEqual(after);
  } finally {
    memory.close();
  }
});
