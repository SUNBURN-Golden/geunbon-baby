import Link from 'next/link';
import { money } from '../../lib/data';
import { formatDealDate, parseDate, roundHref, sellerHref, type modelPriceHistory, type PricePoint } from '../../lib/deals';
import { sellersCopy as copy } from '../../lib/copy/sellers.ko';

const pointLabel = (p: PricePoint) => formatDealDate(p.observed_at, p.precision === 'instant') ?? copy.unknownDate;
type History = Awaited<ReturnType<typeof modelPriceHistory>>;

export function PriceHistory({ history, nextHref, seller, title = copy.priceTrend }: {
  history: History; nextHref?: string; seller?: string; title?: string;
}) {
  const { sampled, minimum, data, observation_count: count } = history;
  const amounts = sampled.flatMap(p => [p.amount,p.list_amount]);
  const min = amounts.length ? Math.min(...amounts) : 0;
  const max = amounts.length ? Math.max(...amounts) : 0;
  const beginning = sampled[0], ending = sampled.at(-1);
  const left = beginning ? parseDate(beginning.point_time) : 0;
  const right = ending ? parseDate(ending.point_time) : 0;
  const x = (p: PricePoint) => right === left ? 480 : 145 + (parseDate(p.point_time) - left) * 680 / (right - left);
  const y = (amount: number) => max === min ? 124 : 204 - (amount - min) * 176 / (max - min);
  const marker = minimum && (!seller || minimum.seller_id === seller) ? minimum : null;
  return <section className="seller-history-chart">
    <h2>{title}</h2>
    <p>{copy.observationCount(count)}</p>
    {count === 0 && <p>{copy.chartEmpty}</p>}
    {count === 1 && <p>{copy.chartSingle}</p>}
    {sampled.length > 0 && <figure>
      <svg viewBox="0 0 960 268" role="img" aria-label={copy.chartTitle}>
        <line x1="135" x2="840" y1="215" y2="215" stroke="currentColor" opacity=".35" />
        <text x="130" y={y(min) + 5} textAnchor="end">{money(min)}</text>
        {max !== min && <text x="130" y={y(max) + 5} textAnchor="end">{money(max)}</text>}
        <polyline points={sampled.map(p => `${x(p)},${y(p.list_amount)}`).join(' ')} fill="none" stroke="currentColor" strokeDasharray="6 5" opacity=".65" />
        {sampled.map(p => <circle key={p.id} cx={x(p)} cy={y(p.list_amount)} r="3" fill="none" stroke="currentColor" />)}
        <polyline points={sampled.map(p => `${x(p)},${y(p.amount)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="3" />
        {sampled.map(p => <circle key={p.id} cx={x(p)} cy={y(p.amount)} r="4" fill="currentColor" />)}
        {marker && <circle cx={x(marker)} cy={y(marker.amount)} r="9" className="seller-chart-minimum"><title>{copy.lowest} · {money(marker.amount)}</title></circle>}
        {beginning && <text x={right === left ? 480 : 145} y="249" textAnchor={right === left ? 'middle' : 'start'}>{formatDealDate(beginning.observed_at)}</text>}
        {ending && right !== left && <text x="825" y="249" textAnchor="end">{formatDealDate(ending.observed_at)}</text>}
      </svg>
      <figcaption>{copy.chartDescription}</figcaption>
    </figure>}
    {marker && <p><strong>{copy.lowest} · {money(marker.amount)}</strong> · {pointLabel(marker)}{' · '}
      <Link href={sellerHref(marker.handle)}>{marker.seller_name}</Link>{' · '}<Link href={roundHref(marker.handle, marker.campaign_id)}>{copy.lowestSource}</Link>
    </p>}
    {!!data.length && <div className="seller-history-table"><table>
      <caption>{copy.observationTable}</caption>
      <thead><tr><th scope="col">{copy.date}</th><th scope="col">{copy.seller}</th><th scope="col">{copy.price}</th><th scope="col">{copy.listPrice}</th><th scope="col">{copy.deal}</th></tr></thead>
      <tbody>{data.map(point => <tr key={point.id}>
        <td><time dateTime={point.observed_at}>{pointLabel(point)}</time></td>
        <td><Link href={sellerHref(point.handle)}>{point.seller_name}</Link></td><td><a href={point.source_url}>{money(point.amount)}</a></td><td><a href={point.official_url}>{money(point.list_amount)}</a></td>
        <td><Link href={roundHref(point.handle, point.campaign_id)}>{point.title}</Link></td>
      </tr>)}</tbody>
    </table></div>}
    {nextHref && <Link href={nextHref}>{copy.next}</Link>}
  </section>;
}
