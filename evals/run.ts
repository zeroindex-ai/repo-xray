// repo-xray eval runner. Mirrors ask-zeroindex/contract-lens: runEval over a
// golden set of repos, deterministic checks + an onboarding-quality LLM judge,
// then a summary.
//
//   pnpm eval                      # all repos, in-process, default (Opus) synthesis
//   pnpm eval micro-lib 2          # filter category, limit 2
//   SYNTH_MODEL=claude-sonnet-4-6 pnpm eval   # the Sonnet-vs-Opus A/B
//   EVAL_TARGET_URL=https://xray.zeroindex.ai pnpm eval   # hit the deployed stack
//   EVAL_JUDGE=none pnpm eval      # skip the LLM judge (deterministic only)
//
// The summary prints mean citation-resolution + total cost, so two runs with
// different SYNTH_MODEL are directly comparable. Run with secrets injected:
//   ANTHROPIC_API_KEY="$(op read 'op://<vault>/repo-xray/ANTHROPIC_API_KEY')" \
//   GITHUB_TOKEN="$(op read 'op://<vault>/repo-xray/GITHUB_TOKEN')" pnpm eval

import { mustMention, p50, p95, runEval, type PassRule, type RunReport } from '@zeroindex-ai/eval-pack';
import { claudeJudge } from '@zeroindex-ai/eval-pack/judge-claude';
import { checks, citationRatio } from './checks';
import { subject } from './subject';

const [onlyCategory, limitArg] = process.argv.slice(2);
const limit = limitArg ? Number(limitArg) : undefined;
const threshold = Number(process.env.EVAL_PASS_THRESHOLD) || 0.8;

// Grounding is checked deterministically (citation_resolution), so the judge is
// scored on usefulness only: a result passes when every check is ok and the
// judge didn't deem the report inappropriate.
const passRule: PassRule = (result) =>
  result.checks.every((c) => c.ok) && (result.judgment === null || result.judgment.appropriate !== 'no');

const JUDGE_SYSTEM = [
  'You are evaluating a first-pass onboarding report an AI generated about a GitHub repository',
  'for a new engineer. Judge whether it would genuinely help someone get oriented: does it',
  'accurately convey what the project is, where to start, how the code is organized, and what to',
  'watch out for — without obvious errors or invented claims? Citations are validated separately,',
  'so rate accuracy and usefulness, not citation formatting.',
].join(' ');

const JUDGE_GUIDANCE =
  'For "appropriate": yes if the report is an accurate, useful orientation; partial if thin or ' +
  'partly off; no if wrong or unhelpful. For "grounded": yes if claims are specific and concrete, else na.';

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const synthModel = process.env.SYNTH_MODEL ?? 'default (Opus 4.7)';
  const target = process.env.EVAL_TARGET_URL ?? 'in-process';
  console.log(`\nrepo-xray eval — synth model: ${synthModel} · target: ${target}\n`);

  const report: RunReport = await runEval({
    golden: 'evals/golden.json',
    subject,
    checks: [...checks, mustMention()],
    judge:
      process.env.EVAL_JUDGE === 'none'
        ? undefined
        : claudeJudge({ system: JUDGE_SYSTEM, categoryGuidance: JUDGE_GUIDANCE }),
    passRule,
    resultsDir: 'evals/results',
    filter: {
      ...(onlyCategory ? { category: onlyCategory } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    onItem: (e) => {
      if (e.type === 'start') process.stdout.write(`  [${e.index + 1}/${e.total}] ${e.item.id.padEnd(16)} `);
      else if (e.type === 'pass') console.log(`✓ ${e.result.timings.totalMs}ms`);
      else if (e.type === 'fail') console.log(`✗ ${e.result.timings.totalMs}ms`);
      else if (e.type === 'error') console.log(`ERROR: ${e.error.message}`);
    },
  });

  const { results, errors } = report;
  const passed = results.filter((r) => r.pass).length;
  const ratios = results.map(citationRatio).filter((r): r is number => r !== null);
  const meanCite = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;
  const totalCost = results.reduce((a, r) => a + Number(r.metadata.costMicroUsd ?? 0), 0);
  const latencies = results.map((r) => r.timings.totalMs);

  console.log('\n  id                cite     cost     ms');
  console.log('  ' + '-'.repeat(44));
  for (const r of results) {
    const c = citationRatio(r);
    console.log(
      `  ${r.id.padEnd(16)} ${(c === null ? '  n/a' : pct(c)).padStart(6)}  ${('$' + (Number(r.metadata.costMicroUsd ?? 0) / 1e6).toFixed(4)).padStart(8)} ${String(r.timings.totalMs).padStart(6)}${r.pass ? '' : '  ✗'}`
    );
  }

  console.log('\n=== Summary ===');
  console.log(`  synth model:            ${synthModel}`);
  console.log(
    `  pass:                   ${passed}/${results.length} (${pct(results.length ? passed / results.length : 0)})`
  );
  console.log(`  mean citation-resolution: ${pct(meanCite)}`);
  console.log(`  total cost:             $${(totalCost / 1e6).toFixed(4)}`);
  console.log(`  latency:                p50 ${p50(latencies)}ms · p95 ${p95(latencies)}ms`);
  if (report.jsonPath) console.log(`  results:                ${report.jsonPath}`);

  if (errors.length) {
    console.log('\n  errors:');
    for (const e of errors) console.log(`    ${e.id}: ${e.error}`);
  }

  const passRate = results.length ? passed / results.length : 0;
  if (passRate < threshold) {
    console.error(`\n✗ pass rate ${pct(passRate)} below threshold ${pct(threshold)}`);
    process.exit(1);
  }
  console.log(`\n✓ pass rate ${pct(passRate)} ≥ threshold ${pct(threshold)}`);
}

void main();
