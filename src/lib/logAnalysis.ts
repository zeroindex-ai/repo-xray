// Dual-write an observability event to trace-pack for each analysis, mirroring
// ask-zeroindex's logAsk emitter. Fire-and-forget + keepalive so the POST
// survives the serverless function returning; errors are swallowed (telemetry
// must never break a user-facing analysis). Env-gated: a no-op unless both
// TRACE_PACK_URL and TRACE_PACK_TOKEN are set, so local dev/CLI/tests don't emit.
//
// trace-pack is a flat event model (see its GenericEvent schema): one 'analyze'
// event per analysis. We deliberately do NOT send `model`/token fields — trace-
// pack derives cost_usd from its own (currently stale for Opus 4.7) pricing
// table, so instead repo-xray's precise costMicroUsd rides in the passthrough
// (raw_json). Everything below `status`/`totalMs`/`idempotencyKey` is passthrough.

export type AnalysisTrace = {
  status: 'ok' | 'error' | 'aborted';
  totalMs: number;
  repo: string; // "owner/repo"
  /** Short failure category on status='error'. Truncated to trace-pack's 120-char cap. */
  outcomeReason?: string | null;
  // The fields below are present on a completed analysis (omitted on a pre-report error):
  analysisId?: string;
  commitSha?: string;
  cached?: boolean;
  costMicroUsd?: number;
  toolCalls?: number;
  exploreCostMicroUsd?: number;
  synthCostMicroUsd?: number;
  citationsChecked?: number;
  citationsValid?: number;
  findingsKept?: number;
  findingsDropped?: number;
};

async function sendToTracePack(url: string, token: string, body: string): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
      // keepalive lets the request finish after the route response is sent,
      // so the Vercel function isn't terminated mid-POST.
      keepalive: true,
    });
  } catch (err) {
    console.warn('trace-pack ingest failed:', err instanceof Error ? err.message : String(err));
  }
}

/** Build the trace-pack GenericEvent body, dropping undefined fields. */
function buildBody(trace: AnalysisTrace): string {
  const source = process.env.TRACE_PACK_SOURCE ?? 'repo-xray';
  const event: Record<string, unknown> = {
    source,
    event: 'analyze',
    ts: new Date().toISOString(),
    status: trace.status,
    totalMs: trace.totalMs,
    repo: trace.repo,
  };
  if (trace.outcomeReason) event.outcomeReason = trace.outcomeReason.slice(0, 120);
  if (trace.analysisId) event.idempotencyKey = trace.analysisId; // dedupe re-emits of the same analysis
  if (trace.commitSha !== undefined) event.commitSha = trace.commitSha;
  if (trace.cached !== undefined) event.cached = trace.cached;
  if (trace.costMicroUsd !== undefined) event.costMicroUsd = trace.costMicroUsd;
  if (trace.toolCalls !== undefined) event.toolCalls = trace.toolCalls;
  if (trace.exploreCostMicroUsd !== undefined) event.exploreCostMicroUsd = trace.exploreCostMicroUsd;
  if (trace.synthCostMicroUsd !== undefined) event.synthCostMicroUsd = trace.synthCostMicroUsd;
  if (trace.citationsChecked !== undefined) event.citationsChecked = trace.citationsChecked;
  if (trace.citationsValid !== undefined) event.citationsValid = trace.citationsValid;
  if (trace.findingsKept !== undefined) event.findingsKept = trace.findingsKept;
  if (trace.findingsDropped !== undefined) event.findingsDropped = trace.findingsDropped;
  return JSON.stringify(event);
}

/** Emit one analysis event to trace-pack. No-op unless both env vars are set. */
export function logAnalysis(trace: AnalysisTrace): void {
  const url = process.env.TRACE_PACK_URL;
  const token = process.env.TRACE_PACK_TOKEN;
  if (!url || !token) return;
  void sendToTracePack(`${url.replace(/\/$/, '')}/api/ingest`, token, buildBody(trace));
}
