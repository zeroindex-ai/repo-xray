// GET /api/analyze/:id — fetch a stored analysis + its report (for shareable
// report URLs and cached results). Returns 404 if the id is unknown.

import { getAnalysis, getReport } from '@/db/analyses';

export const runtime = 'nodejs';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const analysis = await getAnalysis(id);
  if (!analysis) return Response.json({ error: 'Analysis not found' }, { status: 404 });
  const stored = await getReport(id);
  return Response.json({
    analysis,
    report: stored?.report ?? null,
    summary: stored?.summary ?? null,
  });
}
