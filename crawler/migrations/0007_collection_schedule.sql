-- Linux collector only. Slot ownership is immutable, calls are separate from engine attempts.
CREATE TABLE IF NOT EXISTS collection_schedule_runs (
 id TEXT PRIMARY KEY,
 job TEXT NOT NULL CHECK(job IN ('discover','collect','discover-sources','backfill-engine')),
 version TEXT,
 first_slot INTEGER,
 target_slot INTEGER,
 slot_count INTEGER NOT NULL CHECK(slot_count>=0),
 engine_key TEXT,
 engine_origin TEXT CHECK(engine_origin IN ('created','recovered','legacy_unassigned','already_completed')),
 engine_id TEXT UNIQUE REFERENCES engine_runs(id),
 seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('intent','running','pending','succeeded','partial_failure','failed','interrupted','disabled','halted','exhausted','already_completed')),
 reason TEXT NOT NULL,
 next_at INTEGER,
 created_at INTEGER NOT NULL,
 finished_at INTEGER,
 UNIQUE(job,target_slot),
 CHECK((target_slot IS NULL AND version IS NULL AND slot_count=0) OR (target_slot IS NOT NULL AND version IS NOT NULL AND slot_count>0))
);
-- An unstarted slot intent may coexist with isolated recovery work. Neither may duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS collection_schedule_active ON collection_schedule_runs(job,CASE WHEN engine_origin='legacy_unassigned' THEN 1 ELSE 0 END) WHERE status IN ('intent','running','pending','halted');
CREATE UNIQUE INDEX IF NOT EXISTS collection_schedule_active_engine ON collection_schedule_runs(job) WHERE engine_id IS NOT NULL AND status IN ('intent','running','pending','halted');
CREATE TRIGGER IF NOT EXISTS collection_schedule_ownership BEFORE UPDATE ON collection_schedule_runs
 WHEN old.job IS NOT new.job OR old.version IS NOT new.version OR old.first_slot IS NOT new.first_slot OR old.target_slot IS NOT new.target_slot OR old.engine_key IS NOT new.engine_key OR (old.engine_id IS NOT NULL AND old.engine_id IS NOT new.engine_id)
 BEGIN SELECT RAISE(ABORT,'immutable_schedule_ownership'); END;
CREATE TABLE IF NOT EXISTS collection_schedule_calls (
 id TEXT PRIMARY KEY,
 job TEXT NOT NULL CHECK(job IN ('discover','collect','discover-sources','backfill-engine')),
 source TEXT NOT NULL CHECK(source IN ('manual','scheduled')),
 run_id TEXT REFERENCES collection_schedule_runs(id),
 action TEXT NOT NULL CHECK(action IN ('new','resume','skip','dry_run')),
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 observed_at INTEGER,
 outcome TEXT NOT NULL,
 reason TEXT NOT NULL,
 counts TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts))
);
CREATE INDEX IF NOT EXISTS collection_schedule_calls_job ON collection_schedule_calls(job,started_at);
PRAGMA user_version=7;
