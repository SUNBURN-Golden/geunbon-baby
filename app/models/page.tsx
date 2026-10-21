import Link from 'next/link';
import { all, environment } from '../../lib/db';
import { categories, money, type Model } from '../../lib/data';
export const dynamic = 'force-dynamic';
export default async function Models({ searchParams }: { searchParams: Promise<{ category?: string; brand?: string; q?: string; by?: string }> }) {
  const filter = await searchParams;
  const models = await all<Model>(environment().DB, 'SELECT * FROM models ORDER BY rowid');
  const selected = models.filter(m => (!filter.category || m.category === filter.category) && (!filter.brand || m.brand === filter.brand) && (!filter.q || `${m.brand} ${m.name}`.toLowerCase().includes(filter.q.toLowerCase())));
  if (filter.by === 'brand') selected.sort((a, b) => a.brand.localeCompare(b.brand));
  return <main className="page"><p className="eyebrow">THE ESSENTIAL COLLECTION</p><h1>오래 곁에 둘 대표작</h1><p className="lead">작은 일상을 든든하게 채울, 신중한 선택.</p><form className="filters">{filter.by === 'brand' && <input type="hidden" name="by" value="brand"/>}<label>종류<select name="category" defaultValue={filter.category ?? ''}><option value="">모든 종류</option>{Object.entries(categories).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>브랜드<select name="brand" defaultValue={filter.brand ?? ''}><option value="">모든 브랜드</option>{[...new Set(models.map(m => m.brand))].map(b => <option key={b}>{b}</option>)}</select></label><label>검색<input name="q" placeholder="브랜드 또는 모델명" defaultValue={filter.q}/></label><button>찾아보기</button></form><p className="muted">{selected.length}개의 선택 · 가격은 확인일 기준</p><div className="model-grid">{selected.map((m, i) => <Link className="model-card" key={m.id} href={`/models/${m.id}`}><div className={`product-mark tone-${i % 3}`}><span>{categories[m.category]}</span><strong>{m.brand}</strong><small>ESSENTIAL / {m.id.replace('model-', '').padStart(2, '0')}</small></div><p className="eyebrow">{m.brand}</p><h2>{m.name}</h2><p>공식가 <strong>{money(m.official_price)}</strong></p><small className="muted">{m.checked} 확인 · 구성 및 출처 보기 ↗</small></Link>)}</div>{!selected.length && <div className="empty">조건에 맞는 모델이 없습니다. 다른 조건으로 살펴봐 주세요.</div>}</main>;
}
