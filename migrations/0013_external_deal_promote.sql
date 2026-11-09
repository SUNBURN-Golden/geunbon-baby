-- 공개 웹 후보(external_candidates) → deals 게시 경로, 묶음 상품, 감사 추적
PRAGMA foreign_keys=OFF;

CREATE TABLE ingested_items_new (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('post','story','external_web')),
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_at TEXT,
  suggestions TEXT,
  image_url TEXT,
  attribution TEXT,
  attribution_note TEXT
);
INSERT INTO ingested_items_new SELECT id, source_url, account, text, kind, captured_at, status, reviewed_at, suggestions, image_url, attribution, attribution_note FROM ingested_items;
DROP TABLE ingested_items;
ALTER TABLE ingested_items_new RENAME TO ingested_items;
CREATE INDEX review_status ON ingested_items(status, captured_at);

CREATE TABLE deals_new (
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
  origin TEXT NOT NULL DEFAULT 'instagram' CHECK(origin IN ('instagram','external_web')),
  external_candidate_id TEXT,
  source_host TEXT,
  source_ended INTEGER NOT NULL DEFAULT 0 CHECK(source_ended IN (0,1)),
  brand_label TEXT,
  category_label TEXT,
  promoted_by TEXT,
  promoted_at TEXT,
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
INSERT INTO deals_new (
  id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url,
  status, version, updated_at, withdrawn_at, origin, source_ended
) SELECT
  id, model_id, seller_id, title, price, source_url, verify_level, checked, starts_at, ends_at, image_url,
  status, version, updated_at, withdrawn_at, 'instagram', 0 FROM deals;
DROP TABLE deals;
ALTER TABLE deals_new RENAME TO deals;
CREATE INDEX deals_public ON deals(status, starts_at);
CREATE INDEX deals_admin ON deals(status, checked, id);
CREATE UNIQUE INDEX deals_external_source_url ON deals(source_url) WHERE origin = 'external_web';

CREATE TABLE deal_revisions_new (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  action TEXT NOT NULL CHECK(action IN ('publish','correct','withdraw','promote_external')),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT,
  model_id TEXT, seller_id TEXT NOT NULL, title TEXT NOT NULL, price INTEGER CHECK(price IS NULL OR price >= 0),
  starts_at TEXT, ends_at TEXT, image_url TEXT, checked TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','withdrawn')),
  created_at TEXT NOT NULL,
  UNIQUE(deal_id, version),
  UNIQUE(deal_id, request_id)
);
INSERT INTO deal_revisions_new (
  id, deal_id, version, action, request_id, request_hash, reason, model_id, seller_id, title, price,
  starts_at, ends_at, image_url, checked, status, created_at
) SELECT id, deal_id, version, action, request_id, request_hash, reason, model_id, seller_id, title, price,
  starts_at, ends_at, image_url, checked, status, created_at FROM deal_revisions;
DROP TABLE deal_revisions;
ALTER TABLE deal_revisions_new RENAME TO deal_revisions;

CREATE TABLE external_candidates_new (
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
  promoted_deal_id TEXT REFERENCES deals(id)
);
INSERT INTO external_candidates_new (
  id, source, source_url, title, text, seller_handle, seller_name, seller_url, price_hint, price_raw,
  price_basis, starts_at, ends_at, dates_raw, category, model_match, suggestions, captured_at, last_seen_at,
  status, reviewed_at
) SELECT
  id, source, source_url, title, text, seller_handle, seller_name, seller_url, price_hint, price_raw,
  price_basis, starts_at, ends_at, dates_raw, category, model_match, suggestions, captured_at, last_seen_at,
  status, reviewed_at FROM external_candidates;
DROP TABLE external_candidates;
ALTER TABLE external_candidates_new RENAME TO external_candidates;
CREATE INDEX external_candidates_status ON external_candidates(status, captured_at);
CREATE INDEX external_candidates_source ON external_candidates(source, last_seen_at);

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
CREATE INDEX deal_bundle_items_deal ON deal_bundle_items(deal_id, position);

CREATE TABLE external_promotions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES external_candidates(id),
  deal_id TEXT NOT NULL UNIQUE REFERENCES deals(id),
  source_url TEXT NOT NULL UNIQUE,
  promoted_by TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE
);
CREATE INDEX external_promotions_at ON external_promotions(promoted_at);

PRAGMA foreign_keys=ON;
