import { BrandManager } from "@/components/admin/managers";
import { listBrands } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function BrandsAdminPage() {
  await live();
  const brands = await listBrands(await getSql());
  return (
    <section>
      <h1 className="serif">브랜드</h1>
      <BrandManager brands={brands} />
    </section>
  );
}
