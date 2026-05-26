// The pipeline orchestrator: one call runs an analysis end to end —
// parse → resolve SHA → fetch tree → explore → synthesize → validate → persist.
// GitHub, Anthropic, and the DB are injected so the whole flow is testable
// without network, API spend, or a real database. `liveAnalyzeDeps` binds the
// real implementations for the CLI / route.

import type { Client } from '@libsql/client';
import {
  fetchTree as ghFetchTree,
  parseRepoInput,
  readFileRange,
  resolveCommitSha as ghResolveCommitSha,
  type FileSlice,
  type RepoRef,
  type RepoTree,
} from '../lib/github';
import {
  appendEvent,
  getOrCreateAnalysis,
  getReport,
  latestSucceededByRepo,
  saveReport,
  setCost,
  setStatus,
} from '../db/analyses';
import { reserveGlobalDailyBudget } from '../lib/guards';
import type { Report } from '../report/schema';
import { validateReport, type ValidationStats } from '../report/validate';
import { type Budget, type ExploreEvent, type MessagesClient, runExploration } from './explore';
import { synthesizeReport } from './synthesize';

type Conn = Pick<Client, 'execute'>;

export type AnalyzeDeps = {
  anthropic: MessagesClient;
  resolveCommitSha: (ref: RepoRef) => Promise<string>;
  fetchTree: (ref: RepoRef, sha: string) => Promise<RepoTree>;
  readFile: (ref: RepoRef, sha: string, path: string, start?: number, end?: number) => Promise<FileSlice>;
  db?: Conn;
  now?: () => number;
};

export type AnalyzeOptions = {
  budget?: Partial<Budget>;
  /**
   * Per-event callback. `seq` is the run_events sequence number the event was
   * persisted under (once the analysis row exists), so the SSE layer can stamp
   * each frame with an `id:` the client uses as the reconnect cursor (afterSeq).
   * It is undefined for pre-row events (e.g. the initial 'resolving' phase).
   */
  onEvent?: (event: AnalyzeEvent, seq?: number) => void | Promise<void>;
  /**
   * Called once with the analysis id the moment the run's row is established (and
   * event persistence begins). Lets the SSE layer tell the client its id EARLY —
   * before any terminal event — so a dropped connection can reconnect to
   * GET /api/analyze/:id/events and resume. Not called on the sticky/cache short
   * path (no live run to reconnect to).
   */
  onStart?: (analysisId: string) => void | Promise<void>;
  /** Override the synthesis model (e.g. the Sonnet-vs-Opus eval). Defaults to SYNTH_MODEL. */
  synthModel?: string;
  /**
   * Sticky-by-repo serving for sample ("Try") repos: return the latest succeeded
   * report for this repo regardless of HEAD, so an active repo's moving commit
   * never forces a paid re-run. Falls through to a normal (seeding) run if none
   * exists yet.
   */
  sticky?: boolean;
  /**
   * Enforce the global daily $ ceiling via an atomic reservation before any paid
   * model call (default: true). The reservation writes an estimated cost onto the
   * run's row only if the day's total still fits under the ceiling, closing the
   * check-then-spend race; the real spend is reconciled after the run. Disable
   * only for tests that don't exercise the budget path.
   */
  enforceBudget?: boolean;
  /** Override the now() used for the budget reservation's UTC-day window (tests). */
  budgetNow?: () => number;
};

/** Thrown when a run is denied by the global daily budget reservation. */
export class BudgetExceededError extends Error {
  constructor(
    public readonly spentMicroUsd: number,
    public readonly ceilingMicroUsd: number
  ) {
    super('Service is over its daily budget. Please try again tomorrow.');
    this.name = 'BudgetExceededError';
  }
}

// The `report` and `error` events are TERMINAL: emitting one ends the run. They
// carry the same payloads the SSE client consumes (report = the full result
// envelope; error = a sanitized message) and are persisted to run_events so a
// reconnecting/attaching client replays the run to its real conclusion.
export type ReportEventPayload = {
  analysisId: string;
  repo: string;
  commitSha: string;
  cached: boolean;
  costMicroUsd: number;
  stats: ValidationStats | null;
  report: Report;
};

export type AnalyzeEvent =
  | { type: 'phase'; phase: 'resolving' | 'fetching' | 'exploring' | 'synthesizing' | 'validating' | 'done' }
  | { type: 'explore'; event: ExploreEvent }
  | { type: 'report'; report: ReportEventPayload }
  | { type: 'error'; message: string };

export type AnalyzeResult = {
  analysisId: string;
  commitSha: string;
  report: Report;
  stats: ValidationStats | null;
  costMicroUsd: number;
  cached: boolean;
  /** Per-phase metrics for observability. Absent on a cache hit (no run happened). */
  telemetry?: {
    toolCalls: number;
    exploreCostMicroUsd: number;
    synthCostMicroUsd: number;
  };
};

