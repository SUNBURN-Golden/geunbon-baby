// Offline child for SIGKILL/PM2 acceptance. All artifacts belong to a caller-created temp directory.
import { join } from 'node:path';
import { runDeepSeekWeb } from '../../crawler/src/deepseek-web/runner.ts';
import { deepSeekWebCli } from '../../crawler/src/deepseek-web/cli.ts';
import { loadDeepSeekWebConfig } from '../../crawler/src/deepseek-web/config.ts';
import { DeepSeekHttpError } from '../../crawler/src/deepseek-web/client.ts';
import { emptyMemory, saveMemory } from '../../crawler/src/deepseek-web/memory.ts';
import { readHeartbeat } from '../../crawler/src/deepseek-web/heartbeat.ts';
import { CollectorStore } from '../../crawler/src/store.ts';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [mode, dir, point] = process.argv.slice(2);
const complete = async () => { if (mode === 'crash-result' || mode === 'recover-result') appendFileSync(join(dir, 'provider-calls'), 'call\n'); return ({ content: '{"brand":"Stokke","model":"Tripp Trapp","category":"high_chair","gonggu_price":"390,000원","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":true}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'deepseek-chat' }); };
const blockedFetch = () => { throw new Error('offline_harness_network_forbidden'); };
if (mode === 'daemon-fetch-gone') {
  const store = new CollectorStore(join(dir, 'collector.sqlite'));
  const gone = 'https://09pangpang.com/post/900001';
  const listing = 'https://09pangpang.com/';
  const healthy = 'https://shop.example/deal';
  const memory = emptyMemory();
  memory.pending_urls.push(gone);
  memory.pending_catalog_meta[gone] = { catalog_product_id: 'cybex-fixture', category: 'stroller' };
  await saveMemory(dir, memory);
  const requests = [], ticks = [];
  const urls = [gone, healthy];
  const stop = new AbortController();
  const config = loadDeepSeekWebConfig();
  config.fetch.min_interval_ms = 0;
  config.fetch.jitter_ms = [0, 0];
  config.selection.max_pangpang_detail_per_cycle = 1;
  const sample = readFileSync(join(process.cwd(), 'tests/fixtures/deepseek-web/sample-page.txt'), 'utf8');
  try {
    await deepSeekWebCli(['daemon'], {
      stateDir: dir, store, urls, client: { complete }, signal: stop.signal, loadConfig: () => config,
      fetchImpl: async target => {
        const url = String(target);
        requests.push(url);
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
        if (url === gone) return new Response('discarded body', { status: 410 });
        if (url === healthy) return new Response(sample);
        if (url === listing) return new Response([900001, 900002].map((id, index) =>
          `<div><a data-feed-index="${index}" href="/post/${id}"><p class="line-clamp-2 text-base font-bold">Cybex 유모차 ${index}</p></a><span class="text-category">키즈 &gt; 유모차</span><span>11/4 (월) 오픈</span></div>`).join(''));
        return blockedFetch();
      },
      wait: async () => {
        ticks.push(await readHeartbeat(dir));
        if (ticks.length === 1) urls.splice(0, urls.length, listing, gone + '?source=home');
        else stop.abort();
      },
    });
    console.log(JSON.stringify({ pid: process.pid, requests, ticks }));
  } finally { store.close(); }
} else if (mode === 'daemon') {
  // Empty/blocked public fetches exercise the real daemon and its persistent writer ownership.
  const store = new CollectorStore(join(dir, 'collector.sqlite'));
  writeFileSync(join(dir, 'ready-pid'), String(process.pid));
  try { await deepSeekWebCli(['daemon'], { stateDir: dir, store, client: { complete }, fetchImpl: blockedFetch }); }
  finally { store.close(); }
} else {
  await runDeepSeekWeb({ mode: 'dry_run', stateDir: dir,
    urls: mode === 'recover-result' ? ['https://fixture.example/crash'] : mode.startsWith('crash') ? ['https://fixture.example/crash'] : ['https://www.instagram.com/blocked'],
    loadConfig: () => { const config = loadDeepSeekWebConfig(); if (mode === 'recover' || mode === 'recover-result') config.budget.max_requests_per_run = 0; return config; },
    client: { complete: mode === 'crash-backoff' ? async () => { throw new DeepSeekHttpError(402); } : complete }, fetchImpl: blockedFetch,
    fault: location => { if (location === point) process.kill(process.pid, 'SIGKILL'); },
  });
  // Force another restart/recovery to demonstrate idempotent folds and audit replay.
  if (mode === 'recover') {
    const m = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    console.log(JSON.stringify({ tokens: m.lifetime.token_spent, cycles: m.lifetime.cycles }));
  }
}
