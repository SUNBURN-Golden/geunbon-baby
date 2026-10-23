// Render the editable registered SVGs without a server or network.
// Usage: npx tsx scripts/render-model-illustrations.ts [model-1 ... model-20]
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { SQUARE_MODEL_IDS } from '../lib/model-illustrations';

const requested = process.argv.slice(2);
const ids = requested.length ? [...new Set(requested)] : SQUARE_MODEL_IDS;
for (const id of ids) {
  if (!(SQUARE_MODEL_IDS as readonly string[]).includes(id)) throw new Error(`Not a registered square model: ${id}`);
}
const dir = new URL('../public/img/models/', import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort());
  for (const id of ids) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    for (const size of [540, 252]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"></body></html>');
      const data = await page.evaluate(async ({ svg, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d')!.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { svg, size });
      await writeFile(new URL(`${id}-${size}x${size}.png`, dir), Buffer.from(data, 'base64'));
    }
  }
  console.log(`Rendered ${ids.length} SVGs at 540px and 252px (transparent).`);
} finally {
  await browser.close();
}
