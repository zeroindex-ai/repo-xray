// GET /api/analyze/:id/events — replay + live-tail an analysis's run events as
// Server-Sent Events. Backs client reconnect: when the POST stream drops before a
// terminal (report/error) event (tab refresh, network blip), the client resumes
// here from the last seq it saw and keeps consuming live progress. It is public +
// unauthenticated but strictly READ-ONLY — it does no outbound fetch (no SSRF
// surface) and starts no paid work; it only replays already-stored events.
//
// Query param: ?afterSeq=<n> (default 0) — emit only events with seq > n, so a
// reconnecting client picks up exactly where it left off without dupes.

import { getAnalysis } from '@/db/analyses';
import { analysisEventStream, sseHeaders } from '@/lib/sse-replay';

export const runtime = 'nodejs';
export const maxDuration = 300; // tail bounded internally; matches the run's window

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;

  // 404 an unknown id up front (real status — the stream hasn't opened). Don't
  // leak internals; a sanitized JSON error, matching GET /api/analyze/:id.
  const analysis = await getAnalysis(id);
  if (!analysis) return Response.json({ error: 'Analysis not found' }, { status: 404 });

  const url = new URL(request.url);
  const afterSeqRaw = Number(url.searchParams.get('afterSeq') ?? '0');
  const afterSeq = Number.isFinite(afterSeqRaw) && afterSeqRaw > 0 ? Math.floor(afterSeqRaw) : 0;

  return new Response(analysisEventStream(id, afterSeq), { headers: sseHeaders() });
}
