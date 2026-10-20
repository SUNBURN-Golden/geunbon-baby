import { isCategory } from "@/lib/labels";
import { listModelCards } from "@/server/catalog";
import { DomainError } from "@/server/errors";
import { jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET(request: Request) {
  return withErrors(async () => {
    const url = new URL(request.url);
    const brand = url.searchParams.get("brand") ?? undefined;
    const category = url.searchParams.get("category") ?? undefined;
    const featuredParam = url.searchParams.get("featured");
    if (category && !isCategory(category)) {
      throw new DomainError(400, "invalid_input", "없는 카테고리입니다.");
    }
    const featured = featuredParam == null ? undefined : featuredParam === "true";
    const models = await listModelCards(await getSql(), { brandSlug: brand, category, featured });
    return jsonOk(models, undefined, 200, { cors: true });
  }, true);
}
