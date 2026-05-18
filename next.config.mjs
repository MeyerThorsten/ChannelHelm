import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root explicitly — a parent directory has its own
  // package-lock.json which would otherwise confuse Next's tracing.
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
