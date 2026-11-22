import { expect, test } from "@playwright/test";

// T-125: the E2E browser never reaches the real pixel providers (playwright.config.ts `--host-resolver-rules`).
// A spec that needs a pixel script fulfils it with `page.route` (signals.spec.ts), which runs before name resolution.
test("the E2E browser cannot reach the real pixel provider hosts", async ({ page }) => {
  await page.goto("/api/health");
  const reached = await page.evaluate(async (urls) => {
    const out: Record<string, boolean> = {};
    for (const url of urls) out[url] = await fetch(url, { mode: "no-cors" }).then(() => true, () => false);
    return out;
  }, ["https://analytics.tiktok.com/i18n/pixel/events.js", "https://analytics-ipv6.tiktokw.us/ipv6/enrich_ipv6", "https://connect.facebook.net/en_US/fbevents.js", "https://www.googletagmanager.com/gtag/js"]);
  for (const [url, ok] of Object.entries(reached)) expect(ok, url).toBe(false);
});

test("a route-fulfilled pixel script still loads", async ({ page }) => {
  await page.route("https://analytics.tiktok.com/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "window.__t125 = 1;" }));
  await page.goto("/api/health");
  await page.addScriptTag({ url: "https://analytics.tiktok.com/i18n/pixel/events.js" }).catch(() => undefined);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __t125?: number }).__t125)).toBe(1);
});
