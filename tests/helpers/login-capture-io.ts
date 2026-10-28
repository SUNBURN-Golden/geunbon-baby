import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

export const captureRoot = '/login-capture-fixture';
export const captureFile = join(captureRoot, '.session/state.json');

function gate() {
  let arrived!: (path: string) => void;
  let release!: () => void;
  const reached = new Promise<string>(resolve => { arrived = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, async wait(path: string) { arrived(path); await released; } };
}

// This file-system double belongs only to crawler-login-capture.test.ts.
// Keep real session/health logic, but never touch disk or yield to OS I/O.
class LoginCaptureIO {
  private db!: DatabaseSync;
  private gates: { operation: 'close' | 'unlink'; gate: ReturnType<typeof gate> }[] = [];
  unexpected: string[] = [];
  operations: { operation: string; path: string }[] = [];

  reset() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE entries (path TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)');
    this.put(captureRoot, 'directory');
    // health keeps its log path between tests and flushes it before reinitializing.
    this.put(join(captureRoot, 'logs'), 'directory');
    this.gates = [];
    this.unexpected = [];
    this.operations = [];
  }
  close() {
    for (const item of this.gates) item.gate.release();
    this.db.close();
  }
  holdNext(operation: 'close' | 'unlink') {
    const barrier = gate();
    this.gates.push({ operation, gate: barrier });
    return barrier;
  }
  private async boundary(operation: 'close' | 'unlink', path: string) {
    this.operations.push({ operation, path });
    const index = this.gates.findIndex(item => item.operation === operation);
    if (index >= 0) await this.gates.splice(index, 1)[0].gate.wait(path);
  }
  private fail(message: string): never {
    this.unexpected.push(message);
    throw new Error(message);
  }
  private allow(path: string) {
    if (![captureRoot, join(captureRoot, '.session'), join(captureRoot, 'logs'), captureFile,
      join(captureRoot, 'logs/summary.json'), join(captureRoot, 'logs/summary.json.tmp')].includes(path) &&
      !/^\/login-capture-fixture\/\.session\/\.state-[a-f0-9-]+\.tmp$/.test(path) &&
      !/^\/login-capture-fixture\/logs\/health-\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) this.fail('Unexpected capture I/O path');
  }
  private entry(path: string) {
    this.allow(path);
    return this.db.prepare('SELECT kind, body FROM entries WHERE path=?').get(path) as { kind: string; body: string } | undefined;
  }
  private put(path: string, kind: 'file' | 'directory', body = '') {
    this.allow(path);
    this.db.prepare('INSERT OR REPLACE INTO entries VALUES (?, ?, ?)').run(path, kind, body);
  }
  read(path: string) {
    const entry = this.entry(path);
    if (entry?.kind !== 'file') return this.fail('Expected capture file');
    return entry.body;
  }
  files(directory: string) {
    this.allow(directory);
    return (this.db.prepare("SELECT path FROM entries WHERE kind='file' ORDER BY path").all() as { path: string }[])
      .map(row => row.path).filter(path => dirname(path) === directory);
  }
  seed(body: string) {
    this.put(dirname(captureFile), 'directory');
    this.put(captureFile, 'file', body);
  }
  private write(path: string, body: string) {
    if (this.entry(dirname(path))?.kind !== 'directory') this.fail('Missing capture directory');
    this.put(path, 'file', body);
  }
  readonly fs = {
    mkdir: async (path: string) => { this.put(path, 'directory'); },
    chmod: async (path: string) => { if (!this.entry(path)) this.fail('Missing chmod target'); },
    readFile: async (path: string, encoding: string) => {
      if (encoding !== 'utf8') this.fail('Unexpected capture encoding');
      return this.read(path);
    },
    writeFile: async (path: string, body: string) => { this.write(path, body); },
    appendFile: async (path: string, body: string) => { this.write(path, (this.entry(path)?.body ?? '') + body); },
    open: async (path: string, flags: string, mode: number) => {
      if (flags !== 'wx' || mode !== 0o600 || this.entry(path)) this.fail('Unexpected capture open');
      this.write(path, '');
      let synced = false;
      let closed = false;
      return {
        writeFile: async (body: string) => {
          if (closed) this.fail('Write after close');
          this.write(path, body);
        },
        sync: async () => { synced = true; },
        close: async () => {
          if (!synced || closed) this.fail('Invalid capture close');
          closed = true;
          await this.boundary('close', path);
        },
      };
    },
    rename: async (source: string, target: string) => {
      this.write(target, this.read(source));
      this.db.prepare('DELETE FROM entries WHERE path=?').run(source);
      this.operations.push({ operation: 'rename', path: target });
    },
    unlink: async (path: string) => {
      if (!this.entry(path)) throw Object.assign(new Error('Missing temporary file'), { code: 'ENOENT' });
      this.db.prepare('DELETE FROM entries WHERE path=?').run(path);
      await this.boundary('unlink', path);
    },
  };
}

export const captureIO = new LoginCaptureIO();
