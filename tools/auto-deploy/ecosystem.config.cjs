/* eslint-disable @typescript-eslint/no-require-imports -- PM2 loads ecosystem files as CommonJS. */
const { resolve } = require('node:path');

const cwd = resolve(__dirname, '../..');
module.exports = {
  apps: [{
    name: 'agamajung-auto-deploy',
    cwd,
    script: resolve(__dirname, 'run.sh'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    stop_exit_codes: [75],
    restart_delay: 15000,
    kill_timeout: 15000,
    watch: false,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Seoul' },
  }],
};
