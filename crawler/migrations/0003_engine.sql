-- Linux collector only. No site/D1 migration.
CREATE TABLE IF NOT EXISTS engine_runs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, schedule_kind TEXT NOT NULL,
 scheduled_for TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','cost_wait','exhausted','halted','finished')),
 started_at TEXT NOT NULL, finished_at TEXT, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(profile_id,schedule_kind,scheduled_for));
CREATE TABLE IF NOT EXISTS engine_checkpoints (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(id),
 stage TEXT NOT NULL, item_key TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','leased','retry_wait','deferred','done','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER,
 input_digest TEXT NOT NULL, version_tag TEXT NOT NULL, output_ref TEXT, error_code TEXT,
 data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(run_id,stage,item_key));
CREATE INDEX IF NOT EXISTS engine_ckpt_runnable ON engine_checkpoints(run_id,phase,next_at);
CREATE TABLE IF NOT EXISTS engine_failures (id TEXT PRIMARY KEY REFERENCES engine_checkpoints(id), run_id TEXT NOT NULL,
 stage TEXT NOT NULL, item_key TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 40 AND reason NOT GLOB '*[^a-z_]*'),
 attempts INTEGER NOT NULL, retryable INTEGER NOT NULL, next_retry_at INTEGER, first_at INTEGER NOT NULL,
 last_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS engine_costs (id TEXT PRIMARY KEY, scope TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('requests','bytes','model_calls')), cap INTEGER NOT NULL CHECK(cap>=0),
 held INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, CHECK(held>=0 AND spent>=0 AND held+spent<=cap));
CREATE TABLE IF NOT EXISTS engine_cost_holds (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner TEXT NOT NULL,
 created_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS engine_captures (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(id),
 source_id TEXT NOT NULL, url_norm TEXT NOT NULL, fetch_seq INTEGER NOT NULL DEFAULT 1, fetched_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ok','not_modified','http_error','blocked','restricted','skipped_policy','legacy')),
 content_hash TEXT, content_type TEXT, byte_length INTEGER, etag TEXT, last_modified TEXT, raw_ref TEXT,
 prev_capture_id TEXT REFERENCES engine_captures(id), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(run_id,source_id,url_norm,fetch_seq));
CREATE TABLE IF NOT EXISTS engine_cache (content_hash TEXT NOT NULL, stage TEXT NOT NULL, tool TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(content_hash,stage,tool));
CREATE TABLE IF NOT EXISTS engine_extracted (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES engine_captures(id),
 subject_ref TEXT NOT NULL, field TEXT NOT NULL, conditions_key TEXT NOT NULL DEFAULT '', claim_slot INTEGER NOT NULL DEFAULT 0,
 source_url TEXT NOT NULL, locator TEXT NOT NULL CHECK(length(locator)>0), quote TEXT CHECK(quote IS NULL OR length(quote)<=300),
 collected_at TEXT NOT NULL, effective_from TEXT NOT NULL, effective_from_basis TEXT NOT NULL CHECK(effective_from_basis IN ('stated','observed')),
 change_window_start TEXT, fact_status TEXT NOT NULL CHECK(fact_status IN ('verified','source_claim','ai_inference','unverified')),
 extractor TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), CHECK(change_window_start IS NULL OR change_window_start<collected_at),
 UNIQUE(capture_id,extractor,subject_ref,field,conditions_key,claim_slot));
CREATE INDEX IF NOT EXISTS engine_extracted_k ON engine_extracted(subject_ref,field,conditions_key,collected_at);
CREATE TABLE IF NOT EXISTS engine_labels (id TEXT PRIMARY KEY, capture_id TEXT NOT NULL REFERENCES engine_captures(id),
 label TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('rule','model','human')),
 status TEXT NOT NULL CHECK(status IN ('labeled','ambiguous','needs_review')),
 fact_status TEXT NOT NULL CHECK(fact_status IN ('source_claim','ai_inference','unverified','verified')),
 extractor TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS engine_tool_support (tool TEXT PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('supported','unsupported')), version TEXT, checked_at TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS engine_captures_no_update BEFORE UPDATE ON engine_captures BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_captures_no_delete BEFORE DELETE ON engine_captures BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_captures_idempotent BEFORE INSERT ON engine_captures
 WHEN EXISTS(SELECT 1 FROM engine_captures old WHERE old.id=new.id)
 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM engine_captures old WHERE old.id=new.id AND old.id IS new.id AND old.run_id IS new.run_id AND old.source_id IS new.source_id AND old.url_norm IS new.url_norm AND old.fetch_seq IS new.fetch_seq AND old.fetched_at IS new.fetched_at AND old.status IS new.status AND old.content_hash IS new.content_hash AND old.content_type IS new.content_type AND old.byte_length IS new.byte_length AND old.etag IS new.etag AND old.last_modified IS new.last_modified AND old.raw_ref IS new.raw_ref AND old.prev_capture_id IS new.prev_capture_id AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END;
 SELECT RAISE(IGNORE);
 END;

CREATE TRIGGER IF NOT EXISTS engine_extracted_no_update BEFORE UPDATE ON engine_extracted BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_extracted_no_delete BEFORE DELETE ON engine_extracted BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_extracted_idempotent BEFORE INSERT ON engine_extracted
 WHEN EXISTS(SELECT 1 FROM engine_extracted old WHERE old.id=new.id)
 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM engine_extracted old WHERE old.id=new.id AND old.id IS new.id AND old.capture_id IS new.capture_id AND old.subject_ref IS new.subject_ref AND old.field IS new.field AND old.conditions_key IS new.conditions_key AND old.claim_slot IS new.claim_slot AND old.source_url IS new.source_url AND old.locator IS new.locator AND old.quote IS new.quote AND old.collected_at IS new.collected_at AND old.effective_from IS new.effective_from AND old.effective_from_basis IS new.effective_from_basis AND old.change_window_start IS new.change_window_start AND old.fact_status IS new.fact_status AND old.extractor IS new.extractor AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END;
 SELECT RAISE(IGNORE);
 END;

CREATE TRIGGER IF NOT EXISTS engine_labels_no_update BEFORE UPDATE ON engine_labels BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_labels_no_delete BEFORE DELETE ON engine_labels BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS engine_labels_idempotent BEFORE INSERT ON engine_labels
 WHEN EXISTS(SELECT 1 FROM engine_labels old WHERE old.id=new.id)
 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM engine_labels old WHERE old.id=new.id AND old.id IS new.id AND old.capture_id IS new.capture_id AND old.label IS new.label AND old.method IS new.method AND old.status IS new.status AND old.fact_status IS new.fact_status AND old.extractor IS new.extractor AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END;
 SELECT RAISE(IGNORE);
 END;

PRAGMA user_version=3;
