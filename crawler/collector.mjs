import { cli } from './src/cli.ts';
cli(process.argv.slice(2)).then(result=>console.log(result)).catch(()=>{console.error('collector_command_failed');process.exitCode=1;});
