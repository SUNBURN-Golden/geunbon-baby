import { loadCrawlerEnv } from './managed-env.mjs';

try {
  loadCrawlerEnv(undefined, { requireCollectorDb: true });
} catch (error) {
  console.error(error.message === 'collector_db_required' ? 'collector_db_required' : 'crawler_env_unavailable');
  process.exit(1);
}
