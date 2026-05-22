import { describe, expect, it } from 'vitest';
import type { FileSlice, TreeEntry } from '../lib/github';
import { executeTool, listDirectory, renderTree, searchPaths, type ToolDeps } from './tools';

const tree: TreeEntry[] = [
  { path: 'README.md', type: 'blob', sha: 'a' },
  { path: 'src', type: 'tree', sha: 'b' },
  { path: 'src/index.ts', type: 'blob', sha: 'c' },
  { path: 'src/lib', type: 'tree', sha: 'd' },
  { path: 'src/lib/util.ts', type: 'blob', sha: 'e' },
];

const slice = (over: Partial<FileSlice> = {}): FileSlice => ({
  path: 'README.md',
  startLine: 1,
  endLine: 2,
  totalLines: 2,
  content: '# Title\nHello',
  truncated: false,
  ...over,
});

function deps(readFile: ToolDeps['readFile']): ToolDeps {
  return { tree, readFile };
}

describe('listDirectory', () => {
  it('lists root children with trailing slash on directories', () => {
    expect(listDirectory(tree, '')).toEqual(['README.md', 'src/']);
  });

  it('lists nested directory children', () => {
    expect(listDirectory(tree, 'src')).toEqual(['index.ts', 'lib/']);
    expect(listDirectory(tree, 'src/')).toEqual(['index.ts', 'lib/']);
  });
});

describe('searchPaths', () => {
  it('matches blob paths case-insensitively', () => {
    expect(searchPaths(tree, 'UTIL')).toEqual(['src/lib/util.ts']);
  });

  it('returns empty for no match', () => {
    expect(searchPaths(tree, 'nope')).toEqual([]);
  });
});

describe('renderTree', () => {
  it('renders sorted blob paths only', () => {
    expect(renderTree(tree)).toBe('README.md\nsrc/index.ts\nsrc/lib/util.ts');
  });

  it('caps and notes omitted files', () => {
    const big: TreeEntry[] = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      type: 'blob',
      sha: `${i}`,
    }));
    const out = renderTree(big, 3);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('2 more files omitted');
  });
});

describe('executeTool', () => {
  it('read_file returns line-numbered content and captures evidence', async () => {
    const outcome = await executeTool('read_file', { path: 'README.md' }, deps(async () => slice()));
    expect(outcome.content).toContain('README.md (lines 1-2 of 2)');
    expect(outcome.content).toContain('1\t# Title');
    expect(outcome.content).toContain('2\tHello');
    expect(outcome.evidence).toEqual({ path: 'README.md', startLine: 1, endLine: 2, quote: '# Title\nHello' });
  });

  it('read_file passes a line range through to the reader', async () => {
    let captured: [string, number?, number?] = ['', undefined, undefined];
    await executeTool(
      'read_file',
      { path: 'src/index.ts', start_line: 5, end_line: 9 },
      deps(async (p, s, e) => {
        captured = [p, s, e];
        return slice({ path: p, startLine: 5, endLine: 9, totalLines: 20, content: 'x' });
      })
    );
    expect(captured).toEqual(['src/index.ts', 5, 9]);
  });

  it('read_file reports an unreadable (oversized/binary) file without evidence', async () => {
    const outcome = await executeTool(
      'read_file',
      { path: 'big.bin' },
      deps(async () => slice({ path: 'big.bin', startLine: 0, endLine: 0, totalLines: 0, content: '', truncated: true }))
    );
    expect(outcome.content).toMatch(/too large or binary/);
    expect(outcome.evidence).toBeUndefined();
  });

  it('list_directory and search work off the tree without reading files', async () => {
    const readFile = async (): Promise<FileSlice> => {
      throw new Error('should not read');
    };
    expect((await executeTool('list_directory', { path: 'src' }, deps(readFile))).content).toBe('index.ts\nlib/');
    expect((await executeTool('search', { query: 'index' }, deps(readFile))).content).toBe('src/index.ts');
  });
});
