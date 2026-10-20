import { getModelDetail } from "@/server/catalog";
import { jsonError, jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  return withErrors(async () => {
    const { slug } = await context.params;
    const detail = await getModelDetail(await getSql(), slug);
    if (!detail) return jsonError("not_found", "모델을 찾을 수 없습니다.", 404, { cors: true });
    return jsonOk(
      detail,
      { pricesAreSample: detail.allPricesSample, notAParty: true, linkOutOnly: true },
      200,
      { cors: true },
    );
  }, true);
}
