"use server";

import { sellerScope } from "@/lib/context";
import { updateStoreSettings } from "@bukalaris/db";
import { run, text } from "../_run";

export async function updateSettingsAction(f: FormData) {
  const scope = await sellerScope();
  await run("/seller/settings", () => "/seller/settings?saved=1", () =>
    updateStoreSettings(scope, {
      name: text(f, "name"),
      description: text(f, "description"),
      whatsapp: text(f, "whatsapp"),
      theme: text(f, "theme"),
    }),
  );
}
