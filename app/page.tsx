'use client';

import { useEffect, useRef, useState } from 'react';
import type { Report } from '@/report/schema';
import { SAMPLE_REPOS } from '@/lib/samples';
import { ReportView } from './ReportView';

type Stats = {
  citationsChecked: number;
  citationsValid: number;
  findingsKept: number;
  findingsDropped: number;
} | null;

type ReportPayload = {
  analysisId: string;
  repo: string;
  commitSha: string;
  cached: boolean;
  costMicroUsd: number;
  stats: Stats;
  report: Report;
};

type Status = 'idle' | 'running' | 'done' | 'error';
type ToolCall = { seq: number; name: string; input: unknown };

// A completed report survives a page refresh (sessionStorage, tab-scoped). Mirrors
// contract-lens's one-shot post-hydration restore. Only the finished result is
// persisted — a refresh *during* analysis drops the live stream, but the server
// finishes the run and caches it, so re-submitting the same repo returns instantly.
const RESULT_KEY = 'repo-xray:last-result';

// Cap reconnect attempts so a wedged/stalled analysis can't spin the client in a
// hot fetch loop. Each attempt re-attaches to the live tail from the last seq seen.
const MAX_RECONNECTS = 5;

// Human-readable labels for the pipeline phases the API streams. Exploring is the
// only phase with visible tool activity; the rest (esp. synthesizing) are silent,
// which is why the pulsing dot + ticking clock carry the "still working" signal.
const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting…',
  resolving: 'Resolving repository…',
  fetching: 'Fetching the file tree…',
  exploring: 'Exploring the codebase…',
  synthesizing: 'Writing the report…',
  validating: 'Validating citations…',
};

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function toolArg(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.path === 'string') return o.path;
    if (typeof o.query === 'string') return `"${o.query}"`;
  }
  return '';
}

