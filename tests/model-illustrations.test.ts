import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { ILLUSTRATED_MODEL_IDS, SQUARE_MODEL_IDS, modelIllustration } from '../lib/model-illustrations';

const dir = new URL('../public/img/models/', import.meta.url);
const seed = JSON.parse(await readFile(new URL('../seed/models.json', import.meta.url), 'utf8')) as { models: { model: string }[] };
const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

test('every listed model has a non-empty SVG and both PNG sizes', async () => {
  for (const id of ILLUSTRATED_MODEL_IDS) {
    const art = modelIllustration(id)!;
    const files = [`${id}.svg`, ...art.srcSet.split(', ').map(s => s.split(' ')[0].split('/').at(-1)!)];
    for (const file of files) {
      const bytes = await readFile(new URL(file, dir));
      expect(bytes.length, file).toBeGreaterThan(0);
    }
  }
});

test('every SVG in the directory is listed', async () => {
  const listed: readonly string[] = ILLUSTRATED_MODEL_IDS;
  const ids = (await readdir(dir)).filter(f => /^model-\d+\.svg$/.test(f)).map(f => f.replace('.svg', ''));
  expect(ids.sort()).toEqual([...listed].sort());
});

test('SVG titles match the seed model names and contain no external or active content', async () => {
  for (const id of ILLUSTRATED_MODEL_IDS) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    const title = decode(/<title>([^<]*)<\/title>/.exec(svg)?.[1] ?? '');
    const name = seed.models[Number(id.replace('model-', '')) - 1].model;
    expect(title, id).toContain(name);
    for (const forbidden of ['<image', '<script', '<foreignObject', 'href=']) expect(svg, `${id} ${forbidden}`).not.toContain(forbidden);
  }
});

