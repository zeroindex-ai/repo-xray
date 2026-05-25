// Owner-only admin: recent analyses. Gated by proxy.ts (Basic Auth, ADMIN_PASSWORD).
// Server component, always fresh.

import type { Metadata } from 'next';
import Link from 'next/link';
import { listAnalyses, type AnalysisStatus } from '@/db/analyses';
import { db } from '@/db/client';
import { fmtDuration, fmtTs, fmtUsd } from '@/lib/format';

export const dynamic = 'force-dynamic';
// Node runtime (libsql is Node-only) + no fetch caching: Next's fetch
// instrumentation in the prod page render otherwise breaks libsql's POST to
// Turso ("fetch failed: expected non-null body source"). The analyze route
// works because it already pins runtime='nodejs'.
export const runtime = 'nodejs';
export const fetchCache = 'force-no-store';
export const metadata: Metadata = { title: 'Repo X-Ray Admin · ZeroIndex' };

const PAGE_SIZE = 50;
const STATUS_FILTERS = ['all', 'succeeded', 'failed', 'running', 'queued'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function buildHref(page: number, status: StatusFilter): string {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/admin?${qs}` : '/admin';
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const status = (STATUS_FILTERS as readonly string[]).includes(sp.status ?? '')
    ? (sp.status as StatusFilter)
    : 'all';
  const offset = (pageNum - 1) * PAGE_SIZE;

  const { rows, total } = await listAnalyses(
    { limit: PAGE_SIZE, offset, status: status as AnalysisStatus | 'all' },
    db()
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <>
      <section className="pt-10 pb-8">
        <div className="label mb-3">Admin • Repo X-Ray</div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Analyses</h1>
      </section>

      <section className="pt-2 pb-24">
        <div className="filter-strip">
          {STATUS_FILTERS.map((s) =>
            s === status ? (
              <span key={s} className="current">
                {s}
              </span>
            ) : (
              <Link key={s} href={buildHref(1, s)}>
                {s}
              </Link>
            )
          )}
        </div>

        <div className="card">
          {rows.length === 0 ? (
            <div className="empty-state">No analyses match this filter.</div>
          ) : (
            <div className="table-scroll">
              <table className="admin-table">
                <colgroup>
                  <col style={{ width: '88px' }} />
                  <col />
                  <col style={{ width: '104px' }} />
                  <col style={{ width: '96px' }} />
                  <col style={{ width: '88px' }} />
                  <col style={{ width: '150px' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Repo</th>
                    <th>Status</th>
                    <th>Cost</th>
                    <th>Duration</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className="num-cell">
                        <Link href={`/admin/${a.id}`} className="row-link">
                          {a.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td>
                        {a.owner}/{a.repo}
                        <span className="muted-2"> @{a.commitSha.slice(0, 8)}</span>
                      </td>
                      <td>
                        <span className={`status-tag status-${a.status}`}>{a.status}</span>
                      </td>
                      <td className="num-cell">{fmtUsd(a.costMicroUsd)}</td>
                      <td className="num-cell">{fmtDuration(a.createdAt, a.completedAt)}</td>
                      <td className="ts">{fmtTs(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {total > PAGE_SIZE && (
          <div className="pagination">
            {pageNum > 1 ? (
              <Link href={buildHref(pageNum - 1, status)}>← Previous</Link>
            ) : (
              <span className="disabled">← Previous</span>
            )}
            <span>
              {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
            </span>
            {pageNum < totalPages ? (
              <Link href={buildHref(pageNum + 1, status)}>Next →</Link>
            ) : (
              <span className="disabled">Next →</span>
            )}
          </div>
        )}
      </section>
    </>
  );
}
