-- Site-only publication evidence, seller rounds, and alert subscriptions.
ALTER TABLE deals ADD COLUMN published_seller_label TEXT;
UPDATE deals
SET published_seller_label = (
  SELECT COALESCE(NULLIF(trim(c.seller_name), ''),
    '@' || NULLIF(lower(ltrim(trim(c.seller_handle), '@')), ''))
  FROM external_candidates AS c WHERE c.id = deals.external_candidate_id
)
WHERE origin = 'external_web' AND external_candidate_id IS NOT NULL;

CREATE TABLE seller_rounds (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id) CHECK(seller_id NOT GLOB 'ext-*-unknown'),
  event_key TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  UNIQUE(seller_id, event_key)
);
CREATE INDEX seller_round_order ON seller_rounds(seller_id, opened_at, id);
CREATE INDEX seller_round_openings ON seller_rounds(opened_at, id);
CREATE TABLE deal_round_reviews (
  deal_id TEXT NOT NULL REFERENCES deals(id),
  deal_version INTEGER NOT NULL CHECK(deal_version >= 1),
  round_id TEXT NOT NULL REFERENCES seller_rounds(id),
  source_url TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY(deal_id, deal_version)
);
CREATE INDEX deal_round_evidence ON deal_round_reviews(round_id, deal_id, deal_version);

CREATE INDEX published_unmatched_deal_brands ON deals(brand_label, id)
  WHERE status = 'published' AND model_id IS NULL AND brand_label IS NOT NULL;
CREATE INDEX unmatched_bundle_brands ON deal_bundle_items(brand, deal_id)
  WHERE model_id IS NULL AND brand IS NOT NULL;

CREATE TABLE alert_subscriptions (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model_id TEXT REFERENCES models(id),
  seller_id TEXT REFERENCES sellers(id),
  CHECK((model_id IS NULL) <> (seller_id IS NULL))
);
CREATE UNIQUE INDEX model_alert_email ON alert_subscriptions(model_id, email_key) WHERE model_id IS NOT NULL;
CREATE UNIQUE INDEX seller_alert_email ON alert_subscriptions(seller_id, email_key) WHERE seller_id IS NOT NULL;

-- Catalog prices require independent configuration evidence before striking the price.
CREATE TABLE model_official_configurations (
  model_id TEXT PRIMARY KEY REFERENCES models(id),
  configuration_key TEXT NOT NULL CHECK(json_valid(configuration_key)),
  source_url TEXT NOT NULL,
  checked TEXT NOT NULL
);

CREATE TABLE deal_price_history (
  deal_id TEXT NOT NULL,
  deal_version INTEGER NOT NULL,
  price_evidence_id TEXT NOT NULL REFERENCES deal_price_evidence(id),
  deal_price_krw INTEGER NOT NULL CHECK(deal_price_krw >= 0),
  configuration_key TEXT,
  approval_scope TEXT NOT NULL CHECK(json_valid(approval_scope)),
  price_checked_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  opened_at TEXT,
  PRIMARY KEY(deal_id, deal_version, price_evidence_id),
  FOREIGN KEY(deal_id, deal_version) REFERENCES deal_revisions(deal_id, version)
);
CREATE INDEX hook_price_by_configuration ON deal_price_history(configuration_key, deal_price_krw, deal_id, deal_version);

CREATE TABLE invalidated_publication_proofs (
  deal_id TEXT NOT NULL REFERENCES deals(id),
  price_evidence_id TEXT NOT NULL REFERENCES deal_price_evidence(id),
  PRIMARY KEY(deal_id, price_evidence_id)
);

