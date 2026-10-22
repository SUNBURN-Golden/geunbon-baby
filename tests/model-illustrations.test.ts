import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { ILLUSTRATED_MODEL_IDS } from '../lib/model-illustrations';

const dir = new URL('../public/img/models/', import.meta.url);
const seed = JSON.parse(await readFile(new URL('../seed/models.json', import.meta.url), 'utf8')) as { models: { model: string }[] };
const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

test('every listed model has a non-empty SVG and both PNG sizes', async () => {
  for (const id of ILLUSTRATED_MODEL_IDS) {
    for (const file of [`${id}.svg`, `${id}-540x675.png`, `${id}-252x315.png`]) {
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
