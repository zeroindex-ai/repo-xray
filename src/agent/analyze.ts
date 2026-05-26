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
  onEvent?: (event: AnalyzeEvent) => void | Promise<void>;
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
  constructor(public readonly spentMicroUsd: number, public readonly ceilingMicroUsd: number) {
    super('Service is over its daily budget. Please try again tomorrow.');
    this.name = 'BudgetExceededError';
  }
}

export type AnalyzeEvent =
  | { type: 'phase'; phase: 'resolving' | 'fetching' | 'exploring' | 'synthesizing' | 'validating' | 'done' }
  | { type: 'explore'; event: ExploreEvent };

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
  const emit = async (e: AnalyzeEvent) => {
    if (opts.onEvent) await opts.onEvent(e);
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
      onEvent: async (event) => {
        await appendEvent(id, event.type, event, deps.db);
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
    await setStatus(id, 'succeeded', {}, deps.db);
    await emit({ type: 'phase', phase: 'done' });

    return {
      analysisId: id,
      commitSha,
      report: validated.report,
      stats: validated.stats,
      costMicroUsd: exploration.costMicroUsd + synth.costMicroUsd,
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
    await setStatus(id, 'failed', { error: (err as Error).message }, deps.db);
    throw err;
  }
}
