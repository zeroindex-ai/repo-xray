// POST /api/analyze — start an analysis and stream its progress as Server-Sent
// Events: phase markers, the agent's tool calls + running cost, then a final
// `report` event (or `error`). Guards run BEFORE the stream opens so we can still
// return a real 4xx/5xx status — once streaming starts the status is locked at 200.

import { z } from 'zod';
import { analyzeRepo, type AnalyzeDeps } from '@/agent/analyze';
import { parseRepoInput } from '@/lib/github';
import { liveDepsFromEnv } from '@/lib/analyze-deps';
import { checkDailyCap, checkGlobalDailyBudget, clientKey } from '@/lib/guards';
import { logAnalysis } from '@/lib/logAnalysis';

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
  let deps: AnalyzeDeps;
  try {
    const key = clientKey(request.headers);
    const cap = await checkDailyCap(key);
    if (!cap.allowed) return err(429, `Daily analysis limit reached (${cap.limit}/day). Try again tomorrow.`);
    const budget = await checkGlobalDailyBudget();
    if (!budget.allowed) return err(503, 'Service is over its daily budget. Please try again tomorrow.');
    deps = liveDepsFromEnv();
  } catch (e) {
    console.error('[analyze] setup failed:', e);
    return err(500, 'The analysis service is unavailable right now. (Server config — check the logs.)');
  }

  const input = `${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ''}`;
  const repo = `${ref.owner}/${ref.repo}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const t0 = Date.now();
      try {
        const result = await analyzeRepo(input, deps, {
          onEvent: (e) => send(e.type, e), // 'phase' | 'explore'
        });
        send('report', {
          analysisId: result.analysisId,
          repo,
          commitSha: result.commitSha,
          cached: result.cached,
          costMicroUsd: result.costMicroUsd,
          stats: result.stats,
          report: result.report,
        });
        // Fire-and-forget observability dual-write to trace-pack (no-op if unconfigured).
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
        send('error', { message: (e as Error).message });
        logAnalysis({ status: 'error', totalMs: Date.now() - t0, repo, outcomeReason: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let a proxy buffer the stream
    },
  });
}
