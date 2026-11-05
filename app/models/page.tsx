import { PUBLISHED_DEALS } from '../../lib/deals';
import { siteCopy } from '../../lib/site-copy';
import { all, environment } from '../../lib/db';
import { categories, type Deal, type Model } from '../../lib/data';
import { buildModelCards } from '../../lib/model-cards';
import { ModelCard } from './_card';
export const dynamic = 'force-dynamic';
export default async function Models({ searchParams }: { searchParams: Promise<{ category?: string; brand?: string; q?: string; by?: string }> }) {
  const filter = await searchParams;
  const models = await all<Model>(environment().DB, 'SELECT * FROM models ORDER BY rowid');
  const selected = models.filter(m => (!filter.category || m.category === filter.category) && (!filter.brand || m.brand === filter.brand) && (!filter.q || `${m.brand} ${m.name}`.toLowerCase().includes(filter.q.toLowerCase())));
  if (filter.by === 'brand') selected.sort((a, b) => a.brand.localeCompare(b.brand));
  const deals = await all<Deal>(environment().DB, PUBLISHED_DEALS);
  // eslint-disable-next-line react-hooks/purity -- Dynamic Server Component captures request time once for all deal statuses.
  const nowMs = Date.now();
  const cards = buildModelCards(selected, deals, nowMs);
  return <main className="page public-page"><h1>{siteCopy.modelsTitle}</h1><p className="lead">{siteCopy.modelsLead}</p><form className="filters">{filter.by === 'brand' && <input type="hidden" name="by" value="brand"/>}<label>종류<select name="category" defaultValue={filter.category ?? ''}><option value="">모든 종류</option>{Object.entries(categories).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>브랜드<select name="brand" defaultValue={filter.brand ?? ''}><option value="">모든 브랜드</option>{[...new Set(models.map(m => m.brand))].map(b => <option key={b}>{b}</option>)}</select></label><label>검색<input name="q" placeholder="브랜드 또는 모델명" defaultValue={filter.q}/></label><button>찾아보기</button></form><p className="muted">{siteCopy.modelsCount.replace('{count}', String(selected.length))}</p><div className="model-grid">{cards.map(card => <ModelCard key={card.id} card={card}/>)}</div>{!selected.length && <div className="empty">조건에 맞는 모델이 없습니다. 다른 조건으로 살펴봐 주세요.</div>}</main>;
}
