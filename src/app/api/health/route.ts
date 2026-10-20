import { databaseMode, getSql } from "@/server/sql";
import { jsonOk, optionsResponse, withErrors } from "@/server/http";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET() {
  return withErrors(async () => {
    const sql = await getSql();
    await sql.query("SELECT 1 AS ok");
    return jsonOk({ service: "geunbon", database: databaseMode() }, undefined, 200, { cors: true });
  }, true);
}
