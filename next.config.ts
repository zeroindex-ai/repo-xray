import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  // Bundle the DB client (+ its undici transport) whole into each serverless
  // function. Vercel traces functions individually and can miss a libsql
  // runtime dep in the admin page function (works locally, where there's no
  // per-function tracing) → "fetch failed" in the page render.
  serverExternalPackages: ['@libsql/client', 'undici'],
};

export default nextConfig;
