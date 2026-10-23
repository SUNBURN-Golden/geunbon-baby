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

test('all thirty-nine registered models have square, transparent, unclipped PNG pairs', async () => {
  expect(SQUARE_MODEL_IDS).toEqual(Array.from({ length: 41 }, (_, i) => `model-${i + 1}`).filter(id => !['model-32', 'model-39'].includes(id)));
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
    ['model-9', ['frame', 'bassinet', 'footmuff', 'canopy', 'adapter']],
    ['model-12', ['bumper-bar', 'chassis', 'seat']],
    ['model-13', ['stroller', 'bassinet', 'chassis', 'seat']],
    ['model-14', ['chassis', 'seat']],
    ['model-21', ['toddler-seat', 'infant-carrier', 'isofix-base']],
    ['model-22', ['stroller', 'infant-carrier', 'ring-adapter']],
  ] as const) {
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    for (const name of groups) {
      const ds = [...component(svg, name).matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
      expect(new Set(ds).size, `${id}: ${name}`).toBeGreaterThanOrEqual(20);
      expect(ds.filter(d => /[CQ]/.test(d)).length, `${id}: ${name} curves`).toBeGreaterThanOrEqual(12);
    }
  }
  for (const n of [18, 23, 24]) expect(await readFile(new URL(`model-${n}.svg`, dir), 'utf8')).toContain('id="integral-rotating-base"');
  for (const id of ['model-19', 'model-20']) {
    expect(await readFile(new URL(`${id}.svg`, dir), 'utf8')).not.toContain('id="integral-rotating-base"');
  }
});

test('only the 117 registered square illustration files remain', async () => {
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
  expect(await svg(21)).toContain('id="isofix-base"');
  expect(await svg(20)).not.toContain('id="isofix-base"');
  const pathSet = (s: string) => [...new Set([...s.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]))].sort();
  for (const [a, b] of [[3, 4], [7, 8], [7, 9], [10, 11], [23, 24], [25, 26], [27, 28], [27, 29], [28, 29], [30, 31], [33, 36], [34, 36], [35, 36], [27, 40], [28, 40], [29, 40]]) expect(pathSet(await svg(a))).not.toEqual(pathSet(await svg(b)));
});

// Confirmed scope and evidence are mirrored in docs/model-illustrations-batch-4.md.
// Blocked models have no SVG: an unavailable thumbnail must never be replaced by invented art.
const BATCH4: Record<string, {
  status: 'confirmed-single' | 'confirmed-set' | 'unconfirmed' | 'blocked';
  groups: string[];
  absent?: string[];
}> = {
  'model-31': { status: 'confirmed-set', groups: ['chassis', 'seat', 'canopy', 'wheels', 'carrycot', 'footmuff', 'backpack', 'seat-liner', 'car-seat-adapters', 'deluxe-blanket', 'carrycot-sherpa-topper', 'carrycot-fitted-sheets', 'rain-covers'] },
  'model-32': { status: 'blocked', groups: [] },
  'model-33': { status: 'confirmed-set', groups: ['shell', 'harness', 'integral-rotating-base', 'newborn-insert'] },
  'model-34': { status: 'confirmed-set', groups: ['shell', 'harness', 'integral-rotating-base', 'newborn-insert'] },
  'model-35': { status: 'confirmed-set', groups: ['shell', 'harness', 'integral-rotating-base', 'newborn-insert'] },
  'model-36': { status: 'confirmed-set', groups: ['shell', 'harness', 'integral-rotating-base', 'newborn-insert'] },
  'model-37': { status: 'confirmed-single', groups: ['shell', 'harness', 'isofix-tether'], absent: ['newborn-insert', 'isofix-base'] },
  'model-38': { status: 'confirmed-set', groups: ['chassis', 'seat', 'canopy', 'wheels', 'basket', 'rain-cover', 'newborn-apron'] },
  'model-39': { status: 'blocked', groups: [] },
  'model-40': { status: 'unconfirmed', groups: ['body-panel', 'shoulder-straps', 'waist-belt', 'buckle'] },
  'model-41': { status: 'unconfirmed', groups: ['infant-carrier', 'integrated-wheels', 'handle'] },
};

