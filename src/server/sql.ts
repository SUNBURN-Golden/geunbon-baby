import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { seedIfEmpty } from "@/server/seed";

export type Sql = {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
};

type Queryable = {
  unsafe: (text: string, params?: readonly unknown[]) => Promise<unknown[]>;
  begin?: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;
};

const globalForSql = globalThis as unknown as { geunbonSql?: Promise<Sql>; geunbonMode?: DatabaseMode };

let testSql: Sql | null = null;

export type DatabaseMode = "postgres" | "pglite-file" | "pglite-memory";

export function databaseMode(): DatabaseMode {
  if (process.env.DATABASE_URL) return "postgres";
  if (process.env.GEUNBON_DATA_DIR) return "pglite-file";
  return "pglite-memory";
}

export function setSqlForTests(sql: Sql | null) {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("setSqlForTests is only available in tests");
  }
  testSql = sql;
}

export function getSql() {
  if (testSql) return Promise.resolve(testSql);
  if (!globalForSql.geunbonSql) {
    globalForSql.geunbonMode = databaseMode();
    globalForSql.geunbonSql = openSql();
  }
  return globalForSql.geunbonSql;
}

export async function createMemoryDatabase() {
  const sql = adaptPglite(new PGlite());
  await migrate(sql);
  await seedIfEmpty(sql);
  return sql;
}

async function openSql() {
  const sql = process.env.DATABASE_URL ? openPostgres(process.env.DATABASE_URL) : await openPglite();
  await migrate(sql);
  await seedIfEmpty(sql);
  return sql;
}

function openPostgres(url: string) {
  const client = postgres(url, {
    max: 5,
    prepare: false,
    ssl: url.includes("supabase.co") ? "require" : undefined,
  });
  return adaptPostgres(client as unknown as Queryable);
}

async function openPglite() {
  const directory = process.env.GEUNBON_DATA_DIR;
  const client = directory ? new PGlite(directory) : new PGlite();
  return adaptPglite(client);
}

function adaptPostgres(client: Queryable): Sql {
  return {
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const rows = await client.unsafe(text, params);
      return rows as T[];
    },
    async exec(text) {
      await client.unsafe(text);
    },
    async transaction(fn) {
      if (!client.begin) throw new Error("transaction is unavailable");
      return client.begin(async (tx) => fn(adaptPostgres(tx)));
    },
  };
}

function adaptPglite(client: PGlite): Sql {
  return {
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const result = await client.query(text, params as never[]);
      return result.rows as T[];
    },
    async exec(text) {
      await client.exec(text);
    },
    async transaction(fn) {
      await client.exec("BEGIN");
      try {
        const value = await fn(adaptPglite(client));
        await client.exec("COMMIT");
        return value;
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export async function migrate(sql: Sql) {
  const file = path.join(process.cwd(), "db/migrations/001_init.sql");
  const text = readFileSync(file, "utf8");
  await sql.exec(text);
}

export async function resetDatabase(sql?: Sql) {
  const database = sql ?? (await getSql());
  await database.exec(
    "TRUNCATE newsletter_subscribers, submissions, brand_events, group_buys, price_quotes, models, brands RESTART IDENTITY CASCADE",
  );
  await seedIfEmpty(database);
}
