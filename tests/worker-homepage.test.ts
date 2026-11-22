import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('Worker delegates both homepage representations and rejects a failed or unreadable render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-homepage-'));
  try {
    mkdirSync(join(dir, '.open-next')); mkdirSync(join(dir, 'lib'));
    copyFileSync('worker.ts', join(dir, 'worker.ts'));
    copyFileSync('lib/homepage-response.ts', join(dir, 'lib/homepage-response.ts'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, '.open-next/worker.js'), `
      export class DOQueueHandler {}
      export class DOShardedTagCache {}
      export const calls = [];
      export default { fetch(request, env, ctx) {
        calls.push({ accept: request.headers.get('Accept'), env, ctx });
        if (env === 'throw') throw new Error();
        if (env === 'fail') return new Response('unavailable', {status: 500});
        const body = env === 'unreadable'
          ? new ReadableStream({start(controller) { controller.error(new Error()); }})
          : '<html>rendered</html>';
        return new Response(body, { headers: { 'Content-Type': 'text/html', Vary: 'RSC' } });
      } };
    `);
    const program = `
      import assert from 'node:assert/strict';
      import worker, { DOQueueHandler, DOShardedTagCache } from ${JSON.stringify(join(dir, 'worker.ts'))};
      import { calls } from ${JSON.stringify(join(dir, '.open-next/worker.js'))};
      const home = 'https://example.invalid/';
      const json = new Request(home, {headers:{Accept:'application/json'}});
      const html = new Request(home, {headers:{Accept:'text/html'}});
      const ctx = {};
      const success = await worker.fetch(json, 'healthy', ctx);
      assert.equal(success.status, 200);
      assert.deepEqual(await success.json(), {ok: true});
      assert.equal(success.headers.get('Cache-Control'), 'no-store');
      assert.equal(success.headers.get('Vary'), 'Accept');
      assert.deepEqual(calls, [{accept:'text/html', env:'healthy', ctx}]);
      const browser = await worker.fetch(html, 'healthy', ctx);
      assert.equal(await browser.text(), '<html>rendered</html>');
      assert.equal(browser.headers.get('Vary'), 'RSC, Accept');
      for (const env of ['throw','fail','unreadable']) {
        const failed = await worker.fetch(json, env, ctx);
        assert.equal(failed.status, 503);
        assert.deepEqual(await failed.json(), {ok: false});
      }
      assert.equal(typeof DOQueueHandler, 'function');
      assert.equal(typeof DOShardedTagCache, 'function');
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
