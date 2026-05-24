// The pipeline under test. Two modes, like contract-lens:
//   - in-process (default): runs analyzeRepo against an in-memory DB with live
//     deps. SYNTH_MODEL applies here — this is the mode for the Sonnet-vs-Opus A/B.
//   - EVAL_TARGET_URL=https://xray.zeroindex.ai: POSTs to the deployed /api/analyze
//     and consumes the SSE stream (tests the prod stack; uses the deployed model).
//
// The eval reads the analysis stats (citations, findings, cost) from result
// metadata; `text` is a flat rendering of the report for must_mention + the judge.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@libsql/client';
import type { AnswerResult, Subject } from '@zeroindex-ai/eval-pack';
import { analyzeRepo, liveAnalyzeDeps } from '../src/agent/analyze';
import type { MessagesClient } from '../src/agent/explore';
import { migrate } from '../src/db/migrate';
import type { Report } from '../src/report/schema';

// undefined => the pipeline default (Opus 4.7). Set e.g. claude-sonnet-4-6 to A/B.
const SYNTH_MODEL = process.env.SYNTH_MODEL;
const TARGET_URL = process.env.EVAL_TARGET_URL;

type Stats = {
  citationsChecked: number;
  citationsValid: number;
  findingsKept: number;
  findingsDropped: number;
} | null;

function reportToText(report: Report): string {
  const lines: string[] = [report.summary, ''];
  for (const s of report.sections) {
    lines.push(`## ${s.title}`);
    for (const f of s.findings) lines.push(`- ${f.claim} — ${f.detail}`);
  }
  return lines.join('\n');
}

function answer(opts: {
  report: Report;
  stats: Stats;
  costMicroUsd: number;
  commitSha: string;
  cached: boolean;
  model: string;
  totalMs: number;
}): AnswerResult {
  return {
    text: reportToText(opts.report),
    metadata: {
      stats: opts.stats,
      costMicroUsd: opts.costMicroUsd,
      commitSha: opts.commitSha,
      cached: opts.cached,
      sections: opts.report.sections.length,
      model: opts.model,
      totalMs: opts.totalMs,
    },
  };
}

async function inProcess(repo: string): Promise<AnswerResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for in-process eval (or set EVAL_TARGET_URL)');
  const db = createClient({ url: ':memory:' });
  await migrate(db);
  const anthropic = new Anthropic({ apiKey }) as unknown as MessagesClient;
  const deps = liveAnalyzeDeps({ anthropic, githubToken: process.env.GITHUB_TOKEN, db });

  const t0 = Date.now();
  const result = await analyzeRepo(repo, deps, { synthModel: SYNTH_MODEL });
  return answer({
    report: result.report,
    stats: result.stats,
    costMicroUsd: result.costMicroUsd,
    commitSha: result.commitSha,
    cached: result.cached,
    model: SYNTH_MODEL ?? 'default(opus)',
    totalMs: Date.now() - t0,
  });
}

async function viaEndpoint(url: string, repo: string): Promise<AnswerResult> {
  const t0 = Date.now();
  const res = await fetch(`${url.replace(/\/$/, '')}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  if (!res.ok || !res.body) throw new Error(`analyze failed (${res.status})`);

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
        const p = JSON.parse(data) as {
          report: Report;
          stats: Stats;
          costMicroUsd: number;
          commitSha: string;
          cached: boolean;
        };
        return answer({ ...p, model: 'deployed', totalMs: Date.now() - t0 });
      }
      if (evt === 'error') throw new Error((JSON.parse(data) as { message: string }).message);
    }
  }
  throw new Error('stream ended with no report event');
}

export const subject: Subject = (question) =>
  TARGET_URL ? viaEndpoint(TARGET_URL, question) : inProcess(question);
