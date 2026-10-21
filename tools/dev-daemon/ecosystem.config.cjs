// Start explicitly: pm2 start tools/dev-daemon/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'agamajung-dev-daemon',
    cwd: `${__dirname}/../..`,
    script: 'tools/dev-daemon/index.ts',
    interpreter: `${__dirname}/../../node_modules/node/bin/node`,
    node_args: '--import tsx',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 15000,
    kill_timeout: 15000,
    max_memory_restart: '1G',
    time: true,
    env: {
      NODE_ENV: 'production',
      DEV_DAEMON_QUEUE: '/workspace/agamajung/dev-queue',
      DEV_DAEMON_BLUEPRINT: '/workspace/agamajung/TASK.md',
    },
  }],
};
