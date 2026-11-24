import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorStore } from '../../crawler/src/store';

export function temporaryOfferStore(clock: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'verified-offers-'));
  const path = join(dir, 'collector.sqlite');
  let store = new CollectorStore(path, undefined, clock);
  return { dir, get store() { return store; },
    reopen() { store.close(); store = new CollectorStore(path, undefined, clock); },
    close() { store.close(); rmSync(dir, { force: true, recursive: true }); },
  };
}
