import { environment } from '../../lib/db';
import { publicActiveDeals } from '../../lib/deals';
import { dealsCopy } from '../../lib/deals-copy';
import { dealUrl, siteOrigin, xml, xmlResponse } from '../../lib/public-xml';

export const dynamic = 'force-dynamic';

export async function GET() {
  const deals = await publicActiveDeals(environment().DB, Date.now());
  const items = deals.map(deal => {
    const url = xml(dealUrl(deal.id));
    return `<item><title>${xml(deal.title)}</title><link>${url}</link><guid>${url}</guid></item>`;
  }).join('');
  return xmlResponse(`<rss version="2.0"><channel><title>${xml(dealsCopy.title)}</title><description>${xml(dealsCopy.activeHeading)}</description><link>${siteOrigin}/deals</link>${items}</channel></rss>`, 'application/rss+xml');
}
