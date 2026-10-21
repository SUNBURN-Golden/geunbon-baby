// 아가마중 크롤러 pm2 설정. 이 파일에는 비밀값을 넣지 않는다.
// 실행: `pm2 start crawler/ecosystem.config.cjs`
// 비밀은 별도 저장소에서 환경변수로 주입한 뒤 pm2 restart agamajung-crawler --update-env
// 또는 시크릿 저장소에서 내려받은 환경 파일을 쓰는 systemd 단위(crawler/agamajung-crawler.service)를 권장한다.
module.exports = {
  apps: [{
    name: 'agamajung-crawler',
    cwd: `${__dirname}/..`,
    script: 'crawler/index.ts',
    interpreter: 'node',
    node_args: '--import tsx',
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '1G',
    min_uptime: '2m',
    // 재시작도 최소 10분 간격. 차단·챌린지 뒤 무분별한 재시도를 막는다.
    restart_delay: 600000,
    max_restarts: 5,
    stop_exit_codes: [75],
    kill_timeout: 90000,
    time: true,
    out_file: './crawler/logs/pm2-out.log',
    error_file: './crawler/logs/pm2-err.log',
    merge_logs: true,
    env: { NODE_ENV: 'production' },
  }],
};
