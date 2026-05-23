// End-to-end smoke / CLI: analyze a public GitHub repo and print the report.
//
// Run with secrets injected at runtime (never written to disk):
//
//   TURSO_DATABASE_URL=file:local.db \
//   ANTHROPIC_API_KEY="$(op read 'op://<vault>/repo-xray/ANTHROPIC_API_KEY')" \
//   GITHUB_TOKEN="$(op read 'op://<vault>/repo-xray/GITHUB_TOKEN')" \
//   pnpm tsx scripts/analyze.ts <owner/repo[@ref]>
//
// Pick a SMALL repo for the first run — each analysis spends real API budget.

import Anthropic from '@anthropic-ai/sdk';
import { analyzeRepo, liveAnalyzeDeps } from '../src/agent/analyze';
import type { MessagesClient } from '../src/agent/explore';

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: tsx scripts/analyze.ts <owner/repo[@ref]>');
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠  GITHUB_TOKEN not set — unauthenticated GitHub is limited to 60 requests/hour.');
  }

  const anthropic = new Anthropic({ apiKey }) as unknown as MessagesClient;
  const deps = liveAnalyzeDeps({ anthropic, githubToken: process.env.GITHUB_TOKEN });

  console.log(`\n→ Analyzing ${input}\n`);
  const result = await analyzeRepo(input, deps, {
    onEvent: (e) => {
      if (e.type === 'phase') {
        console.log(`  [${e.phase}]`);
      } else if (e.event.type === 'tool_call') {
        console.log(`    tool ${e.event.seq}: ${e.event.name}(${JSON.stringify(e.event.input)})`);
      } else if (e.event.type === 'cost') {
        process.stdout.write(`    cost so far: ${usd(e.event.cumulativeMicroUsd)}\r`);
      }
    },
  });

  console.log(`\n\n=== Report for ${input} @ ${result.commitSha.slice(0, 8)} ===`);
  console.log(`cached: ${result.cached} · cost: ${usd(result.costMicroUsd)}`);
  if (result.stats) {
    console.log(
      `citations: ${result.stats.citationsValid}/${result.stats.citationsChecked} resolved · ` +
        `findings kept: ${result.stats.findingsKept}, dropped: ${result.stats.findingsDropped}`
    );
  }
  console.log(`\n${result.report.summary}\n`);
  for (const section of result.report.sections) {
    console.log(`## ${section.title} (${section.kind})`);
    for (const f of section.findings) {
      const sev = f.severity ? `[${f.severity}] ` : '';
      console.log(`  • ${sev}${f.claim}`);
      for (const c of f.evidence) {
        console.log(`      ${c.path}:${c.startLine}-${c.endLine}`);
      }
    }
  }
  console.log('');
}

void main();
