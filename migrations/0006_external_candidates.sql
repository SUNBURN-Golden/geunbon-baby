-- 외부 공구 모음 사이트 후보. ingested_items와 분리되어 승인 API로 공구가가 될 수 없다.
-- source 허용 목록은 lib/data.ts의 EXTERNAL_SOURCES 한 곳에서만 검증한다(CHECK 없음).
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
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','dismissed')),
  reviewed_at TEXT
);
CREATE INDEX external_candidates_status ON external_candidates(status, captured_at);
CREATE INDEX external_candidates_source ON external_candidates(source, last_seen_at)
;
