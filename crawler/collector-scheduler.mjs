// PM2 JS entry avoids automatic TypeScript interpreter detection.
import { main, collectorFailure } from './src/local-worker.ts';
main().catch(error=>{console.error(collectorFailure(error));process.exitCode=1;});
