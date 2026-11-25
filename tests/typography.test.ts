import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import manifest from '../docs/fonts/manifest.json';
import seed from '../seed/models.json';
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const fonts = read('app/fonts.css');
const css = read('app/globals.css');
const layout = read('app/layout.tsx');
function codepoints(range: string) {
  return range.split(',').flatMap(part => {
    const [lo, hi = lo] = part.trim().replace(/^U\+/i, '').split('-').map(value => parseInt(value, 16));
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
}
describe('vendored display typography', () => {
  test('every downloadable face swaps, resolves offline, and matches the coverage manifest', () => {
    const rules = [...fonts.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(m => m[1]).filter(rule => rule.includes('url('));
    expect(rules).toHaveLength(manifest.faces.length);
    for (const face of manifest.faces) {
      const rule = rules.find(r => r.includes(`"${face.url}"`));
      expect(rule).toContain('font-display: swap;');
      expect(rule).toContain('font-weight: 400;');
      expect(rule).toContain(`font-family: "${face.cssFamily}";`);
      expect(rule).toContain(`unicode-range: ${face.unicodeRange};`);
      expect(rule).not.toContain('local(');
      expect(existsSync(new URL('../public' + face.url, import.meta.url))).toBe(true);
    }
    // Fallback aliases are local sans faces too; they must never hide text or bypass swap.
    const allFaces = [...fonts.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(m => m[1]);
    for (const rule of allFaces) expect(rule).toContain('font-display: swap;');
    expect(fonts).not.toMatch(/https?:\/\//);
  });
  test('Gaegu ranges are exact, disjoint, and confined to Hangul syllables and compatibility jamo', () => {
    const seen = new Set<number>();
    for (const face of manifest.faces.filter(f => f.family === 'Gaegu')) {
      const points = codepoints(face.unicodeRange);
      const asset = manifest.assets.find(a => '/' + a.path.replace('public/', '') === face.url)!;
      expect(points).toEqual(asset.codepoints);
      expect(points.length).toBeLessThanOrEqual(256);
      for (const cp of points) {
        expect((cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x3131 && cp <= 0x318E)).toBe(true);
        expect(seen.has(cp)).toBe(false);
        seen.add(cp);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(manifest.gaeguCoverage);
    expect(new Set([...seen, ...manifest.gaeguSourceGaps]).size).toBe(11172 + 94);
    for (const cp of [0x3131, 0x314e, 0xac00, 0xb9c8, 0xc544, 0xc911]) expect(seen.has(cp)).toBe(true);
    for (const model of seed.models) {
      for (const char of model.brand + model.model) {
        const cp = char.codePointAt(0)!;
        if (cp >= 0xAC00 && cp <= 0xD7A3) expect(seen.has(cp), `${model.model}: ${char}`).toBe(true);
      }
    }
  });
  test('font binaries, provenance source, and complete licenses match SHA-256 records', () => {
    for (const asset of manifest.assets) {
      const data = readFileSync(new URL('../' + asset.path, import.meta.url));
      expect(data.byteLength).toBe(asset.bytes);
      expect(createHash('sha256').update(data).digest('hex')).toBe(asset.sha256);
    }
    for (const revision of Object.values(manifest.revisions)) expect(revision).toMatch(/^[a-f0-9]{40}$/);
    for (const source of manifest.sources) {
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.url).toMatch(/\/[a-f0-9]{40}\//);
    }
    const source = read('docs/fonts/Excalifont.upstream.ts.txt');
    expect(read('public/fonts/excalifont/OFL.txt')).toBe(source.split('Origin File Name Table:\n')[1].split('\nlicenseURL:')[0].replace(/\r\n/g, '\n') + '\n');
    for (const [family, copyright] of [['excalifont', 'Copyright (c) 2024 by Excalidraw.'], ['gaegu', 'Copyright 2018 The Gaegu Project Authors']]) {
      const license = read(`public/fonts/${family}/OFL.txt`);
      for (const required of [copyright, 'SIL OPEN FONT LICENSE Version 1.1', 'PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER', 'OTHER DEALINGS IN THE FONT SOFTWARE.']) expect(license).toContain(required);
      expect(license.length).toBeGreaterThan(4000);
    }
  });
  test('exactly the two wordmark subsets are preloaded with matching anonymous CORS', () => {
    expect(layout).toContain("import './fonts.css'");
    const preloads = [...layout.matchAll(/<link\s+rel="preload"[^>]+\/>/g)].map(m => m[0]);
    expect(preloads).toHaveLength(2);
    for (const path of ['/fonts/excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2', '/fonts/gaegu/gaegu-regular-logo.woff2']) {
      const link = preloads.find(p => p.includes(`href="${path}"`));
      for (const attr of ['as="font"', 'type="font/woff2"', 'crossOrigin="anonymous"']) expect(link).toContain(attr);
      expect(fonts).toContain(`url("${path}")`);
    }
  });
  test('commerce remains sans and display rules stay explicitly scoped', () => {
    expect(css).toMatch(/\.model-prices,\s*\.comparison > section > h2,\s*\.comparison > section > h3,\s*\.comparison > section > \.eyebrow\s*\{ font-family: var\(--font-sans\); \}/);
    expect(css).toMatch(/\.active-deal-count\s*\{[^}]*var\(--font-sans\)/);
    const displayRules = [...css.matchAll(/([^{}]+)\{([^{}]*font-family: var\(--font-display\)[^{}]*)\}/g)];
    expect(displayRules.length).toBeGreaterThan(0);
    for (const rule of displayRules) {
      expect(rule[1]).not.toMatch(/(?:^|,)\s*(?:h[1-6]|p|body|label|table|\.eyebrow)\s*(?:,|$)/);
      expect(rule[1]).not.toMatch(/legal|notice|verification|price|comparison|admin/);
      expect(rule[2]).toContain('font-synthesis: none');
    }
    expect(css).toContain('"Agamajung Excalifont", "Agamajung Gaegu",');
    // A plain upstream family name could match an installed font when the webfont fails.
    expect(css).not.toMatch(/--font-display:\s*"Excalifont"/);
    expect(css).not.toContain('-webkit-line-clamp');
    expect(layout).toContain('<p className="brand-slogan">{siteCopy.tagline}</p>');
    const home = read('app/page.tsx');
    expect(home.match(/<h1>[\s\S]*?<\/h1>/)?.[0]).not.toContain('<br');
    expect(read('app/_active-deals.tsx').match(/<h2\b[\s\S]*?<\/h2>/)?.[0]).not.toContain('<br');
  });
});
