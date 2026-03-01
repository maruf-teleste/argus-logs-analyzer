/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",

  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },

  serverExternalPackages: ["duckdb"],

  // Support large file uploads (900MB+)
  experimental: {
    // Disable body size limit for API routes
    bodySizeLimit: false,
  },

  // Increase API route timeout for large file processing
  serverActions: {
    bodySizeLimit: '1000mb',
  },

  // Ensure proper hostname binding for ECS
  env: {
    HOSTNAME: '0.0.0.0',
  },
};

module.exports = nextConfig;
