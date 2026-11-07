-- Linux only. An evaluation is distinct from immutable execution ownership.
ALTER TABLE collection_schedule_calls ADD COLUMN expected_slot INTEGER;
ALTER TABLE collection_schedule_calls ADD COLUMN schedule_version TEXT;
CREATE INDEX collection_schedule_calls_slot ON collection_schedule_calls(job,expected_slot,schedule_version);
PRAGMA user_version=8;
