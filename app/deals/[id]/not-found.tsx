import Link from 'next/link';
import { dealsCopy } from '../../../lib/deals-copy';

export default function DealNotFound() {
  return (
    <main className="page deals-page">
      <h1>{dealsCopy.missing}</h1>
      <Link className="deal-back" href="/deals">{dealsCopy.back}</Link>
    </main>
  );
}
