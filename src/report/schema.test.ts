import { describe, expect, it } from 'vitest';
import {
  REPORT_JSON_SCHEMA,
  ReportSchema,
  SECTION_KINDS,
  SEVERITIES,
  type Report,
} from './schema';

const sample: Report = {
  summary: 'A small CLI tool.',
  sections: [
    {
      kind: 'overview',
      title: 'Overview',
      findings: [
        { claim: 'It is a CLI', detail: 'Has a bin entry.', evidence: [{ path: 'package.json', startLine: 3, endLine: 3, quote: '"bin": "cli.js"' }] },
      ],
    },
    {
      kind: 'risk',
      title: 'Risks',
      findings: [
        {
          claim: 'No input validation',
          detail: 'User input flows straight to exec.',
          severity: 'high',
          evidence: [{ path: 'cli.js', startLine: 10, endLine: 11, quote: 'exec(userInput)' }],
        },
      ],
    },
  ],
};

describe('ReportSchema', () => {
  it('accepts a well-formed report', () => {
    expect(ReportSchema.safeParse(sample).success).toBe(true);
  });

  it('rejects an unknown section kind', () => {
    const bad = { ...sample, sections: [{ ...sample.sections[0]!, kind: 'misc' }] };
    expect(ReportSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a finding missing evidence', () => {
    const bad = {
      summary: 'x',
      sections: [{ kind: 'overview', title: 't', findings: [{ claim: 'c', detail: 'd' }] }],
    };
    expect(ReportSchema.safeParse(bad).success).toBe(false);
  });

  it('allows an optional severity', () => {
    const noSeverity = ReportSchema.safeParse(sample);
    expect(noSeverity.success && noSeverity.data.sections[0]!.findings[0]!.severity).toBeUndefined();
  });
});

describe('REPORT_JSON_SCHEMA stays in sync with the Zod schema', () => {
  it('shares the same enum members', () => {
    const sectionItems = REPORT_JSON_SCHEMA.properties.sections.items;
    expect(sectionItems.properties.kind.enum).toEqual([...SECTION_KINDS]);
    expect(sectionItems.properties.findings.items.properties.severity.enum).toEqual([...SEVERITIES]);
  });

  it('declares additionalProperties:false at every object level', () => {
    expect(REPORT_JSON_SCHEMA.additionalProperties).toBe(false);
    const section = REPORT_JSON_SCHEMA.properties.sections.items;
    expect(section.additionalProperties).toBe(false);
    expect(section.properties.findings.items.additionalProperties).toBe(false);
    expect(section.properties.findings.items.properties.evidence.items.additionalProperties).toBe(false);
  });

  it('carries no numeric/length keywords (structured-output limits)', () => {
    const serialized = JSON.stringify(REPORT_JSON_SCHEMA);
    for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) {
      expect(serialized).not.toContain(banned);
    }
  });
});
