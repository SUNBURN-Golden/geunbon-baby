export const ROUND_LINK = `LEFT JOIN deal_round_reviews AS rr ON rr.deal_id = d.id AND rr.deal_version = d.version
  LEFT JOIN seller_rounds AS sr ON sr.id = rr.round_id AND sr.seller_id = d.seller_id`;

export const validPublicationProof = (alias: string) => `NOT EXISTS (
  SELECT 1 FROM invalidated_publication_proofs x
  WHERE x.deal_id=${alias}.deal_id AND x.price_evidence_id=${alias}.price_evidence_id
)`;

export const sellerOrdinal = (asOf: string) => `CASE WHEN sr.opened_at <= ${asOf} THEN (
  SELECT COUNT(*) FROM seller_rounds AS r
  WHERE r.seller_id = sr.seller_id AND (r.opened_at, r.id) <= (sr.opened_at, sr.id)
  AND EXISTS (
    SELECT 1 FROM deal_round_reviews evidence
    JOIN deals published ON published.id=evidence.deal_id AND published.status='published'
      AND published.seller_id=r.seller_id
    JOIN deal_price_history h ON h.deal_id=evidence.deal_id AND h.deal_version=evidence.deal_version
    WHERE evidence.round_id=r.id AND h.published_at <= ${asOf} AND ${validPublicationProof('h')}
  )
) END`;
