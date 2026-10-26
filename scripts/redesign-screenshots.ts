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
    for (const width of [320, 390, 1440]) for (const scheme of ['light', 'dark'] as const) {
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
      const metrics = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        hero: document.querySelector('.hero')?.getBoundingClientRect().height ?? null,
        smallTargets: [...document.querySelectorAll('a, button, select, input:not([type="hidden"])')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); })
          .map(el => el.textContent?.trim()),
      }));
      results.push({ name, width, scheme, ...metrics });
      if (metrics.overflow > 0) throw new Error(`${name}-${width}-${scheme}: overflow ${metrics.overflow}`);
      if (metrics.smallTargets.length) throw new Error(`${name}-${width}-${scheme}: targets ${metrics.smallTargets.join(', ')}`);
      if (metrics.background !== (scheme === 'dark' ? 'rgb(22, 27, 34)' : 'rgb(250, 247, 240)')) throw new Error('Incorrect colour scheme');
      await page.screenshot({ path: join(output, `${name}-${width}-${scheme}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await writeFile(join(output, 'metrics.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(`Saved page screenshots and metrics to ${output}`);
