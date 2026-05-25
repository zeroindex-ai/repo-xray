# Repo X-Ray

Point it at a public GitHub repository and an agent explores the code with tools — reading the files a new engineer would read first — then returns an onboarding guide, an architecture map, and risk hotspots. **Every statement links to the exact `file:line` on GitHub**, so nothing has to be taken on faith.

A first-pass code-understanding accelerant — it gets a human productive on an unfamiliar codebase in minutes, and shows its work.

> Status: **live** at [xray.zeroindex.ai](https://xray.zeroindex.ai). The full pipeline runs behind a streaming web UI. See [PROJECT.md](./PROJECT.md) for the design, the public API, and the roadmap (the main open item is moving the in-handler pipeline onto a durable workflow engine — §11).

## How it works

1. Resolve `owner/repo[@ref]` to a commit SHA (public repos only; the input is validated, never a raw URL handed to `fetch`).
2. A bounded, prompt-cached tool-use loop (Sonnet) explores the repo — `list_directory`, `search`, `read_file` — under a hard tool-call/token/time budget, recording every file slice it reads as cited evidence.
3. A synthesis pass (Opus) turns that evidence into a structured, onboarding-led report.
4. A deterministic step re-reads every citation and drops any whose quote doesn't resolve — so 100% of shown citations are verifiable.
5. Results are cached by commit SHA (the same commit is never analyzed twice) and persisted with per-run cost and event history.

## Local development

```bash
pnpm install
echo 'TURSO_DATABASE_URL=file:local.db' > .env.local
pnpm migrate          # apply the schema to a local SQLite DB
pnpm test             # unit tests (mocked model + network)
```

Run an analysis from the CLI (needs an Anthropic API key and, for throughput, a public-repo-read GitHub token):

```bash
ANTHROPIC_API_KEY=... GITHUB_TOKEN=... pnpm tsx scripts/analyze.ts <owner/repo>
```

## License

[MIT](./LICENSE) © 2026 ZeroIndex LLC
