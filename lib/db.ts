import { getCloudflareContext } from '@opennextjs/cloudflare';
export type Env = {
  DB: D1Database; IMAGES: R2Bucket; ADMIN_TOKEN?: string; INGEST_TOKEN?: string; COLLECTOR_STATUS_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; KAKAO_REST_KEY?: string; KAKAO_CLIENT_SECRET?: string; AUTH_ORIGIN?: string;
};
export function environment(): Env { return getCloudflareContext().env as unknown as Env; }
export async function all<T>(db: D1Database, sql: string, ...values: (string | number)[]) {
  const result = await db.prepare(sql).bind(...values).all<T>();
  return result.results;
}
