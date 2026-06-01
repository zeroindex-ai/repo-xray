# Repo X-Ray — agent guide

Point Repo X-Ray at a public GitHub repository and an agent explores the code with tools, then returns a cited onboarding guide, an architecture map, and risk hotspots. Next 16 app on Vercel, Turso for state; a two-phase Sonnet-explore / Opus-synthesize pipeline streamed live over SSE.

The *why* and the architecture live in `PROJECT.md`. This file is how to work here.

## Guardrails (do not violate)

- **Never commit secrets.** `.env.local` and real Turso/Anthropic/GitHub/etc. keys
  stay out of git (`.gitignore` covers them — double-check before `git add -A`).
- **Public repo → sanitize docs.** No machine paths, vault names, private-memory
  refs, or sprint/portfolio framing in any committed `.md`. The `md-review-gate`
  hook enforces this at commit time.
- **Branch before the first commit.** Run `git branch` and confirm — repos are
  sometimes left on an in-flight feature branch. Don't assume `main`.
- **Visual changes: preview before commit.** Run the dev server and get a human
  eyeball/approval BEFORE committing UI changes. Non-visual changes follow normal flow.
- **Scope UI edits to the named element.** "Make X taller" changes only X. Decouple
  shared tokens first; don't grow siblings.
- **Admin stays Basic Auth.** `/admin` is gated by root `proxy.ts` (Basic Auth,
  `ADMIN_PASSWORD` + `timingSafeEqual`). Do NOT add a signin page, cookie, or users
  table until there's a second admin user.
- **Public endpoints need rate limiting + SSRF guards** (P0). A dedupe hash is not a
  rate limit. `POST /api/analyze` runs the cheap guards (body-size cap, SSRF
  validation, per-client rate limit, fast-fail global-budget read) *before* the SSE
  stream opens; the authoritative global-budget gate is the atomic reservation inside
  the pipeline.

## Commands

```bash
pnpm dev          # local dev (localhost:3000)
pnpm test         # vitest (mocked model + network)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # next build (also the CI gate)
pnpm migrate      # apply the schema (tsx scripts/migrate-prod.ts)
pnpm eval         # run the golden-repo eval set (evals/run.ts)
pnpm export-reports  # export stored reports (scripts/export-reports.ts)
```

## Conventions & gotchas

- **Lazy `db()` singleton.** The libsql client + strict `env()` init are deferred to
  first request, NOT module load — a top-level `env()` makes `next build` require
  runtime secrets and preview deploys fail. Keep DB access behind the lazy proxy.
- **libsql on Vercel needs the undici fetch workaround.** Vercel's fetch
  instrumentation corrupts libsql's request ("expected non-null body source"); the
  client passes `undici`'s `fetch` (decomposed to url+init). Don't replace it with the
  global fetch.
- **Read via the GitHub API; never clone or execute.** The service fetches the git
  tree and file blobs on demand — it does not download the repo to disk or run any of
  its code. The `search` tool currently matches file paths only (content search is v0.2).
- **Stale CSS after a `globals.css` edit** = Next 16 + Turbopack caching. `rm -rf
  .next` + restart dev (hard-refresh/incognito won't fix it).
- **Favicon lives in `app/favicon.ico`**, not `public/` (the app router intercepts it).
- **SSR everything** — no client-side data fetches for first paint; render on the server.

## Where to look

- `PROJECT.md` — why it exists, decisions, architecture, the public contract, the roadmap.
- Chrome/layout: the `zeroindex-app-layout` skill (canonical header/footer/spacing).
- Design tokens: `STYLE_GUIDE.md` in the `zeroindex-site` repo (mirrored in
  `app/globals.css`). Don't invent colors.
- Deploy: the `deploy-zeroindex-vercel-app` skill (Turso → Vercel env → migrations → domain).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## AI pipeline

- **Eval harness is the contract for quality.** `pnpm eval` runs the golden set via
  `@zeroindex-ai/eval-pack` (onboarding-quality LLM judge + deterministic
  citation-resolution check); don't change retrieval/prompts/models without re-running
  it. The headline metrics (citation-resolution, pass-rate) live in PROJECT.md.
- **Model picks are deliberate and documented** in PROJECT.md — exploration runs on
  Sonnet 4.6 (cheap, many tool calls), synthesis runs on Opus 4.7 (one expensive call),
  and the Sonnet-vs-Opus synthesis A/B is recorded with numbers. Pick by eval, not vibe.
  Prompt caching where it helps ([[claude-api]]).
- **Cited output must be escaped** — HTML-escape any model text rendered to the page
  (five-entity coverage). The deterministic validation step re-reads every citation and
  prunes any whose quote doesn't resolve, so 100% of shown citations are verifiable.
