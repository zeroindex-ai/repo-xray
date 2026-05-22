// The structured report repo-xray produces. The Zod schema is the source of
// truth for the typed Report and validates the model's output; REPORT_JSON_SCHEMA
// is the wire schema handed to the Messages API's output_config.format.
//
// The wire schema deliberately avoids structured-output pitfalls: no numeric or
// length keywords, additionalProperties:false everywhere, and small enums (well
// under the strict union cap).

import { z } from 'zod';

export const SECTION_KINDS = ['overview', 'onboarding', 'architecture', 'risk'] as const;
export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;

export const CitationSchema = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  quote: z.string(),
});

export const FindingSchema = z.object({
  claim: z.string(),
  detail: z.string(),
  severity: z.enum(SEVERITIES).optional(),
  evidence: z.array(CitationSchema),
});

export const SectionSchema = z.object({
  kind: z.enum(SECTION_KINDS),
  title: z.string(),
  findings: z.array(FindingSchema),
});

export const ReportSchema = z.object({
  summary: z.string(),
  sections: z.array(SectionSchema),
});

export type Citation = z.infer<typeof CitationSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Report = z.infer<typeof ReportSchema>;

// Wire schema for output_config.format. Mirrors the Zod shape; kept in sync by
// the round-trip test in schema.test.ts.
export const REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: [...SECTION_KINDS] },
          title: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                claim: { type: 'string' },
                detail: { type: 'string' },
                severity: { type: 'string', enum: [...SEVERITIES] },
                evidence: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string' },
                      startLine: { type: 'integer' },
                      endLine: { type: 'integer' },
                      quote: { type: 'string' },
                    },
                    required: ['path', 'startLine', 'endLine', 'quote'],
                  },
                },
              },
              required: ['claim', 'detail', 'evidence'],
            },
          },
        },
        required: ['kind', 'title', 'findings'],
      },
    },
  },
  required: ['summary', 'sections'],
} as const;
