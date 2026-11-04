import { expect, test } from "@playwright/test";

test.use({ trace: "off" });
const port = Number(process.env.E2E_PORT ?? 3100) + 3;

// A global normalization option must not turn relative console redirects into
// absolute redirects to the server's internal loopback origin.
for (const [host, next] of [["owner", "/admin"], ["app", "/seller"]] as const) {
  test(`non-WWW ${host} root redirect keeps its own origin`, async ({ page }) => {
    const origin = `http://${host}.localhost:${port}`;
    await page.goto(`${origin}/`);
    await expect(page).toHaveURL((url) => url.origin === origin && url.pathname === "/login" && url.searchParams.get("next") === next);
  });
}
