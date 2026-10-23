CREATE TABLE IF NOT EXISTS collector_status_snapshots (
 worker_id TEXT PRIMARY KEY,
 version INTEGER NOT NULL CHECK(version >= 0),
 generated_at TEXT NOT NULL,
 received_at TEXT NOT NULL,
 payload TEXT NOT NULL
);
