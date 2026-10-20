import { newsletterSchema } from "@/lib/schemas";
import { subscribeNewsletter, unsubscribeNewsletter } from "@/server/inbox";
import { jsonOk, optionsResponse, readJson, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function POST(request: Request) {
  return withErrors(async () => {
    const parsed = newsletterSchema.parse(await readJson(request));
    if (parsed.company.trim()) {
      return jsonOk({ status: parsed.unsubscribe ? "removed" : "created" }, undefined, 200, { cors: true });
    }
    const sql = await getSql();
    const result = parsed.unsubscribe
      ? await unsubscribeNewsletter(sql, parsed.email)
      : await subscribeNewsletter(sql, { email: parsed.email, source: parsed.source });
    return jsonOk(result, undefined, result.status === "created" ? 201 : 200, { cors: true });
  }, true);
}
