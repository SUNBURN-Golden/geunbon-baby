import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const spaced = '아가 마중';

async function sources() {
  const copy = (await readdir(join(root, 'lib'))).filter(f => /-copy\.ts$/.test(f)).map(f => `lib/${f}`);
  const app = [];
  for (const entry of await readdir(join(root, 'app'), { recursive: true })) {
    const file = `app/${entry}`;
    if ((await stat(join(root, file))).isFile()) app.push(file);
  }
  return [...copy, ...app];
}

test('site copy and every file under app/ use the unified brand 아가마중, never the spaced form', async () => {
  const files = await sources();
  expect(files).toEqual(expect.arrayContaining([
    'lib/site-copy.ts', 'lib/deals-copy.ts', 'lib/auth-copy.ts',
    'app/layout.tsx', 'app/globals.css', 'app/api/auth/[[...path]]/route.ts',
  ]));
  const offenders = [];
  for (const file of files) if ((await readFile(join(root, file), 'utf8')).includes(spaced)) offenders.push(file);
  expect(offenders).toEqual([]);
});
