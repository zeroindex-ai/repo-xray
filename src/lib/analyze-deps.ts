// Builds the live analyze dependencies from runtime env. Called inside request
// handlers (never at module scope) so `next build` doesn't need the secrets.

import Anthropic from '@anthropic-ai/sdk';
import { liveAnalyzeDeps, type AnalyzeDeps } from '../agent/analyze';
import type { MessagesClient } from '../agent/explore';
import { requireEnv } from './env';

export function liveDepsFromEnv(): AnalyzeDeps {
  const anthropic = new Anthropic({
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
  }) as unknown as MessagesClient;
  return liveAnalyzeDeps({ anthropic, githubToken: process.env.GITHUB_TOKEN });
}
