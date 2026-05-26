// GET /api/analyze/:id — fetch a stored analysis + its report (for shareable
// report URLs and cached results). Returns 404 if the id is unknown.

import { getAnalysis, getReport, type Analysis } from '@/db/analyses';

export const runtime = 'nodejs';

// The raw `analysis.error` is internal, caught-exception text (e.g. a sliced
// GitHub API response body) and this is a public, unauthenticated endpoint
// backing shareable URLs — so we never return it. The real detail is logged
// server-side; the client sees only a generic message, matching how the POST
// handler sanitizes its failures. Everything else on the row is safe to expose.
function toPublicAnalysis(a: Analysis): Analysis {
  if (a.status === 'failed' && a.error) {
    console.error(`[analyze:${a.id}] stored failure surfaced via GET:`, a.error);
  }
  // Overwrite the raw internal error with a generic message (never expose it).
  return { ...a, error: a.status === 'failed' ? 'Analysis unavailable' : null };
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const analysis = await getAnalysis(id);
  if (!analysis) return Response.json({ error: 'Analysis not found' }, { status: 404 });
  const stored = await getReport(id);
  return Response.json({
    analysis: toPublicAnalysis(analysis),
    report: stored?.report ?? null,
    summary: stored?.summary ?? null,
  });
}
