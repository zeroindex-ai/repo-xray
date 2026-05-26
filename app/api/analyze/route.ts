// POST /api/analyze — start an analysis and stream its progress as Server-Sent
// Events: phase markers, the agent's tool calls + running cost, then a final
// `report` event (or `error`). Guards run BEFORE the stream opens so we can still
// return a real 4xx/5xx status — once streaming starts the status is locked at 200.
//
// Same-commit dedupe (3 ways): a COMPLETED ('succeeded') run for the resolved
// commit serves its cached result; an IN-FLIGHT ('queued'/'running') run for that
// commit is ATTACHED to — we replay+tail its events instead of starting a second
// paid run; otherwise this request atomically claims ownership and runs the
// analysis. Two concurrent first-requests race on the guarded claim: exactly one
// wins and runs, the loser falls through to the in-flight attach path.

import { z } from 'zod';
import { analyzeRepo, type AnalyzeDeps } from '@/agent/analyze';
import { parseRepoInput } from '@/lib/github';
import { liveDepsFromEnv } from '@/lib/analyze-deps';
import { checkDailyCap, checkGlobalDailyBudget, clientKey } from '@/lib/guards';
import { isSampleRepo } from '@/lib/samples';
import { logAnalysis } from '@/lib/logAnalysis';
import { claimOwnership, getOrCreateAnalysis } from '@/db/analyses';
import { analysisEventStream, sseHeaders } from '@/lib/sse-replay';

export const runtime = 'nodejs';
export const maxDuration = 300; // agent runs are long; replaces the old vercel.json

const MAX_BODY_BYTES = 4096;
const BodySchema = z.object({
  repo: z.string().min(1).max(200),
  ref: z.string().max(255).optional(),
});

function err(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  // Cheap guards first, before any paid work or the stream commits to 200.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return err(413, 'Request body too large');

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(JSON.parse(text));
  } catch {
    return err(400, 'Invalid request body — expected { repo, ref? }');
  }

  let ref;
  try {
    ref = parseRepoInput(body.ref ? `${body.repo}@${body.ref}` : body.repo);
  } catch (e) {
    return err(400, (e as Error).message); // SSRF / charset / traversal rejection
  }

  // Guards + dependency init can throw (DB error, or a missing ANTHROPIC_API_KEY
  // in the server env). Catch here so the client gets a clean message instead of
  // a bare 500; the real cause is logged server-side (don't leak env-var names).
  // Sample ("Try") repos serve their pre-cached report sticky-by-repo and are
  // exempt from the daily cap + budget — the point of the samples is that they're
  // viewable even when a visitor can't run a fresh analysis. A sample with no
  // stored report yet seeds once (also exempt), then sticks.
  const sample = isSampleRepo(ref.owner, ref.repo);

  let deps: AnalyzeDeps;
  try {
    if (!sample) {
      const key = clientKey(request.headers);
      const cap = await checkDailyCap(key);
      if (!cap.allowed)
        return err(429, `Daily analysis limit reached (${cap.limit}/day). Try again tomorrow.`);
      const budget = await checkGlobalDailyBudget();
      if (!budget.allowed) return err(503, 'Service is over its daily budget. Please try again tomorrow.');
    }
    deps = liveDepsFromEnv();
  } catch (e) {
    console.error('[analyze] setup failed:', e);
    return err(500, 'The analysis service is unavailable right now. (Server config — check the logs.)');
  }

  const repo = `${ref.owner}/${ref.repo}`;

  // Same-commit dedupe — non-sample runs only. Samples use the sticky-by-repo path
  // (latest succeeded report regardless of HEAD), which is its own cheap dedupe and
  // never starts a second paid run, so it skips the claim/attach machinery below.
  if (!sample) {
    let attachId: string | null = null;
    try {
      // Resolve the commit ONCE here so the dedupe decision and the owning run use
      // the same SHA (no moving-HEAD race between this resolve and analyzeRepo's).
      const commitSha = await deps.resolveCommitSha(ref);
      // Ensure the row exists, then race on the atomic ownership claim.
      const { analysis } = await getOrCreateAnalysis(
        { owner: ref.owner, repo: ref.repo, ref: ref.ref ?? null, commitSha },
        deps.db
      );

      if (analysis.status === 'succeeded') {
        // Completed cache hit — analyzeRepo's own cache path returns it without
        // any model spend. Pin the resolved SHA so it re-resolves to this row.
        return runOwningStream(`${repo}@${commitSha}`, deps, sample, repo);
      }

      const won = await claimOwnership(analysis.id, deps.db);
      if (won) {
        // We own the compute. Run on the pinned SHA so we operate on exactly the
        // row we just claimed (analyzeRepo sets it 'running' again — harmless).
        return runOwningStream(`${repo}@${commitSha}`, deps, sample, repo);
      }
      // Lost the race (or the run was already in flight) — attach.
      attachId = analysis.id;
    } catch (e) {
      // A failure resolving the SHA / touching the DB before streaming: return a
      // real status with a sanitized message (the stream hasn't opened yet).
      console.error('[analyze] dedupe setup failed:', e);
      return err(502, 'Could not reach GitHub to resolve that repository right now. Please try again.');
    }

    if (attachId) {
      // Stream the in-flight run's events (backlog from seq 0 + tail to terminal)
      // in the SAME SSE format the client expects — no second paid run.
      return new Response(analysisEventStream(attachId, 0, { db: deps.db, emitIdEvent: true }), {
        headers: sseHeaders(),
      });
    }
  }

  // Sample path (and the only path for samples): run with sticky serving.
  return runOwningStream(`${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ''}`, deps, sample, repo);
}

