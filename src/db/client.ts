import { createClient, type Client } from '@libsql/client';
import { fetch as undiciFetch } from 'undici';

let _client: Client | null = null;

// libsql's hrana HTTP client calls fetch(new Request(...)) using the GLOBAL
// Request. On Vercel the global fetch is wrapped by runtime instrumentation that
// corrupts that request's body during a Server Component render ("fetch failed:
// expected non-null body source"). We route libsql through undici directly to
// dodge the instrumented global. undici's fetch won't accept a *global* Request
// object (it stringifies it → "Failed to parse URL from [object Request]"), so
// decompose it into url + init, buffering the body (sidesteps stream/duplex).
async function libsqlFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
  if (input instanceof Request) {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    const body = hasBody ? await input.arrayBuffer() : undefined;
    return undiciFetch(input.url, {
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      ...(body !== undefined ? { body } : {}),
    }) as unknown as Response;
  }
  return undiciFetch(input as never, init as never) as unknown as Response;
}

export function db(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not set');
  }
  _client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
    fetch: libsqlFetch as unknown as typeof globalThis.fetch,
  });
  return _client;
}
