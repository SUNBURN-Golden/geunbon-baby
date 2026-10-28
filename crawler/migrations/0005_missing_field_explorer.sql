-- Linux collector only. Facts remain in their existing four storage layers.
CREATE TABLE IF NOT EXISTS extracted_assertion_links (
 extracted_id TEXT PRIMARY KEY REFERENCES engine_extracted(id),
 assertion_id TEXT NOT NULL UNIQUE REFERENCES evidence_assertions(id),
 receipt_id TEXT REFERENCES intake_receipts(id) DEFERRABLE INITIALLY DEFERRED,
 digest TEXT NOT NULL, linked_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS evidence_conflict_evaluations (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES dedup_groups(id),
 rule_version TEXT NOT NULL, input_digest TEXT NOT NULL, evaluated_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS missing_field_slots (
 id TEXT PRIMARY KEY, target_ref TEXT NOT NULL, field TEXT NOT NULL, conditions_key TEXT NOT NULL,
 assessment_id TEXT, stale INTEGER NOT NULL DEFAULT 1 CHECK(stale IN (0,1)), data TEXT NOT NULL CHECK(json_valid(data)),
 UNIQUE(target_ref,field,conditions_key)
);
CREATE TABLE IF NOT EXISTS missing_field_assessments (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES missing_field_slots(id), input_digest TEXT NOT NULL,
 assessed_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS missing_field_actions (
 id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES missing_field_slots(id), assessment_id TEXT NOT NULL REFERENCES missing_field_assessments(id),
 kind TEXT NOT NULL CHECK(kind IN ('improve_extractor','reverse_search','hold_access','review')),
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS missing_field_action_links (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES missing_field_actions(id),
 kind TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS missing_field_metric_snapshots (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_runs(id), measured_at TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX IF NOT EXISTS missing_field_assessments_slot ON missing_field_assessments(slot_id);
CREATE TRIGGER IF NOT EXISTS extracted_assertion_links_no_update BEFORE UPDATE ON extracted_assertion_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS extracted_assertion_links_no_delete BEFORE DELETE ON extracted_assertion_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS evidence_conflict_evaluations_no_update BEFORE UPDATE ON evidence_conflict_evaluations BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS evidence_conflict_evaluations_no_delete BEFORE DELETE ON evidence_conflict_evaluations BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_assessments_no_update BEFORE UPDATE ON missing_field_assessments BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_assessments_no_delete BEFORE DELETE ON missing_field_assessments BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_actions_no_update BEFORE UPDATE ON missing_field_actions BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_actions_no_delete BEFORE DELETE ON missing_field_actions BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_action_links_no_update BEFORE UPDATE ON missing_field_action_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_action_links_no_delete BEFORE DELETE ON missing_field_action_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_metric_snapshots_no_update BEFORE UPDATE ON missing_field_metric_snapshots BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_field_metric_snapshots_no_delete BEFORE DELETE ON missing_field_metric_snapshots BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;

CREATE TRIGGER IF NOT EXISTS extracted_assertion_links_idempotent BEFORE INSERT ON extracted_assertion_links WHEN EXISTS(SELECT 1 FROM extracted_assertion_links old WHERE old.extracted_id=new.extracted_id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM extracted_assertion_links old WHERE old.extracted_id=new.extracted_id AND old.extracted_id IS new.extracted_id AND old.assertion_id IS new.assertion_id AND old.receipt_id IS new.receipt_id AND old.digest IS new.digest AND old.linked_at IS new.linked_at AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS evidence_conflict_evaluations_idempotent BEFORE INSERT ON evidence_conflict_evaluations WHEN EXISTS(SELECT 1 FROM evidence_conflict_evaluations old WHERE old.id=new.id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM evidence_conflict_evaluations old WHERE old.id=new.id AND old.id IS new.id AND old.group_id IS new.group_id AND old.rule_version IS new.rule_version AND old.input_digest IS new.input_digest AND old.evaluated_at IS new.evaluated_at AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS missing_field_assessments_idempotent BEFORE INSERT ON missing_field_assessments WHEN EXISTS(SELECT 1 FROM missing_field_assessments old WHERE old.id=new.id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM missing_field_assessments old WHERE old.id=new.id AND old.id IS new.id AND old.slot_id IS new.slot_id AND old.input_digest IS new.input_digest AND old.assessed_at IS new.assessed_at AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS missing_field_actions_idempotent BEFORE INSERT ON missing_field_actions WHEN EXISTS(SELECT 1 FROM missing_field_actions old WHERE old.id=new.id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM missing_field_actions old WHERE old.id=new.id AND old.id IS new.id AND old.slot_id IS new.slot_id AND old.assessment_id IS new.assessment_id AND old.kind IS new.kind AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS missing_field_action_links_idempotent BEFORE INSERT ON missing_field_action_links WHEN EXISTS(SELECT 1 FROM missing_field_action_links old WHERE old.id=new.id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM missing_field_action_links old WHERE old.id=new.id AND old.id IS new.id AND old.action_id IS new.action_id AND old.kind IS new.kind AND old.ref IS new.ref AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS missing_field_metric_snapshots_idempotent BEFORE INSERT ON missing_field_metric_snapshots WHEN EXISTS(SELECT 1 FROM missing_field_metric_snapshots old WHERE old.id=new.id) BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM missing_field_metric_snapshots old WHERE old.id=new.id AND old.id IS new.id AND old.run_id IS new.run_id AND old.measured_at IS new.measured_at AND old.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END; SELECT RAISE(IGNORE); END;
PRAGMA user_version=5;
-- Resumable policy history materialization. Reads apply the current policy even
-- before these jobs run; approval never follows a policy migration automatically.
CREATE TABLE IF NOT EXISTS evidence_policy_jobs (
 group_id TEXT NOT NULL REFERENCES dedup_groups(id), policy_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','done')), PRIMARY KEY(group_id,policy_version)
);
CREATE INDEX IF NOT EXISTS evidence_links_assertion ON group_evidence_links(assertion_id,group_id);
CREATE INDEX IF NOT EXISTS evidence_policy_pending ON evidence_policy_jobs(policy_version,state,group_id);
CREATE INDEX IF NOT EXISTS missing_capture_url ON engine_captures(url_norm,fetched_at);
CREATE TABLE IF NOT EXISTS missing_field_target_links (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES collection_records(id),
 previous_ref TEXT NOT NULL, current_ref TEXT NOT NULL, linked_at TEXT NOT NULL,
 basis TEXT NOT NULL CHECK(basis='explicit_target_assignment')
);
CREATE TRIGGER IF NOT EXISTS missing_target_links_no_update BEFORE UPDATE ON missing_field_target_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS missing_target_links_no_delete BEFORE DELETE ON missing_field_target_links BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE INDEX IF NOT EXISTS review_events_group ON review_events(json_extract(data,'$.group_id'),json_extract(data,'$.decision'));
