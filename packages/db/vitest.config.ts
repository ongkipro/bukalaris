import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // One shared test database, truncated per test: run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    unstubEnvs: true, // vi.stubEnv (e.g. the per-test Mengantar gate opener) never leaks into the next test
    // Dev/test placeholder (>= 32 bytes) of the AutoLaris callback HMAC (T-49); the missing-secret path is tested with an explicit empty value.
    // Dev/test placeholder of the buyer contact fingerprint ring (T-57); the missing-ring path is tested with an explicit empty value.
    env: {
      AUTOLARIS_CALLBACK_SECRET: "test-only-autolaris-callback-secret-0123456789abcdef",
      KEYRING_BUYER_FINGERPRINT: "t1:dGVzdC1vbmx5LWJ1eWVyLWZpbmdlcnByaW50LWtleSE=",
      KEYRING_SHIPPING_CREDENTIALS: "testship:dGVzdC1vbmx5LXNoaXBwaW5nLWtleS1zZXBhcmF0ZSE=",
      // T-45 signed checkout resume links: dev/test placeholder; the missing-ring path is tested with an explicit empty environment.
      KEYRING_CHECKOUT_RESUME: "tr1:dGVzdC1vbmx5LWNoZWNrb3V0LXJlc3VtZS1rZXktMDE=",
      // The Mengantar entry gate is CLOSED here like everywhere else (T-48 fix 5): a test that drives a stubbed client opens it for itself with vi.stubEnv.
    },
  },
});
