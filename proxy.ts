// Next 16 renamed middleware.ts to proxy.ts (project root). This file is the
// Next middleware running basic auth on /admin — NOT an HTTP/LLM proxy.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/timingSafeCompare';

export function proxy(request: NextRequest) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    console.error('[repo-xray] ADMIN_PASSWORD not set — admin gate misconfigured');
    return new NextResponse('Service temporarily unavailable.', { status: 503 });
  }

  const expectedHeader = 'Basic ' + Buffer.from(`admin:${expected}`).toString('base64');
  const provided = request.headers.get('authorization') ?? '';

  if (!safeEqual(expectedHeader, provided)) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Repo X-Ray admin"' },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
};
