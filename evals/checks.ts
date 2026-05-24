// repo-xray's deterministic eval checks. Citation resolution is the headline
// metric — the share of cited line ranges that re-resolve against the real file
// — and it's directly comparable across synthesis models in the Sonnet-vs-Opus
// A/B. Read from the analysis stats carried in result.metadata (see subject.ts).

import type { Check, GoldenItem, PartialResult } from '@zeroindex-ai/eval-pack';

type Stats = {
  citationsChecked?: number;
  citationsValid?: number;
  findingsKept?: number;
  findingsDropped?: number;
};

function stats(result: PartialResult): Stats {
  return (result.metadata?.stats as Stats | null) ?? {};
}

/** Share of cited ranges that resolved must clear the item's floor (default 0.85). */
export const citationResolution: Check = (item: GoldenItem, result) => {
  const { citationsChecked = 0, citationsValid = 0 } = stats(result);
  const min = (item.metadata?.minCitationResolution as number | undefined) ?? 0.85;
  const ratio = citationsChecked > 0 ? citationsValid / citationsChecked : 0;
  return {
    name: 'citation_resolution',
    ok: citationsChecked > 0 && ratio >= min,
    detail: { ratio: Number(ratio.toFixed(3)), citationsValid, citationsChecked, min },
  };
};

/** A useful report must keep at least one verified finding. */
export const hasFindings: Check = (_item, result) => {
  const { findingsKept = 0 } = stats(result);
  return { name: 'has_findings', ok: findingsKept > 0, detail: { findingsKept } };
};

export const checks: Check[] = [citationResolution, hasFindings];

/** Citation-resolution ratio for a result, or null if nothing was cited. */
export function citationRatio(result: PartialResult): number | null {
  const { citationsChecked = 0, citationsValid = 0 } = stats(result);
  return citationsChecked > 0 ? citationsValid / citationsChecked : null;
}
