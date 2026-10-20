import { listEvents } from "@/server/catalog";
import { jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET() {
  return withErrors(async () => {
    const events = await listEvents(await getSql());
    return jsonOk(events, { pricesAreSample: events.every((event) => event.isSample) }, 200, { cors: true });
  }, true);
}
