# Sample reports

Example Repo X-Ray output on small public OSS repos, kept as demo artifacts and
as seeds for the eval golden set. Each repo has:

- `<repo>.report.json` — the canonical structured report (exactly what's stored
  in `reports.report_json`).
- `<repo>.report.md` — a human-readable rendering with citations linked to the
  exact GitHub lines, mirroring the planned web report page.

| Repo | Commit |
| --- | --- |
| [sindresorhus/slugify](https://github.com/sindresorhus/slugify) | `7c318bd1` |
| [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit) | `42599ebb` |

Regenerate from the local DB after new runs:

```bash
TURSO_DATABASE_URL=file:local.db pnpm export-reports
```

Every citation in these reports resolved against the source at its commit — the
deterministic validation step (`src/report/validate.ts`) drops any that don't.
