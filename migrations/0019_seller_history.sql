-- History is additive. Live deal ownership, URL uniqueness and revisions belong to 0016/0017.
ALTER TABLE sellers ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX seller_public_handle ON sellers(handle);
CREATE TABLE seller_handle_aliases (
  handle TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id)
);
CREATE TRIGGER seller_preserve_handle AFTER UPDATE OF handle ON sellers
WHEN OLD.handle IS NOT NULL AND NEW.handle<>OLD.handle BEGIN
  INSERT INTO seller_handle_aliases VALUES (OLD.handle,NEW.id) ON CONFLICT DO NOTHING;
END;
CREATE TABLE seller_identity_redirects (
  seller_id TEXT PRIMARY KEY REFERENCES sellers(id),
  canonical_id TEXT NOT NULL REFERENCES sellers(id),
  CHECK(seller_id <> canonical_id)
);
CREATE TABLE seller_identity_aliases (
  platform TEXT NOT NULL CHECK(platform IN ('instagram','threads','storefront')),
  identity TEXT NOT NULL,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  source_url TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (platform,identity)
);
CREATE INDEX seller_identity_owner ON seller_identity_aliases(seller_id);
CREATE VIEW canonical_sellers AS
SELECT s.id, COALESCE(r.canonical_id,s.id) AS canonical_id
FROM sellers s LEFT JOIN seller_identity_redirects r ON r.seller_id=s.id;

-- Only the authority of a reviewed Instagram account seeds a social alias.
INSERT INTO seller_identity_aliases
SELECT 'instagram',lower(account),seller_id,'https://www.instagram.com/' || lower(account) || '/','account:' || reviewed_at
FROM seller_accounts WHERE account <> '' ORDER BY reviewed_at,account
ON CONFLICT(platform,identity) DO NOTHING;
WITH preferred AS (
  SELECT seller_id, MIN(identity) AS handle FROM seller_identity_aliases GROUP BY seller_id
)
UPDATE sellers SET handle=COALESCE(
  (SELECT p.handle FROM preferred p WHERE p.seller_id=sellers.id AND p.handle NOT GLOB 'id-*'
    AND p.seller_id=(SELECT MIN(peer.seller_id) FROM preferred peer WHERE peer.handle=p.handle)),
  'id-' || lower(hex(id))
);
CREATE TRIGGER seller_default_handle AFTER INSERT ON sellers WHEN NEW.handle IS NULL BEGIN
  UPDATE sellers SET handle='id-' || lower(hex(NEW.id)) WHERE id=NEW.id;
END;

CREATE TABLE seller_campaigns (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  title TEXT NOT NULL,
  starts_at TEXT,
  first_observed_at TEXT,
  sort_at TEXT GENERATED ALWAYS AS (COALESCE(starts_at,first_observed_at)) STORED,
  source_url TEXT NOT NULL,
  locator TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  merged_into TEXT REFERENCES seller_campaigns(id)
);
CREATE INDEX seller_campaign_owner ON seller_campaigns(seller_id,sort_at,id)
WHERE merged_into IS NULL AND first_observed_at IS NOT NULL;
CREATE TABLE campaign_source_aliases (
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  discriminator TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES seller_campaigns(id),
  source_url TEXT NOT NULL,
  locator TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY(seller_id,discriminator)
);
CREATE TABLE campaign_deals (
  deal_id TEXT PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES seller_campaigns(id)
);
CREATE INDEX campaign_deal_members ON campaign_deals(campaign_id,deal_id);

