import { listBrands } from "@/server/catalog";
import { jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET() {
  return withErrors(async () => jsonOk(await listBrands(await getSql()), undefined, 200, { cors: true }), true);
}
