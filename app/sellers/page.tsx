import { all, environment } from '../../lib/db';
import { sellerAnchor, type Seller } from '../../lib/data';
export const dynamic = 'force-dynamic';
export default async function Sellers() {
  const sellers = await all<Seller>(environment().DB, 'SELECT * FROM sellers ORDER BY name');
  return <main className="page public-page"><p className="eyebrow">TRUST, WITH EVIDENCE</p><h1>판매자 안내</h1><p className="lead">신뢰에는 확인할 수 있는 근거가 필요하니까.</p><div className="notice">초기 시드 출처와 관리자가 직접 등록한 판매처입니다. 목록에 있다는 것은 입점·추천·보증을 의미하지 않습니다. 증빙이 없는 배지는 미확인으로 표시합니다.</div>{sellers.length ? sellers.map(s => <article className="seller" key={s.id} id={sellerAnchor(s.id)} tabIndex={-1} aria-labelledby={`${sellerAnchor(s.id)}-name`}><h2 id={`${sellerAnchor(s.id)}-name`}>{s.name}</h2><div className="badges">{[['통신판매업 신고', s.registration_source], ['청약철회 7일', s.withdrawal_source], ['정식수입', s.official_import_source]].map(([label, source]) => source ? <a className="badge verified" key={label} href={source} target="_blank" rel="noopener noreferrer">{label} · 근거 확인 ↗</a> : <span className="badge" key={label}>{label} · 미확인</span>)}</div><a href={s.source_url} target="_blank" rel="noopener noreferrer">판매처 출처 ↗</a></article>) : <div className="empty"><h2>등록된 판매자가 없습니다.</h2></div>}</main>;
}
