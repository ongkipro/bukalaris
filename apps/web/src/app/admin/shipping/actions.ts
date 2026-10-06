"use server";

import { setMarginRule } from "@bukalaris/db";
import { operatorOrDeny } from "@/lib/context";
import { userError, withError } from "@/lib/errors";
import { redirect } from "next/navigation";

/** Percent is typed as a human value (e.g. "2.5"); the rule stores basis points. */
export async function setMarginRuleAction(f: FormData) {
  const op = await operatorOrDeny();
  const percent = Number(String(f.get("percent") ?? "0").replace(",", "."));
  let error: string | undefined;
  try {
    await setMarginRule(op, {
      fixedIdr: String(f.get("fixedIdr") ?? ""),
      percentBps: Number.isFinite(percent) ? Math.round(percent * 100) : NaN,
      roundTo: String(f.get("roundTo") ?? ""),
    });
  } catch (err) {
    error = userError(err);
  }
  redirect(error ? withError("/admin/shipping", error) : "/admin/shipping?saved=1");
}
