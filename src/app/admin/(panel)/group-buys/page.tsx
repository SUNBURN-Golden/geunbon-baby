import { GroupBuyManager } from "@/components/admin/managers";
import { listGroupBuys, listModels } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function GroupBuysAdminPage() {
  await live();
  const sql = await getSql();
  const [listings, models] = await Promise.all([listGroupBuys(sql), listModels(sql)]);
  return (
    <section>
      <h1 className="serif">공구</h1>
      <GroupBuyManager listings={listings} models={models} />
    </section>
  );
}
