"use server";

import { sellerScope } from "@/lib/context";
import { clearDestinationToken, saveDestination } from "@bukalaris/db";
import { run, text } from "../_run";

const PAGE = "/seller/marketing";

/** Save one destination; the token field is write-only (blank keeps the stored token). */
export async function saveDestinationAction(provider: string, f: FormData) {
  const scope = await sellerScope();
  await run(PAGE, () => `${PAGE}?saved=1`, () =>
    saveDestination(scope, provider, {
      pixelId: text(f, "pixelId"),
      conversionLabel: text(f, "conversionLabel") || undefined,
      token: text(f, "token") || undefined,
      testEventCode: text(f, "testEventCode") || undefined,
      enabled: f.get("enabled") === "on",
    }),
  );
}

export async function clearTokenAction(provider: string) {
  const scope = await sellerScope();
  await run(PAGE, () => `${PAGE}?saved=1`, () => clearDestinationToken(scope, provider));
}
