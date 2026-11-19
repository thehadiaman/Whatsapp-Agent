import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Browsers call the API on the same origin (/api/*), so session cookies stay
// first-party and SameSite=Lax holds. In development Next proxies /api to the
// API; in production Caddy routes /api straight to the API container.
// Read at build time: the Docker build passes it as a build argument.
const apiInternalUrl = process.env['API_INTERNAL_URL'] ?? 'http://localhost:4000';
const isDev = process.env['NODE_ENV'] !== 'production';

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inlines its bootstrap script; dev also needs eval for fast refresh.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: 'standalone',
  // Trace dependencies from the monorepo root so workspace packages are included.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  // Socket.IO requests /api/socket.io/?EIO=…; the default 308 that strips the
  // trailing slash sends it to a path the API does not serve.
  skipTrailingSlashRedirect: true,
  rewrites() {
    return Promise.resolve([
      { source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` },
    ]);
  },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=()' },
        ],
      },
    ]);
  },
};

export default config;