CREATE TABLE campaign_offers (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES seller_campaigns(id),
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  line_id TEXT REFERENCES deal_bundle_items(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  configuration_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('unit','bundle_total','component')),
  closed_at TEXT
);
CREATE INDEX campaign_offer_by_deal ON campaign_offers(deal_id, id);
CREATE INDEX campaign_offer_by_round ON campaign_offers(campaign_id, id);
CREATE TABLE offer_price_observations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES seller_campaigns(id),
  offer_id TEXT NOT NULL REFERENCES campaign_offers(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  configuration_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('unit','bundle_total','component')),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  list_amount INTEGER NOT NULL CHECK(list_amount > amount),
  observed_at TEXT NOT NULL,
  precision TEXT NOT NULL CHECK(precision IN ('day','instant')),
  point_time TEXT NOT NULL,
  source_url TEXT NOT NULL,
  official_url TEXT NOT NULL,
  official_observed_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  deadline_precision TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  approval_revision INTEGER NOT NULL,
  approved_at TEXT,
  approval_expires_at TEXT,
  proof_id TEXT REFERENCES deal_price_evidence(id),
  decision_ref TEXT NOT NULL
);
CREATE INDEX history_price_min ON offer_price_observations(model_id,configuration_key,scope,amount,point_time,id);
CREATE INDEX history_price_time ON offer_price_observations(model_id,configuration_key,scope,point_time,id);
CREATE INDEX history_price_round ON offer_price_observations(campaign_id,point_time,id);
CREATE INDEX history_price_offer ON offer_price_observations(offer_id,point_time,id);
CREATE TABLE campaign_observations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  record_key TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES seller_campaigns(id),
  price_id TEXT NOT NULL REFERENCES offer_price_observations(id),
  source_url TEXT NOT NULL,
  locator TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  precision TEXT NOT NULL CHECK(precision IN ('day','instant')),
  point_time TEXT NOT NULL,
  proof_id TEXT REFERENCES deal_price_evidence(id),
  deal_version INTEGER,
  retracted_by TEXT,
  UNIQUE(namespace,record_key,revision_key,item_key)
);
CREATE INDEX campaign_observation_dates ON campaign_observations(campaign_id,point_time,id) WHERE retracted_by IS NULL;
CREATE INDEX campaign_observation_support ON campaign_observations(price_id) WHERE retracted_by IS NULL;
CREATE TABLE history_reconciliation (
  namespace TEXT NOT NULL,
  record_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(namespace,record_key)
);
CREATE TABLE history_receipts (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  result TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE history_write_guard (
  valid INTEGER NOT NULL CONSTRAINT history_precondition CHECK(valid = 1)
);
CREATE TRIGGER clear_history_guard AFTER INSERT ON history_write_guard BEGIN
  DELETE FROM history_write_guard;
END;

CREATE TABLE official_attestations (
  digest TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  brand_id TEXT NOT NULL,
  campaign_id TEXT REFERENCES seller_campaigns(id),
  evidence_url TEXT NOT NULL,
  envelope TEXT NOT NULL
);
CREATE INDEX official_attestations_seller ON official_attestations(seller_id, campaign_id, brand_id);
CREATE TABLE official_approvals (
  digest TEXT PRIMARY KEY REFERENCES official_attestations(digest),
  state TEXT NOT NULL CHECK(state IN ('approved','revoked','superseded')),
  decided_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- Only the preserved Instagram approval workflow establishes independent review.

CREATE TABLE history_operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('record','close','invalidate','withdraw','import','merge','reassign','retract')),
  namespace TEXT NOT NULL,
  record_key TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  deal_version INTEGER,
  seller_id TEXT REFERENCES sellers(id),
  model_id TEXT REFERENCES models(id),
  proof_id TEXT REFERENCES deal_price_evidence(id),
  committed_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX history_operation_deal ON history_operations(deal_id,deal_version);
CREATE INDEX history_operation_deal_proof ON history_operations(deal_id,proof_id);
CREATE TABLE history_price_authority (
  observed_at TEXT PRIMARY KEY,
  scopes TEXT NOT NULL
);
INSERT INTO history_price_authority SELECT observed_at,scopes FROM official_price_approvals;
CREATE TRIGGER history_price_authority_insert AFTER INSERT ON official_price_approvals BEGIN
  INSERT INTO history_price_authority VALUES (NEW.observed_at, NEW.scopes) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER history_price_authority_update AFTER UPDATE ON official_price_approvals BEGIN
  INSERT INTO history_price_authority VALUES (NEW.observed_at, NEW.scopes) ON CONFLICT DO NOTHING;
END;

CREATE VIEW verified_receipt_history AS
SELECT 'v2:' || op.request_id AS id,
  CASE op.action WHEN 'close_verified_offer_v2' THEN 'close' WHEN 'invalidate_verified_offer_v2' THEN 'invalidate' ELSE 'record' END AS action,
  'verified_offer_v2' AS namespace,op.candidate_id AS record_key,CAST(op.revision AS TEXT) AS revision_key, 'offer' AS item_key,
  r.deal_id,r.committed_revision AS deal_version,d.seller_id,
  json_extract(e.payload,'$.facts.model_id') AS model_id,COALESCE(p.id,CASE WHEN op.action='invalidate_verified_offer_v2' THEN (
    SELECT previous.price_evidence_id FROM deal_revisions previous WHERE previous.deal_id=r.deal_id
    AND previous.version<r.committed_revision AND previous.price_evidence_id IS NOT NULL ORDER BY previous.version DESC LIMIT 1)
  END) AS proof_id,op.committed_at,
  json_object('title',json_extract(e.payload,'$.facts.title'),'starts_at',json_extract(e.payload,'$.facts.starts_at'),
    'deadline',json_extract(e.payload,'$.facts.ends_at'),'precision',json_extract(e.payload,'$.facts.deadline_precision'),
    'source_url',e.source_url,'locator',e.locator,'evidence_ref',e.digest,
    'seller_url',json_extract(op.price_values,'$.seller_url'),'identity',json_extract(op.price_values,'$.identity'),'handle',json_extract(op.price_values,'$.seller_handle'),
    'round',COALESCE(json_extract(op.price_values,'$.round'),json_extract(e.payload,'$.round')),'authority',json_extract(op.price_values,'$.authority')) AS payload
FROM verified_offer_receipts r
JOIN verified_offer_operations op USING(request_id)
JOIN verified_offer_evidence e ON e.candidate_id=op.candidate_id AND e.revision=op.revision
JOIN deals d ON d.id=r.deal_id
LEFT JOIN deal_price_evidence p ON p.id=op.request_id;

CREATE VIEW legacy_revision_history AS
SELECT 'revision:' || r.id AS id,
  CASE WHEN r.action='withdraw' OR r.status='withdrawn' THEN 'withdraw'
       WHEN r.reason='source_closed' THEN 'close'
       WHEN r.version=d.version AND d.price_verification<>'verified' THEN 'invalidate'
       WHEN p.id IS NULL OR (r.action IN ('publish','promote_external') AND r.price IS NOT json_extract(p.body,'$.offer.readings[0].amount'))
            OR r.ends_at IS NULL OR r.model_id IS NULL THEN 'invalidate'
       WHEN d.source_ended=1 AND r.version=d.version THEN 'close' ELSE 'record' END AS action,
  'deal_revision' AS namespace,r.deal_id AS record_key,CAST(r.version AS TEXT) AS revision_key,'offer' AS item_key,
  r.deal_id,r.version AS deal_version,r.seller_id,r.model_id,p.id AS proof_id,r.created_at AS committed_at,
  json_object('title',r.title,'starts_at',CASE WHEN r.starts_at IS NOT NULL AND instr(
    json_extract(p.body,'$.offer.source.text'),'공구 시작일: ' || strftime('%Y-%m-%d',r.starts_at,'+9 hours'))>0 THEN r.starts_at END,
    'deadline',r.ends_at,'source_url',d.source_url,'locator','revision:' || r.id,'evidence_ref',r.id,
    'seller_url',CASE WHEN d.origin='external_web' THEN x.seller_url END,
    'handle',CASE WHEN d.origin='external_web' THEN lower(x.seller_handle) END,
    'social_account',CASE
      WHEN d.origin='instagram' AND i.attribution='account' AND sa.seller_id=r.seller_id THEN 'instagram:' || lower(i.account)
      WHEN d.origin='threads' AND i.attribution='explicit' AND i.source_url GLOB 'https://www.threads.*/@' || lower(i.account) || '/post/*'
        THEN 'threads:' || lower(i.account)
    END,
    'attributed',CASE WHEN d.origin IN ('instagram','threads') AND i.status='approved'
      AND (i.attribution='account' AND sa.seller_id=r.seller_id OR i.attribution='explicit' AND length(trim(i.attribution_note))>=10)
      THEN 1 ELSE 0 END) AS payload
FROM deal_revisions r
JOIN deals d ON d.id=r.deal_id
JOIN ingested_items i ON i.id=r.deal_id
LEFT JOIN seller_accounts sa ON sa.account=lower(i.account)
LEFT JOIN external_candidates x ON x.id=d.external_candidate_id
LEFT JOIN deal_price_evidence p ON p.id=r.price_evidence_id AND p.outcome='verified'
WHERE (d.verified_offer_id IS NULL OR r.action='withdraw') AND r.action<>'legacy_snapshot';

-- The request and its exact proof, not the current head, drive historical admission.
CREATE VIEW history_price_inputs AS
WITH input AS (
  SELECT h.*,p.body,
    json_extract(p.body,'$.offer.source.observed_at') AS offer_at,
    json_extract(p.body,'$.official.source.observed_at') AS official_at,
    json_extract(p.body,'$.offer.source.url') AS offer_url,
    json_extract(p.body,'$.official.source.url') AS official_url,
    json_extract(p.body,'$.offer.readings[0].amount') AS amount,
    json_extract(p.body,'$.official.readings[0].amount') AS list_amount,
    json_extract(p.body,'$.official_approval.id') AS approval_id,
    json_extract(p.body,'$.official_approval.revision') AS approval_revision,
    COALESCE(json_extract(p.body,'$.official_approval.variant.configuration'),json_extract(p.body,'$.official.readings[0].configuration')) AS configuration,
    COALESCE(json_extract(h.payload,'$.authority'),
      (SELECT scope.value FROM history_price_authority a, json_each(a.scopes) scope
       WHERE a.observed_at=(SELECT max(historical.observed_at) FROM history_price_authority historical
         WHERE historical.observed_at<=max(json_extract(p.body,'$.official.source.observed_at'),json_extract(p.body,'$.offer.source.observed_at')))
         AND json_extract(scope.value,'$.id')=json_extract(p.body,'$.official_approval.id')
         AND json_extract(scope.value,'$.revision')=json_extract(p.body,'$.official_approval.revision')
         AND json_extract(scope.value,'$.url')=json_extract(p.body,'$.official.source.url')
         AND json_extract(scope.value,'$.variant') IS json_extract(p.body,'$.official_approval.variant')
         AND json_extract(scope.value,'$.approved_at')<=min(json_extract(p.body,'$.official.source.observed_at'),json_extract(p.body,'$.offer.source.observed_at'))
         AND json_extract(scope.value,'$.expires_at')>max(json_extract(p.body,'$.official.source.observed_at'),json_extract(p.body,'$.offer.source.observed_at'))
       ORDER BY a.observed_at DESC LIMIT 1)) AS authority
  FROM history_operations h JOIN deal_price_evidence p ON p.id=h.proof_id AND p.outcome='verified'
  WHERE h.action IN ('record','close','import')
), seller_links AS (
  SELECT input.*,
    COALESCE(json_extract(payload,'$.identity.platform'), CASE
      WHEN json_extract(payload,'$.social_account') LIKE 'instagram:%' THEN 'instagram'
      WHEN json_extract(payload,'$.social_account') LIKE 'threads:%' THEN 'threads'
      WHEN json_extract(payload,'$.seller_url') GLOB 'https://www.instagram.com/?*' THEN 'instagram'
      WHEN json_extract(payload,'$.seller_url') GLOB 'https://www.threads.*/@?*' THEN 'threads'
      WHEN rtrim(json_extract(payload,'$.seller_url'),'/') GLOB 'https://?*/?*'
        AND (namespace='verified_offer_v2' OR instr(json_extract(body,'$.offer.source.text'),json_extract(payload,'$.seller_url'))>0)
        THEN 'storefront'
    END) AS platform
  FROM input
)
SELECT seller_links.*,
  COALESCE(json_extract(payload,'$.identity.identity'), CASE
    WHEN json_extract(payload,'$.social_account') IS NOT NULL THEN substr(json_extract(payload,'$.social_account'),instr(json_extract(payload,'$.social_account'),':')+1)
    WHEN platform='instagram' THEN rtrim(lower(substr(json_extract(payload,'$.seller_url'),length('https://www.instagram.com/')+1)),'/')
    WHEN platform='threads' THEN rtrim(lower(substr(json_extract(payload,'$.seller_url'),instr(json_extract(payload,'$.seller_url'),'@')+1)),'/')
    WHEN platform='storefront' THEN rtrim(json_extract(payload,'$.seller_url'),'/')
  END) AS identity,
  json_array(lower(trim(json_extract(configuration,'$.brand'))),lower(trim(json_extract(configuration,'$.model'))),
    lower(trim(json_extract(configuration,'$.generation'))),lower(trim(json_extract(configuration,'$.option'))),
    lower(trim(json_extract(configuration,'$.quantity'))),lower(trim(json_extract(configuration,'$.bundle')))) AS configuration_key,
  CASE WHEN json_extract(payload,'$.scope')='component' THEN 'component'
    WHEN lower(trim(json_extract(configuration,'$.bundle'))) IN ('none','없음','단품','standalone') THEN 'unit'
    ELSE 'bundle_total' END AS scope
FROM seller_links
WHERE seller_id IS NOT NULL AND model_id IS NOT NULL
  AND amount>=0 AND list_amount>amount AND amount<=list_amount-((list_amount+99)/100)
  AND json_extract(payload,'$.deadline') IS NOT NULL AND configuration IS NOT NULL
  AND offer_at<=committed_at AND official_at<=committed_at
  AND abs(julianday(official_at)-julianday(offer_at))<1
  AND (action='close' OR offer_at<=json_extract(payload,'$.deadline'))
  AND (authority IS NOT NULL OR namespace='verified_offer_v2');

CREATE VIEW resolved_history_inputs AS
WITH rounds AS (
  SELECT h.*,s.canonical_id,
    COALESCE(a.campaign_id,
      CASE WHEN json_extract(h.payload,'$.round.key') IS NOT NULL AND EXISTS (
        SELECT 1 FROM campaign_source_aliases prior WHERE prior.campaign_id=m.campaign_id
        AND prior.discriminator<>json_extract(h.payload,'$.round.key'))
        THEN 'round:' || h.id ELSE m.campaign_id END,
      'round:' || COALESCE(h.deal_id,h.id)) AS campaign_id
  FROM history_price_inputs h
  JOIN canonical_sellers s ON s.id=h.seller_id
  LEFT JOIN campaign_deals m ON m.deal_id=h.deal_id
  LEFT JOIN campaign_source_aliases a ON a.seller_id=s.canonical_id AND a.discriminator=json_extract(h.payload,'$.round.key')
  WHERE (h.namespace='verified_offer_v2' AND h.identity IS NOT NULL) OR h.action='import' OR json_extract(h.payload,'$.attributed')=1
    OR EXISTS (SELECT 1 FROM seller_identity_aliases alias
               WHERE alias.platform=h.platform AND alias.identity=h.identity AND alias.seller_id=s.canonical_id)
)
SELECT rounds.*,'offer:' || campaign_id || ':' ||
  COALESCE(deal_id,item_key || ':' || model_id) || ':' || configuration_key || ':' || scope AS offer_id
FROM rounds;

CREATE TRIGGER history_round_chronology_insert AFTER INSERT ON campaign_observations BEGIN
  UPDATE seller_campaigns SET first_observed_at=NEW.point_time
    WHERE id=NEW.campaign_id AND NEW.retracted_by IS NULL AND (first_observed_at IS NULL OR first_observed_at>NEW.point_time);
END;
CREATE TRIGGER history_round_chronology_update AFTER UPDATE OF retracted_by,campaign_id ON campaign_observations BEGIN
  UPDATE seller_campaigns SET first_observed_at=(SELECT MIN(point_time) FROM campaign_observations
    WHERE campaign_id=seller_campaigns.id AND retracted_by IS NULL) WHERE id IN (OLD.campaign_id,NEW.campaign_id);
END;
CREATE TRIGGER history_round_chronology_delete AFTER DELETE ON campaign_observations BEGIN
  UPDATE seller_campaigns SET first_observed_at=(SELECT MIN(point_time) FROM campaign_observations
    WHERE campaign_id=OLD.campaign_id AND retracted_by IS NULL) WHERE id=OLD.campaign_id;
END;
CREATE TRIGGER history_apply AFTER INSERT ON history_operations
WHEN NEW.action IN ('record','close','import')
BEGIN
  INSERT INTO seller_identity_redirects(seller_id,canonical_id)
  SELECT h.seller_id,s.canonical_id FROM history_price_inputs h
  JOIN seller_identity_aliases a ON a.platform=h.platform AND a.identity=h.identity
  JOIN canonical_sellers s ON s.id=a.seller_id
  WHERE h.id=NEW.id AND h.namespace='verified_offer_v2' AND h.seller_id<>s.canonical_id
  ON CONFLICT(seller_id) DO NOTHING;

  INSERT INTO seller_identity_aliases
  SELECT h.platform,h.identity,cs.canonical_id,
    COALESCE(json_extract(h.payload,'$.identity.url'),json_extract(h.payload,'$.seller_url'),
      CASE h.platform WHEN 'instagram' THEN 'https://www.instagram.com/' || h.identity || '/'
        ELSE 'https://www.threads.com/@' || h.identity END),
    json_extract(h.payload,'$.evidence_ref')
  FROM history_price_inputs h JOIN canonical_sellers cs ON cs.id=h.seller_id
  WHERE h.id=NEW.id AND h.identity IS NOT NULL AND h.identity<>'' AND
    (h.namespace='verified_offer_v2' OR json_extract(h.payload,'$.attributed')=1 OR h.platform='storefront')
  ON CONFLICT(platform,identity) DO NOTHING;

  UPDATE sellers SET handle=COALESCE(
    (SELECT CASE WHEN platform='storefront' THEN json_extract(h.payload,'$.handle') ELSE h.identity END
     FROM history_price_inputs h WHERE h.id=NEW.id AND h.seller_id=sellers.id
     AND NOT EXISTS (SELECT 1 FROM seller_identity_redirects x WHERE x.seller_id=h.seller_id)),
    handle)
  WHERE id=NEW.seller_id AND handle='id-' || lower(hex(id))
    AND NOT EXISTS (SELECT 1 FROM seller_campaigns c WHERE c.seller_id=sellers.id)
    AND EXISTS (
      SELECT 1 FROM history_price_inputs h WHERE h.id=NEW.id AND
        (CASE WHEN platform='storefront' THEN json_extract(h.payload,'$.handle') ELSE h.identity END) <> ''
        AND (CASE WHEN platform='storefront' THEN json_extract(h.payload,'$.handle') ELSE h.identity END) NOT GLOB '*[^a-z0-9_.-]*'
        AND (CASE WHEN platform='storefront' THEN json_extract(h.payload,'$.handle') ELSE h.identity END) NOT GLOB 'id-*'
        AND NOT EXISTS (SELECT 1 FROM sellers other WHERE other.handle=
          CASE WHEN h.platform='storefront' THEN json_extract(h.payload,'$.handle') ELSE h.identity END));

  INSERT INTO seller_campaigns(id,seller_id,title,starts_at,source_url,locator,evidence_ref)
  SELECT campaign_id,canonical_id,json_extract(payload,'$.title'),json_extract(payload,'$.starts_at'),
    json_extract(payload,'$.source_url'),json_extract(payload,'$.locator'),json_extract(payload,'$.evidence_ref')
  FROM resolved_history_inputs h WHERE id=NEW.id
    AND (h.namespace<>'verified_offer_v2' OR json_extract(payload,'$.round.key') IS NOT NULL
      OR EXISTS (SELECT 1 FROM seller_campaigns round WHERE round.id=h.campaign_id)
      OR NOT EXISTS (SELECT 1 FROM seller_campaigns round WHERE round.seller_id=h.canonical_id
        AND round.source_url=json_extract(h.payload,'$.source_url') AND round.merged_into IS NULL))
  ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at
    WHERE seller_campaigns.starts_at IS NULL AND excluded.starts_at IS NOT NULL;

  INSERT INTO campaign_source_aliases
  SELECT h.canonical_id,json_extract(h.payload,'$.round.key'),h.campaign_id,
    COALESCE(json_extract(h.payload,'$.round.url'),json_extract(h.payload,'$.source_url')),
    COALESCE(json_extract(h.payload,'$.round.locator'),json_extract(h.payload,'$.locator')),
    json_extract(h.payload,'$.round.quote')
  FROM resolved_history_inputs h JOIN seller_campaigns c ON c.id=h.campaign_id
  WHERE h.id=NEW.id AND json_extract(h.payload,'$.round.key') IS NOT NULL
  ON CONFLICT(seller_id,discriminator) DO NOTHING;

  INSERT INTO campaign_deals
  SELECT h.deal_id,h.campaign_id FROM resolved_history_inputs h JOIN seller_campaigns c ON c.id=h.campaign_id
  WHERE h.id=NEW.id AND h.deal_id IS NOT NULL AND c.seller_id=h.canonical_id AND c.merged_into IS NULL
  ON CONFLICT(deal_id) DO UPDATE SET campaign_id=excluded.campaign_id
    WHERE campaign_deals.campaign_id<>excluded.campaign_id;

  INSERT INTO campaign_offers(id,campaign_id,deal_id,model_id,configuration_key,scope,closed_at)
  SELECT h.offer_id,h.campaign_id,h.deal_id,h.model_id,h.configuration_key,h.scope,
     CASE WHEN h.action='close' THEN h.committed_at END
  FROM resolved_history_inputs h JOIN seller_campaigns c ON c.id=h.campaign_id
  WHERE h.id=NEW.id AND c.seller_id=h.canonical_id AND c.merged_into IS NULL
  ON CONFLICT(id) DO UPDATE SET closed_at=excluded.closed_at;

  INSERT INTO offer_price_observations
  SELECT h.id,h.campaign_id,h.offer_id,h.model_id,h.configuration_key,h.scope,h.amount,h.list_amount,
    COALESCE(json_extract(h.payload,'$.observed_day'),h.offer_at),
    CASE WHEN json_extract(h.payload,'$.observed_day') IS NOT NULL THEN 'day' ELSE 'instant' END,
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(h.payload,'$.observed_day'),'-9 hours'),h.offer_at),
    h.offer_url,h.official_url,h.official_at,json_extract(h.payload,'$.deadline'),
    COALESCE(json_extract(h.payload,'$.precision'),'instant'),h.approval_id,h.approval_revision,
    json_extract(h.authority,'$.approved_at'),json_extract(h.authority,'$.expires_at'),h.proof_id,h.id
  FROM resolved_history_inputs h JOIN campaign_offers o ON o.id=h.offer_id
  WHERE h.id=NEW.id AND NOT EXISTS (
    SELECT 1 FROM offer_price_observations p WHERE p.id=(
      SELECT q.id FROM offer_price_observations q WHERE q.offer_id=o.id
        AND EXISTS (SELECT 1 FROM campaign_observations s WHERE s.price_id=q.id AND s.retracted_by IS NULL)
        AND q.point_time<=h.offer_at ORDER BY q.point_time DESC,q.rowid DESC LIMIT 1)
      AND p.amount=h.amount AND p.list_amount=h.list_amount
  );

  INSERT INTO campaign_observations
  SELECT h.id,h.namespace,h.record_key,h.revision_key,h.item_key,h.campaign_id,p.id,h.offer_url,
    json_extract(h.payload,'$.locator'),json_extract(h.payload,'$.evidence_ref'),
    COALESCE(json_extract(h.payload,'$.observed_day'),h.offer_at),
    CASE WHEN json_extract(h.payload,'$.observed_day') IS NOT NULL THEN 'day' ELSE 'instant' END,
    COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(h.payload,'$.observed_day'),'-9 hours'),h.offer_at),
    h.proof_id,h.deal_version,NULL
  FROM resolved_history_inputs h JOIN offer_price_observations p ON p.id=COALESCE(
    (SELECT id FROM offer_price_observations WHERE id=h.id),
    (SELECT q.id FROM offer_price_observations q WHERE q.offer_id=h.offer_id AND q.point_time<=h.offer_at
      AND EXISTS (SELECT 1 FROM campaign_observations s WHERE s.price_id=q.id AND s.retracted_by IS NULL)
      ORDER BY q.point_time DESC,q.rowid DESC LIMIT 1))
  WHERE h.id=NEW.id
  ON CONFLICT(namespace,record_key,revision_key,item_key) DO NOTHING;

  DELETE FROM history_reconciliation WHERE (namespace=NEW.namespace AND record_key=NEW.record_key
    OR namespace='deals' AND record_key=NEW.deal_id)
    AND EXISTS (SELECT 1 FROM campaign_observations WHERE id=NEW.id);
  INSERT INTO history_reconciliation
  SELECT NEW.namespace,NEW.record_key,'unresolved_attribution_round_or_proof'
  WHERE NOT EXISTS (SELECT 1 FROM campaign_observations WHERE id=NEW.id)
  ON CONFLICT DO NOTHING;
