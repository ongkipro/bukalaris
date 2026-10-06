import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One shared test database, truncated per test: run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