function topLevelComponentIds(svg: string) {
  let depth = 0;
  const ids: string[] = [];
  for (const m of svg.matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if (m[0] === '</g>') { depth--; continue; }
    if (depth === 1) {
      const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
      expect(id, 'each component must be named').toBeDefined();
      ids.push(id!);
    }
    depth++;
  }
  expect(depth).toBe(0);
  return ids;
}

test('batch 4 draws exactly the documented components with distinct detailed curves', async () => {
  const files = await readdir(dir);
  for (const [id, spec] of Object.entries(BATCH4)) {
    if (spec.status === 'blocked') {
      expect(modelIllustration(id), id).toBeNull();
      expect(files.filter(f => f.startsWith(`${id}.`) || f.startsWith(`${id}-`)), id).toEqual([]);
      continue;
    }
    const svg = await readFile(new URL(`${id}.svg`, dir), 'utf8');
    expect(topLevelComponentIds(svg).sort(), id).toEqual([...spec.groups].sort());
    expect(svg, id).not.toContain('transform=');
    for (const group of spec.groups) {
      const ds = pathData(component(svg, group));
      expect(new Set(ds).size, `${id} ${group}: unique paths`).toBeGreaterThanOrEqual(20);
      expect(new Set(ds.filter(d => /[CQ]/.test(d))).size, `${id} ${group}: curved paths`).toBeGreaterThanOrEqual(12);
    }
    for (const absent of spec.absent ?? []) expect(svg, `${id} ${absent}`).not.toContain(`id="${absent}"`);
    for (const m of svg.matchAll(/<path\b[^>]*>/g)) {
      const width = Number(/stroke-width="([^"]+)"/.exec(m[0])?.[1]);
      expect(width, id).toBeGreaterThanOrEqual(5.2);
      expect(width, id).toBeLessThanOrEqual(6);
      expect(/\bd="([^"]+)"/.exec(m[0])?.[1], id).toMatch(/^(?:[MLCQZ\s,\d.\-])+$/);
    }
  }
  // This is a structural assertion, independent of included accessories.
  for (const n of [33, 34, 35, 36]) {
    expect(await readFile(new URL(`model-${n}.svg`, dir), 'utf8')).toContain('id="integral-rotating-base"');
  }
  expect(await readFile(new URL('model-37.svg', dir), 'utf8')).not.toContain('id="integral-rotating-base"');
});

test('the DUALFIX trim variants preserve the same verified structure without invented textile details', async () => {
  // The official <=300px photos do not establish different structural seams.
  // Explicit design exception: omit [33,34], [33,35], [34,35] path-difference assertions.
  const sets = await Promise.all([33, 34, 35].map(async n => pathData(await readFile(new URL(`model-${n}.svg`, dir), 'utf8'))));
  expect(sets[0]).toEqual(sets[1]);
  expect(sets[0]).toEqual(sets[2]);
  // [38,39] cannot be compared until a compliant official Dune 2 thumbnail is available.
});

type Point = [number, number];
type Matrix = [number, number, number, number, number, number];
const numbers = (s: string) => (s.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? []).map(Number);
const pathData = (s: string) => [...s.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
const transformPoint = ([x, y]: Point, [a, b, c, d, e, f]: Matrix): Point => [a * x + c * y + e, b * x + d * y + f];

function groupMatrix(group: string): Matrix {
  const value = /\btransform="([^"]+)"/.exec(group.split('>')[0])?.[1] ?? '';
  let result: Matrix = [1, 0, 0, 1, 0, 0];
  for (const match of value.matchAll(/(translate|scale|matrix)\(([^)]+)\)/g)) {
    const n = numbers(match[2]);
    const next: Matrix = match[1] === 'matrix' ? n as Matrix : match[1] === 'translate'
      ? [1, 0, 0, 1, n[0], n[1] ?? 0] : [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    const [a, b, c, d, e, f] = result, [g, h, i, j, k, l] = next;
    result = [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f];
  }
  return result;
}

function controlPoints(d: string): Point[] {
  const n = numbers(d);
  expect(n.length % 2).toBe(0);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[i*2], n[i*2+1]]);
}

