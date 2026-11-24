CREATE TABLE IF NOT EXISTS offer_discovery_edges (
  parent TEXT NOT NULL,
  destination TEXT NOT NULL,
  relation TEXT NOT NULL,
  locator TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(parent, destination, relation, locator)
);

CREATE TABLE IF NOT EXISTS offer_frontier (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('public','threads','instagram')),
  category TEXT NOT NULL DEFAULT '',
  depth INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  last_claimed INTEGER,
  cursor INTEGER NOT NULL DEFAULT 0,
  content_digest TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  gone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS offer_frontier_due ON offer_frontier(lane, gone, due_at, lease_until);

CREATE TABLE IF NOT EXISTS offer_social_observations (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('post','story')),
  seller TEXT NOT NULL,
  evidence TEXT NOT NULL,
  image_url TEXT,
  observed_at INTEGER NOT NULL,
  digest TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_social_checks (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES offer_social_observations(id),
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT,
  identity TEXT,
  digest TEXT
);

CREATE TABLE IF NOT EXISTS offer_catalog_snapshot (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision TEXT NOT NULL,
  body TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_identity (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER NOT NULL DEFAULT 0,
  deal_id TEXT,
  published_at TEXT
);
CREATE TABLE IF NOT EXISTS offer_alias (
  key TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offer_identity(id)
);
CREATE TABLE IF NOT EXISTS offer_provenance (
  offer_id TEXT NOT NULL REFERENCES offer_identity(id),
  url TEXT NOT NULL,
  locator TEXT NOT NULL,
  PRIMARY KEY(offer_id, url, locator)
);

CREATE TABLE IF NOT EXISTS offer_product_revisions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  url TEXT NOT NULL,
  locator TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  catalog_revision TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  failures TEXT NOT NULL,
  extraction TEXT,
  verification TEXT,
  offer_id TEXT REFERENCES offer_identity(id)
);
CREATE INDEX IF NOT EXISTS offer_product_latest ON offer_product_revisions(url,locator,observed_at DESC);

CREATE TABLE IF NOT EXISTS offer_outbox (
  request_id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offer_identity(id),
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  claim TEXT NOT NULL,
  candidate_id TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','acked','cancelled')),
  receipt TEXT
);
CREATE INDEX IF NOT EXISTS offer_outbox_due ON offer_outbox(state,due_at);

CREATE TABLE IF NOT EXISTS offer_metric_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS offer_metric_time ON offer_metric_events(at);
CREATE TABLE IF NOT EXISTS offer_network_stops (
  host TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  until INTEGER
);
CREATE TABLE IF NOT EXISTS offer_runtime (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_work_counters (
  cycle TEXT NOT NULL,
  source TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  details INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(cycle, source)
);
PRAGMA user_version=9;
