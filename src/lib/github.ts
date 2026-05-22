// GitHub read layer for repo-xray. We never clone or execute a repo — we read
// its tree and file blobs over the GitHub REST API on demand.
//
// SSRF posture: user input is parsed down to `owner` + `repo` (+ optional ref),
// each validated against GitHub's identifier charset, and ALL request URLs are
// built against `https://api.github.com` by this module. A user-supplied host
// or URL is never handed to fetch(), so there is no host to redirect.

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

// GitHub identifier rules: owner 1–39 of [A-Za-z0-9-]; repo 1–100 of
// [A-Za-z0-9._-]. Anything else is rejected before a request is built.
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// A ref is a branch, tag, or SHA. Allow slashes (e.g. `feature/x`) but no `..`
// so a ref can't walk the API path.
const REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;

// Read caps — keep a single blob read from exhausting the model's budget.
export const MAX_FILE_BYTES = 256 * 1024; // skip blobs larger than this
export const MAX_LINES_PER_READ = 400; // cap lines returned by one read_file call

export type RepoRef = { owner: string; repo: string; ref?: string };

export type TreeEntry = {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
};

export type RepoTree = {
  sha: string;
  entries: TreeEntry[];
  truncated: boolean;
};

export type FileSlice = {
  path: string;
  /** 1-based inclusive line range actually returned. */
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  /** True when the returned slice was capped (file or range exceeded a limit). */
  truncated: boolean;
};

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * Parse a user-supplied repo reference into validated owner/repo/ref.
 *
 * Accepts: `owner/repo`, `owner/repo@ref`, `github.com/owner/repo`,
 * `https://github.com/owner/repo[.git]`, and `.../owner/repo/tree/<ref>`.
 * Rejects any other host (the SSRF guard) and any out-of-charset identifier.
 */
export function parseRepoInput(input: string): RepoRef {
  const raw = input.trim();
  if (!raw) throw new GitHubError('Empty repository reference');

  let rest = raw;
  let ref: string | undefined;

  // Strip a scheme + host if a URL was given, allowing only github.com.
  const urlMatch = rest.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)\/(.+)$/i);
  if (urlMatch && urlMatch[1]!.includes('.')) {
    // Looks like it carried a host (contains a dot, e.g. "github.com").
    const host = urlMatch[1]!.toLowerCase();
    if (host !== 'github.com') {
      throw new GitHubError(`Only github.com repositories are supported (got "${host}")`);
    }
    rest = urlMatch[2]!;
  }

  // Pull a `@ref` suffix off the bare form (owner/repo@ref).
  const at = rest.indexOf('@');
  if (at !== -1) {
    ref = rest.slice(at + 1).trim() || undefined;
    rest = rest.slice(0, at);
  }

  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new GitHubError(`Expected "owner/repo", got "${raw}"`);
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');

  // A URL form may carry .../tree/<ref> or .../blob/<ref>/...
  if (!ref && parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    ref = parts[3];
  }

  if (!OWNER_RE.test(owner)) throw new GitHubError(`Invalid owner "${owner}"`);
  if (!REPO_RE.test(repo)) throw new GitHubError(`Invalid repository name "${repo}"`);
  if (ref !== undefined && (!REF_RE.test(ref) || ref.includes('..'))) {
    throw new GitHubError(`Invalid ref "${ref}"`);
  }

  return { owner, repo, ref };
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'repo-xray',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Single request primitive. `path` is appended to api.github.com — callers pass
// only paths this module constructs from validated identifiers.
async function gh<T>(path: string, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GitHubError(`Request failed: ${(err as Error).message}`, undefined, path);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
        ? ' (rate limit exhausted — set GITHUB_TOKEN)'
        : '';
    throw new GitHubError(`GitHub ${res.status}${hint}: ${body.slice(0, 300)}`, res.status, path);
  }
  return (await res.json()) as T;
}

/** Resolve a branch/tag/sha (or the default branch) to a concrete commit SHA. */
export async function resolveCommitSha(ref: RepoRef, token?: string): Promise<string> {
  const { owner, repo } = ref;
  let target = ref.ref;
  if (!target) {
    const meta = await gh<{ default_branch: string }>(`/repos/${owner}/${repo}`, token);
    target = meta.default_branch;
  }
  // Preserve slashes in branch refs (e.g. feature/x) while encoding each segment.
  const encodedRef = target.split('/').map(encodeURIComponent).join('/');
  const commit = await gh<{ sha: string }>(
    `/repos/${owner}/${repo}/commits/${encodedRef}`,
    token
  );
  return commit.sha;
}

/** Fetch the full recursive git tree at a commit SHA. */
export async function fetchTree(ref: RepoRef, sha: string, token?: string): Promise<RepoTree> {
  const { owner, repo } = ref;
  const data = await gh<{
    sha: string;
    truncated: boolean;
    tree: Array<{ path: string; type: string; size?: number; sha: string }>;
  }>(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, token);

  const entries: TreeEntry[] = data.tree
    .filter((e) => e.type === 'blob' || e.type === 'tree')
    .map((e) => ({ path: e.path, type: e.type as 'blob' | 'tree', size: e.size, sha: e.sha }));

  return { sha: data.sha, entries, truncated: data.truncated };
}

/**
 * Read a file at a commit SHA, optionally limited to a 1-based inclusive line
 * range. Oversized files and ranges are capped (see MAX_* constants); the
 * `truncated` flag tells the caller the slice was clipped.
 */
export async function readFileRange(
  ref: RepoRef,
  sha: string,
  path: string,
  startLine?: number,
  endLine?: number,
  token?: string
): Promise<FileSlice> {
  const { owner, repo } = ref;
  const data = await gh<{ content?: string; encoding?: string; size: number }>(
    `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
    token
  );

  if (data.size > MAX_FILE_BYTES || data.encoding !== 'base64' || data.content == null) {
    return {
      path,
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      content: '',
      truncated: true,
    };
  }

  const text = Buffer.from(data.content, 'base64').toString('utf8');
  const lines = text.split('\n');
  const totalLines = lines.length;

  const from = Math.max(1, startLine ?? 1);
  let to = endLine ?? totalLines;
  let truncated = false;
  if (to - from + 1 > MAX_LINES_PER_READ) {
    to = from + MAX_LINES_PER_READ - 1;
    truncated = true;
  }
  to = Math.min(to, totalLines);

  return {
    path,
    startLine: from,
    endLine: to,
    totalLines,
    content: lines.slice(from - 1, to).join('\n'),
    truncated,
  };
}
