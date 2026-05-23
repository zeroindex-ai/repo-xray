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
  addCost,
  appendEvent,
  getOrCreateAnalysis,
  getReport,
  saveReport,
  setStatus,
} from '../db/analyses';
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
};

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
    await addCost(id, exploration.costMicroUsd, deps.db);

    await emit({ type: 'phase', phase: 'synthesizing' });
    const synth = await synthesizeReport({
      client: deps.anthropic,
      repo,
      commitSha,
      notes: exploration.notes,
      evidence: exploration.evidence,
    });
    await addCost(id, synth.costMicroUsd, deps.db);

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
    };
  } catch (err) {
    await setStatus(id, 'failed', { error: (err as Error).message }, deps.db);
    throw err;
  }
}
