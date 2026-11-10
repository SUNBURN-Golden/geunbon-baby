/** Browser-only QA: capture local Wrangler pages, serve isolated snapshots/fixtures, compare CLS.
 * npx tsx scripts/typography-check.ts --baseline|--verify [--origin http://localhost:8787]
 * Artifacts are private/ignored under .local/typography. No DB writes or external requests.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { DealDetail } from '../app/deals/_components';
import { ActiveDeals } from '../app/_active-deals';
import type { DealWithContext } from '../lib/deals';
import { authCopy } from '../lib/auth-copy';

const baseline = process.argv.includes('--baseline');
const quick = process.argv.includes('--quick');
if (!baseline && !process.argv.includes('--verify')) throw Error('Choose --baseline or --verify');
const origin = process.argv[process.argv.indexOf('--origin') + 1] || 'http://localhost:8787';
const baseUrl = origin.startsWith('http') ? origin : 'http://localhost:8787';
const root = new URL('..', import.meta.url).pathname;
const output = join(root, '.local/typography');
// Namespaced @font-face families: an installed upstream font must not stand in for a
// failed vendored request, and glyph use must be attributable to the delivered files.
const LATIN_FAMILY = 'Agamajung Excalifont';
const HANGUL_FAMILY = 'Agamajung Gaegu';
await mkdir(output, { recursive: true });
const seed = JSON.parse(await readFile(join(root, 'seed/models.json'), 'utf8')) as { models: { model: string; brand: string }[] };
const longest = seed.models.reduce((best, m, i, all) => m.model.length > all[best].model.length ? i : best, 0);
const paths = ['/', '/models/model-1', '/deals', '/models', `/models/model-${longest + 1}`];
const corpus: { name: string; html: string }[] = [];
const styles = new Set<string>();
for (const path of paths) {
  const response = await fetch(new URL(path, baseUrl));
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
  let html = await response.text();
  for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css(?:\?[^"]*)?)"[^>]*>/g)) styles.add(m[1]);
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]+(?:rel="(?:stylesheet|preload|modulepreload)")[^>]*>/g, '');
  // Preserve actual layout and content, with local immutable CSS/font/image requests only.
  html = html.replace('</head>', '<link rel="stylesheet" href="/qa.css"></head>');
  if (!baseline) html = html.replace('</head>', '<link rel="preload" href="/fonts/excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2" as="font" type="font/woff2" crossorigin="anonymous"><link rel="preload" href="/fonts/gaegu/gaegu-regular-logo.woff2" as="font" type="font/woff2" crossorigin="anonymous"></head>');
  corpus.push({ name: path === '/' ? 'home' : path.slice(1).replaceAll('/', '-'), html });
}
const nowMs = Date.parse('2026-10-21T03:00:00Z');
const deal: DealWithContext = {
  id: 'deal-1', model_id: 'model-1', seller_id: 'seller-1', title: 'A carefully checked deal',
  image_url: null, price: 390000, source_url: 'https://www.instagram.com/p/example/',
  verify_level: 'manual', checked: '2026-10-20T16:00:00Z',
  starts_at: '2026-10-20T00:00:00Z', ends_at: '2026-10-22T14:59:59Z',
  model_joined_id: 'model-1', model_name: 'Example model', model_official_price: 430000,
  model_checked: '2026-10-18', model_verify_level: 'page_body',
  seller_joined_id: 'seller-1', seller_name: 'Example seller',
  seller_registration_source: null, seller_withdrawal_source: null, seller_official_import_source: null,
}; // Same isolated fixture values as tests/deals.test.ts; never persisted.
corpus.push({ name: 'deal-detail-fixture', html: corpus[0].html.replace(/<main\b[\s\S]*?<\/main>/, renderToStaticMarkup(createElement(DealDetail, { deal, nowMs }))) });
corpus.push({ name: 'home-populated-fixture', html: corpus[0].html.replace(/<section class="active-deals"[\s\S]*?<\/section>/, renderToStaticMarkup(createElement(ActiveDeals, { deals: [deal, { ...deal, id: 'deal-2' }, { ...deal, id: 'deal-3' }], totalCount: 3, nowMs }))) });
let css = '';
for (const path of styles) css += await (await fetch(new URL(path, baseUrl))).text();
// Verify captured Worker font URLs, including the exact preload CORS attributes.
if (!baseline && (!css.includes('Excalifont') || !css.includes('font-display:swap'))) throw Error('Worker font CSS missing');
const manifest = JSON.parse(await readFile(join(root, 'docs/fonts/manifest.json'), 'utf8')) as { faces: { url: string }[] };
const fontUrls = new Set(manifest.faces.map(f => f.url));
if (!baseline) {
  const assets = JSON.parse(await readFile(join(root, 'docs/fonts/manifest.json'), 'utf8')) as { assets: { path: string; sha256: string }[] };
  for (const asset of assets.assets.filter(a => a.path.startsWith('public/'))) {
    const response = await fetch(new URL(asset.path.slice(6), baseUrl));
    if (!response.ok || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== asset.sha256) throw Error(`Worker asset mismatch: ${asset.path}`);
  }
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://qa.local').pathname;
  if (path === '/qa.css') { res.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'public,max-age=3600' }); res.end(css); return; }
  if (fontUrls.has(path)) {
    const mode = /fontmode=(\w+)/.exec(req.headers.cookie || '')?.[1];
    if (mode === 'blocked') { res.writeHead(404); res.end(); return; }
    if (mode === 'delayed') await new Promise(r => setTimeout(r, 900));
    res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public,max-age=3600', 'Access-Control-Allow-Origin': '*' });
    res.end(await readFile(join(root, 'public', path))); return;
  }
  if (/^\/img\/models\/model-\d+\.svg$/.test(path)) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(await readFile(join(root, 'public', path))); return; }
  const item = corpus.find(c => path === '/' + c.name);
  if (item) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(item.html); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string') throw Error('No listener');
const qaOrigin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const results: Record<string, unknown>[] = [];
const failures: string[] = [];
try {
  for (const width of quick ? [390] : [320, 390, 1440]) for (const theme of quick ? ['light'] as const : ['light', 'dark'] as const) {
    for (const mode of quick ? ['delayed'] : ['cold', 'warm', 'delayed', 'blocked']) {
      // Parallel independent page contexts; warm-up and measurement share each context's HTTP cache.
      await Promise.all(corpus.map(async item => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
        await context.addCookies([{ name: 'fontmode', value: mode, url: qaOrigin }]);
        await context.addInitScript(() => {
          const state = window as unknown as { shifts: { value: number; time: number; nodes: string[] }[] };
          state.shifts = [];
          new PerformanceObserver(list => {
            for (const raw of list.getEntries()) {
              const e = raw as PerformanceEntry & { hadRecentInput: boolean; value: number; sources: { node?: Element }[] };
              if (!e.hadRecentInput) state.shifts.push({ value: e.value, time: e.startTime, nodes: e.sources.map(s => s.node?.className || s.node?.tagName || s.node?.parentElement?.className || '') });
            }
          }).observe({ type: 'layout-shift', buffered: true });
        });
        const page = await context.newPage();
        // Shared CI runners can be heavily loaded by parallel jobs; a 30s default is too tight
        // when seven pages load ~250KB of fonts at once.
        page.setDefaultTimeout(120_000);
        if (mode === 'warm') { await page.goto(`${qaOrigin}/${item.name}`); await page.evaluate(() => document.fonts.ready); }
        for (let repeat = 0; repeat < 3; repeat++) {
          // A fresh context for cold/delayed/blocked repeats prevents accidental cache warming.
          if (repeat && mode !== 'warm') await context.clearCookies();
          if (repeat && mode !== 'warm') await context.addCookies([{ name: 'fontmode', value: mode, url: qaOrigin }]);
          const cdp = await context.newCDPSession(page);
          if (mode !== 'warm') { await cdp.send('Network.enable'); await cdp.send('Network.clearBrowserCache'); }
          await page.goto(`${qaOrigin}/${item.name}`, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(150);
          const fallback = await page.locator('h1').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, width: r.width, height: r.height }; }));
          if (mode === 'delayed' && repeat === 0) await page.screenshot({ path: join(output, `${baseline ? 'before' : 'after'}-${item.name}-${width}-${theme}-fallback.png`) });
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); })); });
          await page.waitForTimeout(400);
          const measure = await page.evaluate(() => {
            const handwritten = [...document.querySelectorAll<HTMLElement>('body *')].filter(el => getComputedStyle(el).fontFamily.includes('Agamajung Excalifont') && el.textContent?.trim());
            const headings = [...document.querySelectorAll<HTMLElement>('h1')].map(el => {
              const style = getComputedStyle(el), box = el.getBoundingClientRect();
              const centers: number[] = [];
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                for (const rect of range.getClientRects()) if (rect.width > 0) centers.push(rect.y + rect.height / 2);
              }
              const rows: number[] = [];
              for (const center of centers.sort((a, b) => a - b)) if (!rows.some(y => Math.abs(y - center) < parseFloat(style.lineHeight) / 2)) rows.push(center);
              return { text: el.textContent, lines: rows.length, x: box.x, y: box.y, width: box.width, height: box.height };
            });
            const sans = [...document.querySelectorAll<HTMLElement>('.lead,.model-prices,.deal-price,.deal-context,.deal-ad,.deal-disclaimer,.deal-facts,.notice,.active-deal-count,.comparison>section>h2,.comparison>section>h3,.comparison>section>.eyebrow,footer>p:not(.brand-slogan),label,table')].map(el => ({ tag: el.className || el.tagName, family: getComputedStyle(el).fontFamily }));
            const badSize = handwritten.filter(el => parseFloat(getComputedStyle(el).fontSize) < 18).map(el => el.className || el.tagName);
            const clipped = handwritten.filter(el => el.scrollHeight > el.clientHeight + 2 && ['hidden','clip'].includes(getComputedStyle(el).overflowY)).map(el => el.className || el.tagName);
            const contrast = handwritten.map(el => {
              const style = getComputedStyle(el);
              let background: Element | null = el;
              while (background && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(background).backgroundColor)) background = background.parentElement;
              const colors = [style.color, background ? getComputedStyle(background).backgroundColor : getComputedStyle(document.body).backgroundColor];
              const luminance = colors.map(color => {
                const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
                return r * 0.2126 + g * 0.7152 + b * 0.0722;
              });
              return { element: el.className || el.tagName, ratio: (Math.max(...luminance) + 0.05) / (Math.min(...luminance) + 0.05) };
            });
            const carousel = document.querySelector('.active-deal-row');
            let carouselUsable = true;
            if (carousel && innerWidth < 768) { carousel.scrollLeft = carousel.scrollWidth; carouselUsable = carousel.scrollLeft > 0; carousel.scrollLeft = 0; }
            const entries = (window as unknown as { shifts: { value: number; time: number; nodes: string[] }[] }).shifts;
            let cls = 0, score = 0, start = 0, previous = 0;
            for (const entry of entries) { if (entry.time - previous > 1000 || entry.time - start > 5000) { score = 0; start = entry.time; } score += entry.value; cls = Math.max(cls, score); previous = entry.time; }
            const resources = performance.getEntriesByType('resource').filter(e => e.name.includes('/fonts/')).map(e => { const r = e as PerformanceResourceTiming; return { url: new URL(e.name).pathname, bytes: r.encodedBodySize, transfer: r.transferSize }; });
            return { headings, sans, badSize, clipped, contrast, carouselUsable, overflow: document.documentElement.scrollWidth > innerWidth, cls, entries, resources, loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family) };
          });
          await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
          const doc = await cdp.send('DOM.getDocument');
          const rendered: Record<string, string[]> = {};
          for (const selector of ['.logo', '.logo > span', 'h1', '.model-card h2.model-name', '.deal-card > h2 > a', '.comparison>section>h3']) {
            const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
            if (node.nodeId) rendered[selector] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })).fonts.map(f => `${f.familyName}:${f.isCustomFont}:${f.glyphCount}`);
          }
          const key = `${item.name}/${width}/${theme}/${mode}/${repeat}`;
          results.push({ key, ...measure, fallback, rendered });
          if (!baseline) {
            if (measure.overflow || measure.clipped.length || measure.badSize.length) failures.push(`${key}: overflow/clipped/small ${JSON.stringify([measure.overflow, measure.clipped, measure.badSize])}`);
            if (measure.sans.some(s => s.family.includes('Excalifont'))) failures.push(`${key}: sans scope leaked`);
            if (measure.contrast.some(c => c.ratio < 4.5)) failures.push(`${key}: accent contrast below AA`);
            if (!measure.carouselUsable) failures.push(`${key}: mobile carousel does not scroll`);
            if (width !== 320 && measure.headings.some(h => h.lines > (width === 390 ? 3 : 2))) failures.push(`${key}: H1 lines ${JSON.stringify(measure.headings)}`);
            if (mode !== 'blocked' && (!measure.loaded.includes(HANGUL_FAMILY) || !measure.loaded.includes(LATIN_FAMILY))) failures.push(`${key}: expected font not loaded`);
            // CDP reports the name stored in the font file, not the CSS @font-face family.
            if (mode !== 'blocked' && (!rendered['.logo']?.some(f => f.startsWith('Gaegu:true:')) || !rendered['.logo > span']?.some(f => f.startsWith('Excalifont:true:')))) failures.push(`${key}: real wordmark glyphs not rendered`);
            if (mode !== 'blocked' && Object.values(rendered).flat().some(f => f.startsWith('Display '))) failures.push(`${key}: fallback rendered despite successful font requests`);
            if (mode === 'blocked' && Object.values(rendered).flat().some(f => /:true:/.test(f))) failures.push(`${key}: blocked face still rendered`);
          }
          if (mode === 'cold' && repeat === 0) await page.screenshot({ path: join(output, `${baseline ? 'before' : 'after'}-${item.name}-${width}-${theme}.png`), fullPage: true });
          await cdp.detach();
        }
        await context.close();
      }));
      console.log(`${baseline ? 'baseline' : 'verify'} ${width} ${theme} ${mode} done`);
    }
  }
  const probes: Record<string, unknown>[] = [];
  if (!baseline) {
    const page = await browser.newPage();
    await page.goto(`${qaOrigin}/home`);
    await page.evaluate(({ consent, legal }) => {
      const probe = document.createElement('div'); probe.id = 'glyph-probes';
      probe.style.cssText = 'position:fixed;inset:0;background:white;font-size:24px;font-synthesis:none';
      probe.innerHTML = '<span id="probe-latin" style="font-family:var(--font-display)">BabyBjörn 0123456789 é a\u0301</span><span id="probe-hangul" style="font-family:var(--font-display)">아가마중 ㄱㅎ</span><label id="probe-consent"></label><p id="probe-legal"></p><table id="probe-table"><tbody><tr><td>430,000원</td></tr></tbody></table>';
      probe.querySelector('#probe-consent')!.textContent = consent;
      probe.querySelector('#probe-legal')!.textContent = legal;
      document.body.appendChild(probe);
    }, { consent: authCopy.newsletterConsent, legal: authCopy.collectNotice });
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const doc = await cdp.send('DOM.getDocument');
    for (const [selector, family] of [['#probe-latin', 'Excalifont'], ['#probe-hangul', 'Gaegu']]) {
      const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
      probes.push({ selector, fonts });
      // A mixed-script phrase may legitimately borrow the other display family for
      // characters outside its subset (e.g. the space in "아가마중 ㄱㅎ"), but no
      // rendered glyph may come from a non-custom fallback.
      const intended = fonts.some(f => f.isCustomFont && f.familyName === family);
      if (!intended || fonts.some(f => !f.isCustomFont)) failures.push(`${selector}: supported glyph used unexpected fallback`);
    }
    const retainedSans = await page.locator('#probe-consent,#probe-legal,#probe-table').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).fontFamily));
    if (retainedSans.some(f => f.includes('Excalifont') || f.includes('Gaegu'))) failures.push('Consent, legal or table probe lost sans');
    probes.push({ retainedSans });
    await page.close();
  }
  const environment = { browser: browser.version(), platform: process.platform, node: process.version, clock: new Date(nowMs).toISOString(), viewportHeight: 900, observation: '150ms fallback; fonts.ready + image.decode + 400ms; delayed font responses 900ms', corpus: corpus.map(c => ({ name: c.name, textSha256: createHash('sha256').update(c.html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).digest('hex') })), longestModel: longest + 1 };
  if (!baseline) {
    const before = JSON.parse(await readFile(join(output, 'baseline.json'), 'utf8')) as { environment: typeof environment; results: typeof results };
    if (before.environment.browser !== environment.browser) failures.push('Browser changed from baseline');
    for (const row of results) {
      const prior = before.results.find(r => r.key === row.key);
      if (!prior || Number(row.cls) > Number(prior.cls) + 0.000001) failures.push(`${row.key}: CLS increased ${prior?.cls} -> ${row.cls}`);
      if (String(row.key).includes('/delayed/') && Number(row.cls) > 0) failures.push(`${row.key}: delayed swap shifted`);
    }
    if (!quick) {
      type SummaryRow = {
        key: string; cls: number; headings: unknown[]; loaded: string[];
        entries: { value: number; time: number; nodes: string[] }[];
        resources: { url: string; bytes: number; transfer: number }[];
      };
      const rows = results as unknown as SummaryRow[];
      const priorRows = before.results as unknown as { key: string; cls: number }[];
      const scenarios = rows.map(row => ({
        key: row.key,
        cls: Number(row.cls),
        baselineCls: Number(priorRows.find(r => r.key === row.key)?.cls ?? 0),
        h1: row.headings,
        shifts: row.entries,
        loaded: [...new Set(row.loaded)],
        fontUrls: [...new Set(row.resources.map(r => r.url))],
        fontRequestBytes: row.resources.reduce((sum, r) => sum + (r.bytes || 0), 0),
      }));
      const worst = scenarios.reduce((best, row) => row.cls > best.cls ? { key: row.key, cls: row.cls } : best, { key: '', cls: 0 });
      await writeFile(join(root, 'docs/fonts/verification-summary.json'), JSON.stringify({
        environment,
        baseline: { source: '.local/typography/baseline.json', browser: before.environment.browser },
        scenarios,
        worst,
        probes,
        failures,
      }, null, 2) + '\n');
    }
  }
  await writeFile(join(output, baseline ? 'baseline.json' : quick ? 'verification-quick.json' : 'verification.json'), JSON.stringify({ environment, results, probes, failures }, null, 2));
  console.log(`${results.length} measurements; worst CLS ${Math.max(...results.map(r => Number(r.cls)))}; ${failures.length} failures`);
  if (failures.length) { console.error(failures.slice(0, 15).join('\n')); process.exitCode = 1; }
} finally { await browser.close(); await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
