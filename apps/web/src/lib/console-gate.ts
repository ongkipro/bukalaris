import "server-only";
import { authorizeConsole, DomainError, platformDb, type OperatorScope, type PlatformCapability } from "@bukalaris/db";
import { notFound, redirect } from "next/navigation";
import { operator } from "./context";

/**
 * The one Owner console gate (T-62 slice 1, IAM-15). It is the first statement of every page and server action under
 * `/admin`; `src/app/(operator)/admin` is scanned by `packages/db/test/t62-routes.test.ts` for exactly that.
 *
 * Nothing comes from the cookie except the session id: the operator row and the grant rows are read from the database on every
 * call (`authorizeConsole`), the route template must be in the registry (an unlisted or dormant one is not-found), and a refusal
 * writes a denial audit row. A signed-in identity that is not an operator gets not-found; a session without its own verified
 * second factor is sent back to sign in by `operator()` (the existing MFA rule).
 */
export type Gate = { ok: true; op: OperatorScope; sessionId: string; userId: string; caps: PlatformCapability[] } | { ok: false; capability: PlatformCapability };

export async function consoleGate(template: string, capability?: PlatformCapability): Promise<Gate> {
  const { user, op, sessionId } = await operator();
  if (!op) notFound();
  try {
    const res = await authorizeConsole(platformDb(), user.id, template, capability);
    return { ok: true, op: res.op, sessionId, userId: user.id, caps: res.caps };
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === "forbidden") return { ok: false, capability: capability ?? deniedCapability(err.message) };
      if (err.code === "operator_inactive") redirect("/login?next=/admin");
      if (err.code === "not_found") notFound();
    }
    throw err;
  }
}

/** The capability named by the service's refusal text ("... butuh izin x.y."), so the denied state can say what is missing. */
function deniedCapability(message: string): PlatformCapability {
  return (/izin ([a-z_.]+)\./.exec(message)?.[1] ?? "dashboard.read") as PlatformCapability;
}

/** Server actions: same gate; a refusal throws `DomainError("forbidden")` for the action's own error handling. */
export async function consoleActionOp(template: string, capability?: PlatformCapability): Promise<{ op: OperatorScope; sessionId: string }> {
  const g = await consoleGate(template, capability);
  if (!g.ok) throw new DomainError("forbidden", `Akses ditolak: butuh izin ${g.capability}.`);
  return { op: g.op, sessionId: g.sessionId };
}
