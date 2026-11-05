/** Measure installed sans fallbacks before changing CSS metrics. No network. */
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const root = new URL('..', import.meta.url).pathname;
const seed = JSON.parse(await readFile(root + 'seed/models.json', 'utf8')) as { models: { brand: string; model: string }[] };
const samples = [...new Set(['AGAMAJUNG', 'A THOUGHTFUL BEGINNING', 'THE FIRST COLLECTION / 01', 'A carefully checked deal', 'BabyBjörn', ...seed.models.flatMap(m => [m.brand, ...m.model.match(/[\x20-\x7e\u00c0-\u024f]+/g) || []])])].filter(s => s.trim());
const latin = await readFile(root + 'public/fonts/excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2');
const hangul = await readFile(root + 'public/fonts/gaegu/gaegu-regular-logo.woff2');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ latin, hangul, samples }) => {
    for (const [family, data] of [['Excalifont', latin], ['Gaegu', hangul]]) document.fonts.add(await new FontFace(family, `url(data:font/woff2;base64,${data})`).load());
    document.fonts.add(await new FontFace('Measured Latin', 'local("Noto Sans Regular")').load());
    document.fonts.add(await new FontFace('Measured Hangul', 'local("Noto Sans CJK KR")').load());
    const ctx = document.createElement('canvas').getContext('2d')!;
    const measurements = samples.map(text => {
      ctx.font = '100px Excalifont'; const target = ctx.measureText(text).width;
      ctx.font = '100px "Measured Latin"'; const fallback = ctx.measureText(text).width;
      return { text, target, fallback };
    });
    const latinRatio = measurements.reduce((sum, m) => sum + m.target * m.fallback, 0) / measurements.reduce((sum, m) => sum + m.fallback ** 2, 0);
    ctx.font = '100px Gaegu'; const target = ctx.measureText('아가마중').width;
    ctx.font = '100px "Measured Hangul"'; const fallback = ctx.measureText('아가마중').width;
    const korean = { text: '아가마중', target, fallback };
    const symbols = [...' .,()/+-:&!?'].map(text => {
      ctx.font = '1000px Excalifont'; const target = ctx.measureText(text).width;
      ctx.font = '1000px "Measured Latin"'; const fallback = ctx.measureText(text).width;
      return { text, codepoint: text.codePointAt(0)!, target, fallback, sizeAdjust: target / fallback * 100 };
    });
    return { measurements, korean, symbols, latinSizeAdjust: latinRatio * 100, hangulSizeAdjust: korean.target / korean.fallback * 100 };
  }, { latin: Buffer.from(latin).toString('base64'), hangul: Buffer.from(hangul).toString('base64'), samples });
  await writeFile(root + 'docs/fonts/fallback-metrics.json', JSON.stringify({ browser: browser.version(), platform: process.platform, fontSize: 100, latinSource: 'Noto Sans Regular', hangulSource: 'Noto Sans CJK KR', ...result }, null, 2) + '\n');
  console.log({ latinSizeAdjust: result.latinSizeAdjust, hangulSizeAdjust: result.hangulSizeAdjust });
} finally { await browser.close(); }
