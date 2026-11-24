import { environment } from '../../lib/db';
import { publicDealIds } from '../../lib/deals';
import { dealUrl, siteOrigin, xml, xmlResponse } from '../../lib/public-xml';

export const dynamic = 'force-dynamic';

export async function GET() {
  const deals = await publicDealIds(environment().DB);
  const urls = [siteOrigin, ...['/deals', '/models', '/calendar', '/sellers'].map(path => siteOrigin + path), ...deals.map(deal => dealUrl(deal.id))];
  return xmlResponse(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${xml(url)}</loc></url>`).join('')}</urlset>`, 'application/xml');
}