// Bind the real GitHub + DB implementations. `githubToken` lifts the unauth
// 60/hr rate limit to 5000/hr; omit only for light local testing.
export function liveAnalyzeDeps(args: {
  anthropic: MessagesClient;
  githubToken?: string;
  db?: Conn;
}): AnalyzeDeps {
  const { githubToken } = args;
  return {
    anthropic: args.anthropic,
    db: args.db,
    resolveCommitSha: (ref) => ghResolveCommitSha(ref, githubToken),
    fetchTree: (ref, sha) => ghFetchTree(ref, sha, githubToken),
    readFile: (ref, sha, path, start, end) => readFileRange(ref, sha, path, start, end, githubToken),
  };
}

// A first-pass analysis can't meaningfully cover a giant monorepo with the
// agent's ~40-read budget — decline past this many files. Env-tunable.
export const MAX_REPO_FILES = Number(process.env.MAX_REPO_FILES) || 2000;

export async function analyzeRepo(
  input: string,
  deps: AnalyzeDeps,
  opts: AnalyzeOptions = {}
): Promise<AnalyzeResult> {
  // Once the analysis row exists, every emitted event is also persisted to
  // run_events in the SAME shape the SSE client parses — so a reconnecting or
  // late-attaching client replaying run_events sees byte-identical events to the
  // original live stream. `data` mirrors the POST route's `send(e.type, e)`
  // payloads: a phase event stores { phase }, an explore event stores { event }.
  let persistId: string | null = null;
  const emit = async (e: AnalyzeEvent) => {
    let seq: number | undefined;
    if (persistId) {
      // `data` is byte-identical to the POST route's SSE payload for this type,
      // so replaying run_events reproduces the original live stream exactly.
      const data =
        e.type === 'phase'
          ? { phase: e.phase }
          : e.type === 'explore'
            ? { event: e.event }
            : e.type === 'report'
              ? e.report
              : { message: e.message };
      seq = await appendEvent(persistId, e.type, data, deps.db);
    }
    if (opts.onEvent) await opts.onEvent(e, seq);
  };

  // SSRF guard + identifier validation happen here, before any I/O.
  const ref = parseRepoInput(input);
  const repo = `${ref.owner}/${ref.repo}`;

  // Sticky sample serving: return the newest succeeded report for this repo as-is,
  // skipping the SHA resolve + any model spend. Only when one already exists — a
  // never-analyzed sample falls through to a normal run that seeds it.
  if (opts.sticky) {
    const latest = await latestSucceededByRepo(ref.owner, ref.repo, deps.db);
    if (latest) {
      const stored = await getReport(latest.id, deps.db);
      if (stored) {
        await emit({ type: 'phase', phase: 'done' });
        return {
          analysisId: latest.id,
          commitSha: latest.commitSha,
          report: stored.report as Report,
          stats: null,
          costMicroUsd: latest.costMicroUsd,
          cached: true,
        };
      }
    }
  }

  await emit({ type: 'phase', phase: 'resolving' });
  const commitSha = await deps.resolveCommitSha(ref);

  const { analysis, created } = await getOrCreateAnalysis(
    { owner: ref.owner, repo: ref.repo, ref: ref.ref ?? null, commitSha },
    deps.db
  );

  // Dedupe cache: a finished analysis of this exact commit is returned as-is.
  if (!created && analysis.status === 'succeeded') {
    const stored = await getReport(analysis.id, deps.db);
    if (stored) {
      await emit({ type: 'phase', phase: 'done' });
      return {
        analysisId: analysis.id,
        commitSha,
        report: stored.report as Report,
        stats: null,
        costMicroUsd: analysis.costMicroUsd,
        cached: true,
      };
    }
  }

  const id = analysis.id;
  // From here on the row exists and is the one we run, so begin persisting every
  // emitted event to run_events for reconnect/replay + in-flight attach.
  persistId = id;
  if (opts.onStart) await opts.onStart(id);
  const reader = (path: string, start?: number, end?: number) =>
    deps.readFile(ref, commitSha, path, start, end);

  // Atomic budget reservation (default on): write an estimated cost onto this run's
  // row, but only if today's total still fits under the global ceiling. This is the
  // authoritative gate — it closes the check-then-spend race that a bare SUM read
  // (checkGlobalDailyBudget) can't. Reconciled to the real spend below.
  let reserved = false;
  // Tracks real spend reconciled onto the row so far. While this is still the
  // reserved estimate (0 recorded), a failure should release the reservation;
  // once real cost is recorded, the row already holds the true spend.
  let recordedMicroUsd = 0;
  if (opts.enforceBudget !== false) {
    const reservation = await reserveGlobalDailyBudget(id, undefined, undefined, {
      now: opts.budgetNow,
      client: deps.db,
    });
    if (!reservation.allowed) {
      // Never ran ⇒ release the row (mark failed, zero cost) and reject.
      await setCost(id, 0, deps.db);
      await setStatus(id, 'failed', { error: 'over daily budget' }, deps.db);
      throw new BudgetExceededError(reservation.spentMicroUsd, reservation.ceilingMicroUsd);
    }
    reserved = true;
  }

  try {
    await setStatus(id, 'running', {}, deps.db);

    await emit({ type: 'phase', phase: 'fetching' });
    const tree = await deps.fetchTree(ref, commitSha);

    // Decline oversized repos BEFORE any paid model call — a ~40-read first pass
    // can't cover a giant monorepo, so it'd spend ~$0.40 to produce a poor report.
    // (Per-run cost is already bounded by the agent budget; this is the quality +
    // belt-and-suspenders gate. The tree fetch above is free.)
    const blobCount = tree.entries.filter((e) => e.type === 'blob').length;
    if (tree.truncated || blobCount > MAX_REPO_FILES) {
      throw new Error(
        `Repository is too large for a first-pass analysis (${
          tree.truncated ? 'over 100k' : blobCount
        } files; the cap is ${MAX_REPO_FILES}). Try a smaller repo.`
      );
    }

    await emit({ type: 'phase', phase: 'exploring' });
    const exploration = await runExploration({
      client: deps.anthropic,
      deps: { tree: tree.entries, readFile: reader },
      task: `Analyze the repository ${repo} to help a new engineer get oriented.`,
      budget: opts.budget,
      now: deps.now,
      // emit() persists the explore event to run_events (as type 'explore',
      // data { event }) in the same shape the SSE client parses, so there is no
      // separate appendEvent here — that would double-write in the wrong shape.
      onEvent: async (event) => {
        await emit({ type: 'explore', event });
      },
    });
    // Reconcile the reservation down to real spend as it accrues. setCost (not
    // addCost) so we overwrite the placeholder estimate rather than stack on it.
    recordedMicroUsd = exploration.costMicroUsd;
    await setCost(id, recordedMicroUsd, deps.db);

    await emit({ type: 'phase', phase: 'synthesizing' });
    const synth = await synthesizeReport({
      client: deps.anthropic,
      repo,
      commitSha,
      notes: exploration.notes,
      evidence: exploration.evidence,
      model: opts.synthModel,
    });
    recordedMicroUsd = exploration.costMicroUsd + synth.costMicroUsd;
    await setCost(id, recordedMicroUsd, deps.db);

    await emit({ type: 'phase', phase: 'validating' });
    const validated = await validateReport(synth.report, reader);

    await saveReport(id, validated.report, validated.report.summary, deps.db);
    await emit({ type: 'phase', phase: 'done' });

    const costMicroUsd = exploration.costMicroUsd + synth.costMicroUsd;
    const reportPayload: ReportEventPayload = {
      analysisId: id,
      repo,
      commitSha,
      cached: false,
      costMicroUsd,
      stats: validated.stats,
      report: validated.report,
    };
    // Persist + emit the terminal `report` event BEFORE flipping status to
    // 'succeeded'. An attaching/reconnecting client's tail loop stops once the
    // status goes terminal; writing the event first guarantees it has already
    // been recorded (and so will be replayed) when that happens — no lost report.
    await emit({ type: 'report', report: reportPayload });
    await setStatus(id, 'succeeded', {}, deps.db);

    return {
      analysisId: id,
      commitSha,
      report: validated.report,
      stats: validated.stats,
      costMicroUsd,
      cached: false,
      telemetry: {
        toolCalls: exploration.toolCalls,
        exploreCostMicroUsd: exploration.costMicroUsd,
        synthCostMicroUsd: synth.costMicroUsd,
      },
    };
  } catch (err) {
    // Release the unspent part of the reservation: reconcile the row down to the
    // real spend recorded so far. If we failed before any model call (e.g. the
    // oversize-repo gate), recordedMicroUsd is 0 and the row's $0.40 placeholder
    // is freed so a doomed run doesn't hold budget headroom hostage.
    if (reserved) await setCost(id, recordedMicroUsd, deps.db);
    // Persist + emit the terminal `error` event BEFORE flipping status to
    // 'failed' (same ordering rationale as the success path), so an attaching
    // client always replays a terminal event rather than closing silently. The
    // message is the same sanitized text the POST route surfaces to the client;
    // the raw internal error is retained on the row for server-side logs.
    await emit({ type: 'error', message: (err as Error).message });
    await setStatus(id, 'failed', { error: (err as Error).message }, deps.db);
    throw err;
  }
}
