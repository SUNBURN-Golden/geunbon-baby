// Render input with REDESIGN_SCREENSHOTS=1 npm test -- tests/redesign-pages.test.ts.
// Uses real page markup and serves local public assets through Playwright routing. No server.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const output = resolve(process.argv[2] ?? '.local/redesign-shots');
await mkdir(output, { recursive: true });
const css = await readFile('app/globals.css', 'utf8');
const browser = await chromium.launch({ headless: true });
const results: unknown[] = [];
try {
  for (const name of ['home', 'deals', 'models', ...(process.env.LEDGER_FIXTURES === '1' ? ['ledger-fixtures'] : [])]) {
    let markup = await readFile(`.local/redesign-html/${name}.html`, 'utf8');
    if (name === 'ledger-fixtures') markup = (await readFile('.local/redesign-html/home.html', 'utf8')).replace(/<main[\s\S]*?<\/main>/, markup);
    for (const width of [320, 390, 721, 1024, 1280, 1440]) for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 844 }, colorScheme: scheme, reducedMotion: 'reduce' });
      await page.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/fonts/') || path.startsWith('/img/')) {
          const file = resolve('public', `.${path}`);
          if (!file.startsWith(resolve('public') + '/')) return route.abort();
          await route.fulfill({ body: await readFile(file), contentType: path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' });
        } else await route.abort();
      });
      await page.setContent(markup.replace('<head>', `<head><base href="http://redesign.local"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>`));
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(async img => { img.loading = 'eager'; await img.decode(); }));
      });
      const metrics = await page.evaluate(() => {
        const headline = document.querySelector('.hero h1')?.getBoundingClientRect();
        const counter = document.querySelector('.hero-counter')?.getBoundingClientRect();
        return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        hero: document.querySelector('.hero')?.getBoundingClientRect().height ?? null,
        counterOverlap: !!(headline && counter && headline.left < counter.right && headline.right > counter.left && headline.top < counter.bottom && headline.bottom > counter.top),
        overflowingPrices: [...document.querySelectorAll('.deal-price, .ledger-official .deal-context, .model-official, .model-deal-price')]
          .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent?.trim()),
        fontsReady: document.fonts.check('700 20px "Gowun Batang"') && document.fonts.check('400 16px "Spoqa Han Sans Neo"') && document.fonts.check('700 16px "Spoqa Han Sans Neo"'),
        modelColumns: document.querySelector('.model-grid') ? getComputedStyle(document.querySelector('.model-grid')!).gridTemplateColumns.split(' ').length : null,
        smallTargets: [...document.querySelectorAll('a, button, select, input:not([type="hidden"])')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); })
          .map(el => el.textContent?.trim()),
        };
      });
      results.push({ name, width, scheme, ...metrics });
      if (metrics.overflow > 0) throw new Error(`${name}-${width}-${scheme}: overflow ${metrics.overflow}`);
      if (metrics.smallTargets.length) throw new Error(`${name}-${width}-${scheme}: targets ${metrics.smallTargets.join(', ')}`);
      if (metrics.overflowingPrices.length) throw new Error(`${name}-${width}-${scheme}: overflowing prices ${metrics.overflowingPrices.join(', ')}`);
      if (metrics.hero !== null && metrics.hero > 200) throw new Error(`Hero exceeds 200px: ${metrics.hero}`);
      if (metrics.counterOverlap || !metrics.fontsReady) throw new Error('Counter overlap or fonts unavailable');
      if (width <= 720 && metrics.modelColumns !== null && metrics.modelColumns !== 1) throw new Error('Mobile catalogue must be a single column');
      if (metrics.background !== (scheme === 'dark' ? 'rgb(22, 27, 34)' : 'rgb(250, 247, 240)')) throw new Error('Incorrect colour scheme');
      const tabs = page.locator('.category-tabs a');
      if (await tabs.count()) {
        await tabs.first().focus();
        await page.keyboard.press('Tab');
        if (!await tabs.nth(1).evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none')) throw new Error('Category keyboard focus is missing');
        await tabs.last().focus();
        if (width <= 390 && !await page.locator('.category-tabs').evaluate(el => el.scrollLeft > 0)) throw new Error('Keyboard focus did not reveal the last mobile tab');
      }
      const legend = page.locator('.price-legend');
      if (name === 'ledger-fixtures') {
        await legend.evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY + 10));
        if (!await legend.evaluate(el => Math.abs(el.getBoundingClientRect().top) <= 1)) throw new Error('Price legend did not stick');
      }
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        document.querySelector('.category-tabs')?.scrollTo(0, 0);
        window.scrollTo(0, 0);
      });
      await page.screenshot({ path: join(output, `${name}-${width}-${scheme}.png`), fullPage: true });
      if ([320, 390, 1440].includes(width)) await page.screenshot({ path: join(output, `${name}-${width}-${scheme}-viewport.png`) });
      await page.close();
    }
  }
} finally {
  await writeFile(join(output, 'metrics.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(`Saved page screenshots and metrics to ${output}`);
