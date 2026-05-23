// Opt-in LIVE integration test — exercises the real Anthropic + GitHub paths that
// the mocked tests can't: that the API accepts our request shape (thinking +
// output_config.format + cache_control), that prompt caching engages, and that
// citations resolve against real GitHub line numbering.
//
// Skipped by default (no secrets in CI, and it spends real API budget). Run it
// deliberately as a pre-launch gate, with secrets injected at runtime:
//
//   RUN_LIVE_SMOKE=1 \
//   ANTHROPIC_API_KEY="$(op read 'op://<vault>/repo-xray/ANTHROPIC_API_KEY')" \
//   GITHUB_TOKEN="$(op read 'op://<vault>/repo-xray/GITHUB_TOKEN')" \
//   pnpm test analyze.live

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate';
import { analyzeRepo, liveAnalyzeDeps } from './analyze';
import type { MessagesClient } from './explore';

const ENABLED = process.env.RUN_LIVE_SMOKE === '1' && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!ENABLED)('analyzeRepo (LIVE — opt-in, real API spend)', () => {
  it(
    'analyzes a tiny real repo end-to-end with a high citation-resolution rate',
    async () => {
      const db = createClient({ url: ':memory:' });
      await migrate(db);
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      }) as unknown as MessagesClient;
      const deps = liveAnalyzeDeps({ anthropic, githubToken: process.env.GITHUB_TOKEN, db });

      const result = await analyzeRepo('sindresorhus/is-plain-obj', deps);

      expect(result.cached).toBe(false);
      expect(result.report.sections.length).toBeGreaterThan(0);
      expect(result.costMicroUsd).toBeGreaterThan(0);
      // The line-numbering fix should keep resolution high; this guards against
      // regressions in the synthesis evidence format or GitHub line numbering.
      const { citationsChecked, citationsValid } = result.stats!;
      expect(citationsChecked).toBeGreaterThan(0);
      expect(citationsValid / citationsChecked).toBeGreaterThanOrEqual(0.8);
    },
    180_000
  );
});
