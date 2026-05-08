import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/form'],
  },
  turbopack: {
    // Pin the workspace root to this project so Turbopack doesn't get confused
    // by a package-lock.json sitting in a parent directory (/Users/tuannguyen/).
    root: __dirname,
  },
  // Allow LAN devices to reach the dev server for cross-device testing.
  // Next.js 16 blocks cross-origin requests to /_next/ endpoints by default —
  // this includes the Turbopack HMR WebSocket, which prevents React from
  // hydrating on any device that isn't localhost.
  // Covers the three RFC-1918 private address ranges. Add extras (e.g. a
  // corporate hostname) via ALLOWED_DEV_ORIGINS=host1,host2 in .env.local.
  allowedDevOrigins: [
    '192.168.*.*',
    '10.*.*.*',
    '172.16.*.*',
    ...(process.env.ALLOWED_DEV_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
  ],
};

export default nextConfig;
