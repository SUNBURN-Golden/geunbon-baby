import { notFound } from 'next/navigation';
import { environment } from '../../../lib/db';
import { bundleItemsForDeal } from '../../../lib/deal-bundles';
import { dealSelect, type DealWithContext } from '../../../lib/deals';
import { DealDetail } from '../_components';

export const dynamic = 'force-dynamic';

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const { id } = await params;
  const deal = await environment().DB.prepare(`${dealSelect(nowMs)} AND d.id = ?`).bind(id).first<DealWithContext>();
  if (!deal) notFound();
  const bundleItems = await bundleItemsForDeal(environment().DB, deal.id);
  return <DealDetail deal={deal} nowMs={nowMs} bundleItems={bundleItems} />;
}
