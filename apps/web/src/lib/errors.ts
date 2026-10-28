import { DomainError, JobManageError } from "@bukalaris/db";
import { ZodError } from "zod";

/** User-safe message for expected failures; anything else is rethrown (never swallowed). */
export function userError(err: unknown): string {
  if (err instanceof DomainError || err instanceof JobManageError) return err.message;
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Data tidak valid.";
  throw err;
}

export const withError = (path: string, message: string) =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;