END;

CREATE TRIGGER history_retract AFTER INSERT ON history_operations
WHEN NEW.action IN ('withdraw','invalidate','retract')
BEGIN
  UPDATE campaign_observations SET retracted_by=NEW.id
  WHERE retracted_by IS NULL AND (
    NEW.action='retract' AND id=json_extract(NEW.payload,'$.observation_id')
    OR NEW.action='withdraw' AND id IN (
      SELECT observation.id FROM campaign_observations observation JOIN history_operations h ON h.id=observation.id
      WHERE h.deal_id=NEW.deal_id AND h.deal_version<NEW.deal_version)
    OR NEW.action='invalidate' AND id IN (
      SELECT observation.id FROM campaign_observations observation JOIN history_operations h ON h.id=observation.id
      WHERE h.deal_id=NEW.deal_id AND observation.price_id=(
        SELECT prior.price_id FROM campaign_observations prior JOIN history_operations op ON op.id=prior.id
        WHERE op.deal_id=NEW.deal_id AND op.deal_version<NEW.deal_version
          AND prior.retracted_by IS NULL ORDER BY op.deal_version DESC LIMIT 1))
  );
END;

CREATE TRIGGER history_verified_offer_receipt AFTER INSERT ON verified_offer_receipts
WHEN NEW.deal_id IS NOT NULL
BEGIN
  INSERT INTO history_operations SELECT * FROM verified_receipt_history WHERE id='v2:' || NEW.request_id;
