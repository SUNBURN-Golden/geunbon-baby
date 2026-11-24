-- Additive ownership for typed offers. The existing ingest URL constraint stays in place.
ALTER TABLE deals ADD COLUMN verified_offer_id TEXT;

CREATE TABLE verified_offer_candidates (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('eligible','published','review','dismissed')),
  checked_at TEXT NOT NULL,
  deal_id TEXT REFERENCES deals(id)
);
CREATE INDEX verified_offer_review ON verified_offer_candidates(state, checked_at, id);

CREATE TABLE verified_offer_evidence (
  candidate_id TEXT NOT NULL REFERENCES verified_offer_candidates(id),
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  offer_key TEXT NOT NULL,
  campaign_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  locator TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(candidate_id, revision)
);
CREATE TABLE verified_offer_aliases (
  offer_key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES verified_offer_candidates(id)
);
CREATE TABLE verified_offer_provenance (
  candidate_id TEXT NOT NULL REFERENCES verified_offer_candidates(id),
  source_url TEXT NOT NULL,
  locator TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(candidate_id, source_url, locator)
);
CREATE TABLE verified_offer_operations (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('promote_verified_offer_v2','invalidate_verified_offer_v2','close_verified_offer_v2')),
  candidate_id TEXT NOT NULL REFERENCES verified_offer_candidates(id),
  offer_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  deal_id TEXT,
  expected_version INTEGER NOT NULL,
  committed_at TEXT NOT NULL,
  price_values TEXT,
  FOREIGN KEY(candidate_id, revision) REFERENCES verified_offer_evidence(candidate_id, revision)
);
CREATE UNIQUE INDEX verified_offer_once_per_revision ON verified_offer_operations(candidate_id, revision, action);
CREATE TABLE verified_offer_receipts (
  request_id TEXT PRIMARY KEY REFERENCES verified_offer_operations(request_id),
  deal_id TEXT REFERENCES deals(id),
  committed_revision INTEGER
);

DROP INDEX deals_external_source_url;
CREATE UNIQUE INDEX deals_external_source_url
  ON deals(source_url) WHERE origin = 'external_web' AND verified_offer_id IS NULL;
CREATE INDEX deals_source_collision ON deals(source_url);

