import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// One-shot barrier before the transaction mutex. Tests can choose either winner.
export function batchGate(count: number, order = Array.from({ length: count }, (_, i) => i)) {
  if (count < 1 || order.length !== count || new Set(order).size !== count || order.some(i => i < 0 || i >= count)) throw new Error('invalid gate');
  let firstArrived!: () => void;
  let arrived!: () => void;
  const waiting: (() => void)[] = [];
  return {
    order,
    firstArrived: new Promise<void>(resolve => { firstArrived = resolve; }),
    arrived: new Promise<void>(resolve => { arrived = resolve; }),
    wait() {
      if (waiting.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => {
        waiting.push(resolve);
        if (waiting.length === 1) firstArrived();
        if (waiting.length === count) {
          arrived();
          queueMicrotask(() => { for (const index of order) waiting[index](); });
        }
      });
    },
  };
}
type MemoryOptions = { serialize?: boolean; gate?: ReturnType<typeof batchGate>; failAfter?: { batch: number; statement: number } };
// Exercise real migrations/SQL entirely in memory, with no Miniflare HTTP listener.
export function memoryD1(options: MemoryOptions = {}) {
  const sqlite = new DatabaseSync(':memory:');
  let tail = Promise.resolve();
  let batches = 0;
  function execute<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!options.serialize) {
      try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); }
    }
    const next = tail.then(fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }
  class Statement {
    constructor(private sql: string, private values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Statement(this.sql, values); }
    async first() { return execute(() => sqlite.prepare(this.sql).get(...this.values) ?? null); }
    async all() { return execute(() => ({ results: sqlite.prepare(this.sql).all(...this.values), success: true })); }
    runRaw() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
    async run() { return execute(() => this.runRaw()); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      const batch = ++batches;
      if (options.gate) await options.gate.wait();
      return execute(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const [index, statement] of statements.entries()) {
            results.push(options.serialize ? statement.runRaw() : await statement.run());
            if (options.failAfter?.batch === batch && options.failAfter.statement === index) throw new Error('Injected transaction failure');
          }
          sqlite.exec('COMMIT');
          return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
    },
  };
  return { db: db as unknown as D1Database, close: () => sqlite.close() };
}
