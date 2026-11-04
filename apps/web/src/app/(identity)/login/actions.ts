"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { authForHost } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export async function signOut(csrfInput: unknown) {
  await requirePortalCsrf(csrfInput, "/login");
  const h = await headers();
  await authForHost(h.get("host"))?.auth.api.signOut({ headers: h });
  redirect("/login");
}
