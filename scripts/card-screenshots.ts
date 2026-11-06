// Screenshots mobile/desktop x light/dark, either offline fixtures or an isolated seeded local Worker.
//   npx tsx scripts/card-screenshots.ts --out .local/cards [--cards model-4,model-5]
//   npx tsx scripts/card-screenshots.ts --origin http://localhost:8797 --out .local/worker-cards
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { ModelCard } from '../app/models/_card';
import type { ModelCardData } from '../lib/model-cards';
import { priceGap } from '../lib/deals';
import { money } from '../lib/data';
import { siteCopy } from '../lib/site-copy';

const root = new URL('..', import.meta.url).pathname;
const DARK_BG = 'rgb(27, 33, 28)';
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('Usage: tsx scripts/card-screenshots.ts --out .local/<dir> [--origin http://localhost:8797] [--cards model-4,model-5]');
let out = resolve(process.argv[outIndex + 1]);
if (!out.startsWith(resolve('.local') + sep)) throw new Error('--out must be a .local/ subdirectory');
const originIndex = process.argv.indexOf('--origin');
const originUrl = originIndex < 0 ? null : new URL(process.argv[originIndex + 1]);
if (originUrl && (originUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname) ||
    originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash)) {
  throw new Error('--origin must be a local HTTP origin, such as http://localhost:8797');
}
const origin = originUrl?.origin;

const seed = JSON.parse(await readFile(join(root, 'seed/models.json'), 'utf8')) as { models: { brand: string; model: string; kr_official_price_krw: number | null; verify_level: string }[] };
// Coverage comes from seed, independently of the runtime illustration allowlist.
const seedIds = seed.models.map((_, i) => `model-${i + 1}`);
const cardsIndex = process.argv.indexOf('--cards');
const cardIds: readonly string[] = cardsIndex < 0 ? seedIds : [...new Set((process.argv[cardsIndex + 1] ?? '').split(','))];
if (cardIds.some(id => !seedIds.includes(id))) throw new Error('--cards requires comma-separated seeded model IDs');

const base = (n: number) => ({ id: `model-${n}`, name: seed.models[n - 1].model, brand: seed.models[n - 1].brand, official_price: seed.models[n - 1].verify_level === 'page_body' ? seed.models[n - 1].kr_official_price_krw : null });
const withDeal = (card: ReturnType<typeof base>, price: number): ModelCardData => ({ ...card, deal: { price }, gap: priceGap(price, card.official_price) });
const noDeal = (card: ReturnType<typeof base>): ModelCardData => ({ ...card, deal: null, gap: null });
// Synthetic prices only exercise screenshot layout; never written to seed or DB.
const cards: ModelCardData[] = [
  ...seedIds.map(id => {
    const n = Number(id.slice(6)), card = base(n);
    if (n === 3) return { ...card, deal: { price: null }, gap: null };
    const price = ({ 1: 390000, 5: 780000, 10: 1990000 } as Record<number, number>)[n];
    return price === undefined ? noDeal(card) : withDeal(card, price);
  }),
  noDeal({ id: 'model-42', name: '손그림 없는 모델', brand: 'Stokke', official_price: null }),
];

