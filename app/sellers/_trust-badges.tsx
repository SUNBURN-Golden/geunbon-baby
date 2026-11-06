type SellerEvidence = {
  registration_source: string | null;
  withdrawal_source: string | null;
  official_import_source: string | null;
};

export function SellerTrustBadges({ registration_source, withdrawal_source, official_import_source }: SellerEvidence) {
  const evidence = [
    ['통신판매업 신고', registration_source],
    ['청약철회 7일', withdrawal_source],
    ['정식수입', official_import_source],
  ] as const;

  return (
    <div className="badges">
      {evidence.map(([label, source]) => source?.trim()
        ? <a className="badge verified" key={label} href={source} target="_blank" rel="noopener noreferrer">{label} · 근거 확인 ↗</a>
        : <span className="badge" key={label}>{label} · 미확인</span>)}
    </div>
  );
}