// Absolute M/L/Q/C/Z only; include endpoints and ten samples per curve.
function pathSamples(d: string): Point[] {
  const points: Point[] = [];
  let current: Point = [0, 0], first: Point = [0, 0];
  for (const m of d.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const p = controlPoints(m[2]);
    if (m[1] === 'Z') { points.push(first); current = first; continue; }
    if (m[1] === 'M' || m[1] === 'L') {
      current = p[0]; points.push(current);
      if (m[1] === 'M') first = current;
      continue;
    }
    const start = current;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10, u = 1 - t;
      points.push(m[1] === 'Q'
        ? [u*u*start[0]+2*u*t*p[0][0]+t*t*p[1][0], u*u*start[1]+2*u*t*p[0][1]+t*t*p[1][1]]
        : [u**3*start[0]+3*u*u*t*p[0][0]+3*u*t*t*p[1][0]+t**3*p[2][0], u**3*start[1]+3*u*u*t*p[0][1]+3*u*t*t*p[1][1]+t**3*p[2][1]]);
    }
    current = p.at(-1)!;
  }
  return points;
}

function componentExtent(svg: string, id: string) {
  const group = component(svg, id);
  const ancestors: string[] = [];
  for (const m of svg.slice(0, svg.indexOf(group)).matchAll(/<g\b[^>]*>|<\/g>/g)) {
    if (m[0] === '</g>') ancestors.pop(); else ancestors.push(m[0]);
  }
  expect(ancestors.filter(g => /\btransform=/.test(g)), `${id}: no transformed wrapper`).toEqual([]);
  const matrix = groupMatrix(group);
  const points = pathData(group).flatMap(controlPoints).map(p => transformPoint(p, matrix));
  const stroke = Number(/stroke-width="([^"]+)"/.exec(group.split('>')[0])?.[1] ?? 5.5);
  const half = stroke * Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])) / 2;
  const minX = Math.min(...points.map(p => p[0])) - half, maxX = Math.max(...points.map(p => p[0])) + half;
  const minY = Math.min(...points.map(p => p[1])) - half, maxY = Math.max(...points.map(p => p[1])) + half;
  return { minX, maxX, minY, maxY, width: maxX - minX };
}

test('detached accessories and mounted harness remain legible at card size without transformed wrappers', async () => {
  for (const [model, id, width] of [[5, 'baby-set', 300], [5, 'tray', 300], [5, 'harness', 220], [8, 'harness', 137], [21, 'isofix-base', 300], [22, 'ring-adapter', 300]] as const) {
    const svg = await readFile(new URL(`model-${model}.svg`, dir), 'utf8');
    const box = componentExtent(svg, id);
    expect(box.width, `${model} ${id}`).toBeGreaterThanOrEqual(width);
    expect(Math.min(box.minX, box.minY)).toBeGreaterThanOrEqual(32);
    expect(Math.max(box.maxX, box.maxY)).toBeLessThanOrEqual(1048);
  }
  const five = await readFile(new URL('model-5.svg', dir), 'utf8');
  const boxes = ['baby-set', 'tray', 'harness'].map(id => componentExtent(five, id));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].minY - boxes[i-1].maxY).toBeGreaterThanOrEqual(30);
  expect(component(five, 'newborn-set')).toContain('<g id="toy">');
});

test('mounted tray follows its own chair footplate perspective with shortened, sheared depth', async () => {
  const svg = await readFile(new URL('model-4.svg', dir), 'utf8');
  const tray = component(svg, 'tray');
  expect(tray.split('>')[0]).toMatch(/transform="matrix\(/);
  const [a,b,c,d] = groupMatrix(tray);
  const back = Math.atan2(b,a) * 180 / Math.PI, depth = Math.atan2(d,c) * 180 / Math.PI;
  expect(back).toBeGreaterThanOrEqual(-6); expect(back).toBeLessThanOrEqual(8);
  expect(depth).toBeGreaterThanOrEqual(104); expect(depth).toBeLessThanOrEqual(124);
  const ratio = Math.hypot(c,d) / Math.hypot(a,b);
  expect(ratio).toBeGreaterThanOrEqual(.65); expect(ratio).toBeLessThanOrEqual(.85);
  expect(310 * Math.hypot(a,b)).toBeGreaterThanOrEqual(330);
  const chair = component(svg, 'chair');
  for (const landmark of ['385,665', '534,657', '678,711 L 485,765']) expect(chair).toContain(landmark);
});

function inside(p: Point, polygon: Point[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) hit = !hit;
  }
  return hit;
}
function edgeDistance(p: Point, polygon: Point[]) {
  return Math.min(...polygon.map((a, i) => {
    const b = polygon[(i+1) % polygon.length], dx = b[0]-a[0], dy = b[1]-a[1];
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy);
  }));
}

