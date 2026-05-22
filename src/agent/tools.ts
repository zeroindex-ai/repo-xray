// The agent's tool surface over a repo. `list_directory` and `search` operate on
// the in-memory git tree (free, no network); only `read_file` fetches a blob.
// Code/content search is deferred (v0.2) — `search` matches file paths for now.

import type Anthropic from '@anthropic-ai/sdk';
import type { FileSlice, TreeEntry } from '../lib/github';

export type EvidenceItem = {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
};

// What the agent harness needs to execute a tool call. `readFile` is injected so
// tests (and the synthesis/validation steps) can substitute a fake.
export type ToolDeps = {
  tree: TreeEntry[];
  readFile: (path: string, startLine?: number, endLine?: number) => Promise<FileSlice>;
};

export const MAX_SEARCH_RESULTS = 50;
export const MAX_TREE_LINES = 2000;

// Tool definitions handed to the Messages API. Descriptions are behavior-focused;
// every field is described so the model knows what to pass.
export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_directory',
    description:
      'List the files and subdirectories directly under a directory path in the repository. ' +
      'Pass an empty path to list the repository root. Use this to orient before reading files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, e.g. "src/lib". Empty or "/" for the root.' },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the repository, optionally limited to a line range. Prefer a range for ' +
      'large files. Returns line-numbered content. Cite the lines you rely on in your findings.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the repository root.' },
        start_line: { type: 'integer', description: '1-based first line to read (optional).', minimum: 1 },
        end_line: { type: 'integer', description: '1-based last line to read, inclusive (optional).', minimum: 1 },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description:
      'Find files whose path matches a substring (case-insensitive). Use to locate entry points, ' +
      'configs, or modules by name. This searches file paths only, not file contents.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against file paths.' },
      },
      required: ['query'],
    },
  },
];

function normalizeDir(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Immediate children (files + subdirs) of a directory path, from the tree. */
export function listDirectory(tree: TreeEntry[], path: string): string[] {
  const dir = normalizeDir(path ?? '');
  const prefix = dir ? `${dir}/` : '';
  const children = new Set<string>();
  for (const entry of tree) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      // Direct child file (only if it's a blob; tree entries for dirs are listed too).
      children.add(entry.type === 'tree' ? `${rest}/` : rest);
    } else {
      children.add(`${rest.slice(0, slash)}/`);
    }
  }
  return [...children].sort();
}

/** Paths matching a case-insensitive substring, capped. */
export function searchPaths(tree: TreeEntry[], query: string, limit = MAX_SEARCH_RESULTS): string[] {
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (entry.path.toLowerCase().includes(q)) {
      hits.push(entry.path);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/** A flat, sorted path listing of blobs for the prompt (cached). Capped for token budget. */
export function renderTree(tree: TreeEntry[], maxLines = MAX_TREE_LINES): string {
  const blobs = tree
    .filter((e) => e.type === 'blob')
    .map((e) => e.path)
    .sort();
  if (blobs.length <= maxLines) return blobs.join('\n');
  return [...blobs.slice(0, maxLines), `… (${blobs.length - maxLines} more files omitted)`].join('\n');
}

export type ToolOutcome = { content: string; evidence?: EvidenceItem };

/** Execute one tool call, returning text for the model and any evidence captured. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolOutcome> {
  switch (name) {
    case 'list_directory': {
      const path = typeof input.path === 'string' ? input.path : '';
      const entries = listDirectory(deps.tree, path);
      return {
        content: entries.length ? entries.join('\n') : '(empty or not a directory)',
      };
    }
    case 'search': {
      const query = typeof input.query === 'string' ? input.query : '';
      if (!query) return { content: 'Provide a non-empty query.' };
      const hits = searchPaths(deps.tree, query);
      return { content: hits.length ? hits.join('\n') : '(no matching paths)' };
    }
    case 'read_file': {
      const path = typeof input.path === 'string' ? input.path : '';
      if (!path) return { content: 'Provide a file path.' };
      const start = typeof input.start_line === 'number' ? input.start_line : undefined;
      const end = typeof input.end_line === 'number' ? input.end_line : undefined;
      const slice = await deps.readFile(path, start, end);
      if (slice.truncated && slice.content === '') {
        return { content: `(file "${path}" is too large or binary to read)` };
      }
      // Line-number the content so the model cites accurate ranges.
      const numbered = slice.content
        .split('\n')
        .map((line, i) => `${slice.startLine + i}\t${line}`)
        .join('\n');
      const header = `${path} (lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines})`;
      return {
        content: `${header}\n${numbered}`,
        evidence: {
          path,
          startLine: slice.startLine,
          endLine: slice.endLine,
          quote: slice.content,
        },
      };
    }
    default:
      return { content: `Unknown tool: ${name}` };
  }
}
