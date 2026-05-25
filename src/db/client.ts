import { createClient, type Client } from '@libsql/client';
import { fetch as undiciFetch } from 'undici';

let _client: Client | null = null;

export function db(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not set');
  }
  _client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
    // Use undici's fetch directly rather than the global one. On Vercel the
    // global fetch is wrapped by runtime instrumentation that consumes libsql's
    // POST body during a Server Component render, throwing "fetch failed:
    // expected non-null body source" (only on Vercel — local `next start` and
    // the route handler are unaffected). undici's fetch is the same impl Node
    // uses, just not the patched global.
    fetch: undiciFetch as unknown as typeof globalThis.fetch,
  });
  return _client;
}
