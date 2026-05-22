import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTree,
  GitHubError,
  MAX_LINES_PER_READ,
  parseRepoInput,
  readFileRange,
  resolveCommitSha,
} from './github';

const ref = { owner: 'acme', repo: 'widget' };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// Fresh Response per call — Response bodies are one-shot, so reusing one
// instance across calls would hit a consumed stream on the second read.
function mockFetch(responses: Response[]) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return Promise.resolve(r!);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRepoInput', () => {
  it('parses bare owner/repo', () => {
    expect(parseRepoInput('acme/widget')).toEqual({ owner: 'acme', repo: 'widget', ref: undefined });
  });

  it('parses owner/repo@ref', () => {
    expect(parseRepoInput('acme/widget@v1.2.0')).toEqual({
      owner: 'acme',
      repo: 'widget',
      ref: 'v1.2.0',
    });
  });

  it('parses a full https URL and strips .git', () => {
    expect(parseRepoInput('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
      ref: undefined,
    });
  });

  it('parses a /tree/<ref> URL', () => {
    expect(parseRepoInput('https://github.com/acme/widget/tree/develop')).toEqual({
      owner: 'acme',
      repo: 'widget',
      ref: 'develop',
    });
  });

  it('keeps dots in repo names', () => {
    expect(parseRepoInput('acme/my.repo').repo).toBe('my.repo');
  });

  it('rejects a non-github host (SSRF guard)', () => {
    expect(() => parseRepoInput('https://evil.example.com/acme/widget')).toThrow(/only github\.com/i);
  });

  it('rejects an out-of-charset owner', () => {
    expect(() => parseRepoInput('ac me/widget')).toThrow(GitHubError);
  });

  it('rejects a path-traversal ref', () => {
    expect(() => parseRepoInput('acme/widget@../../etc')).toThrow(/invalid ref/i);
  });

  it('rejects input without a repo', () => {
    expect(() => parseRepoInput('acme')).toThrow(/owner\/repo/i);
  });
});

describe('resolveCommitSha', () => {
  it('resolves an explicit ref via the commits endpoint', async () => {
    const spy = mockFetch([jsonResponse({ sha: 'abc123' })]);
    const sha = await resolveCommitSha({ ...ref, ref: 'main' });
    expect(sha).toBe('abc123');
    expect(spy.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/widget/commits/main');
  });

  it('looks up the default branch when no ref is given', async () => {
    const spy = mockFetch([
      jsonResponse({ default_branch: 'trunk' }),
      jsonResponse({ sha: 'def456' }),
    ]);
    const sha = await resolveCommitSha(ref);
    expect(sha).toBe('def456');
    expect(spy.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/widget');
    expect(spy.mock.calls[1]![0]).toBe('https://api.github.com/repos/acme/widget/commits/trunk');
  });

  it('sends a Bearer header when a token is provided', async () => {
    const spy = mockFetch([jsonResponse({ sha: 'abc' })]);
    await resolveCommitSha({ ...ref, ref: 'main' }, 'tok_123');
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_123');
  });
});

describe('fetchTree', () => {
  it('keeps blob and tree entries and surfaces truncation', async () => {
    mockFetch([
      jsonResponse({
        sha: 'tree-sha',
        truncated: true,
        tree: [
          { path: 'src', type: 'tree', sha: 't1' },
          { path: 'src/index.ts', type: 'blob', size: 100, sha: 'b1' },
          { path: 'weird', type: 'commit', sha: 'c1' }, // submodule — dropped
        ],
      }),
    ]);
    const tree = await fetchTree(ref, 'tree-sha');
    expect(tree.truncated).toBe(true);
    expect(tree.entries.map((e) => e.path)).toEqual(['src', 'src/index.ts']);
  });
});

describe('readFileRange', () => {
  const fileBody = (text: string, size = text.length) =>
    jsonResponse({ content: Buffer.from(text).toString('base64'), encoding: 'base64', size });

  it('returns the full file when no range is given', async () => {
    mockFetch([fileBody('a\nb\nc')]);
    const slice = await readFileRange(ref, 'sha', 'README.md');
    expect(slice.content).toBe('a\nb\nc');
    expect(slice.totalLines).toBe(3);
    expect(slice.truncated).toBe(false);
  });

  it('slices a 1-based inclusive line range', async () => {
    mockFetch([fileBody('l1\nl2\nl3\nl4\nl5')]);
    const slice = await readFileRange(ref, 'sha', 'a.ts', 2, 4);
    expect(slice.content).toBe('l2\nl3\nl4');
    expect(slice.startLine).toBe(2);
    expect(slice.endLine).toBe(4);
  });

  it('caps an over-long range and flags truncation', async () => {
    const text = Array.from({ length: MAX_LINES_PER_READ + 50 }, (_, i) => `line${i}`).join('\n');
    mockFetch([fileBody(text)]);
    const slice = await readFileRange(ref, 'sha', 'big.ts', 1);
    expect(slice.endLine - slice.startLine + 1).toBe(MAX_LINES_PER_READ);
    expect(slice.truncated).toBe(true);
  });

  it('refuses an oversized blob', async () => {
    mockFetch([fileBody('x', 9_000_000)]);
    const slice = await readFileRange(ref, 'sha', 'huge.bin');
    expect(slice.truncated).toBe(true);
    expect(slice.content).toBe('');
  });
});

describe('gh error handling', () => {
  it('throws GitHubError with status on a non-ok response', async () => {
    mockFetch([new Response('Not Found', { status: 404 })]);
    await expect(resolveCommitSha({ ...ref, ref: 'nope' })).rejects.toThrow(/GitHub 404/);
  });

  it('hints at the token when rate-limited', async () => {
    mockFetch([
      new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ]);
    await expect(resolveCommitSha(ref)).rejects.toThrow(/set GITHUB_TOKEN/);
  });
});
