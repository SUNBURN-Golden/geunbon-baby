-- 게시 공구 정정·철회와 감사 이력. 수집 원문은 수정하지 않는다
ALTER TABLE deals ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','withdrawn'));
ALTER TABLE deals ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE deals ADD COLUMN updated_at TEXT;
ALTER TABLE deals ADD COLUMN withdrawn_at TEXT;
CREATE TABLE deal_revisions (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  action TEXT NOT NULL CHECK(action IN ('publish','correct','withdraw')),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT,
  model_id TEXT NOT NULL, seller_id TEXT NOT NULL, title TEXT NOT NULL, price INTEGER CHECK(price >= 0),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, image_url TEXT, checked TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','withdrawn')),
  created_at TEXT NOT NULL,
  UNIQUE(deal_id, version),
  UNIQUE(deal_id, request_id)
);
CREATE INDEX deals_public ON deals(status, starts_at);
CREATE INDEX deals_admin ON deals(status, checked, id);
-- 기존 게시분의 원래 상태 보존
INSERT INTO deal_revisions (id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,status,created_at)
SELECT 'baseline-' || id,id,1,'publish','migration-0011','baseline',NULL,model_id,seller_id,title,price,starts_at,ends_at,image_url,checked,'published',checked FROM deals;
