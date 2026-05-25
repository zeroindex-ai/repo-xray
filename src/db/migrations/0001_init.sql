-- 0001_init — base schema for Repo X-Ray.
-- Every statement is idempotent (IF NOT EXISTS) so re-runs are no-ops.
-- Applied in filename-sort order by src/db/migrate.ts.

-- Token buckets from the service scaffold's limiter. Unused by repo-xray, which
-- gates the analyze endpoint via the per-client daily cap + global daily-$ ceiling
-- in request_counts (0002); this table is dropped in 0003 (kept here for history).
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key        TEXT    PRIMARY KEY,
  tokens     REAL    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One analysis run per (owner, repo, commit_sha). The UNIQUE index below is the
-- dedupe key: re-submitting the same commit returns the existing row instead of
-- re-spending. status: queued | running | succeeded | failed.
CREATE TABLE IF NOT EXISTS analyses (
  id             TEXT    PRIMARY KEY,
  owner          TEXT    NOT NULL,
  repo           TEXT    NOT NULL,
  ref            TEXT,
  commit_sha     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'queued',
  error          TEXT,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  tree_truncated INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analyses_repo_sha
  ON analyses (owner, repo, commit_sha);

-- The synthesized report, 1:1 with an analysis. report_json holds the full
-- structured report (sections + findings + citations); its shape is enforced by
-- a Zod schema at write time.
CREATE TABLE IF NOT EXISTS reports (
  analysis_id TEXT    PRIMARY KEY REFERENCES analyses (id),
  report_json TEXT    NOT NULL,
  summary     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Ordered run events for live streaming (SSE), reconnect/replay, and
-- observability. type: tool_call | tool_result | status | cost | error.
CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id TEXT    NOT NULL REFERENCES analyses (id),
  seq         INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  data_json   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_run_events_analysis_seq
  ON run_events (analysis_id, seq);
