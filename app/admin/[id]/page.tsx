// Owner-only admin drill-down for one analysis: typed fields, the run-events
// timeline, and the stored report. Gated by proxy.ts. Server component, fresh.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAnalysis, getEvents, getReport } from '@/db/analyses';
import { db } from '@/db/client';
import { fmtDuration, fmtTs, fmtUsd } from '@/lib/format';
import type { Report } from '@/report/schema';
import { CopyButton } from '../CopyButton';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // libsql is Node-only
export const metadata: Metadata = { title: 'Analysis · Repo X-Ray Admin · ZeroIndex' };

// A compact one-line detail for a run event, by event type.
function eventDetail(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const o = data as Record<string, unknown>;
  if (o.type === 'tool_call') {
    const input = o.input as Record<string, unknown> | undefined;
    const arg = (input?.path ?? input?.query ?? '') as string;
    return `${String(o.name)}(${arg})`;
  }
  if (o.type === 'cost') return fmtUsd(Number(o.cumulativeMicroUsd));
  if (o.type === 'phase') return String(o.phase ?? '');
  const s = JSON.stringify(o);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export default async function AnalysisDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = db();
  const analysis = await getAnalysis(id, client);
  if (!analysis) notFound();

  const [events, stored] = await Promise.all([getEvents(id, 0, client), getReport(id, client)]);
  const report = stored?.report as Report | undefined;
  const reportJson = report ? JSON.stringify(report, null, 2) : null;
  const findingCount = report?.sections.reduce((n, s) => n + s.findings.length, 0) ?? 0;
  const repoUrl = `https://github.com/${analysis.owner}/${analysis.repo}/tree/${analysis.commitSha}`;

  return (
    <>
      <section className="pt-10 pb-8">
        <div className="label mb-3">
          <Link href="/admin" className="subtle">
            ← Admin • Repo X-Ray
          </Link>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight leading-none">
            {analysis.owner}/{analysis.repo}
          </h1>
          <a
            className="icon-btn relative top-[3px]"
            href={repoUrl}
            target="_blank"
            rel="noopener"
            title={`Open ${analysis.owner}/${analysis.repo}@${analysis.commitSha.slice(0, 8)} on GitHub`}
            aria-label={`Open ${analysis.owner}/${analysis.repo} on GitHub`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
            </svg>
          </a>
        </div>
      </section>

      <section className="pt-2 pb-8">
        <div className="label mb-4">00 / Analysis</div>
        <div className="card">
          <dl className="kv-list">
            <dt>id</dt> <dd className="mono">{analysis.id}</dd>
            <dt>status</dt>
            <dd>
              <span className={`status-tag status-${analysis.status}`}>{analysis.status}</span>
            </dd>
            <dt>commit sha</dt> <dd className="mono">{analysis.commitSha}</dd>
            <dt>ref</dt> <dd className="mono">{analysis.ref ?? '—'}</dd>
            <dt>default branch</dt> <dd className="mono">{analysis.defaultBranch ?? '—'}</dd>
            <dt>tree truncated</dt> <dd className="mono">{analysis.treeTruncated ? 'yes' : 'no'}</dd>
            <dt>cost</dt> <dd className="mono">{fmtUsd(analysis.costMicroUsd)}</dd>
            <dt>findings</dt> <dd className="mono">{report ? findingCount : '—'}</dd>
            <dt>created</dt> <dd className="mono">{fmtTs(analysis.createdAt)}</dd>
            <dt>completed</dt> <dd className="mono">{fmtTs(analysis.completedAt)}</dd>
            <dt>duration</dt>{' '}
            <dd className="mono">{fmtDuration(analysis.createdAt, analysis.completedAt)}</dd>
            <dt>error</dt> <dd>{analysis.error ?? '—'}</dd>
          </dl>
        </div>
      </section>

      <section className="pt-2 pb-8">
        <div className="label mb-4">01 / Run events ({events.length})</div>
        <div className="card">
          {events.length === 0 ? (
            <div className="empty-state">No events recorded.</div>
          ) : (
            <div className="table-scroll">
              <table className="admin-table">
                <colgroup>
                  <col style={{ width: '56px' }} />
                  <col style={{ width: '120px' }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Type</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.seq}>
                      <td className="num-cell">{e.seq}</td>
                      <td className="mono">{e.type}</td>
                      <td className="mono">{eventDetail(e.data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="pt-2 pb-24">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="label">02 / Stored report</div>
          {reportJson && <CopyButton text={reportJson} />}
        </div>
        <div className="card">
          {reportJson ? (
            <div className="report-panel">
              <pre className="report-json">{reportJson}</pre>
            </div>
          ) : (
            <div className="empty-state">No report stored (analysis did not complete).</div>
          )}
        </div>
      </section>
    </>
  );
}
