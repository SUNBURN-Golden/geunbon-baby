import { SubmissionManager } from "@/components/admin/managers";
import { listSubmissions } from "@/server/inbox";
import { live } from "@/server/live";
import { getSql } from "@/server/sql";

export const dynamic = "force-dynamic";

export default async function SubmissionsAdminPage() {
  await live();
  const submissions = await listSubmissions(await getSql());
  return (
    <section>
      <h1 className="serif">제보</h1>
      <SubmissionManager submissions={submissions} />
    </section>
  );
}
