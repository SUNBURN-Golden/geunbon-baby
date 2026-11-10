import Link from 'next/link';
import { dealsCopy } from '../../lib/deals-copy';

export type DealPageSearch = { limit?: string | string[]; cursor?: string | string[] };
export function DealPagination({ path, limit, nextCursor, continued }: { path: string; limit: number; nextCursor: string | null; continued: boolean }) {
  const first = `${path}?${new URLSearchParams({ limit: String(limit) })}`;
  return <nav aria-label="공구 목록 페이지">
    {nextCursor && <Link href={`${first}&${new URLSearchParams({ cursor: nextCursor })}`}>{dealsCopy.nextPage}</Link>}
    {continued && <Link href={first}>{dealsCopy.restart}</Link>}
  </nav>;
}
export function InvalidDealPage({ path }: { path: string }) {
  return <div className="notice"><p>{dealsCopy.invalidPage}</p><Link href={path}>{dealsCopy.restart}</Link></div>;
}
