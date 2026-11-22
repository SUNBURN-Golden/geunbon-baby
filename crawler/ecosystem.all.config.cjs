/* eslint-disable @typescript-eslint/no-require-imports -- PM2 loads ecosystem files as CommonJS. */
const { join } = require('node:path');
const { slots } = require('./pm2-cron.cjs');

const cwd = '/workspace/agamajung/runtime/current';
const logs = '/workspace/agamajung/auto-deploy/crawler-logs';
const inventory = [
  { name: 'agamajung-local-worker', script: 'crawler/local-worker.mjs', args: ['serve'] },
  { name: 'agamajung-discover', script: 'crawler/local-worker.mjs', args: ['discover'], cron_restart: slots['agamajung-discover'] },
  { name: 'agamajung-collect', script: 'crawler/local-worker.mjs', args: ['collect'], cron_restart: slots['agamajung-collect'] },
  { name: 'agamajung-discover-sources', script: 'crawler/local-worker.mjs', args: ['discover-sources'], cron_restart: slots['agamajung-discover-sources'] },
  { name: 'agamajung-backfill', script: 'crawler/local-worker.mjs', args: ['backfill-engine'], cron_restart: slots['agamajung-backfill'] },
  { name: 'agamajung-deepseek-web', script: 'crawler/deepseek-web/run.mjs', args: ['daemon'] },
];

// The deployer includes this entry only when adopting an existing matching PM2 app.
const instagram = {
  name: 'agamajung-crawler', script: 'crawler/run.mjs', args: [], cron_restart: slots['agamajung-crawler'],
};

function app(entry, root = cwd, preloadRoot = root) {
  const scheduled = !!entry.cron_restart;
  const deepseek = entry.name === 'agamajung-deepseek-web';
  const env = { NODE_ENV: 'production', TZ: 'Asia/Seoul' };
  if (scheduled) env.AGAMAJUNG_PM2_JOB = entry.name;
  if (deepseek) {
    env.DEEPSEEK_WEB_DAEMON_MS = '600000';
    if (root === cwd) env.AGAMAJUNG_PM2_DEEPSEEK = '1';
  }
  if (entry.name === instagram.name) {
    env.AGAMAJUNG_ONCE = '1';
    env.AGAMAJUNG_QUIET_WINDOWS = '06:45-08:00,13:00-14:00';
  }
  return {
    ...entry,
    cwd: root,
    script: join(root, entry.script),
    interpreter: join(root, 'node_modules/node/bin/node'),
    node_args: [
      '--import', 'tsx', '--import', join(preloadRoot, 'crawler/load-managed-env.mjs'),
      ...(scheduled ? ['--import', join(preloadRoot, 'crawler/pm2-cron-gate.mjs')] : []),
    ],
    exec_mode: 'fork',
    instances: 1,
    // PM2 applies autostart again inside its cron-triggered restart. The
    // preload gates boot-time launches while allowing the cron callback to run.
    autostart: true,
    autorestart: !scheduled,
    watch: false,
    stop_exit_codes: [75],
    kill_timeout: deepseek ? 60000 : 90000,
    restart_delay: deepseek ? 60000 : 10000,
    max_restarts: deepseek ? 20 : 10,
    ...(deepseek ? { min_uptime: 120000 } : {}),
    out_file: join(logs, entry.name + '-out.log'),
    error_file: join(logs, entry.name + '-error.log'),
    time: true,
    env,
  };
}

module.exports = { apps: inventory.map(entry => app(entry)) };
Object.defineProperties(module.exports, { inventory: { value: inventory }, instagram: { value: instagram }, app: { value: app } });
