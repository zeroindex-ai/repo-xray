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

// Normalize for comparison: collapse runs of whitespace so trivial reflowing
// (leading indentation, trailing spaces) doesn't fail an otherwise-real quote.
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function citationResolves(
  citation: { path: string; startLine: number; endLine: number; quote: string },
  readFile: FileReader
): Promise<boolean> {
  const quote = normalize(citation.quote);
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
