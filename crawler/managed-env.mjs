import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export const crawlerEnvFile = '/home/box/.secrets/agamajung_crawler.env';

export function readCrawlerEnv(file = crawlerEnvFile) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 64 * 1024) throw new Error();
    const values = Object.create(null);
    for (const line of readFileSync(fd, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const entry = /^([A-Za-z_][A-Za-z0-9_]*)=([^\0]*)$/.exec(line);
      if (!entry) throw new Error();
      values[entry[1]] = entry[2];
    }
    return values;
  } catch {
    throw new Error('crawler_env_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function loadCrawlerEnv(file = crawlerEnvFile, { requireCollectorDb = false } = {}) {
  const values = readCrawlerEnv(file);
  if (requireCollectorDb && !values.COLLECTOR_DB) throw new Error('collector_db_required');
  Object.assign(process.env, values);
}
