import { isStatus, type WindowStatus } from "@/lib/labels";
import { listGroupBuys } from "@/server/catalog";
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
    const rawStatus = url.searchParams.get("status") ?? undefined;
    const month = url.searchParams.get("month") ?? undefined;
    const on = url.searchParams.get("on") ?? undefined;
    if (rawStatus && !isStatus(rawStatus)) throw new DomainError(400, "invalid_input", "없는 상태입니다.");
    const status: WindowStatus | undefined = rawStatus && isStatus(rawStatus) ? rawStatus : undefined;
    const listings = await listGroupBuys(await getSql(), { status, month, on });
    const pricesAreSample = listings.every((item) => item.isSample);
    return jsonOk(listings, { pricesAreSample, notAParty: true }, 200, { cors: true });
  }, true);
}
