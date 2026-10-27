-- Linux only; source candidates confer no collection or official-source permission.
CREATE TABLE IF NOT EXISTS source_candidates (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, canonical_url TEXT, display_url TEXT,
 identity TEXT NOT NULL CHECK(identity IN ('preserved','identity_loss','rejected')),
 status TEXT NOT NULL DEFAULT 'discovered' CHECK(status='discovered'),
 policy_version TEXT NOT NULL, reasons TEXT NOT NULL CHECK(json_valid(reasons)),
 relevance INTEGER NOT NULL CHECK(relevance BETWEEN 0 AND 100), relevance_version TEXT NOT NULL,
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, observation_count INTEGER NOT NULL DEFAULT 0,
 added_day TEXT NOT NULL, url_policy TEXT NOT NULL CHECK(json_valid(url_policy)),
 CHECK((identity='preserved' AND canonical_url IS NOT NULL) OR (identity!='preserved' AND canonical_url IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS source_candidates_url ON source_candidates(profile_id,canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_candidates_day ON source_candidates(profile_id,added_day);
CREATE TABLE IF NOT EXISTS source_discovery_queries (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, provider_id TEXT NOT NULL,
 query_text TEXT NOT NULL, subject_ref TEXT NOT NULL, conditions_key TEXT NOT NULL,
 data TEXT NOT NULL CHECK(json_valid(data)), cursor TEXT, capture_id TEXT REFERENCES engine_captures(id),
 next_requery_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS source_candidate_evidence (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES source_candidates(id),
 capture_id TEXT NOT NULL REFERENCES engine_captures(id), locator TEXT NOT NULL,
 relation TEXT NOT NULL, subject_ref TEXT NOT NULL, conditions_key TEXT NOT NULL, claim_slot INTEGER NOT NULL,
 extractor_version TEXT NOT NULL, source_url TEXT NOT NULL, collected_at TEXT NOT NULL,
 effective_at TEXT NOT NULL, effective_basis TEXT NOT NULL CHECK(effective_basis IN ('explicit','observed')),
 fact_status TEXT NOT NULL CHECK(fact_status IN ('source_claim','unverified')),
 data TEXT NOT NULL CHECK(json_valid(data)),
 UNIQUE(candidate_id,capture_id,locator,relation,subject_ref,conditions_key,claim_slot,extractor_version)
);
-- Path provenance is additive and separate from immutable claim identity. Reusing a
-- search capture on two paths must retain both parents without rewriting a claim.
CREATE TABLE IF NOT EXISTS source_discovery_paths (
 id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES source_candidate_evidence(id),
 query_id TEXT REFERENCES source_discovery_queries(id), parent_id TEXT REFERENCES source_candidates(id),
 depth INTEGER NOT NULL CHECK(depth>=0), deferred_reason TEXT,
 data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TRIGGER IF NOT EXISTS source_evidence_no_update BEFORE UPDATE ON source_candidate_evidence BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS source_evidence_no_delete BEFORE DELETE ON source_candidate_evidence BEGIN SELECT RAISE(ABORT,'immutable_id_conflict'); END;
CREATE TRIGGER IF NOT EXISTS source_evidence_idempotent BEFORE INSERT ON source_candidate_evidence WHEN EXISTS(SELECT 1 FROM source_candidate_evidence WHERE id=new.id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM source_candidate_evidence o WHERE o.id=new.id AND o.candidate_id IS new.candidate_id AND o.capture_id IS new.capture_id AND o.locator IS new.locator AND o.relation IS new.relation AND o.subject_ref IS new.subject_ref AND o.conditions_key IS new.conditions_key AND o.claim_slot IS new.claim_slot AND o.extractor_version IS new.extractor_version AND o.source_url IS new.source_url AND o.collected_at IS new.collected_at AND o.effective_at IS new.effective_at AND o.effective_basis IS new.effective_basis AND o.fact_status IS new.fact_status AND o.data IS new.data) THEN NULL ELSE RAISE(ABORT,'immutable_id_conflict') END;
 SELECT RAISE(IGNORE);
END;
PRAGMA user_version=4;
