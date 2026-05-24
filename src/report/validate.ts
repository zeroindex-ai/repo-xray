// Deterministic citation validation — the credibility gate. Every citation is
// re-read from the repo at its cited line range; if the quoted text isn't found
// there, the citation is dropped. Findings left with no surviving evidence are
// dropped too. What remains satisfies "100% of shown citations resolve" — a
// cheap, non-LLM guarantee.

import type { Report } from './schema';

// Structural — satisfied by github.readFileRange.
export type FileReader = (
  path: string,
  startLine?: number,
  endLine?: number
) => Promise<{ content: string; startLine: number; endLine: number }>;

export type ValidationStats = {
  citationsChecked: number;
  citationsValid: number;
  findingsKept: number;
  findingsDropped: number;
};

// Normalize for comparison PER LINE: collapse intra-line whitespace and trim each
// line, but preserve line breaks. This keeps the guarantee close to "verbatim at
// the cited lines" — a multi-line quote must match the line structure — while
// still tolerating indentation/trailing-space reflow. (The earlier version
// collapsed newlines too, weakening the guarantee to "the words appear somewhere
// in the cited range".)
function normalize(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
}

// The synthesis evidence is line-numbered as "<n>\t<text>", and the prompt tells
// the model to quote the source text ONLY. When it slips and echoes the "<n>\t"
// prefix, that's a formatting artifact — not a miscitation — but it would fail the
// verbatim match and drop an otherwise-correct citation. Strip a leading
// "<digits>\t" from each quoted line before matching. A literal tab immediately
// after leading digits does not occur in real source, so this can never make a
// genuinely wrong quote resolve (it only un-breaks correct, prefix-tainted ones).
function stripEvidencePrefix(quote: string): string {
  return quote
    .split('\n')
    .map((line) => line.replace(/^\d+\t/, ''))
    .join('\n');
}

async function citationResolves(
  citation: { path: string; startLine: number; endLine: number; quote: string },
  readFile: FileReader
): Promise<boolean> {
  const quote = normalize(stripEvidencePrefix(citation.quote));
  if (!quote) return false;
  try {
    const slice = await readFile(citation.path, citation.startLine, citation.endLine);
    return normalize(slice.content).includes(quote);
  } catch {
    return false;
  }
}

/**
 * Return a pruned copy of the report containing only resolvable citations, plus
 * stats. Findings that lose all their evidence are removed; empty sections are
 * kept (they convey the section was considered) unless they have no findings to
 * begin with — those are left as-is.
 */
export async function validateReport(
  report: Report,
  readFile: FileReader
): Promise<{ report: Report; stats: ValidationStats }> {
  const stats: ValidationStats = {
    citationsChecked: 0,
    citationsValid: 0,
    findingsKept: 0,
    findingsDropped: 0,
  };

  const sections = await Promise.all(
    report.sections.map(async (section) => {
      const findings = [];
      for (const finding of section.findings) {
        const validEvidence = [];
        for (const citation of finding.evidence) {
          stats.citationsChecked += 1;
          if (await citationResolves(citation, readFile)) {
            stats.citationsValid += 1;
            validEvidence.push(citation);
          }
        }
        if (validEvidence.length > 0) {
          stats.findingsKept += 1;
          findings.push({ ...finding, evidence: validEvidence });
        } else {
          stats.findingsDropped += 1;
        }
      }
      return { ...section, findings };
    })
  );

  return { report: { ...report, sections }, stats };
}
