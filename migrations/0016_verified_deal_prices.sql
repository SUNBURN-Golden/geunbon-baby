-- Site D1. Snapshot dependent rows before removing parents, including cascade children.
-- The migration runs with foreign keys enabled and uses persistent staging tables within
-- the migration transaction. Stage names are removed before creating the indexes.

CREATE TABLE stage_0016_ingested_items AS SELECT id, source_url, account, text, kind, captured_at, status, reviewed_at, suggestions, image_url, attribution, attribution_note FROM ingested_items;

CREATE TABLE stage_0016_deals AS SELECT id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url, status, version, updated_at, withdrawn_at, origin, external_candidate_id, source_host, source_ended, brand_label, category_label, promoted_by, promoted_at FROM deals;

CREATE TABLE stage_0016_deal_revisions AS SELECT id, deal_id, version, action, request_id, request_hash, reason, model_id, seller_id, title, price, starts_at, ends_at, image_url, checked, status, created_at FROM deal_revisions;

CREATE TABLE stage_0016_external_candidates AS SELECT id, source, source_url, title, text, seller_handle, seller_name, seller_url, price_hint, price_raw, price_basis, starts_at, ends_at, dates_raw, category, model_match, suggestions, captured_at, last_seen_at, status, reviewed_at, promoted_deal_id FROM external_candidates;

CREATE TABLE stage_0016_deal_bundle_items AS SELECT id, deal_id, position, brand, product_name, model_id, price FROM deal_bundle_items;

CREATE TABLE stage_0016_external_promotions AS SELECT id, candidate_id, deal_id, source_url, promoted_by, promoted_at, request_id FROM external_promotions;

DROP TABLE external_promotions;

DROP TABLE deal_bundle_items;

DROP TABLE external_candidates;

DROP TABLE deal_revisions;

DROP TABLE deals;

DROP TABLE ingested_items;

CREATE TABLE deal_price_evidence (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('ingest','candidate','deal')),
  target_id TEXT NOT NULL,
  target_revision TEXT NOT NULL,
  outcome TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE deal_price_evidence_heads (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_revision TEXT NOT NULL,
  evidence_id TEXT NOT NULL REFERENCES deal_price_evidence(id),
  PRIMARY KEY(target_kind,target_id,target_revision)
);

CREATE TABLE deal_price_backfill_receipts (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  operation_id TEXT NOT NULL
);

CREATE TABLE official_price_approvals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  observed_at TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes))
);

CREATE TABLE ingested_items (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('post','story','external_web','threads_post')),
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_at TEXT,
  suggestions TEXT,
  image_url TEXT,
  attribution TEXT,
  attribution_note TEXT
);

INSERT INTO ingested_items (id, source_url, account, text, kind, captured_at, status, reviewed_at, suggestions, image_url, attribution, attribution_note)
SELECT id, source_url, account, text, kind, captured_at, status, reviewed_at, suggestions, image_url, attribution, attribution_note FROM stage_0016_ingested_items;

DROP TABLE stage_0016_ingested_items;

