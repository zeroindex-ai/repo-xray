// POST /admin/resample — owner-only re-run of a sample ("Try") repo. Behind the
// admin Basic-auth gate (proxy.ts matches /admin/:path*), so no separate auth here.
// Samples are served sticky-by-repo and never auto-refresh; this forces a fresh
// analysis at the repo's CURRENT HEAD (sticky:false), which becomes the new latest
// the sticky path serves. If HEAD is unchanged it hits the per-commit cache and
// returns the existing report (no spend). Cap/budget are not applied — admin action.

import { z } from 'zod';
import { analyzeRepo, type AnalyzeDeps } from '@/agent/analyze';
import { parseRepoInput } from '@/lib/github';
import { liveDepsFromEnv } from '@/lib/analyze-deps';
import { isSampleRepo } from '@/lib/samples';
import { logAnalysis } from '@/lib/logAnalysis';

export const runtime = 'nodejs';
export const maxDuration = 300; // a fresh analysis is long

const BodySchema = z.object({ repo: z.string().min(1).max(200) });

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return json(400, { error: 'Invalid request body — expected { repo }' });
  }

  let ref;
  try {
    ref = parseRepoInput(body.repo);
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }

  // Defense in depth: re-run is sample-only even though the route is admin-gated.
  if (!isSampleRepo(ref.owner, ref.repo)) {
    return json(403, { error: 'Re-run is limited to the sample repos.' });
  }

  let deps: AnalyzeDeps;
  try {
    deps = liveDepsFromEnv();
  } catch (e) {
    console.error('[resample] setup failed:', e);
    return json(500, { error: 'The analysis service is unavailable right now.' });
  }

  const repo = `${ref.owner}/${ref.repo}`;
  const t0 = Date.now();
  try {
    const result = await analyzeRepo(repo, deps, { sticky: false });
    logAnalysis({
      status: 'ok',
      totalMs: Date.now() - t0,
      repo,
      analysisId: result.analysisId,
      commitSha: result.commitSha,
      cached: result.cached,
      costMicroUsd: result.costMicroUsd,
    });
    return json(200, {
      repo,
      analysisId: result.analysisId,
      commitSha: result.commitSha,
      cached: result.cached,
      costMicroUsd: result.costMicroUsd,
    });
  } catch (e) {
    logAnalysis({ status: 'error', totalMs: Date.now() - t0, repo, outcomeReason: (e as Error).message });
    return json(500, { error: (e as Error).message });
  }
}
