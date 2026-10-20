import { EventManager } from "@/components/admin/managers";
import { listBrands, listEvents } from "@/server/catalog";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function EventsAdminPage() {
  await live();
  const sql = await getSql();
  const [events, brands] = await Promise.all([listEvents(sql), listBrands(sql)]);
  return (
    <section>
      <h1 className="serif">행사</h1>
      <EventManager events={events} brands={brands} />
    </section>
  );
}
