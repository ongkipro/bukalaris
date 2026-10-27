"use server";

import { sellerScope } from "@/lib/context";
import { userError } from "@/lib/errors";
import { clearDestinationToken, createFeedToken, feedUrls, revokeFeedToken, saveDestination } from "@bukalaris/db";
import { revalidatePath } from "next/cache";
import { run, text } from "../_run";

const PAGE = "/seller/marketing";

// ── Catalog feeds (T-40) ─────────────────────────────────────────────────────

export type FeedTokenState = { urls?: { meta: string; google: string }; error?: string } | null;

/** The one-time token travels only in the action result (never a URL, cookie or log), inside the two feed URLs. */
export async function createFeedTokenAction(): Promise<FeedTokenState> {
  const scope = await sellerScope();
  try {
    const { token } = await createFeedToken(scope);
    revalidatePath(PAGE);
    return { urls: feedUrls(token) };
  } catch (err) {
    return { error: userError(err) };
  }
}

export async function revokeFeedTokenAction() {
  const scope = await sellerScope();
  await run(PAGE, () => `${PAGE}?saved=1`, () => revokeFeedToken(scope));
}

// ── Ad destinations (T-38) ───────────────────────────────────────────────────

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
