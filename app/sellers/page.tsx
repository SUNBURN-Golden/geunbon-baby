import { AlertForm } from '../_alert-form';
import { alertStatus, isPlaceholderSeller, type AlertSearch } from '../../lib/alert-target';
import { all, environment } from '../../lib/db';
import { sellerAnchor, type Seller } from '../../lib/data';
import { SellerTrustBadges } from './_trust-badges';

export const dynamic = 'force-dynamic';

export default async function Sellers({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<AlertSearch> } = {}) {
  const search = await searchParams;
  const sellers = await all<Seller>(environment().DB, "SELECT * FROM sellers ORDER BY name");
  return (
    <main className="page public-page">
      <p className="eyebrow">TRUST, WITH EVIDENCE</p>
      <h1>판매자 안내</h1>
      <p className="lead">신뢰에는 확인할 수 있는 근거가 필요하니까.</p>
      <div className="notice">아가마중에 소개된 판매처예요. 여기에 있다고 해서 입점이나 추천, 보증을 뜻하지는 않아요. 따로 확인된 자료가 없으면 미확인으로 보여요.</div>
      {sellers.length ? sellers.map(seller => {
        const anchor = sellerAnchor(seller.id);
        return (
          <article className="seller" key={seller.id} id={anchor} tabIndex={-1} aria-labelledby={`${anchor}-name`}>
            <h2 id={`${anchor}-name`}>{seller.name}</h2>
            <SellerTrustBadges registration_source={seller.registration_source} withdrawal_source={seller.withdrawal_source} official_import_source={seller.official_import_source} />
            <a href={seller.source_url} target="_blank" rel="noopener noreferrer">판매처 출처 ↗</a>
            {!isPlaceholderSeller(seller.id) && <AlertForm type="seller" id={seller.id} initialStatus={search.alert_seller === seller.id ? alertStatus(search.alert) : undefined} />}
          </article>
        );
      }) : <div className="empty"><h2>등록된 판매자가 없습니다.</h2></div>}
    </main>
  );
}