-- An old typed publication can be recovered from its immutable accepted operation
-- and receipt. Other versions need a retained current price projection.
CREATE VIEW hook_publication_evidence AS
WITH accepted AS (
  SELECT r.deal_id, r.version AS deal_version, r.request_id, r.price_evidence_id,
    CASE WHEN o.request_id IS NULL THEN d.deal_price_krw ELSE json_extract(o.price_values,'$.prices[0]') END AS deal_price_krw,
    CASE WHEN o.request_id IS NULL THEN d.price_source_url ELSE json_extract(o.price_values,'$.prices[2]') END AS offer_url,
    CASE WHEN o.request_id IS NULL THEN d.list_price_source_url ELSE json_extract(o.price_values,'$.prices[3]') END AS official_url,
    CASE WHEN o.request_id IS NULL THEN d.price_checked_at ELSE json_extract(o.price_values,'$.prices[4]') END AS price_checked_at,
    COALESCE(o.committed_at,r.created_at) AS published_at,
    json_extract(e.payload,'$.facts.starts_at') AS opened_at,
    COALESCE(json_extract(e.payload,'$.facts.configuration'),
      json_extract(p.body,'$.official_approval.variant.configuration'),
      CASE WHEN json_extract(p.body,'$.offer.readings[0].configuration') IS json_extract(p.body,'$.offer.readings[1].configuration')
        AND json_extract(p.body,'$.offer.readings[0].configuration') IS json_extract(p.body,'$.official.readings[0].configuration')
        AND json_extract(p.body,'$.offer.readings[0].configuration') IS json_extract(p.body,'$.official.readings[1].configuration')
        THEN json_extract(p.body,'$.offer.readings[0].configuration') END) AS configuration,
    p.body
  FROM deal_revisions r
  JOIN deals d ON d.id=r.deal_id
  JOIN ingested_items i ON i.id=r.deal_id AND i.status='approved'
  JOIN deal_price_evidence p ON p.id=r.price_evidence_id AND p.outcome='verified'
  LEFT JOIN verified_offer_operations o ON d.verified_offer_id IS NOT NULL
    AND o.request_id=r.request_id AND o.candidate_id=d.verified_offer_id AND o.deal_id=r.deal_id
    AND o.expected_version+1=r.version AND o.action='promote_verified_offer_v2'
  LEFT JOIN verified_offer_receipts receipt ON receipt.request_id=o.request_id
    AND receipt.deal_id=r.deal_id AND receipt.committed_revision=r.version
  LEFT JOIN verified_offer_evidence e ON e.candidate_id=o.candidate_id
    AND e.revision=o.revision AND e.digest=o.digest AND e.offer_key=o.offer_key
  WHERE r.status='published' AND d.status='published' AND (
    (d.verified_offer_id IS NULL AND r.version=d.version AND p.id=d.price_evidence_id AND d.verified_price_ready=1 AND (
      (p.target_kind='deal' AND p.target_id=d.id AND CAST(p.target_revision AS INTEGER) BETWEEN 1 AND r.version)
      OR (p.target_kind='ingest' AND p.target_id=i.id AND p.target_revision=i.captured_at)
      OR (p.target_kind='candidate' AND p.target_id=d.external_candidate_id
        AND EXISTS (SELECT 1 FROM external_candidates c WHERE c.id=p.target_id AND c.price_revision=p.target_revision))
    )) OR (
      receipt.request_id IS NOT NULL AND p.id=o.request_id AND p.target_kind='deal'
      AND p.target_id=r.deal_id AND p.target_revision=CAST(r.version AS TEXT)
      AND json(p.body)=json(json_extract(e.payload,'$.price_evidence'))
      AND json_extract(e.payload,'$.facts.deal_price_krw')=json_extract(o.price_values,'$.prices[0]')
      AND json_extract(e.payload,'$.facts.price_source_url')=json_extract(o.price_values,'$.prices[2]')
      AND json_extract(e.payload,'$.facts.list_price_source_url')=json_extract(o.price_values,'$.prices[3]')
    )
  )
)
SELECT a.deal_id, a.deal_version, a.request_id, a.price_evidence_id, a.deal_price_krw,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM json_each('["brand","model","generation","option","quantity","bundle"]') f
    WHERE COALESCE(json_type(a.configuration,'$.'||f.value),'')<>'text'
      OR trim(json_extract(a.configuration,'$.'||f.value))=''
  ) THEN json_array(
    lower(trim(json_extract(configuration,'$.brand'))), lower(trim(json_extract(configuration,'$.model'))),
    lower(trim(json_extract(configuration,'$.generation'))), lower(trim(json_extract(configuration,'$.option'))),
    lower(trim(json_extract(configuration,'$.quantity'))), lower(trim(json_extract(configuration,'$.bundle')))
  ) END AS configuration_key,
  scope.value AS approval_scope, a.price_checked_at, a.published_at, a.opened_at
FROM accepted a JOIN official_price_approvals approval ON approval.id=1
JOIN json_each(approval.scopes) scope
WHERE a.deal_price_krw >= 0
  AND json_extract(a.body,'$.offer.source.url')=a.offer_url
  AND json_extract(a.body,'$.official.source.url')=a.official_url
  AND json_extract(a.body,'$.official.source.observed_at')=a.price_checked_at
  AND json_extract(scope.value,'$.url')=a.official_url
  AND json_extract(scope.value,'$.id')=json_extract(a.body,'$.official_approval.id')
  AND json_extract(scope.value,'$.revision')=json_extract(a.body,'$.official_approval.revision')
  AND json_extract(scope.value,'$.variant') IS json_extract(a.body,'$.official_approval.variant')
  AND json_extract(scope.value,'$.approved_at')<=a.price_checked_at
  AND a.price_checked_at<json_extract(scope.value,'$.expires_at')
  AND a.price_checked_at<=a.published_at
  AND a.published_at<json_extract(scope.value,'$.expires_at')
  AND a.published_at<strftime('%Y-%m-%dT%H:%M:%fZ',a.price_checked_at,'+86400 seconds');

INSERT INTO deal_price_history
SELECT deal_id,deal_version,price_evidence_id,deal_price_krw,configuration_key,approval_scope,price_checked_at,published_at,opened_at
FROM hook_publication_evidence WHERE true
ON CONFLICT DO NOTHING;

-- Typed closure receipts preserve the preceding proof even though the closure
-- revision has its own receipt and proof row.
CREATE VIEW hook_invalidated_price_proofs AS
SELECT o.request_id, p.deal_id, p.price_evidence_id
FROM verified_offer_operations o
JOIN verified_offer_receipts receipt ON receipt.request_id=o.request_id AND receipt.committed_revision=o.expected_version+1
JOIN deal_revisions r ON r.deal_id=receipt.deal_id AND r.version=o.expected_version
LEFT JOIN verified_offer_operations closure ON closure.request_id=r.request_id
  AND closure.deal_id=r.deal_id AND closure.action='close_verified_offer_v2'
JOIN deal_revisions p ON p.deal_id=r.deal_id AND p.version IN (r.version,closure.expected_version)
WHERE o.action='invalidate_verified_offer_v2' AND p.price_evidence_id IS NOT NULL;

INSERT INTO invalidated_publication_proofs
SELECT deal_id,price_evidence_id FROM hook_invalidated_price_proofs WHERE true
ON CONFLICT DO NOTHING;
