import { PriceManager } from "@/components/admin/managers";
import { listModels, listPrices } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function PricesAdminPage() {
  await live();
  const sql = await getSql();
  const [prices, models] = await Promise.all([listPrices(sql), listModels(sql)]);
  return (
    <section>
      <h1 className="serif">가격</h1>
      <PriceManager prices={prices} models={models} />
    </section>
  );
}
