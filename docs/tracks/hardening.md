# Track `hardening` — security headers, correlation-id trust, dependency hygiene (T-29)

Branch `m2/hardening`, worktree `~/Projects/bukalaris-wt/hardening`. Dev DB
`bukalaris_hardening`, ports 3210 (manual checks) / 3211 (e2e). Implements
T-29 (PR-16; SEC-9, SEC-13, SEC-14, SEC-15).

## Changed files

Owned by this track:

| File | Change |
|---|---|
| `apps/web/src/lib/security-headers.ts` (new) | Single home for every header value: `THIRD_PARTY` allow-list (empty; the pixel track adds origins here), `contentSecurityPolicy(nonce, {dev, https})`, `STATIC_SECURITY_HEADERS`, HSTS value, `newNonce()` (128 random bits, base64, edge-safe). No imports, so proxy and next.config can both use it. |
| `apps/web/src/proxy.ts` | Per-request headers: nonce CSP on HTML routes (request header for Next to stamp its scripts + response header), HSTS when `ENABLE_HSTS=1` **and** the request arrived as HTTPS, `x-request-id` minted unless `TRUST_PROXY_REQUEST_ID=1`. Skips CSP on `/api/*` (JSON) and `…/media/<id>` (binary; the route sets its own policy, which a proxy header would overwrite — found by the spec). Rewrite/redirect logic unchanged. |
| `apps/web/next.config.ts` | `poweredByHeader: false`; `headers()` → `STATIC_SECURITY_HEADERS` on `/:path*` (build-time constants, so they also cover `/_next/static`, which the proxy matcher excludes). |
| `apps/web/package.json` | `shadcn` CLI moved to `devDependencies` (lockfile: 3 lines). `globals.css` still imports `shadcn/tailwind.css` at build time only; `pnpm build` and the Docker build stage (`pnpm install --frozen-lockfile`, dev deps included) both pass. |
| `apps/web/e2e/security-headers.spec.ts` (new) | 3 tests × 2 projects (5 run, 1 skipped on mobile by design), see below. |
| `docs/tracks/hardening.md` | This report. |

Shared edits (all within the allowance for this row):

- `.github/workflows/ci.yml` — two audit steps after `pnpm install`: `pnpm audit --prod --audit-level high` (blocking) and `pnpm audit --prod` with `continue-on-error: true` (full report). File only; never executed.
- `docs/DEPLOY-COOLIFY.md` — env table rows `ENABLE_HSTS` and `TRUST_PROXY_REQUEST_ID`.
- `docs/12-SECURITY-ARCHITECTURE.md` — "Resolved by" notes on SEC-14 and SEC-15 only.
- `apps/web/e2e/ops.spec.ts` (ops track, 5 lines) — the inbound-id assertion inverted: a client-supplied `x-request-id` is now *replaced* by default (the e2e server does not set `TRUST_PROXY_REQUEST_ID`). The trusted-proxy behaviour is covered by the new spec instead.

Not touched: root `package.json`, `pnpm-workspace.yaml`/`.npmrc`, layouts, `packages/db/**`, other tracks' files.

## Headers per surface (observed, production build, 2026-10-07)