END;
CREATE TRIGGER history_unmapped_deal AFTER INSERT ON deals WHEN NEW.status='published' BEGIN
  INSERT INTO history_reconciliation VALUES ('deals',NEW.id,'missing_history_membership') ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER history_deal_revision AFTER INSERT ON deal_revisions
WHEN NEW.action IN ('publish','withdraw')
BEGIN
  INSERT INTO history_operations SELECT * FROM legacy_revision_history WHERE id='revision:' || NEW.id;
END;
CREATE TRIGGER history_corrected_deal AFTER UPDATE OF version ON deals
WHEN NEW.version>OLD.version AND NEW.verified_offer_id IS NULL
BEGIN
  INSERT INTO history_operations SELECT h.* FROM legacy_revision_history h
    WHERE h.deal_id=NEW.id AND h.deal_version=NEW.version AND h.action<>'withdraw'
    ON CONFLICT(id) DO NOTHING;
END;
CREATE TRIGGER history_legacy_close AFTER INSERT ON history_operations
WHEN NEW.action='close' AND NEW.namespace='deal_revision'
BEGIN
  UPDATE campaign_offers SET closed_at=NEW.committed_at WHERE deal_id=NEW.deal_id;
END;
CREATE TRIGGER history_external_receipt AFTER INSERT ON external_promotions
BEGIN
  INSERT INTO history_operations SELECT h.* FROM legacy_revision_history h JOIN deal_revisions r ON h.id='revision:' || r.id
    WHERE r.deal_id=NEW.deal_id AND r.request_id=NEW.request_id;
