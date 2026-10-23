// Renders all registered illustrated models plus one placeholder fixture into a static page and screenshots them in
// mobile/desktop x light/dark. No server, no network: images are inlined.
//   npx tsx scripts/card-screenshots.ts --out <dir> [--cards model-31,model-33]
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { ModelCard } from '../app/models/_card';
import type { ModelCardData } from '../lib/model-cards';
import { priceGap } from '../lib/deals';
import { SQUARE_MODEL_IDS } from '../lib/model-illustrations';

const root = new URL('..', import.meta.url).pathname;
const DARK_BG = 'rgb(27, 33, 28)';
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('Usage: tsx scripts/card-screenshots.ts --out <dir> [--cards model-31,model-33]');
const out = resolve(process.argv[outIndex + 1]);

const cardsIndex = process.argv.indexOf('--cards');
const cardIds: readonly string[] = cardsIndex < 0 ? SQUARE_MODEL_IDS.slice(30) : [...new Set((process.argv[cardsIndex + 1] ?? '').split(','))];
if (cardIds.some(id => !(SQUARE_MODEL_IDS as readonly string[]).includes(id))) throw new Error('--cards requires comma-separated registered model IDs');

const seed = JSON.parse(await readFile(join(root, 'seed/models.json'), 'utf8')) as { models: { brand: string; model: string; kr_official_price_krw: number | null }[] };
const base = (n: number) => ({ id: `model-${n}`, name: seed.models[n - 1].model, brand: seed.models[n - 1].brand, official_price: seed.models[n - 1].kr_official_price_krw });
const withDeal = (card: ReturnType<typeof base>, price: number): ModelCardData => ({ ...card, deal: { price }, gap: priceGap(price, card.official_price) });
const noDeal = (card: ReturnType<typeof base>): ModelCardData => ({ ...card, deal: null, gap: null });
// Synthetic prices only exercise screenshot layout; never written to seed or DB.
const cards: ModelCardData[] = [
  ...SQUARE_MODEL_IDS.map(id => {
    const n = Number(id.slice(6)), card = base(n);
    if (n === 3) return { ...card, deal: { price: null }, gap: null };
    const price = ({ 1: 390000, 5: 780000, 10: 1990000 } as Record<number, number>)[n];
    return price === undefined ? noDeal(card) : withDeal(card, price);
  }),
  noDeal({ id: 'model-42', name: '손그림 없는 모델', brand: 'Stokke', official_price: null }),
];

const css = await readFile(join(root, 'app/globals.css'), 'utf8');
const markup = renderToStaticMarkup(createElement('div', { className: 'model-grid' }, cards.map(card => createElement(ModelCard, { key: card.id, card }))));
const imageData = new Map<string, string>();
async function dataUrl(path: string) {
  if (!imageData.has(path)) imageData.set(path, `data:image/png;base64,${Buffer.from(await readFile(join(root, 'public', path))).toString('base64')}`);
  return imageData.get(path)!;
}
let html = markup;
for (const path of new Set(markup.match(/\/img\/models\/[\w.-]+\.png/g) ?? [])) html = html.split(path).join(await dataUrl(path));
if (/\/img\//.test(html)) throw new Error('Unreplaced /img/ path remains in markup');
const pageHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="page">${html}</main></body></html>`;

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const seen: Record<string, { bg: string; body: string }> = {};
  for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      const page = await context.newPage();
      await page.route('**/*', route => route.abort());
      await page.emulateMedia({ colorScheme: scheme });
      await page.setContent(pageHtml);
      const colors = await page.evaluate(() => ({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        body: getComputedStyle(document.body).backgroundColor,
      }));
      seen[`${name}-${scheme}`] = colors;
      if (scheme === 'dark' && colors.body !== DARK_BG) throw new Error(`${name} dark screenshot is not dark: ${JSON.stringify(colors)}`);
      if (scheme === 'light' && colors.body === DARK_BG) throw new Error(`${name} light screenshot is dark: ${JSON.stringify(colors)}`);
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(async img => {
          img.loading = 'eager';
          await img.decode();
        }));
        await document.fonts.ready;
      });
      if (await page.locator('.model-art-line img').count() !== SQUARE_MODEL_IDS.length) throw new Error('Illustrated model coverage is incomplete');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`${name}-${scheme}: horizontal overflow`);
      const broken = await page.evaluate(() => [...document.images].filter(img => !img.complete || img.naturalWidth === 0 || img.naturalWidth !== img.naturalHeight).length);
      if (broken) throw new Error(`${name}-${scheme}: ${broken} broken image(s)`);
      const layout = await page.evaluate(() => {
        const invalidDeals = [...document.querySelectorAll('.model-deal')].filter(el => {
          const height = el.getBoundingClientRect().height;
          return height <= 0 || height > 40;
        }).length;
        const rows = new Map<number, number[]>();
        for (const el of document.querySelectorAll<HTMLElement>('.model-card')) {
          const heights = rows.get(el.offsetTop) ?? [];
          heights.push(el.getBoundingClientRect().height);
          rows.set(el.offsetTop, heights);
        }
        return { invalidDeals, unevenRows: [...rows.values()].filter(h => Math.max(...h) - Math.min(...h) > 1).length };
      });
      if (layout.invalidDeals || layout.unevenRows) throw new Error(`${name}-${scheme}: ${JSON.stringify(layout)}`);
      if (await page.locator('.model-art-mark').count() !== 1 || await page.locator('a[href="/models/model-42"] .model-art-mark').count() !== 1) throw new Error('Placeholder coverage is incorrect');
      for (const id of SQUARE_MODEL_IDS) {
        if (await page.locator(`a[href="/models/${id}"] .model-art-mark`).count()) throw new Error(`Unexpected placeholder: ${id}`);
      }
      for (const id of cardIds) {
        const card = page.locator(`a[href="/models/${id}"]`);
        await card.screenshot({ path: join(out, `${name}-${scheme}-${id}.png`) });
      }
      await page.screenshot({ path: join(out, `${name}-${scheme}.png`), fullPage: true });
      await context.close();
    }
  }
  for (const name of ['mobile', 'desktop']) {
    const light = seen[`${name}-light`], dark = seen[`${name}-dark`];
    if (light.bg === dark.bg || light.body === dark.body) throw new Error(`${name}: light and dark backgrounds are identical`);
  }
  console.log(`Saved 4 full-page and ${cardIds.length * 4} selected card screenshots to ${out}`);
} finally {
  await browser.close();
}