Measured with `curl -D -` against the standalone server and asserted by the spec. Values are identical on `/login`, `/s/toko-a` (and host mode `toko-a.localhost`), `/checkout?store=toko-a`, `/seller/products`, the unauthenticated `/admin` → `307 /login?next=/admin` redirect, and the 404 page:

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-<22 base64 chars>==' 'strict-dynamic'; style-src 'self' 'nonce-<same>'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'
x-request-id: <uuid v4>
(no X-Powered-By; no Strict-Transport-Security over plain http)
```

Variations:

| Surface | Difference |
|---|---|
| `/api/*` (JSON) | Static headers + `x-request-id`; **no CSP** (nothing to render). |
| `/_next/static/*` | Static headers only (outside the proxy matcher, so no CSP/request id; none needed). |
| `…/media/<id>` (storefront, host mode, seller) | Static headers + the route's own `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline`, immutable cache (unchanged from the content track). |
| Request with `x-forwarded-proto: https` | CSP gains `; upgrade-insecure-requests`. |
| … and `ENABLE_HSTS=1` | `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`: irreversible for the whole root domain, needs an owner decision). |
| Development (`next dev`) | `script-src` adds `'unsafe-eval'`, `style-src` uses `'unsafe-inline'` (React/Next overlay), per the bundled Next CSP guide. Not asserted by tests. |

## Decisions and defaults

- **Nonce CSP, not `'unsafe-inline'`.** The bundled Next 16 guide warns that nonces force dynamic rendering. `pnpm build` shows every route already `ƒ (Dynamic)` (auth cookies, cart cookie, host header), so the nonce costs nothing here; no page needed `connection()`. Next stamps the nonce itself: the login HTML carries 17 `nonce="…"` attributes, and the spec checks that every `<script>` with a nonce holds the header's value. `'strict-dynamic'` lets Next's loader inject chunks without host entries.
- **`style-src` with nonce (no `'unsafe-inline'`).** Tailwind v4 ships one stylesheet; no `<style>` or `style=""` appears in the rendered HTML (grep on `/login`) and no component in `src/` uses `style={{}}`. The full suite — including Base UI inputs/buttons, the image gallery and both themes — ran with zero `securitypolicyviolation` events and zero CSP console errors. If a future component SSRs a `style` attribute, the spec fails loudly; the fallback is `'unsafe-inline'` for `style-src` only.
- **`frame-ancestors 'none'` everywhere, storefront included** (default deny asked by the brief). Sellers embedding their storefront in another site would need a per-store allowance — not requested; `X-Frame-Options: DENY` is the CSP-2-less fallback.
- **`form-action 'self'`.** Every form posts to its own origin (Server Actions, Better Auth); the cart → checkout step is a link, and in host mode `/checkout` stays on the store host. Chrome also applies `form-action` to redirects after a POST — all redirects in `checkout/actions.ts` and `s/[store]/actions.ts` are same-origin paths.
- **`img-src 'self'` only.** Images are `/s/<store>/media/<id>`; no `data:`/`blob:` consumer exists (grep). Add them in `THIRD_PARTY.img`/the directive when a preview or pixel needs it.
- **Where third-party allowances go.** `THIRD_PARTY` in `apps/web/src/lib/security-headers.ts` is the one place. For PR-20 (Meta/TikTok/Google): add the origins to `script`/`connect`/`img`/`frame`, and render the tags with `<Script nonce={(await headers()).get("x-nonce")}>` — with `'strict-dynamic'` the nonce is what authorises them; host entries are a fallback for CSP-2 browsers.
- **HSTS is runtime-gated, not build-time.** `next.config.ts` `headers()` is evaluated at build; the Docker image is built without production env, so HSTS lives in `proxy.ts` behind `ENABLE_HSTS=1` and additionally requires `x-forwarded-proto: https` (or an https URL), so the flag alone can never pin a plain-http host (a localhost smoke test with the flag on stays clean).
- **Correlation id trust.** Default: always mint (`crypto.randomUUID()`). `TRUST_PROXY_REQUEST_ID=1` keeps a well-formed inbound id (`^[A-Za-z0-9_-]{8,64}$`), for deployments where the reverse proxy sets/overwrites `x-request-id`. Addresses the review note that a client could choose the id its log lines carry (log-correlation spoofing); the id was never authorization.
- **`drizzle-kit` stays out of the runtime but in the audit.** `better-auth` lists `drizzle-kit` as an *optional* peer; it resolves only because `packages/db` has `drizzle-kit` as a devDependency and pnpm dedupes the single `better-auth` instance across both workspace packages (`pnpm why drizzle-kit`). A trial of `dedupePeerDependents: false` in `pnpm-workspace.yaml` produced no lockfile change (`pnpm install --lockfile-only --force`) and was reverted — a root-config change affecting every track is not worth it. What matters: the standalone output (`apps/web/.next/standalone`) contains **no** `shadcn`, `drizzle-kit` or `esbuild` directory (`find`), so the production image never ships them; `pnpm audit --prod` still sees drizzle-kit through the peer edge.
- **No `auditConfig.ignoreGhsas`.** The remaining moderate advisory is left visible in `pnpm audit --prod` (CI reports it, non-blocking) rather than suppressed; its reachability is recorded below.

## Dependency hygiene — `pnpm audit --prod`

Before (2026-10-06, SEC-15): 2 vulnerabilities — 1 high, 1 moderate.

```
high      braces <=3.0.3  (GHSA-vfj7-8cjw-p6xm)  apps__web>shadcn>…>micromatch>braces  (4 paths)
moderate  esbuild <=0.24.2 (GHSA-67mh-4wv8-2f99) apps__web>better-auth>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild
```

After (2026-10-07): 1 vulnerability — 1 moderate.

```
moderate  esbuild <=0.24.2 (GHSA-67mh-4wv8-2f99) apps__web>better-auth>drizzle-kit>@esbuild-kit/esm-loader>@esbuild-kit/core-utils>esbuild
Severity: 1 moderate
```

Reachability of the remaining advisory: the flaw is in esbuild's **development server** (`serve` mode, CORS on the dev server). Nothing runs esbuild's server here; `drizzle-kit` only loads esbuild through `@esbuild-kit` to read `drizzle.config.ts` during `pnpm db:generate` (developer machine). `drizzle-kit`/esbuild are absent from the standalone build output and from the `runner` image. Not reachable in production; tracked as audit noise until `better-auth` or `drizzle-kit` move off `@esbuild-kit` (the upstream fix path).

## Commands and results (worktree root, 2026-10-07)

| Command | Result |
|---|---|
| `pnpm lint` | pass (apps/web eslint; db has no lint script) |
| `pnpm typecheck` | pass (`next typegen && tsc --noEmit`, `tsc -p packages/db`) |
| `pnpm test` | 10 files, 88 tests passed (22.9 s) |
| `pnpm build` | pass; every route `ƒ (Dynamic)`, `ƒ Proxy (Middleware)` |
| `pnpm --filter @bukalaris/web e2e security-headers` | 5 passed, 1 skipped (16.1 s) |
| `pnpm e2e` (full) | 46 passed, 2 skipped (5.0 min), exit 0 |
| `pnpm verify:docker` | `health=200 s_nope=404 login=200 healthcheck=healthy user=app media=writable`; web 307 MB, migrate 274 MB, 30 public tables |
| `pnpm audit --prod` | 1 moderate (above); no high/critical |
| `pnpm audit --prod --audit-level high` | exit 0 (the CI blocking step) |

Spec `apps/web/e2e/security-headers.spec.ts`:

1. **public surfaces** — `/login`, `/s/toko-a`, add-to-cart action, `/checkout?store=toko-a`, `/admin` (307 + location), 404 page: static headers, CSP pattern, no `X-Powered-By`, no HSTS, uuid `x-request-id`; `/api/health` has no CSP; `/_next/static/*` has nosniff; nonces differ per response; zero CSP violations (console errors and `securitypolicyviolation` events).
2. **seller admin + media** — logs in as `owner-a`, asserts `/seller/products` headers, every nonced `<script>` matches the header nonce, uploads a 1×1 PNG to "Totebag Kanvas", asserts both the seller media URL and `/s/toko-a/media/<id>` answer 200 `image/png` with `default-src 'none'; sandbox`, nosniff, `X-Frame-Options: DENY`, no `X-Powered-By`; deletes the image again (other specs screenshot the storefront).
3. **ENABLE_HSTS=1 + TRUST_PROXY_REQUEST_ID=1** (desktop project only; viewport-independent) — spawns a second standalone server on `E2E_PORT+2` with both flags: plain http → no HSTS and no `upgrade-insecure-requests`; with `x-forwarded-proto: https` → HSTS value and `upgrade-insecure-requests`, a well-formed inbound id is echoed, a malformed one is still replaced.

Regenerated evidence PNGs from the full run were restored (`git checkout -- docs/evidence/m1/`); this track adds no screenshots.

## Open issues / not verified

- One full `pnpm e2e` run (between the two green ones) failed 30 of 48 tests with the webServer still up; the immediate rerun passed 46/46 and the first green run before it differed only by the Totebag/cleanup change in this spec. Not diagnosed (log not kept); noted so the orchestrator's re-verification watches for it. The worker's `poll_failed: relation "job" does not exist` line at startup is the known race with global-setup and resolves itself.
- CI audit steps are file-only (no remote); `pnpm audit --prod --audit-level high` was run locally once as a stand-in.
- HSTS/CSP in a real browser over TLS behind Coolify's proxy (SEC-9 acceptance "on the deployed serving layers") is not possible locally; the `x-forwarded-proto` path is tested, the proxy's actual header forwarding is a deploy-time check (DEPLOY-COOLIFY env table).
- Development mode (`next dev`) CSP (`'unsafe-eval'`, `'unsafe-inline'` styles) was not exercised by a test; a quick manual `pnpm dev` check is advisable when the next person works on the overlay.
- `preload` for HSTS and per-store framing allowances are owner decisions, not taken.
- The remaining moderate advisory needs an upstream move off `@esbuild-kit` (drizzle-kit/better-auth); nothing to do in this repository.

## Dependency audit after T-96 (2026-11-05)

Trigger: GitHub CI run 41968197087 (push of df04f49) failed `pnpm audit --prod --audit-level high`: 11 production-tree advisories (2 critical, 3 high, 5 moderate, 1 low) — next >=16.0.0 <=16.4.0 (critical RCE via Image Optimization with SVG; critical RCE in `use cache` returning typed arrays; high Server Actions DoS), zod <4.6.6 (high, memory exhaustion), vite >=8.3.0 <=8.3.2 (high, reached through better-auth's optional vitest peer). The app imports neither `next/image` nor `"use cache"`, but `/_next/image` and the Server Actions surface exist regardless, so the exposure was real for any deployment (none exists yet).

Change: next and eslint-config-next 16.3.8 → 16.4.5, zod 4.6.5 → 4.6.7 (apps/web, packages/db), pnpm override for vite (dev, see pnpm-workspace.yaml).

`pnpm audit --prod` after: 1 moderate — esbuild <=0.24.2 via better-auth → drizzle-kit (unchanged; dev-server flaw, reachability above). No high or critical.

Full `pnpm audit` (dev tooling, not shipped, not the CI gate) still reports highs only under the `shadcn` CLI (undici <7.30.1, body-parser <2.4.0, systeminformation <5.33.16) and `eslint-config-next` → `eslint-plugin-react-hooks` → zod 4.6.5. None ships: the runner image copies only `.next/standalone` and `.next/static`, the migrate image is `deploy --prod` of packages/db, and `apps/web/src` imports none of these packages. Tracked as dev-tooling noise; revisit with the next tooling bump.
