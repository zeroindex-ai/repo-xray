import { describe, expect, it } from 'vitest';
import type { Report } from './schema';
import { validateReport, type FileReader } from './validate';

// A reader backed by an in-memory file map; returns the requested line range.
function reader(files: Record<string, string>): FileReader {
  return async (path, startLine = 1, endLine) => {
    const text = files[path];
    if (text === undefined) throw new Error(`no such file: ${path}`);
    const lines = text.split('\n');
    const from = Math.max(1, startLine);
    const to = Math.min(endLine ?? lines.length, lines.length);
    return { content: lines.slice(from - 1, to).join('\n'), startLine: from, endLine: to };
  };
}

const files = { 'cli.js': 'line one\nexec(userInput)\nline three' };

function reportWith(...evidence: Report['sections'][number]['findings'][number]['evidence']): Report {
  return {
    summary: 's',
    sections: [{ kind: 'risk', title: 'Risks', findings: [{ claim: 'c', detail: 'd', evidence }] }],
  };
}

describe('validateReport', () => {
  it('keeps a citation whose quote resolves at the cited lines', async () => {
    const { report, stats } = await validateReport(
      reportWith({ path: 'cli.js', startLine: 2, endLine: 2, quote: 'exec(userInput)' }),
      reader(files)
    );
    expect(stats).toMatchObject({ citationsChecked: 1, citationsValid: 1, findingsKept: 1, findingsDropped: 0 });
    expect(report.sections[0]!.findings).toHaveLength(1);
  });

  it('tolerates whitespace differences in the quote', async () => {
    const { stats } = await validateReport(
      reportWith({ path: 'cli.js', startLine: 2, endLine: 2, quote: '  exec(userInput)  ' }),
      reader(files)
    );
    expect(stats.citationsValid).toBe(1);
  });

  it('drops a fabricated quote, and the finding with it', async () => {
    const { report, stats } = await validateReport(
      reportWith({ path: 'cli.js', startLine: 2, endLine: 2, quote: 'rm -rf /' }),
      reader(files)
    );
    expect(stats).toMatchObject({ citationsValid: 0, findingsKept: 0, findingsDropped: 1 });
    expect(report.sections[0]!.findings).toHaveLength(0);
  });

  it('keeps a finding but filters to the resolvable citations', async () => {
    const { report, stats } = await validateReport(
      reportWith(
        { path: 'cli.js', startLine: 2, endLine: 2, quote: 'exec(userInput)' },
        { path: 'cli.js', startLine: 1, endLine: 1, quote: 'NOT REAL' }
      ),
      reader(files)
    );
    expect(stats).toMatchObject({ citationsChecked: 2, citationsValid: 1, findingsKept: 1 });
    expect(report.sections[0]!.findings[0]!.evidence).toHaveLength(1);
    expect(report.sections[0]!.findings[0]!.evidence[0]!.quote).toBe('exec(userInput)');
  });

  it('treats a missing file (reader throws) as an unresolved citation', async () => {
    const { stats } = await validateReport(
      reportWith({ path: 'ghost.js', startLine: 1, endLine: 1, quote: 'anything' }),
      reader(files)
    );
    expect(stats.citationsValid).toBe(0);
  });

  it('rejects an empty quote', async () => {
    const { stats } = await validateReport(
      reportWith({ path: 'cli.js', startLine: 1, endLine: 1, quote: '   ' }),
      reader(files)
    );
    expect(stats.citationsValid).toBe(0);
  });
});
