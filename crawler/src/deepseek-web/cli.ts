import { runDeepSeekWeb } from './runner';
export async function deepSeekWebCli(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'once') return runDeepSeekWeb({ mode: 'once', urls: rest.length ? rest : undefined });
  if (command === 'dry-run') return runDeepSeekWeb({ mode: 'dry_run', urls: rest.length ? rest : undefined });
  if (command === 'daemon') {
    const interval = Number(process.env.DEEPSEEK_WEB_DAEMON_MS ?? 600000);
    for (;;) {
      const report = await runDeepSeekWeb({ mode: 'once' });
      console.error(JSON.stringify({ event: 'deepseek_web_tick', ...report }));
      await new Promise(r => setTimeout(r, interval));
    }
  }
  throw new Error('usage: once [url...] | dry-run [url...] | daemon');
}
