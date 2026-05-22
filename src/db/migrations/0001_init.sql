-- 0001_init — base schema for Repo X-Ray.
-- Every statement is idempotent (IF NOT EXISTS) so re-runs are no-ops.

-- Token buckets backing src/lib/rateLimit.ts. One row per client key
-- (`ip:<addr>` or `fp:<hash>`). Required by every public unauth endpoint.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key        TEXT    PRIMARY KEY,
  tokens     REAL    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- TODO: replace `items` with your real domain table(s). This is a placeholder
-- so the schema is non-empty and the migration runner has something to apply.
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  payload    TEXT    NOT NULL
);
