// Response security headers (SEC-9, SEC-14). No imports: shared by proxy.ts (edge bundle) and next.config.ts.

/**
 * Third-party origins the CSP allows. Empty on purpose: images are same-origin
 * (`/s/<store>/media/<id>`) and no external script exists yet. The pixel track (PR-20:
 * Meta/TikTok/Google) adds its origins HERE and nowhere else. Their `<Script>` tags must
 * also carry the request nonce (`(await headers()).get("x-nonce")`); `'strict-dynamic'`
 * then extends trust to whatever those scripts load, so host entries are only a fallback.
 */
// T-38 (PR-20) pixel destinations. Loaders are injected by the nonce-trusted bundle (strict-dynamic),
// so `script` is the CSP2 fallback; `connect`/`img` carry the pixels' beacons; `frame` the Google
// conversion-linker iframe. Only hosts seen in the official snippets; verify against a live test event.
export const THIRD_PARTY = {
  script: ["https://connect.facebook.net", "https://analytics.tiktok.com", "https://www.googletagmanager.com"],
  connect: [
    "https://www.facebook.com",
    "https://analytics.tiktok.com",
    "https://www.googletagmanager.com",
    "https://www.google.com",
    "https://www.google.co.id",
    "https://www.googleadservices.com",
    "https://googleads.g.doubleclick.net",
  ],
  img: ["https://www.facebook.com", "https://analytics.tiktok.com", "https://www.google.com", "https://www.google.co.id", "https://googleads.g.doubleclick.net", "https://www.googletagmanager.com"],
  frame: ["https://td.doubleclick.net"],
};

export const CSP_HEADER = "Content-Security-Policy";
/** Request header Next reads to stamp the nonce on its own inline scripts (see the bundled CSP guide). */
export const NONCE_HEADER = "x-nonce";
export const HSTS_HEADER = "Strict-Transport-Security";
/** One year, subdomains included (storefronts live on `<slug>.<STORE_ROOT_DOMAIN>`); no `preload` without an owner decision. */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Build-time constants for every path, static assets included (next.config.ts `headers()`). */
export const STATIC_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Legacy fallback for browsers without CSP Level 2; frame-ancestors below is the real rule.
  { key: "X-Frame-Options", value: "DENY" },
];

const list = (own: string, extra: string[]) => [own, ...extra].join(" ");

/** Nonce-based CSP for HTML responses. All app routes render dynamically, so the nonce costs nothing (docs/tracks/hardening.md). */
export function contentSecurityPolicy(nonce: string, { dev, https }: { dev: boolean; https: boolean }) {
  return [
    "default-src 'self'",
    // Dev only: React rebuilds server stack traces with eval; the overlay injects inline styles.
    `script-src ${list("'self'", THIRD_PARTY.script)} 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    `img-src ${list("'self'", THIRD_PARTY.img)}`,
    `connect-src ${list("'self'", THIRD_PARTY.connect)}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Admin, seller, login, checkout and storefront alike: nothing on this origin may be framed.
    "frame-ancestors 'none'",
    THIRD_PARTY.frame.length ? `frame-src ${THIRD_PARTY.frame.join(" ")}` : "frame-src 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** 128 random bits, base64 (edge runtime: no Buffer needed). */
export function newNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
