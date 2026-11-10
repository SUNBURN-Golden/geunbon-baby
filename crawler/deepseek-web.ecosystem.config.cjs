// 아가마중 DeepSeek 공개 웹 전용 수집기. 비밀값은 이 파일에 넣지 않는다.
// 박스 측 DEEPSEEK_API_KEY·COLLECTOR_DB 등은 pm2 env 또는 호스트 시크릿으로 주입한다.
// Instagram/Threads 자동화 금지 — 이 앱은 PoliteFetcher 공개 GET만 사용한다.
module.exports = {
  apps: [{
    name: 'agamajung-deepseek-web',
    cwd: `${__dirname}/..`,
    script: 'crawler/deepseek-web/run.mjs',
    args: 'daemon',
    interpreter: `${__dirname}/../node_modules/node/bin/node`,
    node_args: '--import tsx',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 60000,
    max_restarts: 20,
    // Keep startup failures within PM2's min_uptime * max_restarts window even with a 60s delay.
    min_uptime: 120000,
    watch: false,
    kill_timeout: 60000,
    time: true,
    out_file: './crawler/logs/deepseek-web-out.log',
    error_file: './crawler/logs/deepseek-web-err.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Seoul',
      // COLLECTOR_DB must be injected on the host for domain_state enforcement.
      // Set DEEPSEEK_MODEL on the host to your verified DeepSeek model id (optional; code default deepseek-chat).
      DEEPSEEK_WEB_DAEMON_MS: '600000',
    },
  }],
};
