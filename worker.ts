import nextWorker from './.open-next/worker.js';
export { DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';
const worker = {
  fetch: nextWorker.fetch,
  async scheduled() {
    console.info('아가마중 cron: 수집은 별도 Linux worker에서 실행합니다.');
  },
};
export default worker;
