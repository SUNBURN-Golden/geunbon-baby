import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import Home from '../app/page';
import DealsPage from '../app/deals/page';
import Models from '../app/models/page';
import Layout from '../app/layout';
import { memoryD1 } from './helpers/sqlite';

const context = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock('../lib/db', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/db')>(),
  environment: () => ({ DB: context.db }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

test('real pages preserve the zero-deal state with repository models', async () => {
  const memory = memoryD1();
  context.db = memory.db;
  try {
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
      for (const sql of (await readFile(new URL(file, dir), 'utf8')).split(';').filter(s => s.trim())) {
        await memory.db.prepare(sql).run();
      }
    }
    const seed = JSON.parse(await readFile(new URL('../seed/models.json', import.meta.url), 'utf8'));
    for (const [index, model] of seed.models.entries()) {
      await memory.db.prepare('INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
        `model-${index + 1}`, model.brand, model.model, model.category, model.kr_importer,
        model.kr_official_price_krw, model.source_url, model.checked, model.verify_level, model.note,
      ).run();
    }
    const pages = {
      home: await Home(),
      deals: await DealsPage(),
      models: await Models({ searchParams: Promise.resolve({}) }),
    };
    for (const [name, element] of Object.entries(pages)) {
      const html = renderToStaticMarkup(createElement(Layout, null, element));
      expect(html).not.toContain('class="deal-card"');
      if (name !== 'models') expect(html).toContain('aria-label="0개 진행 중이에요"');
      else expect(html).not.toMatch(/<time|model-discount/);
      if (process.env.REDESIGN_SCREENSHOTS === '1') {
        await mkdir('.local/redesign-html', { recursive: true });
        await writeFile(`.local/redesign-html/${name}.html`, `<!doctype html>${html}`);
      }
    }
  } finally {
    memory.close();
  }
});
