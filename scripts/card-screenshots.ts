// Renders all batch-2 models plus legacy / placeholder card fixtures into a static page and screenshots them in
// mobile/desktop x light/dark. No server, no network: images are inlined.
//   npx tsx scripts/card-screenshots.ts --out <dir>
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
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('Usage: tsx scripts/card-screenshots.ts --out <dir>');
const out = resolve(process.argv[outIndex + 1]);

const seed = JSON.parse(await readFile(join(root, 'seed/models.json'), 'utf8')) as { models: { brand: string; model: string; kr_official_price_krw: number | null }[] };
const base = (n: number) => ({ id: `model-${n}`, name: seed.models[n - 1].model, brand: seed.models[n - 1].brand, official_price: seed.models[n - 1].kr_official_price_krw });
const withDeal = (card: ReturnType<typeof base>, price: number): ModelCardData => ({ ...card, deal: { price }, gap: priceGap(price, card.official_price) });
const noDeal = (card: ReturnType<typeof base>): ModelCardData => ({ ...card, deal: null, gap: null });
const official1 = base(1).official_price!;
const cards: ModelCardData[] = [
  ...SQUARE_MODEL_IDS.map(id => noDeal(base(Number(id.slice(6))))),
  withDeal(base(1), 390000),            // art + deal
  withDeal(base(3), Math.round((base(3).official_price ?? official1) * 0.85 / 1000) * 1000), // placeholder + deal
  noDeal(base(2)),                      // art + no deal
  noDeal(base(4)),                      // placeholder + no deal
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
      if (await page.locator('.model-art-line img').count() !== 10) throw new Error('Batch-2 coverage is incomplete');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`${name}-${scheme}: horizontal overflow`);
      const broken = await page.evaluate(() => [...document.images].filter(img => !img.complete || img.naturalWidth === 0).length);
      if (broken) throw new Error(`${name}-${scheme}: ${broken} broken image(s)`);
      for (const id of SQUARE_MODEL_IDS) {
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
  console.log(`Saved 4 full-page and 40 batch-2 card screenshots to ${out}`);
} finally {
  await browser.close();
}
