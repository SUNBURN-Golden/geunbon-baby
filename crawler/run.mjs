// Start with node --import tsx crawler/run.mjs (also used by pm2).
import { main, handleFailure } from './index.ts';

await main().catch(handleFailure);
