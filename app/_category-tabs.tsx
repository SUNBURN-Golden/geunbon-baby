import Link from 'next/link';
import { categories } from '../lib/data';

export const selectedCategory = (value?: string) => value && Object.hasOwn(categories, value) ? value : '';

export function CategoryTabs({ category, base = '/', by, brand, q }: {
  category?: string; base?: '/' | '/deals' | '/models'; by?: string; brand?: string; q?: string;
}) {
  const current = selectedCategory(category);
  const href = (key: string) => {
    const params = new URLSearchParams();
    if (key) params.set('category', key);
    if (by === 'brand') params.set('by', by);
    if (brand) params.set('brand', brand);
    if (q) params.set('q', q);
    return `${base}${params.size ? `?${params}` : ''}`;
  };
  return <nav className="category-tabs" aria-label="종류">
    <Link href={href('')} aria-current={current === '' ? 'page' : undefined}>모든 종류</Link>
    {['stroller', 'high_chair', 'carrier', 'bouncer', 'car_seat'].map(key =>
      <Link key={key} href={href(key)} aria-current={current === key ? 'page' : undefined}>{categories[key]}</Link>)}
  </nav>;
}
