-- Site D1 only. 0013 rebuilt ingested_items/deals/external_candidates and dropped
-- these indexes without recreating them. Restore the 0001/0012 index contract.
-- Add-only: no table or data changes, safe to re-apply. Not for the Linux collector.
CREATE INDEX IF NOT EXISTS review_status_cursor ON ingested_items(status, captured_at, id);
CREATE INDEX IF NOT EXISTS external_candidates_status_cursor ON external_candidates(status, captured_at, id);
CREATE INDEX IF NOT EXISTS deals_calendar ON deals(starts_at, ends_at);
