// Wrap only the losing request. Reads complete normally; its conditional rejection
// waits before touching SQLite so a real review request can win deterministically.
export function rejectionGate(db: D1Database) {
  let arrived!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  function wrap(statement: D1PreparedStatement, rejection: boolean): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), rejection);
        if (key === 'run' && rejection) return async () => {
          arrived();
          await released;
          return target.run();
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql),
        /UPDATE ingested_items SET status = 'rejected'.*WHERE id = \? AND status = 'pending'/s.test(sql));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, reached, release };
}

export async function reviewSnapshot(db: D1Database, id: string) {
  return {
    item: await db.prepare('SELECT * FROM ingested_items WHERE id = ?').bind(id).first(),
    deal: await db.prepare('SELECT * FROM deals WHERE id = ?').bind(id).first(),
    revisions: (await db.prepare('SELECT * FROM deal_revisions WHERE deal_id = ? ORDER BY version').bind(id).all()).results,
  };
}

export const LOSER_TIME = '2026-11-01T00:00:00.000Z';
export const WINNER_TIME = '2026-11-01T00:00:01.000Z';
