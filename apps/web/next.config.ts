import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// Local dev/build share the single root .env; deployed containers use real env vars.
if (existsSync(`${repoRoot}.env`)) process.loadEnvFile(`${repoRoot}.env`);

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace workspace packages (packages/db) into the standalone output.
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@bukalaris/db"],
};

export default nextConfig;
