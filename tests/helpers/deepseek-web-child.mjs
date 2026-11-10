// Offline child for SIGKILL/PM2 acceptance. All artifacts belong to a caller-created temp directory.
import { join } from 'node:path';
import { runDeepSeekWeb } from '../../crawler/src/deepseek-web/runner.ts';
import { deepSeekWebCli } from '../../crawler/src/deepseek-web/cli.ts';
import { loadDeepSeekWebConfig } from '../../crawler/src/deepseek-web/config.ts';
import { DeepSeekHttpError } from '../../crawler/src/deepseek-web/client.ts';
import { CollectorStore } from '../../crawler/src/store.ts';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [mode, dir, point] = process.argv.slice(2);
const complete = async () => { if (mode === 'crash-result' || mode === 'recover-result') appendFileSync(join(dir, 'provider-calls'), 'call\n'); return ({ content: '{"brand":"Stokke","model":"Tripp Trapp","category":"high_chair","gonggu_price":"390,000원","regular_price":"정보 없음","period":"정보 없음","gifts":"정보 없음","conditions":"정보 없음","seller":"정보 없음","url":"정보 없음","checked_date":"정보 없음","in_scope":true}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'deepseek-chat' }); };
const blockedFetch = () => { throw new Error('offline_harness_network_forbidden'); };
if (mode === 'daemon') {
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
