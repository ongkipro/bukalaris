// Which request header carries the client IP for abuse counters (T-30, T-52, step-up), decided by the hosting topology (docs/DEPLOY-COOLIFY.md, D-23). Exactly ONE
// header is trusted, never a mix, because every other header is client-controlled. Never identity or authorization.
//   CLIENT_IP_HEADER unset or `x-forwarded-for`: the last hop the nearest proxy appended (Traefik direct), else `x-real-ip`.
//   CLIENT_IP_HEADER `cf-connecting-ip`: behind Cloudflare ONLY, and only when the origin firewall accepts Cloudflare ranges alone; every other header is ignored.
// A missing or malformed value yields undefined: the services then skip the IP dimension (per-cart and per-phone limits still apply).

const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;
export type ClientIpHeader = "x-forwarded-for" | "cf-connecting-ip";

export function clientIpHeader(env: Record<string, string | undefined> = process.env): ClientIpHeader {
  const v = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "x-forwarded-for") return "x-forwarded-for";
  if (v === "cf-connecting-ip") return "cf-connecting-ip";
  throw new Error("CLIENT_IP_HEADER must be x-forwarded-for or cf-connecting-ip"); // a typo must not silently trust the wrong header
}

export function resolveClientIp(get: (name: string) => string | null | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const mode = clientIpHeader(env);
  const raw =
    mode === "cf-connecting-ip"
      ? get("cf-connecting-ip")?.trim()
      : (get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? get("x-real-ip")?.trim());
  return raw && IP_RE.test(raw) ? raw : undefined;
}
