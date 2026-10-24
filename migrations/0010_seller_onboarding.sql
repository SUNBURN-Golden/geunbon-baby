-- 검수자가 확인한 원문 계정과 사이트 판매자 연결. Linux 수집기 후보와 별개다.
CREATE TABLE seller_accounts (
  account TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  reviewed_at TEXT NOT NULL
);
CREATE INDEX seller_accounts_seller ON seller_accounts(seller_id);
-- 승인 귀속 근거는 공개 판매자나 공구 테이블에 저장하지 않는다.
ALTER TABLE ingested_items ADD COLUMN attribution TEXT CHECK(attribution IS NULL OR attribution IN ('account','explicit'));
ALTER TABLE ingested_items ADD COLUMN attribution_note TEXT;
