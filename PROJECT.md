# Repo X-Ray

> Status: **live** at [xray.zeroindex.ai](https://xray.zeroindex.ai)

Point Repo X-Ray at a public GitHub repository and an agent explores the code with tools — reading the files a new engineer would read first — then returns an onboarding guide, an architecture map, and risk hotspots. Every statement links to the exact `file:line` on GitHub, so nothing has to be taken on faith.

It is a **first-pass code-understanding accelerant**, not a replacement for an engineer's judgment: it gets a human productive on an unfamiliar codebase in minutes instead of a day, and shows its work.

---

## 1. Why this exists

Landing in an unfamiliar repository is slow and unstructured: you grep around, open the README, guess at the entry points, and slowly build a mental model. Repo X-Ray does that first sweep for you and hands back a structured, cited starting point — where to start reading, how the pieces fit, how to run it, and what looks risky. The audience is an engineer onboarding onto a new codebase (a new hire, a contractor picking up a project, or someone evaluating code they've inherited).

The bet is that an LLM with the right _tools and a budget_ — rather than a single prompt with the whole repo pasted in — produces a genuinely useful map, and that **citing every claim to real lines** is what makes the output trustworthy enough to act on.

## 2. Strategic decisions

- **Agentic exploration, not whole-repo stuffing.** The model is given tools to navigate the repo and a bounded budget, and it decides what to read. This scales to repos far larger than a context window and mirrors how an engineer actually explores. _Rejected:_ dumping the repo into one prompt (doesn't scale, no provenance, expensive).
- **Read via the GitHub API; never clone or execute.** The service fetches the git tree and file blobs on demand. It does not download the repo to disk or run any of its code, so there is no untrusted-execution surface to sandbox. _Rejected:_ tarball-to-temp (memory/time blowups on large repos) and code execution (unnecessary and unsafe).
- **Two-phase pipeline: explore, then synthesize.** A cheaper model runs the many-call exploration loop and gathers cited evidence; a more capable model runs once to synthesize the report from that evidence. This puts the expensive model only where judgment is needed.
- **Durable orchestration.** An exploration run is long and multi-step, so it runs as a durable, step-based workflow with per-step retries — a crash or timeout resumes rather than restarts (and re-spends).
- **Provenance is the product.** Every finding carries structured evidence (`path`, line range, quoted snippet). A deterministic post-step validates that each citation actually resolves to the quoted text before the report is shown; citations that don't resolve are dropped or flagged. "100% of citations resolve" is a metric we can state plainly.
- **Cost and abuse control are first-class.** Each run spends real money on model calls, so: requests are SSRF-guarded to validated `github.com/owner/repo` targets only; runs are rate-limited per client and capped by a global daily spend ceiling; and results are cached by `(repo, commit SHA)` so the same commit is never analyzed twice.
- **Observability built in.** Each run emits spans — tool calls, tokens, latency, and cost — to an external tracing endpoint, surfaced live to the user as the run streams.

## 3. Architecture

Request → report:

1. **Submit** `owner/repo` (+ optional ref). Validate and SSRF-guard the target, resolve it to a concrete commit SHA.
2. **Cache check** — if `(repo, SHA)` was already analyzed, return the stored report immediately.
3. **Run** a durable workflow:
   - **fetch** — repo metadata, language breakdown, the full git tree, and a set of seed files (README, package/dependency manifest, CI config, likely entry points). Tree + seeds are cached into the model's first turn.
   - **explore** — a bounded tool loop. The agent calls `list_directory`, `read_file` (line-numbered, range-capped so a single huge file can't exhaust the budget), and `search`, accumulating cited evidence notes. Hard limits on tool calls, tokens, and wall-clock; on budget exhaustion it is told to stop and synthesize.
   - **synthesize** — one pass that turns the evidence into the structured report.
   - **validate** — deterministically confirm every citation's quoted text exists at the referenced lines; drop or flag failures.
   - **persist + render**.
4. **Stream** the run live to the browser (tool calls and a running cost meter) via server-sent events; render the finished report with section navigation and citation links to `github.com/owner/repo/blob/<SHA>/<path>#L<start>-L<end>`.

**Data model (Turso/libsql):** an `analyses` row keyed by `(repo, commit_sha)` with status and cost, plus the persisted evidence and the final report (sections + findings + citations). Ingest is idempotent on `(repo, commit_sha)`.

**Report output** is a strict, validated schema: ordered sections, each finding carrying `severity` (for risk items) and an `evidence[]` array.

## 4. Public contract (v0.1)

- `POST /api/analyze` `{ repo, ref? }` → `{ id, status, cached }`.
- `GET /api/analyze/:id/stream` → SSE stream of run progress (tool calls, cost) until completion.
- `GET /api/analyze/:id` → status, and the report JSON once ready.

**Report sections, in order (onboarding-led):**

1. **Overview** — what the project is, in two or three sentences, cited.
2. **Onboarding** — "start here": the files to read first, how to build/run it, and the key concepts, each pointing at real code.
3. **Architecture** — modules and their responsibilities and the main data/control flow (with an optional diagram).
4. **Risk hotspots** — severity-tagged concerns found _in the code_ (not dependency CVEs — see non-goals), each cited.

## 5. Distribution

A standalone page at `xray.zeroindex.ai` (Next.js app-router on Vercel, Turso for state, owner-only admin behind basic auth). A GitHub API token raises the read rate limit. Runs stream live; finished reports are shareable by URL and cached by commit.

---

## Non-goals (v0.1)

Deliberately out of scope to keep the first version focused on the agent core:

- Private repositories (auth/permission complexity).
- Running or building the analyzed code.
- **Dependency vulnerability scanning (OSV)** — a clean deterministic add-on planned for v0.2, not the differentiator.
- Very large monorepos — enforce file-count/size caps and decline gracefully past them.
- PR-diff mode and cross-repository comparison.

## Risks / watch-items

- **Cost** — the per-run budget, global daily ceiling, and SHA-dedupe cache are load-bearing, not optional.
- **Large repos** — the agent must prioritize ruthlessly; the budget stop is what guarantees termination.
- **GitHub rate limits** — needs a token for any real throughput.
- **Citation drift** — the deterministic validation step is what keeps "every claim is cited" honest.

---

## Work list

Ordered, not calendared.

- [x] Scaffold the service (Next.js + Turso).
- [x] Data model: `analyses` (dedupe-keyed on owner/repo/sha), `reports` (1:1 structured report JSON), `run_events` (ordered, for SSE replay), `request_counts` (daily cap); typed dependency-injectable data layer in `src/db/analyses.ts`.
- [x] GitHub access layer: resolve ref → SHA, SSRF guard, tree fetch, blob/range read. _(code search deferred — add when the agent's search tool needs it)_
- [x] Agent tool definitions + bounded exploration loop (Sonnet, budgets, prompt caching, evidence capture, cost accounting). _(unit-tested with a mocked model; live wiring + smoke pending)_
- [x] Synthesis pass (Opus 4.7) → strict report schema (Zod + wire JSON-schema; sections + cited findings). _(unit-tested with a mocked model)_
- [x] Deterministic citation-validation step (re-reads each cited range, prunes unresolved citations + evidence-less findings).
- [ ] Durable workflow wiring (fetch → explore → synthesize → validate → persist) with retries. _(v0.1 runs the pipeline inside the SSE handler; WDK is the durability upgrade)_
- [x] API: `POST /api/analyze` (SSE stream of phase/tool/cost events → final report) + `GET /api/analyze/:id` (stored report).
- [x] Report UI consuming the SSE stream (live progress + cost meter) with citation links; completed reports survive a refresh.
- [x] Cost/abuse guards: per-client daily cap + global daily $ ceiling (`src/lib/guards.ts`); SHA-dedupe cache (already in the orchestrator). SSRF guard in github.ts.
- [x] Span emission to the external tracing endpoint (one event per analysis; env-gated, fire-and-forget).
- [x] Eval set: golden repos + onboarding-quality LLM judge + deterministic citation-resolution check (`evals/`, via `@zeroindex-ai/eval-pack`). Synthesis model is a configurable dimension — see the model A/B below.
- [x] Deploy to `xray.zeroindex.ai`.
- [ ] Admin view.

### Synthesis model: Sonnet vs Opus (eval, 2026-05-24)

Exploration runs on Sonnet 4.6 (cheap, many tool calls); synthesis runs on Opus 4.7 (one expensive call). The eval set ran both synthesis models across the golden repos:

| Synthesis model | Pass | Mean citation-resolution | Total cost |
| --------------- | ---- | ------------------------ | ---------- |
| Opus 4.7        | 5/5  | 95.8%                    | $2.44      |
| Sonnet 4.6      | 4/5  | 91.3%                    | $1.52      |

Sonnet is ~38% cheaper but drops citation-resolution on every non-trivial repo (and fell below the 0.85 floor on one). Since cited, verifiable findings are the product's whole point — and volume is bounded by the daily/global cost guards — **Opus stays the synthesis model**. Decision made with numbers, not assumption; revisit if volume grows.

## Goals & success criteria

| Goal                                               | How I'll know it's met                                                                   | Status                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| Useful onboarding output on a real unfamiliar repo | A human gets oriented from the report alone, faster than reading cold                    | ☑ eval judge 5/5                              |
| Every claim is verifiable                          | Deterministic check: 100% of shown citations resolve to their quoted lines               | ☑ by construction (validator prunes the rest) |
| Runs stay within budget                            | Per-run cost and time bounded; global daily ceiling enforced; same commit never re-spent | ☑                                             |
| The agentic loop is observable                     | Every run's tool calls, tokens, latency, and cost visible live and in traces             | ☑ live SSE + trace-pack                       |
