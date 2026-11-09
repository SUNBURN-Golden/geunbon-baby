import { all, environment } from '../../lib/db';
import { sellerAnchor, type Seller } from '../../lib/data';
import { SellerTrustBadges } from './_trust-badges';
export const dynamic = 'force-dynamic';
export default async function Sellers() {
  const sellers = await all<Seller>(environment().DB, 'SELECT * FROM sellers ORDER BY name');
  return <main className="page public-page"><p className="eyebrow">TRUST, WITH EVIDENCE</p><h1>판매자 안내</h1><p className="lead">신뢰에는 확인할 수 있는 근거가 필요하니까.</p><div className="notice">아가마중에 소개된 판매처예요. 여기에 있다고 해서 입점이나 추천, 보증을 뜻하지는 않아요. 따로 확인된 자료가 없으면 미확인으로 보여요.</div>{sellers.length ? sellers.map(s => <article className="seller" key={s.id} id={sellerAnchor(s.id)} tabIndex={-1} aria-labelledby={`${sellerAnchor(s.id)}-name`}><h2 id={`${sellerAnchor(s.id)}-name`}>{s.name}</h2><SellerTrustBadges registration_source={s.registration_source} withdrawal_source={s.withdrawal_source} official_import_source={s.official_import_source} /><a href={s.source_url} target="_blank" rel="noopener noreferrer">판매처 출처 ↗</a></article>) : <div className="empty"><h2>등록된 판매자가 없습니다.</h2></div>}</main>;
}
