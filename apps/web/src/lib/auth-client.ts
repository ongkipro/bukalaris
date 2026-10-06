/**
 * Browser-side POST to Better Auth's HTTP handler (`/api/auth/*`). Security-relevant
 * auth flows must take this path, not `auth.api` in a Server Action, so the origin
 * check and rate limiter apply. `status: 0` means the network failed.
 */
export type AuthResult = { ok: boolean; status: number; code?: string; data?: unknown };

export async function authPost(path: string, body: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => undefined);
    const code = (data as { code?: string } | undefined)?.code;
    return { ok: res.ok, status: res.status, code, data };
  } catch {
    return { ok: false, status: 0 };
  }
}
