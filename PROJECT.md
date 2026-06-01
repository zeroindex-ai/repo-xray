# Repo X-Ray — Project Documentation

> **Phase:** Production
> **Live:** [xray.zeroindex.ai](https://xray.zeroindex.ai) · **Repo:** github.com/zeroindex-ai/repo-xray

Point Repo X-Ray at a public GitHub repository and an agent explores the code with tools — reading the files a new engineer would read first — then returns an onboarding guide, an architecture map, and risk hotspots. Every statement links to the exact `file:line` on GitHub, so nothing has to be taken on faith.

It is a **first-pass code-understanding accelerant**, not a replacement for an engineer's judgment: it gets a human productive on an unfamiliar codebase in minutes instead of a day, and shows its work.

> **Section convention:** every numbered section below is expected. If one genuinely
> doesn't apply, the heading is kept with `— n/a: [reason]`.

---

## 1. Why this exists

Landing in an unfamiliar repository is slow and unstructured: you grep around, open the README, guess at the entry points, and slowly build a mental model. Repo X-Ray does that first sweep for you and hands back a structured, cited starting point — where to start reading, how the pieces fit, how to run it, and what looks risky. The audience is an engineer onboarding onto a new codebase (a new hire, a contractor picking up a project, or someone evaluating code they've inherited).

The bet is that an LLM with the right _tools and a budget_ — rather than a single prompt with the whole repo pasted in — produces a genuinely useful map, and that **citing every claim to real lines** is what makes the output trustworthy enough to act on.

### Goals & success criteria

| Goal | How I'll know it's met | Status |
| --- | --- | --- |
| Useful onboarding output on a real unfamiliar repo | A human gets oriented from the report alone, faster than reading cold | ☑ eval judge 5/5 |
| Every claim is verifiable | Deterministic check: 100% of shown citations resolve to their quoted lines | ☑ by construction (validator prunes the rest) |
| Runs stay within budget | Per-run cost and time bounded; global daily ceiling enforced; same commit never re-spent | ☑ |
| The agentic loop is observable | Every run's tool calls, tokens, latency, and cost visible live and in traces | ☑ live SSE + trace-pack |

**Out of scope (v0.1)** — deliberately deferred to keep the first version focused on the agent core:

- Private repositories (auth/permission complexity).
- Running or building the analyzed code.
- **Dependency vulnerability scanning (OSV)** — a clean deterministic add-on planned for v0.2, not the differentiator.
- Very large monorepos — file-count/size caps decline gracefully past `MAX_REPO_FILES` (default 2000).
- PR-diff mode and cross-repository comparison.

## 2. Strategic decisions

### Tech stack

| Choice | Why this | Alternative rejected |
| --- | --- | --- |
| Next 16 (app router) | SSR-everything report pages + API route handlers + the SSE stream in one deploy unit; house default. | — (house default) |
| Turso / libsql | Cheap edge SQLite for run state, reports, and the daily-cap counter; the `@libsql/client` lazy singleton is the portfolio standard. | Postgres — heavier than this workload needs |
| `@anthropic-ai/sdk` (Sonnet 4.6 explore · Opus 4.7 synthesize) | Two-phase: a cheap model runs the many-call tool loop, an expensive one synthesizes once. See the Sonnet-vs-Opus eval (Decision log). | Single model for both — fails the cost/quality split (eval-backed) |
| `undici` (its `fetch`) | Vercel's fetch instrumentation corrupts libsql's request ("expected non-null body source"); the client passes `undici`'s `fetch` decomposed to url+init. | Global `fetch` — breaks libsql on Vercel |
| Zod 4 | Validate the analyze request body and enforce the report schema (sections + findings + citations) at write time; doubles as the wire JSON-schema for synthesis. | Hand-rolled validation — no single source of truth |
| `@zeroindex-ai/eval-pack` | Golden-repo eval harness: onboarding-quality LLM judge + deterministic citation-resolution check; the contract for quality. | Ad-hoc eval scripts — not reproducible |
| vitest · pnpm · Vercel | House default | — |

### Key decisions

Each carries the alternative rejected so it can be re-litigated with full context.

- **Agentic exploration, not whole-repo stuffing.** The model is given tools to navigate the repo and a bounded budget, and it decides what to read. This scales to repos far larger than a context window and mirrors how an engineer actually explores. _Rejected:_ dumping the repo into one prompt (doesn't scale, no provenance, expensive).
- **Read via the GitHub API; never clone or execute.** The service fetches the git tree and file blobs on demand. It does not download the repo to disk or run any of its code, so there is no untrusted-execution surface to sandbox. _Rejected:_ tarball-to-temp (memory/time blowups on large repos) and code execution (unnecessary and unsafe).
- **Two-phase pipeline: explore, then synthesize.** A cheaper model (Sonnet 4.6) runs the many-call exploration loop and gathers cited evidence; a more capable model (Opus 4.7) runs once to synthesize the report. This puts the expensive model only where judgment is needed.
- **Provenance is the product.** Every finding carries structured evidence (`path`, line range, quoted snippet). A deterministic post-step (`src/report/validate.ts`) confirms each citation resolves to the quoted text before the report is shown; citations that don't resolve are dropped or flagged. "100% of citations resolve" is a metric statable plainly.
- **Cost and abuse control are first-class.** Each run spends real money, so: requests are SSRF-guarded to validated `github.com/owner/repo` targets only; runs are rate-limited per client and capped by a global daily spend ceiling — enforced via an **atomic up-front reservation** (a single guarded `UPDATE` writes the run's estimated cost onto its row only if the day's total still fits under the ceiling, then reconciles to real spend after the run), so concurrent submissions can't each pass a stale "under budget" read and collectively overshoot; and results are cached by `(repo, commit SHA)` so the same commit is never analyzed twice.
- **Observability built in.** Each run emits one span event — tool calls, tokens, latency, cost — to trace-pack's `/api/ingest` (env-gated, fire-and-forget), surfaced live to the user as the run streams.
- **Deliberately NOT chosen:** no auth framework — `/admin` is single-secret Basic Auth in root `proxy.ts` (`ADMIN_PASSWORD` + `timingSafeEqual`); no signin page / cookie / users table until there's a second admin user. No client-side data fetching for first paint (SSR everything).

## 3. Architecture

Request → report:

```
POST /api/analyze → cheap guards (body cap · SSRF · per-client rate limit · fast-fail budget read)
  → resolve ref→SHA → cache check (repo, SHA)
  → pipeline: fetch → explore (Sonnet, tool loop) → synthesize (Opus) → validate → persist
  → SSE stream (phase/explore/cost → report) → render
```

1. **Submit** `owner/repo` (+ optional ref). Validate and SSRF-guard the target, resolve it to a concrete commit SHA.
2. **Cache check** — if `(repo, SHA)` was already analyzed, return the stored report immediately.
3. **Run** the pipeline — inline in the streaming handler today, a durable workflow on the roadmap (see Known constraints):
   - **fetch** — repo metadata, language breakdown, the full git tree, and a set of seed files (README, package/dependency manifest, CI config, likely entry points). Tree + seeds are cached into the model's first turn.
   - **explore** — a bounded tool loop. The agent calls `list_directory`, `read_file` (line-numbered, range-capped at `MAX_LINES_PER_READ` = 400 so a single huge file can't exhaust the budget), and `search`, accumulating cited evidence notes. Hard limits on tool calls, tokens, and wall-clock; on budget exhaustion it is told to stop and synthesize.
   - **synthesize** — one Opus pass that turns the evidence into the structured report.
   - **validate** — deterministically confirm every citation's quoted text exists at the referenced lines; drop or flag failures.
   - **persist + render**.
4. **Stream** the run live to the browser (tool calls and a running cost meter) via server-sent events; render the finished report with section navigation and citation links to `github.com/owner/repo/blob/<SHA>/<path>#L<start>-L<end>`.

**Report output** is a strict, validated Zod schema: ordered sections, each finding carrying `severity` (for risk items) and an `evidence[]` array. Sections, in order (onboarding-led):

1. **Overview** — what the project is, in two or three sentences, cited.
2. **Onboarding** — "start here": the files to read first, how to build/run it, and the key concepts, each pointing at real code.
3. **Architecture** — modules and their responsibilities and the main data/control flow (with an optional diagram).
4. **Risk hotspots** — severity-tagged concerns found _in the code_ (not dependency CVEs — see Out of scope), each cited.

## 4. Public contract (v0.1)

- `POST /api/analyze` — body `{ repo, ref? }` (Zod-validated). Returns a **Server-Sent Events** stream: `phase` and `explore` markers (tool calls + a running cost meter), then a final `report` event (or `error`). The cheap guards — body-size cap, SSRF validation, per-client rate limit, and a fast-fail global-budget read — run _before_ the stream opens, so a clearly-rejected request still returns a real 4xx/5xx; once streaming starts the HTTP status is locked at 200. The **authoritative** global-budget gate is the atomic reservation inside the pipeline (§2); if it denies a run under concurrency the rejection arrives as an SSE `error` event.
- `GET /api/analyze/:id` — the stored analysis plus its report (`{ analysis, report, summary }`), or 404 if the id is unknown. Backs shareable report URLs and cached results. As a public, unauthenticated endpoint it never returns the internal `error` string — a failed analysis surfaces a generic `"Analysis unavailable"`; the raw detail is logged server-side and visible only in the owner-only admin console.
- `GET /api/analyze/:id/events?afterSeq=<n>` — replay + live-tail the run's stored events as SSE; backs **client reconnect** when the POST stream drops before a terminal event (tab refresh, network blip): the client resumes from the last `seq` it saw. Public, unauthenticated, strictly **read-only** — no outbound fetch (no SSRF surface), starts no paid work; emits only events with `seq > afterSeq` (default 0) so a reconnecting client picks up without dupes. 404s an unknown id up front.
- `/admin/*` — owner-only analyses list + per-analysis drill-down (stored report JSON, cost, cited findings), gated by root `proxy.ts` Basic Auth.

## 5. Data model

Turso/libsql. DDL in `src/db/migrations/` (applied in filename-sort order by `src/db/migrate.ts`; idempotent). Typed dependency-injectable accessors in `src/db/analyses.ts`.

- **`analyses`** — one run per `(owner, repo, commit_sha)`. Columns: `id` (PK), `owner`, `repo`, `ref?`, `commit_sha`, `status` (`queued | running | succeeded | failed`), `error?`, `cost_micro_usd` (default 0 — micro-USD avoids float drift and backs the atomic budget reservation), `default_branch?`, `tree_truncated` (0/1 — flags a repo over the file cap), `created_at` / `updated_at` (epoch ms) / `completed_at?`. **`UNIQUE INDEX idx_analyses_repo_sha (owner, repo, commit_sha)` is the dedupe key** — re-submitting a commit returns the existing row instead of re-spending.
- **`reports`** — the synthesized report, 1:1 with an analysis (`analysis_id` PK → `analyses.id`). `report_json` holds the full structured report (sections + findings + citations), shape enforced by the Zod schema at write time; nullable `summary`; `created_at`.
- **`run_events`** — ordered events for live streaming, reconnect/replay, and observability. `id` (autoincrement PK), `analysis_id` → `analyses.id`, `seq`, `type` (`tool_call | tool_result | status | cost | error`), `data_json`, `created_at`. Indexed `(analysis_id, seq)` to drive replay from a given seq.
- **`request_counts`** — per-client daily counter for the analyze endpoint. One row per `(bucket, day)` (PK), `count`. The atomic increment-with-cap in `src/lib/guards.ts` gates the expensive public endpoint; `bucket` is the hashed client key, `day` a UTC date.

> Migration history note: `0001_init` created a `rate_limit_buckets` token-bucket table inherited from the service scaffold; repo-xray gates via the daily cap + global-$ ceiling in `request_counts` instead, so `0003` drops it (append-only — `0001` still records it once existed).

## 6. Project structure

```
app/
  page.tsx · ReportView.tsx · HeaderNav.tsx   — submit UI + SSE-consuming report view
  layout.tsx · globals.css · favicon.ico      — chrome (favicon in app/, not public/)
  api/analyze/route.ts                         — POST: guards → pipeline → SSE
  api/analyze/[id]/route.ts                     — GET stored analysis+report
  api/analyze/[id]/events/route.ts              — GET SSE replay/live-tail (reconnect)
  admin/                                         — owner-only list + [id] drill-down + resample
src/
  agent/
    analyze.ts        — orchestrator (fetch→explore→synthesize→validate→persist), budget reservation
    explore.ts        — bounded tool loop; EXPLORE_MODEL = claude-sonnet-4-6
    synthesize.ts     — one synthesis pass; SYNTH_MODEL = claude-opus-4-7
    tools.ts          — list_directory · read_file · search tool defs
    cost.ts · messageParams.ts                  — token→$ accounting, prompt-cache message build
  lib/
    github.ts         — GitHub API layer: parseRepoInput, resolveCommitSha, fetchTree,
                        readFileRange (MAX_FILE_BYTES 256KB, MAX_LINES_PER_READ 400); SSRF guard
    guards.ts         — checkDailyCap + checkGlobalDailyBudget + reserveGlobalDailyBudget; clientKey hash
    sse-replay.ts     — analysisEventStream + sseHeaders (replay/live-tail)
    env.ts · format.ts · logAnalysis.ts · samples.ts · analyze-deps.ts
  db/
    client.ts         — lazy db() singleton (undici fetch workaround)
    analyses.ts       — typed, injectable accessors
    migrate.ts · migrations/000{1,2,3}_*.sql    — schema (filename-sort, idempotent)
  report/
    schema.ts         — Zod report schema (sections + findings + citations)
    validate.ts       — deterministic citation re-resolution + pruning
proxy.ts              — root Basic-auth gate for /admin/*
evals/                — golden.json + run.ts + checks.ts (@zeroindex-ai/eval-pack)
scripts/              — migrate-prod.ts · export-reports.ts · analyze.ts · seed-examples.ts
```

## 7. Distribution

A standalone page at `xray.zeroindex.ai` (Next.js app-router on Vercel, DNS-only at Cloudflare; Turso for state; owner-only admin behind Basic Auth). Deploy via the `deploy-zeroindex-vercel-app` skill (Turso → Vercel env → migrations → domain). Runs stream live; finished reports are shareable by URL and cached by commit. Dual-writes one observability span per analysis to **trace-pack** (`traces.zeroindex.ai/api/ingest`) when configured.

### Configuration

| Env var | Required? | Purpose / default |
| --- | --- | --- |
| `TURSO_DATABASE_URL` · `TURSO_AUTH_TOKEN` | yes | prod DB (local dev: `file:local.db`) |
| `ANTHROPIC_API_KEY` | yes | the `/api/analyze` agent calls Claude |
| `ADMIN_PASSWORD` | yes | `/admin/*` Basic Auth |
| `GITHUB_TOKEN` | recommended | lifts GitHub API rate limit 60→5000/hr; public-repo read-only is enough |
| `RATE_LIMIT_SALT` | optional | salt for the client-key hash; set random in prod so keys aren't guessable (default empty) |
| `ANALYZE_DAILY_CAP` | optional | per-client analyses per UTC day (default 5) |
| `GLOBAL_DAILY_USD_CEILING` | optional | global spend ceiling USD/UTC day (default 5) |
| `MAX_REPO_FILES` | optional | decline repos larger than this many files (default 2000) |
| `TRACE_PACK_URL` · `TRACE_PACK_TOKEN` · `TRACE_PACK_SOURCE` | optional | trace-pack dual-write; token must match trace-pack's `SOURCE_TOKEN_REPO_XRAY`; omit any to disable (no-op) |

## 8. Testing & evaluation

Unit tests (vitest, mocked model + network) cover the agent loop, cost accounting, GitHub layer, guards, SSE replay, report schema + validation, and the analyze route. `pnpm build` (next build) is the CI gate. A `*.live.test.ts` exercises live wiring (gated).

The **eval harness is the quality contract**: `pnpm eval` runs the golden repo set (`evals/`, via `@zeroindex-ai/eval-pack`) with an onboarding-quality LLM judge + a deterministic citation-resolution check. Don't change retrieval/prompts/models without re-running it. Headline metrics from the 2026-05-24 run: **Opus 4.7 synthesis = 5/5 pass, 95.8% mean citation-resolution** (pass floor 0.85). The synthesis model is a configurable eval dimension — see the Sonnet-vs-Opus A/B in the Decision log.

---

## Ordered work list

Ordered, not calendared.

- [x] Scaffold the service (Next.js + Turso).
- [x] Data model: `analyses` / `reports` / `run_events` / `request_counts`; typed dependency-injectable data layer in `src/db/analyses.ts`.
- [x] GitHub access layer: resolve ref → SHA, SSRF guard, tree fetch, blob/range read. _(code search deferred — add when the agent's search tool needs it)_
- [x] Agent tool definitions + bounded exploration loop (Sonnet, budgets, prompt caching, evidence capture, cost accounting).
- [x] Synthesis pass (Opus 4.7) → strict report schema (Zod + wire JSON-schema; sections + cited findings).
- [x] Deterministic citation-validation step (re-reads each cited range, prunes unresolved citations + evidence-less findings).
- [x] API: `POST /api/analyze` (SSE) + `GET /api/analyze/:id` (stored report) + `GET /api/analyze/:id/events` (reconnect replay).
- [x] Report UI consuming the SSE stream (live progress + cost meter) with citation links; completed reports survive a refresh.
- [x] Cost/abuse guards: per-client daily cap + global daily $ ceiling (`src/lib/guards.ts`); SHA-dedupe cache; SSRF guard in `github.ts`.
- [x] Span emission to trace-pack (one event per analysis; env-gated, fire-and-forget).
- [x] Eval set: golden repos + onboarding-quality LLM judge + deterministic citation-resolution check.
- [x] Deploy to `xray.zeroindex.ai`; admin view behind owner-only Basic Auth.
- [ ] Durable workflow wiring (fetch → explore → synthesize → validate → persist) with retries. _(v0.1 runs the pipeline inside the SSE handler; WDK is the durability upgrade — see Known constraints)_
- [ ] In-flight dedupe: short-circuit a concurrent submit of the same *uncached* commit onto the already-`running` analysis instead of starting a second paid pipeline. _(v0.1 dedupes only finished runs; the global reservation still bounds total daily spend)_
- [ ] Content `search` (the agent's `search` tool currently matches file paths only, not file contents) and OSV dependency scanning — both v0.2.

## Decision log (running)

Newest first. Every entry dated.

- **2026-06-01** — Documentation normalized to the 14-section web-service baseline: added the explicit Tech-stack table, the annotated project-structure tree, and the column-level data model; documented the `GET /api/analyze/:id/events` reconnect endpoint in the public contract; fixed a dangling "§11" cross-reference (the doc had no §11). No design change.
- **2026-05-24 — Synthesis model: Sonnet vs Opus (eval).** Exploration runs on Sonnet 4.6 (cheap, many tool calls); synthesis runs on Opus 4.7 (one expensive call). The eval set ran both synthesis models across the golden repos:

  | Synthesis model | Pass | Mean citation-resolution | Total cost |
  | --------------- | ---- | ------------------------ | ---------- |
  | Opus 4.7        | 5/5  | 95.8%                    | $2.44      |
  | Sonnet 4.6      | 4/5  | 91.3%                    | $1.52      |

  Sonnet is ~38% cheaper but drops citation-resolution on every non-trivial repo (and fell below the 0.85 floor on one). Since cited, verifiable findings are the product's whole point — and volume is bounded by the daily/global cost guards — **Opus stays the synthesis model**. Decision made with numbers, not assumption; revisit if volume grows.

## Known constraints & future work

- **Cost** — the per-run budget, global daily ceiling (atomic reservation, §2), and SHA-dedupe cache are load-bearing, not optional. Known residual: the SHA cache short-circuits only *finished* runs, so two near-simultaneous submits of the same *uncached* commit can each run the full paid pipeline (the global reservation still bounds the day's total spend; the per-commit double-spend is the gap). In-flight (`status==='running'`) dedupe is a roadmap item.
- **Durability** — v0.1 runs the steps inline inside the streaming handler; the headline roadmap item is the resume-rather-than-restart (and re-spend) upgrade via a step-based workflow engine (WDK): discrete `fetch → explore → synthesize → validate → persist` steps with per-step retries.
- **Large repos** — the agent must prioritize ruthlessly; the budget stop is what guarantees termination. File-count/size caps decline gracefully past `MAX_REPO_FILES`.
- **GitHub rate limits** — needs a token for any real throughput (60→5000/hr).
- **Citation drift** — the deterministic validation step is what keeps "every claim is cited" honest.
- **Content search + OSV** — both deferred to v0.2 (the `search` tool matches file paths only today).

## User personas

- **Engineer onboarding onto an unfamiliar repo** (new hire, contractor, or someone evaluating inherited code) — values a trustworthy, cited starting point over a confident-but-unverifiable summary. This is why provenance (every claim → `file:line`) and the onboarding-led section order drive the UX, not raw coverage.

## Cross-references

- **trace-pack** (`traces.zeroindex.ai`) — observability sink; repo-xray dual-writes one span per analysis to its `/api/ingest`.
- **@zeroindex-ai/eval-pack** — the eval harness (`evals/`) depends on it.
- Skills: `deploy-zeroindex-vercel-app` (deploy), `zeroindex-app-layout` (chrome/layout).
- Design tokens: `STYLE_GUIDE.md` in the `zeroindex-site` repo (mirrored in `app/globals.css`).