test('tray footprint hides rail and crotch guard without paint or masks', async () => {
  const svg = await readFile(new URL('model-4.svg', dir), 'utf8');
  const tray = component(svg, 'tray'), ds = pathData(tray), matrix = groupMatrix(tray);
  // Back chord, right end wall, front wall (reversed), left end wall.
  const rear = pathSamples(ds[0]).slice(0, 2), wall = pathSamples(ds[5]);
  const polygon = [...rear, ...[...wall].reverse()].map(p => transformPoint(p, matrix));
  for (const id of ['rail', 'crotch-guard']) {
    const group = component(svg, id);
    expect(pathData(group).length, id).toBeGreaterThanOrEqual(8);
    expect(svg.slice(0, svg.indexOf(group))).toContain('<g transform="translate(295 220)">');
    const points = pathData(group).flatMap(d => [...controlPoints(d), ...pathSamples(d)]).map(([x,y]): Point => [x+295,y+220]);
    for (const p of points) expect(inside(p, polygon) && edgeDistance(p, polygon) >= 4, `${id}: ${p}`).toBe(false);
    if (id === 'crotch-guard') {
      const bottom = Math.max(...ds.flatMap(d => [...controlPoints(d), ...pathSamples(d)]).map(p => transformPoint(p, matrix)[1]));
      expect(Math.min(...points.map(p => p[1]))).toBeGreaterThanOrEqual(bottom + 4);
    }
  }
  const three = await readFile(new URL('model-3.svg', dir), 'utf8');
  expect(pathData(component(three, 'rail')).length).toBeGreaterThanOrEqual(14);
});

test('all refined set ink, including transformed stroke widths, stays inside the safe square', async () => {
  for (const n of [3, 4, 5, 8, 9, 21, 22, 31, 33, 34, 35, 36, 37, 38, 40, 41]) {
    const svg = await readFile(new URL(`model-${n}.svg`, dir), 'utf8');
    const stack: { matrix: Matrix; stroke: number }[] = [{ matrix: [1,0,0,1,0,0], stroke: 5.5 }];
    for (const tag of svg.matchAll(/<g\b[^>]*>|<\/g>|<path\b[^>]*>/g)) {
      if (tag[0] === '</g>') { stack.pop(); continue; }
      const parent = stack.at(-1)!;
      if (tag[0].startsWith('<g')) {
        const [a,b,c,d,e,f] = parent.matrix, [g,h,i,j,k,l] = groupMatrix(tag[0]);
        stack.push({ matrix: [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f], stroke: Number(/stroke-width="([^"]+)"/.exec(tag[0])?.[1] ?? parent.stroke) });
      } else {
        const points = controlPoints(/\bd="([^"]+)"/.exec(tag[0])![1]).map(p => transformPoint(p, parent.matrix));
        const [a,b,c,d] = parent.matrix;
        // The transformed circular stroke has these exact horizontal/vertical radii.
        const stroke = Number(/stroke-width="([^"]+)"/.exec(tag[0])?.[1] ?? parent.stroke);
        const rx = stroke * Math.hypot(a,c) / 2, ry = stroke * Math.hypot(b,d) / 2;
        for (const [x,y] of points) {
          expect(Math.min(x-rx,y-ry), `model-${n} safe margin`).toBeGreaterThanOrEqual(32);
          expect(Math.max(x+rx,y+ry), `model-${n} safe margin`).toBeLessThanOrEqual(1048);
        }
      }
    }
  }
});
