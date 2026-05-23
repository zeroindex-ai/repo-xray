// One-off production migration runner. Run from your terminal with Turso creds
// pulled from 1Password (NOT `vercel env pull` — Sensitive vars come back empty):
//
//   TURSO_DATABASE_URL="$(op read 'op://<vault>/Turso repo-xray/url')" \
//   TURSO_AUTH_TOKEN="$(op read 'op://<vault>/Turso repo-xray/token')" \
//   pnpm tsx scripts/migrate-prod.ts
//
// See the deploy-zeroindex-vercel-app skill, Phase C.
import { createClient } from '@libsql/client';
import { migrate } from '../src/db/migrate';

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    console.error('TURSO_DATABASE_URL required');
    process.exit(1);
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const masked = url.replace(/libsql:\/\/[^.]+/, 'libsql://***');
  console.log(`→ Migrating ${masked}`);
  const client = createClient({ url, authToken });
  const applied = await migrate(client);
  console.log(`Applied: ${applied.join(', ')}`);
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  console.log(`Tables: ${tables.rows.map((r) => r.name).join(', ')}`);
}

void main();
