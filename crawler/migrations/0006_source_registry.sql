-- Linux collector registry only; no site/D1 or raw-body storage.
CREATE TABLE IF NOT EXISTS source_registry_approvals (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, base_revision INTEGER NOT NULL,
 revision INTEGER NOT NULL, approved_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)),
 UNIQUE(source_id,revision),
 FOREIGN KEY(source_id,base_revision) REFERENCES source_registry_revisions(source_id,revision),
 CHECK(revision=base_revision+1)
);
CREATE TABLE IF NOT EXISTS source_registry_revisions (
 source_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 approval_id TEXT REFERENCES source_registry_approvals(id),
 data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(source_id,revision),
 CHECK(json_extract(data,'$.source_id')=source_id),
 CHECK(json_extract(data,'$.revision')=revision),
 CHECK(json_extract(data,'$.status') IN ('registered','deprioritized','excluded')),
 CHECK((revision=1 AND approval_id IS NULL) OR (revision>1 AND approval_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS source_registry_conflicts (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL, revision INTEGER NOT NULL,
 existing_hash TEXT NOT NULL, proposed_hash TEXT NOT NULL,
 recorded_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state='pending'),
 data TEXT NOT NULL CHECK(json_valid(data)),
 FOREIGN KEY(source_id,revision) REFERENCES source_registry_revisions(source_id,revision)
);
CREATE TRIGGER IF NOT EXISTS source_registry_revisions_no_update BEFORE UPDATE ON source_registry_revisions BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
CREATE TRIGGER IF NOT EXISTS source_registry_revisions_no_delete BEFORE DELETE ON source_registry_revisions BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
CREATE TRIGGER IF NOT EXISTS source_registry_approvals_no_update BEFORE UPDATE ON source_registry_approvals BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
CREATE TRIGGER IF NOT EXISTS source_registry_approvals_no_delete BEFORE DELETE ON source_registry_approvals BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
CREATE TRIGGER IF NOT EXISTS source_registry_conflicts_no_update BEFORE UPDATE ON source_registry_conflicts BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
CREATE TRIGGER IF NOT EXISTS source_registry_conflicts_no_delete BEFORE DELETE ON source_registry_conflicts BEGIN SELECT RAISE(ABORT,'immutable_registry_history'); END;
PRAGMA user_version=6;
