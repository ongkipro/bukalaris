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
  // Product image uploads (5 MB) and transfer receipts of the Owner console (10 MB, T-37) go through Server Actions: 10 MB + multipart overhead.
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  poweredByHeader: false,
  // Build-time constants for every path including /_next/static. The per-request headers
  // (nonce CSP, HSTS, x-request-id) are set in src/proxy.ts because they need runtime env.
  headers: async () => [
    { source: "/:path*", headers: STATIC_SECURITY_HEADERS },
    // Owner console pages carry privileged data (audit, issue reports, approvals): never stored by a cache (T-62 slice 4).
    { source: "/admin/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    { source: "/admin", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
};

export default nextConfig;
