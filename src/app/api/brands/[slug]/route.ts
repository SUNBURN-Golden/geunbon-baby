import { getBrandBySlug } from "@/server/catalog";
import { jsonError, jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  return withErrors(async () => {
    const { slug } = await context.params;
    const brand = await getBrandBySlug(await getSql(), slug);
    if (!brand) return jsonError("not_found", "브랜드를 찾을 수 없습니다.", 404, { cors: true });
    return jsonOk(brand, undefined, 200, { cors: true });
  }, true);
}
