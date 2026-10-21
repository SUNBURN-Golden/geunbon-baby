import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
// Exercise real migrations/SQL entirely in memory, with no Miniflare HTTP listener.
export function memoryD1() {
  const sqlite = new DatabaseSync(':memory:');
  class Statement {
    constructor(private sql: string, private values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Statement(this.sql, values); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values), success: true }; }
    async run() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db: db as unknown as D1Database, close: () => sqlite.close() };
}
