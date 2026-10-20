import { getHome } from "@/server/catalog";
import { jsonOk, optionsResponse, withErrors } from "@/server/http";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return optionsResponse();
}

export function GET() {
  return withErrors(async () => {
    const home = await getHome(await getSql());
    return jsonOk(home, { pricesAreSample: home.sample.allStoredPricesAreSample, notAParty: true }, 200, {
      cors: true,
    });
  }, true);
}