CREATE TABLE deals (
  id TEXT PRIMARY KEY REFERENCES ingested_items(id),
  model_id TEXT REFERENCES models(id),
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  title TEXT NOT NULL,
  price INTEGER CHECK(price IS NULL OR price >= 0),
  source_url TEXT NOT NULL,
  verify_level TEXT NOT NULL,
  checked TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','withdrawn')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT,
  withdrawn_at TEXT,
  origin TEXT NOT NULL DEFAULT 'instagram' CHECK(origin IN ('instagram','external_web','threads')),
  external_candidate_id TEXT,
  source_host TEXT,
  source_ended INTEGER NOT NULL DEFAULT 0 CHECK(source_ended IN (0,1)),
  brand_label TEXT,
  category_label TEXT,
  promoted_by TEXT,
  promoted_at TEXT,
  deal_price_krw INTEGER CHECK(deal_price_krw IS NULL OR (typeof(deal_price_krw) = 'integer' AND deal_price_krw BETWEEN 0 AND 9007199254740991)),
  list_price_krw INTEGER CHECK(list_price_krw IS NULL OR (typeof(list_price_krw) = 'integer' AND list_price_krw BETWEEN 0 AND 9007199254740991)),
  discount_pct INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN deal_price_krw IS NULL OR list_price_krw IS NULL OR list_price_krw <= 0 THEN NULL
      WHEN deal_price_krw <= list_price_krw THEN (100 * (list_price_krw - deal_price_krw)) / list_price_krw
      ELSE -((100 * (deal_price_krw - list_price_krw) + list_price_krw - 1) / list_price_krw)
    END
  ) VIRTUAL,
  price_source_url TEXT,
  list_price_source_url TEXT,
  price_checked_at TEXT,
  price_verification TEXT NOT NULL DEFAULT 'unverified' CHECK(price_verification IN ('unverified','verified')),
  price_evidence_id TEXT REFERENCES deal_price_evidence(id),
  price_evidence_version INTEGER,
  orders_open INTEGER NOT NULL DEFAULT 0 CHECK(orders_open IN (0,1)),
  price_display_exclusion TEXT GENERATED ALWAYS AS (
    CASE WHEN price_verification = 'verified' THEN
      CASE
        WHEN deal_price_krw = list_price_krw THEN 'equal_price'
        WHEN deal_price_krw > list_price_krw THEN 'above_list'
        WHEN discount_pct = 0 THEN 'discount_below_one_percent'
      END
    END
  ) VIRTUAL,
  verified_start_utc TEXT GENERATED ALWAYS AS (
    CASE WHEN price_verification = 'verified' THEN (CASE WHEN instr(starts_at, char(0)) = 0 AND substr(starts_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(starts_at, 1, 4) || substr(starts_at, 6, 2) || substr(starts_at, 9, 2) || substr(starts_at, 12, 2) || substr(starts_at, 15, 2) || substr(starts_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(starts_at, 1, 10), '+0 days') = substr(starts_at, 1, 10)
    AND CAST(substr(starts_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(starts_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(starts_at, 18, 2) AS INTEGER) <= 59
    AND (substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' OR ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END) END
  ) STORED,
  verified_price_ready INTEGER GENERATED ALWAYS AS (
    CASE WHEN status = 'published' AND price_verification = 'verified'
    AND price_evidence_id IS NOT NULL AND price_evidence_version = version
    AND deal_price_krw >= 0 AND list_price_krw > 0 AND discount_pct > 0
    AND ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', ends_at, '+0 seconds') AND price_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', price_checked_at, '+0 seconds')
    AND price_source_url GLOB 'https://?*' AND list_price_source_url GLOB 'https://?*' THEN 1 ELSE 0 END
  ) STORED,
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

INSERT INTO deals (id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url, status, version, updated_at, withdrawn_at, origin, external_candidate_id, source_host, source_ended, brand_label, category_label, promoted_by, promoted_at)
SELECT id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url, status, version, updated_at, withdrawn_at, origin, external_candidate_id, source_host, source_ended, brand_label, category_label, promoted_by, promoted_at FROM stage_0016_deals;

DROP TABLE stage_0016_deals;

CREATE TABLE deal_revisions (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  action TEXT NOT NULL CHECK(action IN ('publish','correct','withdraw','promote_external','verify_prices')),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT,
  model_id TEXT, seller_id TEXT NOT NULL, title TEXT NOT NULL, price INTEGER CHECK(price IS NULL OR price >= 0),
  starts_at TEXT, ends_at TEXT, image_url TEXT, checked TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','withdrawn')),
  created_at TEXT NOT NULL,
  price_evidence_id TEXT REFERENCES deal_price_evidence(id),
  UNIQUE(deal_id, version),
  UNIQUE(deal_id, request_id)
);

INSERT INTO deal_revisions (id, deal_id, version, action, request_id, request_hash, reason, model_id, seller_id, title, price, starts_at, ends_at, image_url, checked, status, created_at)
SELECT id, deal_id, version, action, request_id, request_hash, reason, model_id, seller_id, title, price, starts_at, ends_at, image_url, checked, status, created_at FROM stage_0016_deal_revisions;

DROP TABLE stage_0016_deal_revisions;

CREATE TABLE external_candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  seller_handle TEXT,
  seller_name TEXT,
  seller_url TEXT,
  price_hint INTEGER CHECK(price_hint IS NULL OR price_hint >= 0),
  price_raw TEXT,
  price_basis TEXT NOT NULL DEFAULT 'external_listing',
  starts_at TEXT,
  ends_at TEXT,
  dates_raw TEXT,
  category TEXT,
  model_match INTEGER NOT NULL DEFAULT 0 CHECK(model_match IN (0,1)),
  suggestions TEXT,
  captured_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','dismissed','promoted')),
  reviewed_at TEXT,
  promoted_deal_id TEXT REFERENCES deals(id),
  price_revision TEXT NOT NULL DEFAULT 'legacy'
);

INSERT INTO external_candidates (id, source, source_url, title, text, seller_handle, seller_name, seller_url, price_hint, price_raw, price_basis, starts_at, ends_at, dates_raw, category, model_match, suggestions, captured_at, last_seen_at, status, reviewed_at, promoted_deal_id)
SELECT id, source, source_url, title, text, seller_handle, seller_name, seller_url, price_hint, price_raw, price_basis, starts_at, ends_at, dates_raw, category, model_match, suggestions, captured_at, last_seen_at, status, reviewed_at, promoted_deal_id FROM stage_0016_external_candidates;

DROP TABLE stage_0016_external_candidates;

CREATE TABLE deal_bundle_items (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  brand TEXT,
  product_name TEXT NOT NULL,
  model_id TEXT REFERENCES models(id),
  price INTEGER CHECK(price IS NULL OR price >= 0),
  UNIQUE(deal_id, position)
);

INSERT INTO deal_bundle_items (id, deal_id, position, brand, product_name, model_id, price)
SELECT id, deal_id, position, brand, product_name, model_id, price FROM stage_0016_deal_bundle_items;

DROP TABLE stage_0016_deal_bundle_items;

CREATE TABLE external_promotions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES external_candidates(id),
  deal_id TEXT NOT NULL UNIQUE REFERENCES deals(id),
  source_url TEXT NOT NULL UNIQUE,
  promoted_by TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT
);

INSERT INTO external_promotions (id, candidate_id, deal_id, source_url, promoted_by, promoted_at, request_id)
SELECT id, candidate_id, deal_id, source_url, promoted_by, promoted_at, request_id FROM stage_0016_external_promotions;

DROP TABLE stage_0016_external_promotions;

CREATE INDEX review_status ON ingested_items(status, captured_at);

CREATE INDEX deals_public ON deals(status, starts_at);

CREATE INDEX deals_admin ON deals(status, checked, id);

CREATE UNIQUE INDEX deals_external_source_url ON deals(source_url) WHERE origin = 'external_web';

CREATE INDEX external_candidates_status ON external_candidates(status, captured_at);

CREATE INDEX external_candidates_source ON external_candidates(source, last_seen_at);

CREATE INDEX deal_bundle_items_deal ON deal_bundle_items(deal_id, position);

CREATE INDEX external_promotions_at ON external_promotions(promoted_at);

-- Additive site D1 indexes. No stored schedules or previous indexes are changed.
-- Expressions/static predicates match lib/deal-query-sql.ts exactly. Time is bound at query time.
-- Keep the legacy INDEXED BY names and ordering expressions. Workerd cannot
-- compile a correction that repeats all of the legacy schedule predicates as
-- index maintenance code. The legacy SELECTs still apply those predicates.
CREATE INDEX public_deal_chronology ON deals (starts_at, id) WHERE status = 'published';

CREATE INDEX public_deal_model_chronology ON deals (model_id, starts_at, id) WHERE status = 'published';

CREATE INDEX public_deal_intervals ON deals ((CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), id, (CASE WHEN instr(starts_at, char(0)) = 0 AND substr(starts_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(starts_at, 1, 4) || substr(starts_at, 6, 2) || substr(starts_at, 9, 2) || substr(starts_at, 12, 2) || substr(starts_at, 15, 2) || substr(starts_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(starts_at, 1, 10), '+0 days') = substr(starts_at, 1, 10)
    AND CAST(substr(starts_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(starts_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(starts_at, 18, 2) AS INTEGER) <= 59
    AND (substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' OR ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), model_id, price) WHERE status = 'published';

CREATE INDEX public_deal_model_intervals ON deals (model_id, (CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), id, (CASE WHEN instr(starts_at, char(0)) = 0 AND substr(starts_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(starts_at, 1, 4) || substr(starts_at, 6, 2) || substr(starts_at, 9, 2) || substr(starts_at, 12, 2) || substr(starts_at, 15, 2) || substr(starts_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(starts_at, 1, 10), '+0 days') = substr(starts_at, 1, 10)
    AND CAST(substr(starts_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(starts_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(starts_at, 18, 2) AS INTEGER) <= 59
    AND (substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' OR ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), price) WHERE status = 'published';

CREATE INDEX public_deal_upcoming ON deals ((CASE WHEN instr(starts_at, char(0)) = 0 AND substr(starts_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(starts_at, 1, 4) || substr(starts_at, 6, 2) || substr(starts_at, 9, 2) || substr(starts_at, 12, 2) || substr(starts_at, 15, 2) || substr(starts_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(starts_at, 1, 10), '+0 days') = substr(starts_at, 1, 10)
    AND CAST(substr(starts_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(starts_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(starts_at, 18, 2) AS INTEGER) <= 59
    AND (substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' OR ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), id) WHERE status = 'published';

CREATE INDEX public_deal_ended ON deals ((CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END) DESC, id ASC) WHERE status = 'published';

CREATE INDEX public_deal_end_only_ended ON deals ((CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END) DESC, id ASC) WHERE status = 'published';

CREATE INDEX public_deal_end_only_unknown ON deals ((CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), id) WHERE status = 'published';

CREATE INDEX public_deal_source_ended ON deals (COALESCE((CASE WHEN instr(ends_at, char(0)) = 0 AND substr(ends_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(ends_at, 1, 4) || substr(ends_at, 6, 2) || substr(ends_at, 9, 2) || substr(ends_at, 12, 2) || substr(ends_at, 15, 2) || substr(ends_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(ends_at, 1, 10), '+0 days') = substr(ends_at, 1, 10)
    AND CAST(substr(ends_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(ends_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(ends_at, 18, 2) AS INTEGER) <= 59
    AND (substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' OR ((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(ends_at, 1, 19) || substr(ends_at, 20, length(ends_at) - CASE WHEN substr(ends_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(ends_at, -1) = 'Z' THEN 'Z' ELSE substr(ends_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), '1970-01-01T00:00:00.000Z') DESC, id ASC) WHERE status = 'published';

CREATE INDEX public_deal_permanent_unknown ON deals (id) WHERE status = 'published';

CREATE INDEX public_deal_start_only ON deals ((CASE WHEN instr(starts_at, char(0)) = 0 AND substr(starts_at, 1, 19) GLOB '????-??-??T??:??:??'
    AND (substr(starts_at, 1, 4) || substr(starts_at, 6, 2) || substr(starts_at, 9, 2) || substr(starts_at, 12, 2) || substr(starts_at, 15, 2) || substr(starts_at, 18, 2)) NOT GLOB '*[^0-9]*'
    AND date(substr(starts_at, 1, 10), '+0 days') = substr(starts_at, 1, 10)
    AND CAST(substr(starts_at, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(starts_at, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(starts_at, 18, 2) AS INTEGER) <= 59
    AND (substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) = '' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9]' OR substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END) GLOB '.[0-9][0-9][0-9]')
    AND ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' OR ((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) GLOB '[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) <= 23 AND CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER) <= 59))
    AND length(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END)) = 24 AND substr(strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END), 1, 4) NOT GLOB '*[^0-9]*'
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', substr(starts_at, 1, 19) || substr(starts_at, 20, length(starts_at) - CASE WHEN substr(starts_at, -1) = 'Z' THEN 20 ELSE 25 END), CASE WHEN (CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END) = 'Z' THEN '+0 minutes' ELSE (CASE substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 1, 1) WHEN '+' THEN '-' ELSE '+' END) || (CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 2, 2) AS INTEGER) * 60 + CAST(substr((CASE WHEN substr(starts_at, -1) = 'Z' THEN 'Z' ELSE substr(starts_at, -6) END), 5, 2) AS INTEGER)) || ' minutes' END) END), id) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS review_status_cursor ON ingested_items(status, captured_at, id);
CREATE INDEX IF NOT EXISTS external_candidates_status_cursor ON external_candidates(status, captured_at, id);
CREATE INDEX IF NOT EXISTS deals_calendar ON deals(starts_at, ends_at);

-- Verified public indexes generated from lib/verified-deal-sql.ts.
CREATE INDEX verified_deal_chronology ON deals (starts_at, id) WHERE verified_price_ready = 1;

CREATE INDEX verified_deal_model_chronology ON deals (model_id, starts_at, id) WHERE verified_price_ready = 1;

CREATE INDEX verified_deal_ending ON deals (ends_at, id, COALESCE(verified_start_utc, '0000-01-01T00:00:00.000Z')) WHERE verified_price_ready = 1 AND source_ended = 0 AND ((verified_start_utc IS NULL AND orders_open = 1) OR (verified_start_utc IS NOT NULL AND verified_start_utc <= ends_at));

CREATE INDEX verified_deal_discount ON deals ((-discount_pct), ends_at, id, COALESCE(verified_start_utc, '0000-01-01T00:00:00.000Z')) WHERE verified_price_ready = 1 AND source_ended = 0 AND ((verified_start_utc IS NULL AND orders_open = 1) OR (verified_start_utc IS NOT NULL AND verified_start_utc <= ends_at));

CREATE INDEX verified_deal_model_active ON deals (model_id, ends_at, COALESCE(verified_start_utc, '0000-01-01T00:00:00.000Z'), deal_price_krw) WHERE verified_price_ready = 1 AND source_ended = 0 AND ((verified_start_utc IS NULL AND orders_open = 1) OR (verified_start_utc IS NOT NULL AND verified_start_utc <= ends_at));

CREATE INDEX verified_deal_upcoming ON deals (verified_start_utc, id) WHERE verified_price_ready = 1 AND source_ended = 0 AND verified_start_utc IS NOT NULL AND verified_start_utc <= ends_at;

CREATE INDEX verified_deal_ended ON deals (ends_at DESC, id) WHERE verified_price_ready = 1 AND source_ended = 0 AND verified_start_utc IS NOT NULL AND verified_start_utc <= ends_at;

CREATE INDEX verified_deal_end_only_ended ON deals (ends_at DESC, id) WHERE verified_price_ready = 1 AND source_ended = 0 AND verified_start_utc IS NULL;

CREATE INDEX verified_deal_end_only_unknown ON deals (ends_at, id) WHERE verified_price_ready = 1 AND source_ended = 0 AND verified_start_utc IS NULL;

CREATE INDEX verified_deal_closed ON deals (ends_at DESC, id) WHERE verified_price_ready = 1 AND source_ended = 1;

CREATE INDEX verified_deal_unknown ON deals (ends_at, id) WHERE verified_price_ready = 1 AND source_ended = 0 AND verified_start_utc > ends_at;
