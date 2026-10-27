"use server";

import { sellerScope } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { createChannel, revokeChannel } from "@bukalaris/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type CreateChannelState = { token?: string; prefix?: string; name?: string; error?: string } | null;

/** Returns the one-time token in the action result only: it never enters a URL, cookie or log. */
export async function createChannelAction(_prev: CreateChannelState, f: FormData): Promise<CreateChannelState> {
  const scope = await sellerScope();
  const input = {
    name: String(f.get("name") ?? ""),
    origin: String(f.get("origin") ?? ""),
    returnPath: String(f.get("returnPath") ?? "") || "/",
    expiresAt: String(f.get("expiresAt") ?? ""),
  };
  try {
    const { token, prefix } = await createChannel(scope, input);
    revalidatePath("/seller/channels");
    return { token, prefix, name: input.name };
  } catch (err) {
    return { error: userError(err) };
  }
}

export async function revokeChannelAction(channelId: number) {
  const scope = await sellerScope();
  let error: string | undefined;
  try {
    await revokeChannel(scope, channelId);
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/seller/channels", error) : "/seller/channels?saved=1");
}
