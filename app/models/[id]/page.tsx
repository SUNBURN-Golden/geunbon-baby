import { chronologicalDeals, modelDealSummaries, publicDealOptions, publicPageParams, PublicDealPaginationError, type DealWithContext } from '../../../lib/deals';
import { notFound } from 'next/navigation';
import { environment } from '../../../lib/db';
import { categories, displayableOfficialPrice, money, verificationLabel, type Model } from '../../../lib/data';
import { siteCopy } from '../../../lib/site-copy';
import { dealsCopy } from '../../../lib/deals-copy';
import { DealList } from '../../deals/_components';
import { DealPagination, InvalidDealPage, type DealPageSearch } from '../../deals/_pagination';
export const dynamic = 'force-dynamic';
export default async function Detail({ params, searchParams = Promise.resolve({}) }: { params: Promise<{ id: string }>; searchParams?: Promise<DealPageSearch> }) {
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const { id } = await params; const db = environment().DB;
  let options;
  const path = `/models/${encodeURIComponent(id)}`;
  try { options = publicDealOptions(publicPageParams(await searchParams), 'page-model', id); }
  catch (error) { if (error instanceof PublicDealPaginationError) return <main className="page public-page"><InvalidDealPage path={path} /></main>; throw error; }
  const m = await db.prepare('SELECT * FROM models WHERE id = ?').bind(id).first<Model>();
  if (!m) notFound();
  const [page, summaries] = await Promise.all([chronologicalDeals<DealWithContext>(db, options, true, nowMs), modelDealSummaries(db, [id], nowMs)]);
  const current = summaries.get(id)!;
  return (
    <main className="page public-page">
      <p className="eyebrow">{`${m.brand} / ${categories[m.category]}`}</p>
      <h1>{m.name}</h1>
      <p className="lead">{siteCopy.modelLead}</p>
      <div className="notice">{siteCopy.comparisonNotice}</div>
      <div className="comparison">
        <section>
          <p className="eyebrow">01 / GROUP BUY</p>
          <h2>{dealsCopy.groupBuyPrice}</h2>
          <p>{dealsCopy.currentPrice}: {current.active_count ? money(current.lowest_price) : dealsCopy.noActive}</p>
          {page.data.length ? <DealList deals={page.data} nowMs={nowMs} /> : <p>{options.cursor ? dealsCopy.emptyPosition : dealsCopy.modelEmpty}</p>}
          <DealPagination path={path} limit={options.limit} nextCursor={page.next_cursor} continued={!!options.cursor} />
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
