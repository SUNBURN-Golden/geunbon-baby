import { deepSeekWebCli } from '../src/deepseek-web/cli.ts';
const command = process.argv[2] ?? 'dry-run';
deepSeekWebCli([command, ...process.argv.slice(3)]).then(report => {
  console.log(JSON.stringify(report, null, 2));
}).catch(err => {
  console.error(err instanceof Error ? err.message : 'deepseek_web_failed');
  process.exitCode = 1;
});
