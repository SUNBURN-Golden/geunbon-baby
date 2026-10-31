// Verify production SVGs offline; optional PNG previews stay outside public/.
// Usage: npx tsx scripts/render-model-illustrations.ts [model-1 ...] [--out .local/illustration-previews]
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { modelIllustration } from '../lib/model-illustrations';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
let out: string | undefined;
if (outIndex >= 0) {
  const value = args[outIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--out requires an ignored .local/ subdirectory');
  const local = resolve('.local');
  out = resolve(value);
  if (!out.startsWith(local + sep)) throw new Error('Preview output must be an ignored .local/ subdirectory');
  args.splice(outIndex, 2);
}
const seed = JSON.parse(await readFile(new URL('../seed/models.json', import.meta.url), 'utf8')) as { models: unknown[] };
const seedIds = seed.models.map((_, i) => `model-${i + 1}`);
const ids = args.length ? [...new Set(args)] : seedIds;
for (const id of ids) {
  if (!seedIds.includes(id) || !modelIllustration(id)) throw new Error(`Missing registered SVG for seeded model: ${id}`);
}
const dir = new URL('../public/img/models/', import.meta.url);
if (out) {
  await mkdir(out, { recursive: true });
  const local = await realpath(resolve('.local'));
  out = await realpath(out);
  if (!out.startsWith(local + sep)) throw new Error('Preview output must stay inside .local/ after resolving symlinks');
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort());
  for (const id of ids) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    const tags = [...svg.matchAll(/<\/?([\w:-]+)/g)].map(m => m[1]);
    if (!tags.every(t => ['svg', 'title', 'g', 'path'].includes(t)) ||
        /\b(?:href|style|filter|on\w+)\s*=|url\(|data:|<!/i.test(svg) ||
        svg.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]*>/g, '').trim() ||
        !svg.includes('width="1080" height="1080" viewBox="0 0 1080 1080"') ||
        !svg.includes('fill="none"') ||
        [...svg.matchAll(/\bfill="([^"]*)"/g)].some(m => m[1] !== 'none')) {
      throw new Error(`${id}: invalid square, passive, text-free line-art SVG`);
    }
    for (const size of [540, 252]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"></body></html>');
      const result = await page.evaluate(async ({ svg, size, preview }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        await image.decode();
        if (image.naturalWidth !== 1080 || image.naturalHeight !== 1080) throw new Error('Incorrect intrinsic dimensions');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let ink = 0, marginInk = 0;
        const margin = Math.floor(size * .025);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          if (pixels[(y * size + x) * 4 + 3]) {
            ink++;
            if (x < margin || x >= size - margin || y < margin || y >= size - margin) marginInk++;
          }
        }
        return { ink, marginInk, png: preview ? canvas.toDataURL('image/png').split(',')[1] : null };
      }, { svg, size, preview: !!out });
      if (result.ink <= size * 4 || result.ink / (size * size) >= .2 || result.marginInk) {
        throw new Error(`${id} at ${size}px: ink=${result.ink}, marginInk=${result.marginInk}`);
      }
      if (out && result.png) await writeFile(resolve(out, `${id}-${size}x${size}.png`), Buffer.from(result.png, 'base64'));
    }
  }
  console.log(`Verified ${ids.length}/${seedIds.length} seeded SVGs at 540px and 252px: square, transparent, unclipped, ink density <20%.${out ? ` Previews: ${out}` : ' No files written.'}`);
} finally {
  await browser.close();
}