// Build the SSE stream for a run we own (or a sample). analyzeRepo emits — and
// persists to run_events — every phase/explore event plus a terminal report/error
// event; we forward each to the client in the canonical SSE wire format. The
// terminal events are emitted by analyzeRepo itself, so the route only needs to
// forward and (best-effort) log.
function runOwningStream(input: string, deps: AnalyzeDeps, sample: boolean, repo: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // `id:` carries the run_events seq so a client that drops the POST stream can
      // reconnect to GET …/events?afterSeq=<last id> without missing or duplicating
      // events. Pre-row events (seq undefined) are sent without an id line.
      const send = (event: string, data: unknown, seq?: number) => {
        const idLine = seq === undefined ? '' : `id: ${seq}\n`;
        controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const t0 = Date.now();
      // Whether analyzeRepo already emitted a terminal report/error event. If it
      // did, we must NOT re-send one from the catch/cached branches below.
      let sentTerminal = false;
      try {
        const result = await analyzeRepo(input, deps, {
          // Tell the client its analysis id the moment the row exists — before any
          // terminal event — so a dropped POST stream can reconnect to
          // GET …/events. This `id` control event is not persisted (reconnect
          // carries the id in the URL); the client ignores it for rendering.
          onStart: (analysisId) => send('id', { analysisId }),
          // Forward exactly what analyzeRepo emits; the wire `data` matches the
          // persisted run_events payloads (phase → { phase }, explore → { event },
          // report → full envelope, error → { message }).
          onEvent: (e, seq) => {
            if (e.type === 'phase') send('phase', { phase: e.phase }, seq);
            else if (e.type === 'explore') send('explore', { event: e.event }, seq);
            else if (e.type === 'report') {
              sentTerminal = true;
              send('report', e.report, seq);
            } else {
              sentTerminal = true;
              send('error', { message: e.message }, seq);
            }
          },
          sticky: sample, // serve sample repos from the latest stored report
        });
        // A cached/sticky return emits a 'done' phase but no 'report' event (no run
        // happened), so synthesize the terminal report event the client expects.
        if (result.cached && !sentTerminal) {
          sentTerminal = true;
          send('report', {
            analysisId: result.analysisId,
            repo,
            commitSha: result.commitSha,
            cached: result.cached,
            costMicroUsd: result.costMicroUsd,
            stats: result.stats,
            report: result.report,
          });
        }
        logAnalysis({
          status: 'ok',
          totalMs: Date.now() - t0,
          repo,
          analysisId: result.analysisId,
          commitSha: result.commitSha,
          cached: result.cached,
          costMicroUsd: result.costMicroUsd,
          toolCalls: result.telemetry?.toolCalls,
          exploreCostMicroUsd: result.telemetry?.exploreCostMicroUsd,
          synthCostMicroUsd: result.telemetry?.synthCostMicroUsd,
          citationsChecked: result.stats?.citationsChecked,
          citationsValid: result.stats?.citationsValid,
          findingsKept: result.stats?.findingsKept,
          findingsDropped: result.stats?.findingsDropped,
        });
      } catch (e) {
        // analyzeRepo already emitted+persisted the terminal `error` event for a
        // run that reached the row (so onEvent already sent it). Only send here for
        // a throw BEFORE the row existed (e.g. SSRF/parse/oversize-before-claim),
        // which has no persisted error event — avoids a duplicate terminal event.
        if (!sentTerminal) send('error', { message: (e as Error).message });
        logAnalysis({ status: 'error', totalMs: Date.now() - t0, repo, outcomeReason: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
