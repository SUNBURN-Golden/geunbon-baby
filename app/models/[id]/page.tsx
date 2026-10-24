import { DEAL_SELECT, type DealWithContext } from '../../../lib/deals';
import { notFound } from 'next/navigation';
import { all, environment } from '../../../lib/db';
import { categories, displayableOfficialPrice, money, verificationLabel, type Model } from '../../../lib/data';
import { siteCopy } from '../../../lib/site-copy';
import { dealsCopy } from '../../../lib/deals-copy';
import { DealList } from '../../deals/_components';
export const dynamic = 'force-dynamic';
export default async function Detail({ params }: { params: Promise<{ id: string }> }) {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const { id } = await params; const db = environment().DB;
  const m = await db.prepare('SELECT * FROM models WHERE id = ?').bind(id).first<Model>();
  if (!m) notFound();
  const deals = await all<DealWithContext>(db, `${DEAL_SELECT} AND d.model_id = ? ORDER BY d.starts_at, d.id`, id);
  return (
    <main className="page">
      <p className="eyebrow">{m.brand} / {categories[m.category]}</p>
      <h1>{m.name}</h1>
      <p className="lead">{siteCopy.modelLead}</p>
      <div className="notice">{siteCopy.comparisonNotice}</div>
      <div className="comparison">
        <section>
          <p className="eyebrow">01 / GROUP BUY</p>
          <h2>{dealsCopy.groupBuyPrice}</h2>
          {deals.length ? <DealList deals={deals} nowMs={nowMs} /> : <p>{dealsCopy.modelEmpty}</p>}
        </section>
        <section>
          <p className="eyebrow">02 / OFFICIAL</p>
          <h2>{siteCopy.officialPrice}</h2>
          <h3>{money(displayableOfficialPrice(m))}</h3>
          <p>{m.importer}</p>
          <p className="muted">{m.checked} · {verificationLabel(m.verify_level)}</p>
          {m.source_url && <a href={m.source_url} target="_blank" rel="noopener noreferrer">{siteCopy.officialSource}</a>}
          <p className="muted">{siteCopy.officialSourceNotice}</p>
        </section>
      </div>
    </main>
  );
}
