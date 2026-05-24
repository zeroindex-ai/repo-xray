// Pre-warm the prod analysis cache for the homepage example repos so the example
// buttons return instantly (and for free) on first click. Re-runnable: a repo
// already cached at its current commit comes back as a no-op CACHED hit. Run
// after a deploy, or when an example repo gets new commits.
//
//   pnpm tsx scripts/seed-examples.ts                       # against prod
//   REPO_XRAY_URL=http://localhost:3000 pnpm tsx scripts/seed-examples.ts
//
// Each fresh (uncached) repo costs real Anthropic spend. Requests are serial to
// stay under the per-client daily cap and be gentle on the endpoint.

// Keep in sync with EXAMPLES in app/page.tsx.
const EXAMPLES = ['zeroindex-ai/eval-pack', 'zeroindex-ai/mcp-pack', 'sindresorhus/slugify'];
const BASE = process.env.REPO_XRAY_URL ?? 'https://xray.zeroindex.ai';

type ReportPayload = {
  commitSha: string;
  cached: boolean;
  costMicroUsd: number;
  stats: { citationsChecked: number; citationsValid: number } | null;
};

async function seed(repo: string): Promise<void> {
  process.stdout.write(`→ ${repo} … `);
  const res = await fetch(`${BASE}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => '');
    console.log(`FAILED (${res.status}) ${msg.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evt = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) evt = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      if (evt === 'report') {
        const p = JSON.parse(data) as ReportPayload;
        const cites = p.stats ? `${p.stats.citationsValid}/${p.stats.citationsChecked} citations` : 'n/a';
        console.log(
          `${p.cached ? 'CACHED' : 'fresh '} @ ${p.commitSha.slice(0, 8)} · $${(p.costMicroUsd / 1e6).toFixed(4)} · ${cites}`
        );
        return;
      }
      if (evt === 'error') {
        console.log(`ERROR ${(JSON.parse(data) as { message: string }).message}`);
        process.exitCode = 1;
        return;
      }
    }
  }
  console.log('stream ended with no report event');
  process.exitCode = 1;
}

async function main() {
  console.log(`Seeding ${EXAMPLES.length} example(s) against ${BASE}\n`);
  for (const repo of EXAMPLES) await seed(repo);
}

void main();
