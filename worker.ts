import nextWorker from './.open-next/worker.js';
import { homepageResponse } from './lib/homepage-response';
export { DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';
const worker = {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return homepageResponse(request, incoming => nextWorker.fetch(incoming, env, ctx));
  },
  async scheduled() {
    console.info('아가마중 cron: 수집은 별도 Linux worker에서 실행합니다.');
  },
};
export default worker;
