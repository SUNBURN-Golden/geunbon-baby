-- Site D1 only. Keep existing indexes and rows while making tied timestamps seekable.
CREATE INDEX review_status_cursor ON ingested_items(status, captured_at, id);
CREATE INDEX external_candidates_status_cursor ON external_candidates(status, captured_at, id);
