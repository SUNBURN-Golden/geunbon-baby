import { notFound } from 'next/navigation';
import Link from 'next/link';
import { sellersCopy as copy } from '../../../lib/copy/sellers.ko';
import { environment } from '../../../lib/db';
import { formatDealDate, historySelection, modelPriceHistory, publicPageParams, PublicDealPaginationError,
  roundHref, selectedHistoryConfiguration, sellerCampaignPage, sellerHref, sellerProfile } from '../../../lib/deals';
import { DealList } from '../../deals/_components';
import { InvalidDealPage } from '../../deals/_pagination';
import { OfficialSellerBadges } from '../_official';
import { PriceHistory } from '../_price-history';
import { SellerTrustBadges } from '../_trust-badges';
import { ConfigurationSelector } from '../_configuration';

export const dynamic = 'force-dynamic';
export default async function SellerPage({ params, searchParams }: {
  params: Promise<{ handle: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ handle }, query] = await Promise.all([params,searchParams]);
  const db = environment().DB;
  // eslint-disable-next-line react-hooks/purity -- Evaluate server data at a single request instant.
  const now = Date.now();
  const profile = await sellerProfile(db, handle, now);
  if (!profile) notFound();
  const { seller, first_seen, last_seen, products } = profile;
  const path = sellerHref(seller.handle);
  let selected, campaigns, history;
  try {
    selected = selectedHistoryConfiguration(products,query.configuration);
    [campaigns, history] = await Promise.all([
      sellerCampaignPage(db, seller.id, publicPageParams(query), now),
      selected ? modelPriceHistory(db, selected.model_id, selected.configuration_key,
        publicPageParams({ cursor: query.prices }), now, seller.id, selected.scope) : null,
    ]);
  } catch (error) {
    if (error instanceof PublicDealPaginationError) return <main className="page public-page"><InvalidDealPage path={path} /></main>;
    throw error;
  }
  if (query.round && !campaigns.data.length) notFound();
  const href = (key: string, cursor: string) => {
    const p = new URLSearchParams({ [key]: cursor });
    if (selected) p.set('configuration', historySelection(selected));
    if (key === 'prices' && typeof query.round === 'string') p.set('round',query.round);
    return `${path}?${p}`;
  };
  const date = (value: typeof first_seen) => value ? formatDealDate(value.observed_at, value.precision === 'instant') : copy.unknownDate;
  return <main className="page public-page">
    <h1>{seller.name}</h1>
    <dl className="deal-facts">
      <div><dt>{copy.total}</dt><dd>{profile.total}</dd></div>
      <div><dt>{copy.completed}</dt><dd>{profile.completed}</dd></div>
      <div><dt>{copy.brands}</dt><dd>{profile.brands.join(' · ') || copy.unknown}</dd></div>
      <div><dt>{copy.firstSeen}</dt><dd>{date(first_seen)}</dd></div>
      <div><dt>{copy.lastSeen}</dt><dd>{date(last_seen)}</dd></div>
    </dl>
    <SellerTrustBadges {...seller} />
    <OfficialSellerBadges badges={profile.official_badges} handle={seller.handle} />
    <ConfigurationSelector path={path} options={products} selected={selected} />
    {history && <PriceHistory title={copy.sellerTrend} history={history} seller={seller.id}
      nextHref={history.next_cursor ? href('prices', history.next_cursor) : undefined} />}
    <section><h2>{copy.history}</h2>
      {campaigns.data.length ? campaigns.data.map(round => <section key={round.id}>
        <h3><Link href={roundHref(seller.handle,round.id)}>{round.title}</Link></h3>
        <p><time dateTime={round.starts_at ?? round.sort_at}>{formatDealDate(round.starts_at ?? round.sort_at)}</time>{' · '}
          <a href={round.source_url}>{copy.source}</a></p>
        {round.deals.length > 0 && <DealList deals={round.deals} nowMs={now} />}
      </section>) : <p>{copy.noCampaigns}</p>}
      {(query.cursor || query.round) && <Link href={path}>{copy.startOver}</Link>}
      {campaigns.next_cursor && <Link href={href('cursor', campaigns.next_cursor)}>{copy.next}</Link>}
    </section>
  </main>;
}
