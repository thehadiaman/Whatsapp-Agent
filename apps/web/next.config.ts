import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: 'standalone',
  // Trace dependencies from the monorepo root so workspace packages are included.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
