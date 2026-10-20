import type { Submission, Subscriber } from "@/lib/types";
import { DomainError } from "@/server/errors";
import type { Sql } from "@/server/sql";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function nullable(value: unknown) {
  if (value == null) return null;
  const stringValue = String(value);
  return stringValue.length ? stringValue : null;
}

function asObject(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function mapSubmission(row: Record<string, unknown>): Submission {
  return {
    id: text(row.id),
    kind: text(row.kind) as Submission["kind"],
    status: text(row.status) as Submission["status"],
    payload: asObject(row.payload),
    contactEmail: nullable(row.contactEmail),
    createdAt: text(row.createdAt),
    reviewedAt: nullable(row.reviewedAt),
  };
}

export async function listSubmissions(sql: Sql) {
  const rows = await sql.query(
    `SELECT id, kind, status, payload, contact_email AS "contactEmail",
            created_at::text AS "createdAt", reviewed_at::text AS "reviewedAt"
     FROM submissions ORDER BY created_at DESC`,
  );
  return rows.map(mapSubmission);
}

export async function createSubmission(
  sql: Sql,
  input: { kind: "group_buy" | "tip"; payload: Record<string, unknown>; contactEmail: string | null },
) {
  const id = crypto.randomUUID();
  await sql.query(
    `INSERT INTO submissions (id, kind, status, payload, contact_email) VALUES ($1, $2, 'pending', $3::jsonb, $4)`,
    [id, input.kind, JSON.stringify(input.payload), input.contactEmail],
  );
  const rows = await sql.query(
    `SELECT id, kind, status, payload, contact_email AS "contactEmail",
            created_at::text AS "createdAt", reviewed_at::text AS "reviewedAt"
     FROM submissions WHERE id = $1`,
    [id],
  );
  return mapSubmission(rows[0]);
}

export async function reviewSubmission(sql: Sql, id: string, status: Submission["status"]) {
  const rows = await sql.query(
    `UPDATE submissions SET status = $2, reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
     WHERE id = $1
     RETURNING id, kind, status, payload, contact_email AS "contactEmail",
               created_at::text AS "createdAt", reviewed_at::text AS "reviewedAt"`,
    [id, status],
  );
  if (!rows[0]) throw new DomainError(404, "not_found", "제보를 찾을 수 없습니다.");
  return mapSubmission(rows[0]);
}

export async function listSubscribers(sql: Sql): Promise<Subscriber[]> {
  const rows = await sql.query(
    `SELECT id, email, source, created_at::text AS "createdAt" FROM newsletter_subscribers ORDER BY created_at DESC`,
  );
  return rows.map((row) => ({
    id: text(row.id),
    email: text(row.email),
    source: text(row.source),
    createdAt: text(row.createdAt),
  }));
}

export async function subscribeNewsletter(sql: Sql, input: { email: string; source?: string }) {
  const email = input.email.toLowerCase();
  const source = input.source?.trim() || "web";
  const existing = await sql.query("SELECT id FROM newsletter_subscribers WHERE email = $1", [email]);
  if (existing.length > 0) return { status: "exists" as const };
  await sql.query("INSERT INTO newsletter_subscribers (id, email, source) VALUES ($1, $2, $3)", [
    crypto.randomUUID(),
    email,
    source,
  ]);
  await forwardNewsletter({ email, source });
  return { status: "created" as const };
}

export async function unsubscribeNewsletter(sql: Sql, email: string) {
  await sql.query("DELETE FROM newsletter_subscribers WHERE email = $1", [email.toLowerCase()]);
  return { status: "removed" as const };
}

async function forwardNewsletter(payload: { email: string; source: string }) {
  const url = process.env.NEWSLETTER_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("newsletter webhook failed", error instanceof Error ? error.message : "unknown");
  }
}
