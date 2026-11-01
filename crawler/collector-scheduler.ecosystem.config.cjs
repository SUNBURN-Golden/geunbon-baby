// Linux only; inject COLLECTOR_DB/COLLECTOR_RAW_DIR from the host's secret environment.
module.exports = {
  apps: [{
    name: 'agamajung-collector-scheduler',
    cwd: `${__dirname}/..`,
    script: 'crawler/collector-scheduler.mjs',
    args: 'schedule',
    interpreter: `${__dirname}/../node_modules/node/bin/node`,
    node_args: '--import tsx',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 5000,
    watch: false,
    kill_timeout: 90000,
    time: true,
    env: { NODE_ENV: 'production', TZ: 'Asia/Seoul' },
  }],
};
