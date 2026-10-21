// 아가마중 크롤러 pm2 설정. 이 파일에는 비밀값을 넣지 않는다.
// 실행: `pm2 start crawler/ecosystem.config.cjs`
// PM2 데몬의 시간대도 Asia/Seoul이어야 한다(env.TZ는 자식 프로세스에만 적용).
// 최초 등록 시 즉시 실행하지 않으려면 stopped 상태로 등록하고 cron만 활성화한다.
module.exports = {
  apps: [{
    name: 'agamajung-crawler',
    cwd: `${__dirname}/..`,
    // A JS entrypoint avoids pm2's automatic TypeScript interpreter detection.
    script: 'crawler/run.mjs',
    interpreter: `${__dirname}/../node_modules/node/bin/node`,
    node_args: '--import tsx',
    exec_mode: 'fork',
    instances: 1,
    // 매일 KST 09:30 / 20:30에 한 사이클만 실행하고 브라우저를 닫는다.
    cron_restart: '30 9,20 * * *',
    autorestart: false,
    watch: false,
    stop_exit_codes: [75],
    kill_timeout: 90000,
    time: true,
    out_file: './crawler/logs/pm2-out.log',
    error_file: './crawler/logs/pm2-err.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Seoul',
      AGAMAJUNG_ONCE: '1',
      AGAMAJUNG_QUIET_WINDOWS: '06:45-08:00,13:00-14:00',
    },
  }],
};
