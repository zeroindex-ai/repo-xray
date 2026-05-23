-- 0002_request_counts — per-client daily request counter for the analyze endpoint.
-- One row per (hashed-client-key, UTC day). Atomic increment-with-cap in
-- src/lib/guards.ts gates the expensive public endpoint. Idempotent.

CREATE TABLE IF NOT EXISTS request_counts (
  bucket TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, day)
);
