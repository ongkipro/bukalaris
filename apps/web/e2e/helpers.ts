import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Playwright runs from apps/web (pnpm e2e).
const dir = resolve(process.cwd(), "../../docs/evidence/m1") + "/";
mkdirSync(dir, { recursive: true });

/** Full-page screenshot into docs/evidence/m1 plus a no-horizontal-scroll check (NFR-3 reflow). */
export async function evidence(page: Page, info: TestInfo, step: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${step}: horizontal overflow`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${dir}${info.project.name}-${step}.png`, fullPage: true });
}

export async function login(page: Page, email: string, next: "/seller" | "/admin" = "/seller") {
  const landing = next === "/seller" ? "/seller/products" : "/admin";
  // Better Auth allows 3 sign-ins per 10 s per IP in production mode; the suite
  // logs in more often than that, so wait out a 429 instead of disabling the limit.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`/login?next=${next}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Kata sandi").fill("bukalaris-dev-123");
    await page.getByRole("button", { name: "Masuk" }).click();
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname === landing).then(() => "ok"),
      page.getByText("Terlalu banyak percobaan").waitFor().then(() => "429"),
    ]);
    if (outcome === "ok") return;
    await page.waitForTimeout(11_000);
  }
  throw new Error("login kept being rate limited");
}
