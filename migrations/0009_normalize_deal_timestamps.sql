-- Normalize existing deal schedules to the API form YYYY-MM-DDTHH:MM:SS.SSSZ
-- Mirrors parseTimestamp in lib/deals.ts and applies offsets up to 23:59 as minute modifiers instead of SQLite zone parsing
-- Rows with any invalid value or a reversed pair stay unchanged and render as unknown schedule
CREATE VIEW deal_timestamps_0009 AS
SELECT id, col,
  CASE WHEN date(day) = day
    AND CAST(substr(raw, 12, 2) AS INTEGER) <= 23
    AND CAST(substr(raw, 15, 2) AS INTEGER) <= 59
    AND CAST(substr(raw, 18, 2) AS INTEGER) <= 59
    AND (frac = '' OR frac GLOB '.[0-9]' OR frac GLOB '.[0-9][0-9]' OR frac GLOB '.[0-9][0-9][0-9]')
    AND (zone = 'Z' OR (zone GLOB '[+-][0-9][0-9]:[0-9][0-9]'
      AND CAST(substr(zone, 2, 2) AS INTEGER) <= 23 AND CAST(substr(zone, 5, 2) AS INTEGER) <= 59))
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', day || ' ' || substr(raw, 12, 8) || frac,
    CASE WHEN zone = 'Z' THEN '+0 minutes'
      ELSE (CASE substr(zone, 1, 1) WHEN '+' THEN '-' ELSE '+' END)
        || (CAST(substr(zone, 2, 2) AS INTEGER) * 60 + CAST(substr(zone, 5, 2) AS INTEGER)) || ' minutes' END)
  END AS utc
FROM (
  SELECT id, col, raw, substr(raw, 1, 10) AS day,
    CASE WHEN substr(raw, -1) = 'Z' THEN 'Z' ELSE substr(raw, -6) END AS zone,
    CASE WHEN substr(raw, -1) = 'Z' THEN substr(raw, 20, length(raw) - 20) ELSE substr(raw, 20, length(raw) - 25) END AS frac
  FROM (
    SELECT id, 'starts' AS col, starts_at AS raw FROM deals
    UNION ALL SELECT id, 'ends', ends_at FROM deals
  )
  WHERE raw GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
);

UPDATE deals SET starts_at = s.utc, ends_at = e.utc
FROM deal_timestamps_0009 AS s
JOIN deal_timestamps_0009 AS e ON e.id = s.id AND e.col = 'ends'
WHERE s.col = 'starts' AND s.id = deals.id
  -- SQLite can format negative years so require the same four-digit UTC result as the API
  AND s.utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND e.utc GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND e.utc > s.utc;

DROP VIEW deal_timestamps_0009;