END;

INSERT INTO history_operations SELECT * FROM legacy_revision_history WHERE action<>'withdraw' ORDER BY record_key,deal_version;
INSERT INTO history_operations SELECT * FROM verified_receipt_history ORDER BY deal_id,deal_version;
INSERT INTO history_operations SELECT * FROM legacy_revision_history WHERE action='withdraw' ORDER BY record_key,deal_version;
INSERT INTO history_reconciliation
SELECT 'deals',d.id,'missing_history_membership' FROM deals d
WHERE d.status='published' AND NOT EXISTS (SELECT 1 FROM campaign_deals m WHERE m.deal_id=d.id)
ON CONFLICT DO NOTHING;

CREATE VIEW accepted_offer_prices AS
SELECT p.* FROM offer_price_observations p WHERE EXISTS (
  SELECT 1 FROM campaign_observations s WHERE s.price_id=p.id AND s.retracted_by IS NULL);
CREATE VIEW accepted_seller_rounds AS
SELECT * FROM seller_campaigns WHERE merged_into IS NULL AND first_observed_at IS NOT NULL;

CREATE TABLE history_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
INSERT INTO history_generation VALUES (1, 1);
CREATE TRIGGER history_gen_ingested_items_insert AFTER INSERT ON ingested_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_ingested_items_update AFTER UPDATE ON ingested_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_ingested_items_delete AFTER DELETE ON ingested_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_candidates_insert AFTER INSERT ON external_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_candidates_update AFTER UPDATE ON external_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_candidates_delete AFTER DELETE ON external_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deals_insert AFTER INSERT ON deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deals_update AFTER UPDATE ON deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deals_delete AFTER DELETE ON deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_promotions_insert AFTER INSERT ON external_promotions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_promotions_update AFTER UPDATE ON external_promotions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_external_promotions_delete AFTER DELETE ON external_promotions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_revisions_insert AFTER INSERT ON deal_revisions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_revisions_update AFTER UPDATE ON deal_revisions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_revisions_delete AFTER DELETE ON deal_revisions BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_bundle_items_insert AFTER INSERT ON deal_bundle_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_bundle_items_update AFTER UPDATE ON deal_bundle_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_bundle_items_delete AFTER DELETE ON deal_bundle_items BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_sellers_insert AFTER INSERT ON sellers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_sellers_update AFTER UPDATE ON sellers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_sellers_delete AFTER DELETE ON sellers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_accounts_insert AFTER INSERT ON seller_accounts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_accounts_update AFTER UPDATE ON seller_accounts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_accounts_delete AFTER DELETE ON seller_accounts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_models_insert AFTER INSERT ON models BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_models_update AFTER UPDATE ON models BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_models_delete AFTER DELETE ON models BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_aliases_insert AFTER INSERT ON seller_identity_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_aliases_update AFTER UPDATE ON seller_identity_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_aliases_delete AFTER DELETE ON seller_identity_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_redirects_insert AFTER INSERT ON seller_identity_redirects BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_redirects_update AFTER UPDATE ON seller_identity_redirects BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_identity_redirects_delete AFTER DELETE ON seller_identity_redirects BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_campaigns_insert AFTER INSERT ON seller_campaigns BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_campaigns_update AFTER UPDATE ON seller_campaigns BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_seller_campaigns_delete AFTER DELETE ON seller_campaigns BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_deals_insert AFTER INSERT ON campaign_deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_deals_update AFTER UPDATE ON campaign_deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_deals_delete AFTER DELETE ON campaign_deals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_observations_insert AFTER INSERT ON campaign_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_observations_update AFTER UPDATE ON campaign_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_observations_delete AFTER DELETE ON campaign_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_offers_insert AFTER INSERT ON campaign_offers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_offers_update AFTER UPDATE ON campaign_offers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_campaign_offers_delete AFTER DELETE ON campaign_offers BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_offer_price_observations_insert AFTER INSERT ON offer_price_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_offer_price_observations_update AFTER UPDATE ON offer_price_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_offer_price_observations_delete AFTER DELETE ON offer_price_observations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_operations_insert AFTER INSERT ON history_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_operations_update AFTER UPDATE ON history_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_operations_delete AFTER DELETE ON history_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_receipts_insert AFTER INSERT ON history_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_receipts_update AFTER UPDATE ON history_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_receipts_delete AFTER DELETE ON history_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_attestations_insert AFTER INSERT ON official_attestations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_attestations_update AFTER UPDATE ON official_attestations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_attestations_delete AFTER DELETE ON official_attestations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_approvals_insert AFTER INSERT ON official_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_approvals_update AFTER UPDATE ON official_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_approvals_delete AFTER DELETE ON official_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_reconciliation_insert AFTER INSERT ON history_reconciliation BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_reconciliation_update AFTER UPDATE ON history_reconciliation BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_history_reconciliation_delete AFTER DELETE ON history_reconciliation BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_insert AFTER INSERT ON deal_price_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_update AFTER UPDATE ON deal_price_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_delete AFTER DELETE ON deal_price_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_heads_insert AFTER INSERT ON deal_price_evidence_heads BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_heads_update AFTER UPDATE ON deal_price_evidence_heads BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_deal_price_evidence_heads_delete AFTER DELETE ON deal_price_evidence_heads BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_price_approvals_insert AFTER INSERT ON official_price_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_price_approvals_update AFTER UPDATE ON official_price_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_official_price_approvals_delete AFTER DELETE ON official_price_approvals BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_candidates_insert AFTER INSERT ON verified_offer_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_candidates_update AFTER UPDATE ON verified_offer_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_candidates_delete AFTER DELETE ON verified_offer_candidates BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_evidence_insert AFTER INSERT ON verified_offer_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_evidence_update AFTER UPDATE ON verified_offer_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_evidence_delete AFTER DELETE ON verified_offer_evidence BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_aliases_insert AFTER INSERT ON verified_offer_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_aliases_update AFTER UPDATE ON verified_offer_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_aliases_delete AFTER DELETE ON verified_offer_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_provenance_insert AFTER INSERT ON verified_offer_provenance BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_provenance_update AFTER UPDATE ON verified_offer_provenance BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_provenance_delete AFTER DELETE ON verified_offer_provenance BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_operations_insert AFTER INSERT ON verified_offer_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_operations_update AFTER UPDATE ON verified_offer_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_operations_delete AFTER DELETE ON verified_offer_operations BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_receipts_insert AFTER INSERT ON verified_offer_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_receipts_update AFTER UPDATE ON verified_offer_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_gen_verified_offer_receipts_delete AFTER DELETE ON verified_offer_receipts BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_history_price_authority_insert AFTER INSERT ON history_price_authority BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_history_price_authority_update AFTER UPDATE ON history_price_authority BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_history_price_authority_delete AFTER DELETE ON history_price_authority BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_seller_handle_aliases_insert AFTER INSERT ON seller_handle_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_seller_handle_aliases_update AFTER UPDATE ON seller_handle_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_seller_handle_aliases_delete AFTER DELETE ON seller_handle_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_campaign_source_aliases_insert AFTER INSERT ON campaign_source_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_campaign_source_aliases_update AFTER UPDATE ON campaign_source_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;

CREATE TRIGGER history_gen_campaign_source_aliases_delete AFTER DELETE ON campaign_source_aliases BEGIN
  UPDATE history_generation SET generation=generation+1 WHERE id=1;
END;
