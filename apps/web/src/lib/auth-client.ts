/**
 * Browser-side POST to Better Auth's HTTP handler (`/api/auth/*`). Security-relevant
 * auth flows must take this path, not `auth.api` in a Server Action, so the origin
 * check and rate limiter apply. `status: 0` means the network failed.
 */
export type AuthResult = { ok: boolean; status: number; code?: string; data?: unknown };

export async function authPost(path: string, body: unknown): Promise<AuthResult> {
  try {
    // A fresh read handles login/MFA/enrollment session replacement. Never replay an unsafe POST.
    const issued = await fetch("/api/auth/csrf-token", { cache: "no-store", credentials: "same-origin" });
    const csrf = await issued.json().catch(() => null) as { token?: unknown; code?: unknown } | null;
    if (!issued.ok) return { ok: false, status: issued.status, code: typeof csrf?.code === "string" ? csrf.code : undefined };
    const token = csrf?.token;
    if (token !== null && typeof token !== "string") return { ok: false, status: 503, code: "INVALID_CSRF" };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (typeof token === "string") headers["x-bl-csrf"] = token;
    const res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => undefined);
    const code = (data as { code?: string } | undefined)?.code;
    return { ok: res.ok, status: res.status, code, data };
  } catch {
    return { ok: false, status: 0 };
  }
}
