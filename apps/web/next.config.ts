import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// Local dev/build share the single root .env; deployed containers use real env vars.
if (existsSync(`${repoRoot}.env`)) process.loadEnvFile(`${repoRoot}.env`);

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace workspace packages (packages/db) into the standalone output.
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@bukalaris/db"],
  // Product image uploads go through a Server Action (5 MB image + multipart overhead).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  poweredByHeader: false,
  // Build-time constants for every path including /_next/static. The per-request headers
  // (nonce CSP, HSTS, x-request-id) are set in src/proxy.ts because they need runtime env.
  headers: async () => [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }],
};

export default nextConfig;