const css = await readFile(join(root, 'app/fonts.css'), 'utf8') + await readFile(join(root, 'app/globals.css'), 'utf8');
const manifest = JSON.parse(await readFile(join(root, 'docs/fonts/manifest.json'), 'utf8')) as { faces: { url: string }[] };
const fontPaths = new Set(manifest.faces.map(face => face.url));
const markup = renderToStaticMarkup(createElement('div', { className: 'model-grid' }, cards.map(card => createElement(ModelCard, { key: card.id, card }))));
const imageData = new Map<string, string>();
async function dataUrl(path: string) {
  if (!imageData.has(path)) imageData.set(path, `data:image/svg+xml;base64,${Buffer.from(await readFile(join(root, 'public', path))).toString('base64')}`);
  return imageData.get(path)!;
}
let html = markup;
for (const path of new Set(markup.match(/\/img\/models\/[\w.-]+\.svg/g) ?? [])) html = html.split(path).join(await dataUrl(path));
if (/\/img\//.test(html)) throw new Error('Unreplaced /img/ path remains in markup');
const pageHtml = `<!doctype html><html lang="ko"><head><base href="https://cards.local/"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="page">${html}</main></body></html>`;

await mkdir(out, { recursive: true });
out = await realpath(out);
if (!out.startsWith(await realpath(resolve('.local')) + sep)) throw new Error('--out must stay inside .local/ after resolving symlinks');
const expectedCards = (origin ? seedIds.map(id => noDeal(base(Number(id.slice(6))))) : cards).map(card => ({
  id: card.id,
  name: `${card.brand} ${card.name}`,
  deal: card.deal ? money(card.deal.price) : siteCopy.noActiveDeal,
  official: `${siteCopy.officialLabel} ${money(card.official_price)}`,
  illustrated: seedIds.includes(card.id),
}));
const checks: unknown[] = [];
const browser = await chromium.launch({ headless: true });
try {
  const seen: Record<string, { bg: string; body: string }> = {};
  for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport, colorScheme: scheme });
      const page = await context.newPage();
      const artRequests: string[] = [];
      const artResponses: { path: string; status: number; type: string }[] = [];
      if (origin) {
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.pathname.startsWith('/img/models/') || url.pathname === '/_next/image') artRequests.push(url.pathname + url.search);
        });
        page.on('response', response => {
          const url = new URL(response.url());
          if (url.pathname.startsWith('/img/models/')) artResponses.push({ path: url.pathname, status: response.status(), type: response.headers()['content-type'] ?? '' });
        });
      }
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (origin && url.origin === origin) {
          await route.continue();
        } else if (!origin && url.origin === 'https://cards.local' && fontPaths.has(url.pathname)) {
          await route.fulfill({ body: await readFile(join(root, 'public', url.pathname)), contentType: 'font/woff2', headers: { 'Access-Control-Allow-Origin': '*' } });
        } else await route.abort();
      });
      await page.emulateMedia({ colorScheme: scheme });
      if (origin) {
        const response = await page.goto(`${origin}/models`);
        if (response?.status() !== 200) throw new Error('Local Worker /models did not return 200');
      } else await page.setContent(pageHtml);
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
        for (const family of ['Agamajung Excalifont', 'Agamajung Gaegu']) {
          if (![...document.fonts].some(face => face.family === family && face.status === 'loaded')) throw new Error(`${family} did not load`);
        }
      });
      if (await page.locator('.model-art-line img').count() !== seedIds.length) throw new Error('Illustrated model coverage is incomplete');
      if (await page.locator('img[srcset], img[sizes]').count()) throw new Error('SVG cards must not have raster source selection');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`${name}-${scheme}: horizontal overflow`);
      const broken = await page.evaluate(() => [...document.images].filter(img => !img.complete || img.naturalWidth === 0 || img.naturalWidth !== img.naturalHeight).length);
      if (broken) throw new Error(`${name}-${scheme}: ${broken} broken image(s)`);
      const invalidCards = await page.evaluate(expected => {
        const elements = [...document.querySelectorAll<HTMLElement>('.model-card')];
        if (elements.length !== expected.length) return ['Incorrect card count'];
        return expected.flatMap(card => {
          const el = elements.find(el => el.getAttribute('href') === `/models/${card.id}`);
          if (!el) return [`Missing ${card.id}`];
          const art = el.querySelector('.model-art');
          const prices = el.querySelector('.model-prices');
          const img = art?.querySelector('img');
          const box = el.getBoundingClientRect();
          const artBox = art?.getBoundingClientRect();
          const imgBox = img?.getBoundingClientRect();
          const invalid = [...el.children].map(child => child.tagName).join(',') !== 'DIV,H2,DIV' ||
            prices?.children.length !== 2 || art?.children.length !== 1 ||
            el.querySelectorAll('h2').length !== 1 || el.querySelectorAll('p').length !== 2 ||
            [
              [el.querySelector('h2')?.textContent, card.name],
              [el.querySelector('.model-deal')?.textContent, card.deal],
              [el.querySelector('.model-official')?.textContent, card.official],
              [el.textContent, `${card.illustrated ? '' : [...card.name][0]}${card.name}${card.deal}${card.official}`],
            ].some(([actual, wanted]) => (actual ?? '').replace(/\s/g, '') !== (wanted ?? '').replace(/\s/g, '')) ||
            !!el.querySelector('time, button, a, .badge, .eyebrow') ||
            !artBox || artBox.width <= 0 || Math.abs(artBox.width - artBox.height) > 1 ||
            (card.illustrated && (!img || img.getAttribute('width') !== '1080' || img.getAttribute('height') !== '1080' ||
              img.naturalWidth !== 1080 || img.naturalHeight !== 1080 ||
              img.alt !== card.name || img.loading !== 'eager' || img.decoding !== 'async' ||
              !imgBox || Math.abs(imgBox.width - imgBox.height) > 1 ||
              Math.abs(imgBox.width - artBox.width) > 1)) ||
            [...el.querySelectorAll<HTMLElement>('h2, p, img')].some(child => {
              const rect = child.getBoundingClientRect();
              return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1 ||
                child.scrollWidth > child.clientWidth + 1;
            });
          return invalid ? [card.id] : [];
        });
      }, expectedCards);
      if (invalidCards.length) throw new Error(`${name}-${scheme}: invalid card content/geometry: ${invalidCards.join(', ')}`);
      if (origin) {
        const paths = seedIds.map(id => `/img/models/${id}.svg`).sort();
        if (JSON.stringify([...artRequests].sort()) !== JSON.stringify(paths) ||
            JSON.stringify(artResponses.map(response => response.path).sort()) !== JSON.stringify(paths) ||
            artResponses.some(response => response.status !== 200 || response.type.split(';')[0].trim() !== 'image/svg+xml')) {
          throw new Error(`${name}-${scheme}: expected 41 direct SVG requests/responses: ${JSON.stringify({ artRequests, artResponses })}`);
        }
        for (const id of seedIds) {
          if (await page.locator(`a[href="/models/${id}"] img`).getAttribute('src') !== `/img/models/${id}.svg`) throw new Error(`Incorrect SVG path: ${id}`);
        }
      }
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
      if (await page.locator('.model-art-mark').count() !== (origin ? 0 : 1) || (!origin && await page.locator('a[href="/models/model-42"] .model-art-mark').count() !== 1)) throw new Error('Placeholder coverage is incorrect');
      for (const id of seedIds) {
        if (await page.locator(`a[href="/models/${id}"] .model-art-mark`).count()) throw new Error(`Unexpected placeholder: ${id}`);
      }
      checks.push({ viewport: name, scheme, cards: expectedCards.length, illustrations: seedIds.length, colors, layout, artRequests, artResponses });
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
  await writeFile(join(out, 'checks.json'), JSON.stringify({ mode: origin ? 'worker' : 'offline', origin, checks }, null, 2) + '\n');
  console.log(`Verified ${origin ? 'local Worker' : 'offline fixtures'}. Saved 4 full-page and ${cardIds.length * 4} selected card screenshots to ${out}`);
} finally {
  await browser.close();
}