// Read the persisted PNG pixels directly: no browser, network or image decoder dependency.
async function pngPixels(file: URL) {
  const { inflateSync } = await import('node:zlib');
  const bytes = await readFile(file);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  expect(bytes[24]).toBe(8); // 8-bit RGBA, non-interlaced
  expect(bytes[25]).toBe(6);
  expect(bytes[28]).toBe(0);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    if (new TextDecoder().decode(bytes.subarray(at + 4, at + 8)) === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  expect(raw.length).toBe((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? pixels[at - 4] : 0;
      const above = y ? pixels[at - stride] : 0;
      const corner = y && x >= 4 ? pixels[at - stride - 4] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, corner)][filter];
      pixels[at] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

test('all twenty models have square, transparent, unclipped PNG pairs', async () => {
  expect(SQUARE_MODEL_IDS).toEqual(Array.from({ length: 20 }, (_, i) => `model-${i + 1}`));
  for (const id of SQUARE_MODEL_IDS) {
    for (const size of [252, 540]) {
      const { width, height, pixels } = await pngPixels(new URL(`${id}-${size}x${size}.png`, dir));
      expect([width, height], id).toEqual([size, size]);
      let ink = 0, marginInk = 0;
      const margin = Math.floor(size * .025);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (pixels[(y * size + x) * 4 + 3]) {
          ink++;
          if (x < margin || x >= size - margin || y < margin || y >= size - margin) marginInk++;
        }
      }
      expect(ink, id).toBeGreaterThan(size * 4);
      expect(ink / (size * size), id).toBeLessThan(.2);
      expect(marginInk, id).toBe(0);
    }
  }
});

test('new SVGs contain only unfilled product paths, groups and a nonvisual title', async () => {
  for (const id of SQUARE_MODEL_IDS) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    expect(svg, id).toContain('viewBox="0 0 1080 1080"');
    expect(svg, id).toContain('stroke-linecap="round"');
    expect(svg, id).toContain('stroke-linejoin="round"');
    const tags = [...svg.matchAll(/<\/?([\w:-]+)/g)].map(m => m[1]);
    expect(tags.every(t => ['svg', 'title', 'g', 'path'].includes(t)), id).toBe(true);
    expect(svg.replace(/<title>[^<]*<\/title>/, '').replace(/<[^>]*>/g, '').trim(), id).toBe('');
    expect(svg, id).not.toMatch(/\b(?:href|style|filter|on\w+)\s*=|url\(|data:|<!/i);
    expect([...svg.matchAll(/\bfill="([^"]*)"/g)].every(m => m[1] === 'none'), id).toBe(true);
    expect([...svg.matchAll(/\bstroke="([^"]*)"/g)].map(m => m[1]), id).toEqual(['#334338']);
    expect(svg, id).not.toMatch(/<text|<image|<rect|<filter|<use|<symbol/i);
  }
});

function component(svg: string, id: string) {
  expect([...svg.matchAll(/\bid="([^"]+)"/g)].filter(m => m[1] === id), id).toHaveLength(1);
  const start = svg.indexOf(`<g id="${id}"`);
  expect(start, id).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (const m of svg.slice(start).matchAll(/<g\b[^>]*>|<\/g>/g)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return svg.slice(start, start + m.index! + m[0].length);
  }
  throw new Error(`Unclosed component ${id}`);
}

test('element IDs are unique within every SVG', async () => {
  for (const id of ILLUSTRATED_MODEL_IDS) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size, id).toBe(ids.length);
  }
});

test('mounted and detached trays have a flat back and rounded front with an inset spill rim', async () => {
  for (const [model, groups] of [[4, ['tray', 'tray-detail']], [5, ['tray']]] as const) {
    const svg = await readFile(new URL(`model-${model}.svg`, dir), 'utf8');
    for (const group of groups) {
      const paths = [...component(svg, group).matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
      // The outer silhouette, raised lip and recessed surface each have a straight
      // rear chord; all curved front points lie forward of it (an oval fails).
      const contours = paths.slice(0, 3).map(d => {
        expect(d.match(/[A-Za-z]/g), `${model} ${group}`).toEqual(['M', 'L', 'C', 'C', 'Z']);
        const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        const [left, back, right, rearEnd] = n;
        expect(rearEnd).toBe(back);
        expect(right - left).toBeGreaterThan(200);
        const frontYs = n.slice(4).filter((_, i) => i % 2 === 1);
        expect(frontYs.every(y => y >= back)).toBe(true);
        expect(Math.max(...frontYs) - back).toBeGreaterThan(60);
        expect(n.slice(-2)).toEqual([left, back]);
        return { left, right, back, front: Math.max(...frontYs) };
      });
      for (let i = 1; i < contours.length; i++) {
        expect(contours[i].left).toBeGreaterThan(contours[i - 1].left);
        expect(contours[i].right).toBeLessThan(contours[i - 1].right);
        expect(contours[i].back).toBeGreaterThan(contours[i - 1].back);
        expect(contours[i].front).toBeLessThan(contours[i - 1].front);
      }
    }
  }
  const four = await readFile(new URL('model-4.svg', dir), 'utf8');
  for (const id of ['detail-backrest', 'detail-rail', 'detail-crotch-guard']) component(four, id);
});

test('set components keep distinct detailed groups rather than abstract stand-ins', async () => {
  for (const [id, groups] of [
    ['model-3', ['chair', 'baby-set']],
    ['model-4', ['chair', 'baby-set', 'tray', 'tray-detail']],
    ['model-5', ['chair', 'newborn-set', 'baby-set', 'tray', 'harness']],
    ['model-8', ['frame', 'seat', 'canopy', 'harness']],
    ['model-9', ['frame', 'bassinet', 'footmuff', 'canopy']],
    ['model-12', ['bumper-bar', 'chassis', 'seat']],
    ['model-13', ['stroller', 'bassinet', 'chassis', 'seat']],
    ['model-14', ['chassis', 'seat']],
  ] as const) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    for (const name of groups) {
      const ds = [...component(svg, name).matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
      expect(new Set(ds).size, `${id}: ${name}`).toBeGreaterThanOrEqual(20);
      expect(ds.filter(d => /[CQ]/.test(d)).length, `${id}: ${name} curves`).toBeGreaterThanOrEqual(12);
    }
  }
  const gi = await readFile(new URL('model-18.svg', dir), 'utf8');
  expect(gi).toContain('id="integral-rotating-base"');
  for (const id of ['model-19', 'model-20']) {
    expect(await readFile(new URL(`${id}.svg`, dir), 'utf8')).not.toContain('id="integral-rotating-base"');
  }
});

test('only the sixty square illustration files remain', async () => {
  const files = (await readdir(dir)).sort();
  const expected = SQUARE_MODEL_IDS.flatMap(id => [`${id}.svg`, `${id}-540x540.png`, `${id}-252x252.png`]).sort();
  expect(files).toEqual(expected);
});

test('single items and bundles retain different component structures', async () => {
  const svg = async (n: number) => readFile(new URL(`model-${n}.svg`, dir), 'utf8');
  for (const n of [1, 2]) {
    expect(await svg(n)).not.toContain('id="baby-set"');
    expect(await svg(n)).not.toContain('id="tray"');
  }
  expect(await svg(3)).not.toContain('id="tray"');
  for (const id of ['seat', 'canopy', 'bassinet']) expect(await svg(7)).not.toContain(`id="${id}"`);
  for (const id of ['backrest', 'rail', 'crotch-guard', 'glider']) expect(await svg(3)).toContain(`id="${id}"`);
  for (const [n, groups] of [[2, ['grain']], [6, ['chassis', 'seat', 'canopy', 'wheels']], [9, ['adapter']], [10, ['chassis', 'seat', 'canopy', 'wheels', 'basket']]] as const) {
    for (const id of groups) expect(await svg(n)).toContain(`id="${id}"`);
  }
  const pathSet = (s: string) => [...new Set([...s.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]))].sort();
  for (const [a, b] of [[3, 4], [7, 8], [7, 9], [10, 11]]) expect(pathSet(await svg(a))).not.toEqual(pathSet(await svg(b)));
});
