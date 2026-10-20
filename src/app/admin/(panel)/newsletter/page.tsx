import { SubscriberTable } from "@/components/admin/managers";
import { listSubscribers } from "@/server/inbox";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function NewsletterAdminPage() {
  await live();
  const subscribers = await listSubscribers(await getSql());
  return (
    <section>
      <h1 className="serif">뉴스레터</h1>
      <p className="note">주소만 저장합니다. 발송 도구는 연결하지 않았습니다.</p>
      <SubscriberTable subscribers={subscribers} />
    </section>
  );
}