export default function Home() {
  const [repo, setRepo] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [phase, setPhase] = useState('');
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [cost, setCost] = useState(0);
  const [result, setResult] = useState<ReportPayload | null>(null);
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);
  // Reconnect bookkeeping: the analysis id (learned from the early `id` event) and
  // the last run_events seq seen (the SSE `id:` line). If the POST stream drops
  // before a terminal event, we reconnect to GET …/events?afterSeq=<lastSeq>.
  const analysisIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);

  // Tick a wall-clock while a run is in flight — the strongest "not stuck" signal,
  // since the synthesis phase streams no tool calls and can run 20–40s silently.
  useEffect(() => {
    if (status !== 'running') return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(id);
  }, [status]);

  // One-shot restore of the last completed report so a refresh keeps it on screen.
  /* eslint-disable react-hooks/set-state-in-effect -- intentional one-shot restore of the persisted result */
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(RESULT_KEY);
      if (!saved) return;
      const payload = JSON.parse(saved) as ReportPayload;
      setResult(payload);
      setCost(payload.costMicroUsd);
      setStatus('done');
    } catch {
      /* ignore a corrupt or oversized restore — fall back to the empty form */
    }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Consume one SSE stream (the POST run OR a GET …/events reconnect), updating
  // the live UI. Returns true once a terminal (report/error) event is processed;
  // returns false if the stream ends WITHOUT a terminal (a dropped connection),
  // so the caller can reconnect. A surfaced `error` event throws (caught upstream).
  // Tracks the analysis id (early `id` event) + last seq seen (SSE `id:` line) so
  // a reconnect resumes from the right cursor without dupes.
  async function consumeStream(body: ReadableStream<Uint8Array>): Promise<boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawTerminal = false;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let evt = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) {
            const seq = Number(line.slice(3).trim());
            if (Number.isFinite(seq) && seq > lastSeqRef.current) lastSeqRef.current = seq;
          } else if (line.startsWith('event:')) evt = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (evt === 'id') {
          // Early control event: learn the analysis id so we can reconnect mid-run.
          if (typeof parsed.analysisId === 'string') analysisIdRef.current = parsed.analysisId;
        } else if (evt === 'phase') {
          setPhase(String(parsed.phase));
        } else if (evt === 'explore') {
          const ev = parsed.event as Record<string, unknown>;
          if (ev.type === 'tool_call') {
            const seq = Number(ev.seq);
            // De-dupe on reconnect: a replay re-emits backlog tool calls, so skip
            // any seq we've already rendered (the explore seq is stable per run).
            setTools((t) =>
              t.some((x) => x.seq === seq) ? t : [...t, { seq, name: String(ev.name), input: ev.input }]
            );
          } else if (ev.type === 'cost') {
            setCost(Number(ev.cumulativeMicroUsd));
          }
        } else if (evt === 'report') {
          sawTerminal = true;
          const payload = parsed as unknown as ReportPayload;
          if (!payload.analysisId && analysisIdRef.current) payload.analysisId = analysisIdRef.current;
          setResult(payload);
          setCost(payload.costMicroUsd);
          setStatus('done');
          try {
            sessionStorage.setItem(RESULT_KEY, JSON.stringify(payload));
          } catch {
            /* persistence is best-effort; the report still renders this session */
          }
        } else if (evt === 'error') {
          sawTerminal = true;
          throw new Error(String(parsed.message));
        }
      }
    }
    return sawTerminal;
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const value = repo.trim();
    if (!value || status === 'running') return;
    setStatus('running');
    setPhase('starting');
    setTools([]);
    setCost(0);
    setResult(null);
    setError('');
    setElapsedMs(0);
    startedAtRef.current = Date.now();
    analysisIdRef.current = null;
    lastSeqRef.current = 0;
    try {
      sessionStorage.removeItem(RESULT_KEY); // drop any stale restored result
    } catch {
      /* sessionStorage may be unavailable; the run still proceeds */
    }

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: value }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }

      let sawTerminal = await consumeStream(res.body);

      // Reconnect loop: if the stream ended (connection dropped / tab refresh blip)
      // before a terminal event AND we know the analysis id, resume live progress
      // from GET …/events?afterSeq=<last seq seen>. The server-side run keeps going
      // regardless; this just re-attaches the UI. Bounded retries avoid a hot loop
      // if the analysis is genuinely wedged.
      let attempts = 0;
      while (!sawTerminal && analysisIdRef.current && attempts < MAX_RECONNECTS) {
        attempts += 1;
        const id = analysisIdRef.current;
        const reconnect = await fetch(
          `/api/analyze/${encodeURIComponent(id)}/events?afterSeq=${lastSeqRef.current}`
        );
        if (!reconnect.ok || !reconnect.body) break;
        sawTerminal = await consumeStream(reconnect.body);
      }

      if (!sawTerminal) throw new Error('The analysis ended unexpectedly.');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  const active = status === 'error' || status === 'running' || (status === 'done' && !!result);

  return (
    <>
      <section className="pt-10 pb-8 no-print">
        <div className="label mb-3">Repo X-Ray</div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Get oriented in any GitHub repo.</h1>
        <p className="mt-4 muted text-base leading-relaxed max-w-5xl">
          Point Repo X-Ray at a public GitHub repository and an agent explores it the way a new engineer would
          &mdash; returning an onboarding guide, an architecture map, and risk hotspots, with every claim
          linked to the exact lines on GitHub.
        </p>

        <form onSubmit={run} className="mt-8 flex flex-col sm:flex-row gap-3 max-w-2xl">
          <label className="field flex-1">
            <span className="prefix" aria-hidden="true">
              github.com/
            </span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
              aria-label="GitHub repository (owner/repo)"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={status === 'running'}
            />
          </label>
          <button className="btn-primary" type="submit" disabled={status === 'running' || !repo.trim()}>
            {status === 'running' ? 'Analyzing…' : 'Analyze'} <span aria-hidden="true">&rarr;</span>
          </button>
        </form>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="label mr-1">Try</span>
          {SAMPLE_REPOS.map((ex) => (
            <button
              key={ex}
              type="button"
              className="example-chip"
              onClick={() => setRepo(ex)}
              disabled={status === 'running'}
            >
              {ex}
            </button>
          ))}
        </div>
      </section>

      {active && (
        <section className="pt-2 pb-24">
          {status === 'error' && <div className="error-state max-w-2xl">{error}</div>}

          {status === 'running' && (
            <div className="max-w-2xl">
              <p className="run-note mono text-xs muted-2">
                Keep this tab open &mdash; refreshing hides the live progress (the analysis keeps running, but
                you&rsquo;d need to re-submit to see the result).
              </p>
              <div className="card">
                <div className="flex items-center justify-between gap-3">
                  <span className="label flex items-center gap-2">
                    <span className="pulse-dot" aria-hidden="true" />
                    {PHASE_LABEL[phase] ?? phase}
                  </span>
                  <span className="mono text-xs muted-2 tabular-nums">
                    {clock(elapsedMs)}
                    <span className="meta-sep mx-2" aria-hidden="true">
                      &middot;
                    </span>
                    {usd(cost)}
                  </span>
                </div>
                <div className="mt-4 flex flex-col gap-1">
                  {tools.length === 0 ? (
                    <span className="run-line muted-2">Resolving repository&hellip;</span>
                  ) : (
                    tools.map((t) => (
                      <span key={t.seq} className="run-line">
                        <span className="muted-2">{String(t.seq).padStart(2, '0')}</span> {t.name}
                        <span className="muted-2">({toolArg(t.input)})</span>
                      </span>
                    ))
                  )}
                  {tools.length > 0 && (phase === 'synthesizing' || phase === 'validating') && (
                    <span className="run-line muted-2 mt-1">
                      {phase === 'validating'
                        ? 'Done reading — checking every citation against the source…'
                        : `Done reading ${tools.length} files — writing the report…`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {status === 'done' && result && (
            <div className="report-doc">
              <div className="event-meta mono text-xs muted-2 mb-8 no-print">
                <span>
                  {result.repo}@{result.commitSha.slice(0, 8)}
                </span>
                <span className="meta-sep">&middot;</span>
                <span>{result.cached ? 'cached' : 'fresh'}</span>
                <span className="meta-sep">&middot;</span>
                <span>{usd(result.costMicroUsd)}</span>
                {result.stats && (
                  <>
                    <span className="meta-sep">&middot;</span>
                    <span>
                      {result.stats.citationsValid}/{result.stats.citationsChecked} citations resolved
                    </span>
                  </>
                )}
                <button type="button" className="download-link ml-1" onClick={() => window.print()}>
                  <span aria-hidden="true">&darr;</span> Download PDF
                </button>
              </div>
              {/* Print-only header: the app chrome is hidden in the PDF, so stamp the
                  report with its source repo + commit for provenance. */}
              <div className="print-only report-print-head mono mb-6">
                {result.repo}@{result.commitSha.slice(0, 8)}
              </div>
              <ReportView repo={result.repo} commitSha={result.commitSha} report={result.report} />
            </div>
          )}
        </section>
      )}
    </>
  );
}
