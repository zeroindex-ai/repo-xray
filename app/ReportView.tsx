// Presentational report renderer. No 'use client' and no runtime schema import
// (type-only) so it works in both the client page and a future server-rendered
// /a/[id] page, and keeps zod out of the client bundle. All model-authored text
// is rendered as text (React escapes it) — never as HTML.

import type { Report } from '@/report/schema';

const SEV_CLASS: Record<string, string> = {
  info: 'sev-info',
  low: 'sev-low',
  medium: 'sev-medium',
  high: 'sev-high',
};

export function ReportView({
  repo,
  commitSha,
  report,
}: {
  repo: string; // "owner/repo"
  commitSha: string;
  report: Report;
}) {
  const ghLink = (path: string, a: number, b: number) =>
    `https://github.com/${repo}/blob/${commitSha}/${path}#L${a}-L${b}`;

  return (
    <div>
      <div className="card lead-card">
        <div className="label mb-4">Summary</div>
        <p className="muted text-[15px] leading-relaxed">{report.summary}</p>
      </div>

      <div className="mt-8 flex flex-col gap-8">
        {report.sections.map((section, i) => (
          <section key={i} className="card">
            <div className="label mb-4">{section.title}</div>
            <div className="flex flex-col gap-5">
              {section.findings.map((f, j) => (
                <div key={j} className="finding">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    {f.severity && <span className={`sev ${SEV_CLASS[f.severity]}`}>{f.severity}</span>}
                    <span className="font-semibold">{f.claim}</span>
                  </div>
                  <p className="muted text-[15px] mt-1 leading-relaxed">{f.detail}</p>
                  {f.evidence.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {f.evidence.map((c, k) => (
                        <a
                          key={k}
                          className="cite"
                          href={ghLink(c.path, c.startLine, c.endLine)}
                          target="_blank"
                          rel="noopener"
                        >
                          {c.path}:{c.startLine}-{c.endLine}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {section.findings.length === 0 && (
                <p className="empty-state">No verified findings in this section.</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
