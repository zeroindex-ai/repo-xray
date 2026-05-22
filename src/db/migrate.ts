import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Client } from '@libsql/client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// libsql rejects multi-statement execute() and chokes on `--` comments when you
// hand a whole file to executeMultiple, so we split each file into individual
// statements ourselves: drop line comments, split on ';', discard empties.
// Migrations apply in filename-sort order; every statement must be idempotent
// (CREATE TABLE/INDEX IF NOT EXISTS) so re-runs and partial failures are safe.
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Returns the list of migration filenames applied, in order.
export async function migrate(client: Client): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      await client.execute(stmt);
    }
  }
  return files;
}
