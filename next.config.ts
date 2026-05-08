import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['@mantine/core', '@mantine/hooks', '@mantine/notifications', '@mantine/form'],
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
