// Data-access layer for analysis runs. Every function takes an optional libsql
// client (defaulting to the lazy singleton) so tests can inject an in-memory DB.

import { randomUUID } from 'node:crypto';
import type { Client, InValue } from '@libsql/client';
import { db } from './client';

type Conn = Pick<Client, 'execute'>;

export type AnalysisStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type Analysis = {
  id: string;
  owner: string;
  repo: string;
  ref: string | null;
  commitSha: string;
  status: AnalysisStatus;
  error: string | null;
  costMicroUsd: number;
  defaultBranch: string | null;
  treeTruncated: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type RunEvent = {
  seq: number;
  type: string;
  data: unknown;
  createdAt: number;
};

export type NewAnalysis = {
  owner: string;
  repo: string;
  ref?: string | null;
  commitSha: string;
  defaultBranch?: string | null;
  treeTruncated?: boolean;
};

function rowToAnalysis(row: Record<string, unknown>): Analysis {
  return {
    id: String(row.id),
    owner: String(row.owner),
    repo: String(row.repo),
    ref: row.ref == null ? null : String(row.ref),
    commitSha: String(row.commit_sha),
    status: String(row.status) as AnalysisStatus,
    error: row.error == null ? null : String(row.error),
    costMicroUsd: Number(row.cost_micro_usd),
    defaultBranch: row.default_branch == null ? null : String(row.default_branch),
    treeTruncated: Number(row.tree_truncated) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

/**
 * Get the existing analysis for `(owner, repo, commitSha)` or create a queued
 * one. Race-safe via the UNIQUE index: concurrent submits of the same commit
 * resolve to one row. `created` tells the caller whether to start work or serve
 * the cached result.
 */
export async function getOrCreateAnalysis(
  input: NewAnalysis,
  client: Conn = db()
): Promise<{ analysis: Analysis; created: boolean }> {
  const id = randomUUID();
  // One round-trip: the no-op DO UPDATE makes the upsert RETURN a row whether it
  // inserted or hit the existing one. `created` is inferred from whether the
  // returned id is the one we just generated. Race-safe via the UNIQUE index.
  const res = await client.execute({
    sql: `INSERT INTO analyses (id, owner, repo, ref, commit_sha, default_branch, tree_truncated)
          VALUES (:id, :owner, :repo, :ref, :sha, :branch, :trunc)
          ON CONFLICT (owner, repo, commit_sha) DO UPDATE SET updated_at = updated_at
          RETURNING *`,
    args: {
      id,
      owner: input.owner,
      repo: input.repo,
      ref: input.ref ?? null,
      sha: input.commitSha,
      branch: input.defaultBranch ?? null,
      trunc: input.treeTruncated ? 1 : 0,
    },
  });
  const row = res.rows[0];
  if (!row) throw new Error('getOrCreateAnalysis: upsert returned no row');
  const analysis = rowToAnalysis(row as Record<string, unknown>);
  return { analysis, created: analysis.id === id };
}

export type ListAnalysesResult = { rows: Analysis[]; total: number };

/** Recent analyses for the admin list, newest first, with an optional status filter. */
export async function listAnalyses(
  opts: { limit: number; offset: number; status?: AnalysisStatus | 'all' },
  client: Conn = db()
): Promise<ListAnalysesResult> {
  const filtered = opts.status && opts.status !== 'all';
  const whereSql = filtered ? 'WHERE status = ?' : '';
  const filterArgs: InValue[] = filtered ? [opts.status as string] : [];

  const totalRes = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM analyses ${whereSql}`,
    args: filterArgs,
  });
  const total = Number((totalRes.rows[0] as Record<string, unknown>).n ?? 0);

  const res = await client.execute({
    // rowid (insertion order) breaks created_at ties so pagination is stable.
    sql: `SELECT * FROM analyses ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    args: [...filterArgs, opts.limit, opts.offset],
  });
  return { rows: res.rows.map((r) => rowToAnalysis(r as Record<string, unknown>)), total };
}

export async function findByRepoSha(
  owner: string,
  repo: string,
  commitSha: string,
  client: Conn = db()
): Promise<Analysis | null> {
  const res = await client.execute({
    sql: 'SELECT * FROM analyses WHERE owner = ? AND repo = ? AND commit_sha = ?',
    args: [owner, repo, commitSha],
  });
  return res.rows[0] ? rowToAnalysis(res.rows[0] as Record<string, unknown>) : null;
}

/**
 * Newest succeeded analysis for a repo, regardless of commit SHA. Backs the
 * sticky-by-repo serving of the sample ("Try") repos: an active sample's HEAD
 * moves, but we return the stored report instead of re-running on every push.
 * rowid breaks created_at ties so the pick is deterministic.
 */
export async function latestSucceededByRepo(
  owner: string,
  repo: string,
  client: Conn = db()
): Promise<Analysis | null> {
  const res = await client.execute({
    sql: "SELECT * FROM analyses WHERE owner = ? AND repo = ? AND status = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    args: [owner, repo],
  });
  return res.rows[0] ? rowToAnalysis(res.rows[0] as Record<string, unknown>) : null;
}

export async function getAnalysis(id: string, client: Conn = db()): Promise<Analysis | null> {
  const res = await client.execute({ sql: 'SELECT * FROM analyses WHERE id = ?', args: [id] });
  return res.rows[0] ? rowToAnalysis(res.rows[0] as Record<string, unknown>) : null;
}

export async function setStatus(
  id: string,
  status: AnalysisStatus,
  opts: { error?: string | null } = {},
  client: Conn = db()
): Promise<void> {
  const terminal = status === 'succeeded' || status === 'failed';
  await client.execute({
    sql: `UPDATE analyses
          SET status = :status,
              error = :error,
              updated_at = unixepoch() * 1000,
              completed_at = CASE WHEN :terminal = 1 THEN unixepoch() * 1000 ELSE completed_at END
          WHERE id = :id`,
    args: { id, status, error: opts.error ?? null, terminal: terminal ? 1 : 0 },
  });
}

/** Add to the running cost of an analysis (micro-USD; integer, no float drift). */
export async function addCost(id: string, microUsd: number, client: Conn = db()): Promise<void> {
  await client.execute({
    sql: `UPDATE analyses
          SET cost_micro_usd = cost_micro_usd + :delta, updated_at = unixepoch() * 1000
          WHERE id = :id`,
    args: { id, delta: Math.round(microUsd) },
  });
}

/** Append an ordered run event; returns its sequence number. */
export async function appendEvent(
  analysisId: string,
  type: RunEvent['type'],
  data: unknown,
  client: Conn = db()
): Promise<number> {
  const res = await client.execute({
    sql: `INSERT INTO run_events (analysis_id, seq, type, data_json)
          VALUES (
            :aid,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE analysis_id = :aid),
            :type,
            :data
          )
          RETURNING seq`,
    args: { aid: analysisId, type, data: JSON.stringify(data ?? null) },
  });
  return Number((res.rows[0] as Record<string, unknown>).seq);
}

/** Events for an analysis in order, optionally only those after `afterSeq` (SSE replay). */
export async function getEvents(analysisId: string, afterSeq = 0, client: Conn = db()): Promise<RunEvent[]> {
  const res = await client.execute({
    sql: `SELECT seq, type, data_json, created_at FROM run_events
          WHERE analysis_id = ? AND seq > ? ORDER BY seq ASC`,
    args: [analysisId, afterSeq],
  });
  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      seq: Number(row.seq),
      type: String(row.type),
      data: JSON.parse(String(row.data_json)) as unknown,
      createdAt: Number(row.created_at),
    };
  });
}

/** Persist the synthesized report (upsert; 1:1 with the analysis). */
export async function saveReport(
  analysisId: string,
  report: unknown,
  summary: string | null = null,
  client: Conn = db()
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO reports (analysis_id, report_json, summary)
          VALUES (:aid, :json, :summary)
          ON CONFLICT (analysis_id) DO UPDATE SET report_json = :json, summary = :summary`,
    args: { aid: analysisId, json: JSON.stringify(report), summary } as Record<string, InValue>,
  });
}

export async function getReport(
  analysisId: string,
  client: Conn = db()
): Promise<{ report: unknown; summary: string | null } | null> {
  const res = await client.execute({
    sql: 'SELECT report_json, summary FROM reports WHERE analysis_id = ?',
    args: [analysisId],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    report: JSON.parse(String(row.report_json)) as unknown,
    summary: row.summary == null ? null : String(row.summary),
  };
}
