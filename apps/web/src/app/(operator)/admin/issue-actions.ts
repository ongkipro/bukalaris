"use server";

import { requirePortalCsrf } from "@/lib/auth-csrf";

import { consoleActionOp } from "@/lib/console-gate";
import { DomainError, reportConsoleIssue } from "@bukalaris/db";
import { headers } from "next/headers";
import { ZodError } from "zod";

type Result = { ok: true; id: number } | { ok: false; message: string; field?: "description" | "category" | "severity" };

/**
 * The only way a report is created. The gate runs first (capability `ops.issues.report`, re-read from the database); the
 * browser payload is untrusted input: the service validates it against the versioned schema, resolves the page id from the
 * route registry and scrubs the text. The user agent comes from this request, not from the body.
 */
export async function reportIssueAction(csrfInput: unknown, payload: unknown): Promise<Result> {
  let gate;
  try {
    gate = await consoleActionOp("/admin", "ops.issues.report");
    await requirePortalCsrf(csrfInput);
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, message: err.message };
    throw err;
  }
  const h = await headers();
  try {
    const { id } = await reportConsoleIssue(gate.op, payload, { release: process.env.RELEASE_REVISION ?? process.env.npm_package_version, userAgent: h.get("user-agent") ?? undefined });
    return { ok: true, id };
  } catch (err) {
    if (err instanceof ZodError) {
      const path = err.issues[0]?.path[0];
      return { ok: false, message: err.issues[0]?.message ?? "Isian laporan tidak valid.", field: path === "description" || path === "category" || path === "severity" ? path : undefined };
    }
    if (err instanceof DomainError) return { ok: false, message: err.message };
    throw err;
  }
}
