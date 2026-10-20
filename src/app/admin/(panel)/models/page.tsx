import { ModelManager } from "@/components/admin/managers";
import { listBrands, listModels } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function ModelsAdminPage() {
  await live();
  const sql = await getSql();
  const [models, brands] = await Promise.all([listModels(sql), listBrands(sql)]);
  return (
    <section>
      <h1 className="serif">모델</h1>
      <ModelManager models={models} brands={brands} />
    </section>
  );
}
