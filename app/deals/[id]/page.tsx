import { notFound } from 'next/navigation';
import { environment } from '../../../lib/db';
import { DEAL_SELECT, type DealWithContext } from '../../../lib/deals';
import { DealDetail } from '../_components';

export const dynamic = 'force-dynamic';

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const { id } = await params;
  const deal = await environment().DB.prepare(`${DEAL_SELECT} WHERE d.id = ?`).bind(id).first<DealWithContext>();
  if (!deal) notFound();
  return <DealDetail deal={deal} nowMs={nowMs} />;
}
