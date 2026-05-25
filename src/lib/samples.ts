// The "Try" repos surfaced on the home page. Their reports are pre-cached on the
// server and served sticky-by-repo (the latest succeeded analysis, regardless of
// the current commit) so an active repo's moving HEAD never triggers a paid
// re-run — and viewing them is exempt from the daily analysis cap. The whole
// point of the samples is that anyone can read them even when they can't run a
// fresh analysis. Shared by the page (the chips) and the API (the sticky path)
// so the two never drift.
export const SAMPLE_REPOS = [
  'zeroindex-ai/eval-pack',
  'zeroindex-ai/mcp-pack',
  'sindresorhus/slugify',
] as const;

export function isSampleRepo(owner: string, repo: string): boolean {
  return (SAMPLE_REPOS as readonly string[]).includes(`${owner}/${repo}`);
}