CREATE TRIGGER deal_typed_url_insert BEFORE INSERT ON deals
WHEN EXISTS (SELECT 1 FROM deals d WHERE d.source_url = NEW.source_url
  AND (d.verified_offer_id IS NULL) <> (NEW.verified_offer_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'offer_source_conflict');
END;

CREATE TRIGGER deal_typed_url_update BEFORE UPDATE OF source_url, verified_offer_id ON deals
WHEN EXISTS (SELECT 1 FROM deals d WHERE d.id <> NEW.id AND d.source_url = NEW.source_url
  AND (d.verified_offer_id IS NULL) <> (NEW.verified_offer_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'offer_source_conflict');
END;

CREATE TRIGGER verified_offer_apply AFTER INSERT ON verified_offer_operations
WHEN NEW.action IN ('promote_verified_offer_v2','close_verified_offer_v2')
BEGIN
  INSERT INTO verified_offer_aliases(offer_key, candidate_id)
    SELECT value, NEW.candidate_id FROM json_each(json_array(NEW.offer_key,
      (SELECT campaign_key FROM verified_offer_evidence WHERE candidate_id=NEW.candidate_id AND revision=NEW.revision)))
    WHERE true ON CONFLICT(offer_key) DO NOTHING;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM verified_offer_aliases a JOIN verified_offer_evidence e ON a.offer_key IN (e.offer_key,e.campaign_key)
    WHERE e.candidate_id=NEW.candidate_id AND e.revision=NEW.revision AND a.candidate_id<>NEW.candidate_id
  ) THEN RAISE(ABORT, 'offer_key_conflict') END;

  INSERT INTO sellers(id, name, source_url)
    VALUES (json_extract(NEW.price_values,'$.seller_id'), json_extract(NEW.price_values,'$.seller_handle'), json_extract(NEW.price_values,'$.seller_url'))
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO ingested_items(id,source_url,account,text,kind,captured_at,status,reviewed_at,image_url,attribution,attribution_note)
    SELECT NEW.deal_id, source_url || '#agamajung-' || NEW.candidate_id, json_extract(NEW.price_values,'$.seller_handle'),
      json_extract(payload,'$.price_evidence.offer.source.text'), 'external_web',
      json_extract(payload,'$.checked_at'), 'approved', NEW.committed_at, json_extract(payload,'$.facts.image_url'), 'explicit', 'collector'
    FROM verified_offer_evidence WHERE candidate_id=NEW.candidate_id AND revision=NEW.revision AND NEW.expected_version=0;
  SELECT CASE WHEN changes() <> (NEW.expected_version=0) THEN RAISE(ABORT,'offer_anchor_write') END;

  INSERT INTO deal_price_evidence(id,target_kind,target_id,target_revision,outcome,body,created_at,observed_at)
    SELECT NEW.request_id,'deal',NEW.deal_id,CAST(NEW.expected_version+1 AS TEXT),'verified',
      json_extract(payload,'$.price_evidence'),NEW.committed_at,json_extract(NEW.price_values,'$.prices[4]')
    FROM verified_offer_evidence WHERE candidate_id=NEW.candidate_id AND revision=NEW.revision;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT,'offer_proof_write') END;
  INSERT INTO deal_price_evidence_heads(target_kind,target_id,target_revision,evidence_id)
    VALUES ('deal',NEW.deal_id,CAST(NEW.expected_version+1 AS TEXT),NEW.request_id);

  INSERT INTO deals(id,model_id,seller_id,title,price,source_url,verify_level,checked,starts_at,ends_at,image_url,
    origin,source_host,promoted_by,promoted_at,updated_at,verified_offer_id,
    deal_price_krw,list_price_krw,price_source_url,list_price_source_url,price_checked_at,price_verification,price_evidence_id,price_evidence_version,orders_open)
    SELECT NEW.deal_id,json_extract(payload,'$.facts.model_id'),json_extract(NEW.price_values,'$.seller_id'),json_extract(payload,'$.facts.title'),
      json_extract(NEW.price_values,'$.prices[0]'),source_url,'verified_offer_v2',json_extract(payload,'$.checked_at'),
      json_extract(payload,'$.facts.starts_at'),json_extract(payload,'$.facts.ends_at'),json_extract(payload,'$.facts.image_url'),
      'external_web',json_extract(NEW.price_values,'$.host'),'collector',NEW.committed_at,NEW.committed_at,NEW.candidate_id,
      json_extract(NEW.price_values,'$.prices[0]'),json_extract(NEW.price_values,'$.prices[1]'),json_extract(NEW.price_values,'$.prices[2]'),
      json_extract(NEW.price_values,'$.prices[3]'),json_extract(NEW.price_values,'$.prices[4]'),json_extract(NEW.price_values,'$.prices[5]'),
      json_extract(NEW.price_values,'$.prices[6]'),json_extract(NEW.price_values,'$.prices[7]'),json_extract(NEW.price_values,'$.prices[8]')
    FROM verified_offer_evidence WHERE candidate_id=NEW.candidate_id AND revision=NEW.revision AND NEW.expected_version=0;
  SELECT CASE WHEN changes() <> (NEW.expected_version=0) THEN RAISE(ABORT,'offer_deal_write') END;

  UPDATE deals SET (model_id,title,source_url,checked,starts_at,ends_at,image_url) =
    (SELECT json_extract(payload,'$.facts.model_id'),json_extract(payload,'$.facts.title'),source_url,json_extract(payload,'$.checked_at'),
      json_extract(payload,'$.facts.starts_at'),json_extract(payload,'$.facts.ends_at'),json_extract(payload,'$.facts.image_url')
      FROM verified_offer_evidence WHERE candidate_id=NEW.candidate_id AND revision=NEW.revision),
    price=json_extract(NEW.price_values,'$.prices[0]'),
    (deal_price_krw,list_price_krw,price_source_url,list_price_source_url,price_checked_at,price_verification,price_evidence_id,price_evidence_version,orders_open) =
      (json_extract(NEW.price_values,'$.prices[0]'),json_extract(NEW.price_values,'$.prices[1]'),json_extract(NEW.price_values,'$.prices[2]'),
      json_extract(NEW.price_values,'$.prices[3]'),json_extract(NEW.price_values,'$.prices[4]'),json_extract(NEW.price_values,'$.prices[5]'),
      json_extract(NEW.price_values,'$.prices[6]'),json_extract(NEW.price_values,'$.prices[7]'),json_extract(NEW.price_values,'$.prices[8]')),
    source_host=json_extract(NEW.price_values,'$.host'),source_ended=(NEW.action='close_verified_offer_v2'),
    version=version+1,updated_at=NEW.committed_at
    WHERE id=NEW.deal_id AND verified_offer_id=NEW.candidate_id AND version=NEW.expected_version AND status='published';
  SELECT CASE WHEN changes() <> (NEW.expected_version>0) THEN RAISE(ABORT,'offer_version_write') END;
  UPDATE verified_offer_candidates SET state='published',deal_id=NEW.deal_id
    WHERE id=NEW.candidate_id AND revision=NEW.revision AND digest=NEW.digest AND state='eligible';
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT,'offer_head_write') END;

  INSERT INTO deal_revisions(id,deal_id,version,action,request_id,request_hash,model_id,seller_id,title,price,
      starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
    SELECT 'offer-' || NEW.request_id,id,version,'promote_external',NEW.request_id,NEW.request_hash,model_id,seller_id,title,price,
      starts_at,ends_at,image_url,checked,status,NEW.committed_at,price_evidence_id FROM deals WHERE id=NEW.deal_id;
  UPDATE deals SET price_verification='unverified'
    WHERE NEW.action='promote_verified_offer_v2' AND id<>NEW.deal_id AND status='published' AND price_verification='verified'
      AND list_price_source_url=json_extract(NEW.price_values,'$.prices[3]')
      AND price_checked_at<=json_extract(NEW.price_values,'$.prices[4]')
      AND list_price_krw<>json_extract(NEW.price_values,'$.prices[1]')
      AND EXISTS (SELECT 1 FROM deal_price_evidence old JOIN deal_price_evidence fresh ON fresh.id=NEW.request_id
        WHERE old.id=deals.price_evidence_id
          AND json_extract(old.body,'$.official_approval.variant')=json_extract(fresh.body,'$.official_approval.variant'));

  INSERT INTO verified_offer_receipts(request_id,deal_id,committed_revision)
    VALUES (NEW.request_id, NEW.deal_id, NEW.expected_version+1);
END;

CREATE TRIGGER verified_offer_invalidate AFTER INSERT ON verified_offer_operations
WHEN NEW.action = 'invalidate_verified_offer_v2'
BEGIN
  UPDATE deals SET price_verification='unverified',price_evidence_id=NULL,price_evidence_version=NULL,
    deal_price_krw=NULL,list_price_krw=NULL,price_source_url=NULL,list_price_source_url=NULL,price_checked_at=NULL,
    orders_open=0,price=NULL,version=version+1,updated_at=NEW.committed_at
    WHERE id=NEW.deal_id AND verified_offer_id=NEW.candidate_id AND status='published' AND version=NEW.expected_version;
  SELECT CASE WHEN changes() <> (NEW.deal_id IS NOT NULL) THEN RAISE(ABORT,'offer_version_write') END;
  INSERT INTO deal_revisions(id,deal_id,version,action,request_id,request_hash,reason,model_id,seller_id,title,price,
      starts_at,ends_at,image_url,checked,status,created_at,price_evidence_id)
    SELECT 'offer-' || NEW.request_id,id,version,'verify_prices',NEW.request_id,NEW.request_hash,'offer_invalidated',model_id,seller_id,title,price,
      starts_at,ends_at,image_url,checked,status,NEW.committed_at,price_evidence_id FROM deals WHERE id=NEW.deal_id;
  INSERT INTO verified_offer_receipts(request_id,deal_id,committed_revision)
    VALUES (NEW.request_id,NEW.deal_id,CASE WHEN NEW.deal_id IS NOT NULL THEN NEW.expected_version+1 END);
END;
