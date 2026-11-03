# Track `uxp` (`UxPublic`) — Buyer-Facing & Public Surfaces UI/UX Review and Polish

Author: UxPublic

Scope: Buyer-facing and public surfaces across storefront (`apps/web/src/app/(storefront)/s/[store]/**`: home, product, cart, collections, pages, search, `/promo` hub with flash sales and copyable vouchers, independent landing pages `/lp/[slug]`) in BOTH built-in themes (`responsive` and `mobile`), hosted checkout (`(checkout)/checkout/**`: destination search/picker, courier/payment choice, recipient data + abandoned-checkout capture notice position on 320px, voucher & affiliate code fields with read-only preview, order confirmation with VA/QRIS/e-wallet payment instructions and discount rows, `/checkout/h/invalid` and `/checkout/r/[token]` dead-end recovery), buyer order status `/o/[token]` (shipment timeline, discount rows, refund-destination form that never echoes the full account number, redacted state), affiliate referral redirect `/r/[token]` (no UI), identity pages (`(identity)`: `/login`, `/account/recovery`, `/account/recovery/reset`, `/account/support-recovery/[token]`, `/account/support-recovery/invalid`, `/account/security` TOTP enrolment, `/invite/[token]`), root error/not-found/global-error pages, and `/dev/outbox`.

gate-allow: mono — Monospace (`font-mono`) is intentionally used on copyable voucher codes, order numbers, tracking numbers (resi), virtual account / payment codes, QRIS raw payloads, TOTP secrets/backup codes, request/digest diagnostic IDs, and raw email text in the dev outbox.

## Reference evidence

No external visual reference was supplied; per assignment instructions, pages are judged against `docs/10-DESIGN-SYSTEM-WHITELABEL.md` (UI-1..UI-10), `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md` (UX-3, UX-4, UX-6, UX-12, UX-14, UX-15, UX-16, UX-20, SF-01..SF-12, AU-01..AU-06), and the repository's accepted two-theme baseline captures:

- `docs/evidence/m1/desktop-39-storefront-home-responsive-theme.png`
- `docs/evidence/m1/mobile-320-39-storefront-home-responsive-theme.png`
- `docs/evidence/m1/desktop-34-storefront-home-mobile-theme.png`
- `docs/evidence/m1/mobile-320-34-storefront-home-mobile-theme.png`

Transferred composition contracts:
- **C1 (Storefront two-theme container contract, UI-5):** `data-theme="responsive"` expands up to `72rem` while `data-theme="mobile"` caps `.sf-shell` at `480px` centred on wide viewports; child pages must adapt through `@container` queries on `<main>` (`@xl`, `@2xl`, `@3xl`, `@5xl`) rather than viewport media queries (`sm:`, `md:`), and both themes must reflow at `320px` with `0px` horizontal overflow.
- **C2 (Hosted checkout separation & reading order, UI-10 / UX-12 / UX-15):** Platform-owned layout independent of storefront themes; sticky order summary on desktop, single-column flow at 320px/390px; privacy notice for abandoned-checkout contact capture must precede the contact fields so buyers see it before typing at 320px.
- **C3 (Honest transactional & status typography):** Integer IDR formatted as `Rp 1.234.567` with `tabular-nums` and right-aligned monetary columns; timestamps rendered in `Asia/Jakarta` with an explicit `WIB` suffix; status communicated with text (never colour alone); sentence-case section headings without AI-template tracked uppercase micro-labels.
- **C4 (Touch & keyboard accessibility, UI-3 / WCAG 2.2 AA):** Every interactive control meets the `>= 24x24 CSS px` target size floor (WCAG 2.5.8), has a visible `:focus-visible` indicator, links validation errors to inputs via `aria-describedby` / `aria-invalid`, and provides pending submit feedback (`SubmitButton` / `aria-busy`).

## Per-page UX review and findings table

| Route / Page ID | Viewports & states checked | Findings fixed | Findings deferred (with reason) | Verdict |
|---|---|---|---|---|
| `/s/[store]` (`SF-01` Storefront Home & Shell `layout.tsx`) | `320`, `390`, `1366`, `1536` CSS px; `responsive` (`demo-batik-nusantara`) and `mobile` (`demo-dapur-bunda`) themes; empty and populated catalog | 1. **Fixed 16px horizontal overflow at 320px on stores with 3-word names (`Dapur Bunda Frozen`)**: header store link had `shrink-0` alongside `min-w-0 truncate`, preventing truncation and pushing the `Keranjang` pill past 320px (`right: 336px`). Removed `shrink-0` so long store names truncate cleanly at 320px.<br>2. **Fixed `<24px` target height (`19px`) on footer CMS page links**: added `inline-flex min-h-6 items-center py-1` and visible `:focus-visible` ring (`28px` height).<br>3. **Removed tracked uppercase micro-label tell** on `Koleksi` heading (`uppercase tracking-wide` → sentence-case `text-sm font-semibold text-muted-foreground`) and added `tabular-nums` on product count. | Collection sorting/filtering controls (`SF-02` planned scope in `docs/17`, requires backend query parameters). | PASS |
| `/s/[store]/products/[slug]` (`SF-04` Product Detail) | `320`, `390`, `1366`, `1536` CSS px; both themes; multi-variant, single-variant, out-of-stock, validation error | 1. **Added pending state on Add to Cart button (`UI-8`)**: replaced static `<Button type="submit">` with `<SubmitButton pendingText="Menambahkan…">` (`disabled` + `aria-busy` during Server Action).<br>2. **Removed tracked uppercase micro-label tell** on `Deskripsi` heading (`text-base font-semibold`).<br>3. Added `tabular-nums` to variant stock counts and quantity input. | Interactive thumbnail gallery switcher (secondary images render in a responsive grid below the main image; no client state needed). | PASS |
| `/s/[store]/cart` (`SF-06` Cart) | `320`, `390`, `1366`, `1536` CSS px; both themes; empty cart, loaded cart, stock-exceeded warning | 1. **Added `tabular-nums`** to per-line unit price and quantity input.<br>2. **Added pending state (`SubmitButton`)** on the per-line `Ubah` quantity form. | Stale-price review banner in cart (`docs/17` "Not yet"; checkout re-derives authoritative price server-side). | PASS |
| `/s/[store]/collections/[slug]` (`SF-02` Collection) | `320`, `390`, `1366`, `1536` CSS px; both themes; populated and empty collection | 1. **Added explanation + next-action CTA (`Lihat semua produk`)** to the empty collection `EmptyState`.<br>2. Added `tabular-nums` on the collection product count. | — | PASS |
| `/s/[store]/pages/[slug]` (`SF-05` CMS Page) & `/s/[store]/(shop)/not-found.tsx` | `320`, `390`, `1366`, `1536` CSS px; both themes; published markdown-lite page and in-shell 404 | 1. Removed `tracking-wide uppercase` micro-label classes on the `404` label in `StoreNotFound`. | — | PASS |
| `/s/[store]/search` (`SF-03` Search) | `320`, `390`, `1366`, `1536` CSS px; initial empty query, matched results, zero-match state | Verified `role="search"`, labelled input, `role="status"` result count, and zero-match `EmptyState`. No layout or target defects found. | — | PASS |
| `/s/[store]/promo` (`SF-12` Store Promotions Hub) | `320`, `390`, `1366`, `1536` CSS px; both themes (`responsive` and `mobile`); active banner, flash sale with countdown + stock bar, copyable vouchers, featured collections, empty hub | 1. **Fixed `mobile` theme layout bug on desktop viewports (`sm:grid-cols-2` → `@2xl:grid-cols-2`)**: `promo/page.tsx` used viewport media query `sm:grid-cols-2`, which forced 2 narrow columns inside the 480px `mobile` theme shell on desktop (`1366px`/`1536px`), wrapping 24-hex voucher codes onto 2 lines and cramping flash-sale cards. Switched to container query `@2xl:grid-cols-2` so `mobile` theme stacks cleanly in 1 column while `responsive` theme uses 2 columns.<br>2. **Fixed `<24px` target height (`20px`) on flash-sale product links**: added `inline-flex min-h-6 w-fit items-center py-0.5` and `:focus-visible` ring.<br>3. **Restructured voucher card header**: aligned voucher code and `<CopyButton>` in a top flex row, formatted percentage discount with `toLocaleString("id-ID")`, and added `tabular-nums` on prices/quotas/dates.<br>4. **Added next-action button (`Lihat semua produk`)** to the empty promo hub `EmptyState`. | — | PASS |
| `/s/[store]/lp/[slug]` (`SF-09` Independent Landing Page) | `320`, `390`, `1366`, `1536` CSS px; tested across theme switches (`UI-6`); hero, benefits, FAQ, CTA, and locked platform order form | 1. **Fixed `<24px` target height (`22px` header, `19px` footer)** on store home links (`min-h-7 py-1` and `min-h-6 py-1`).<br>2. **Fixed `tells-scan.py --css` `outline-removed` warning**: moved `#lp-main:focus { outline: none; }` into `lp.css` alongside `:focus-visible` rules.<br>3. **Removed `uppercase` + `letter-spacing` micro-label tell** on `.lp-eyebrow` in `lp.css` and added `font-variant-numeric: tabular-nums`. | — | PASS |
| `/checkout` (`SF-07` Hosted Checkout) | `320`, `390`, `1366`, `1536` CSS px; empty cart, store without pickup area, area search/select, courier & payment radios, COD-refusing area/courier, voucher preview (valid & invalid), affiliate code, rate-limited error | 1. **Fixed abandoned-checkout capture notice (`#capture-notice`) position at 320px**: previously placed at the bottom of `3. Data penerima` (`y=1513px` at 320px, `410px` below `#buyerName` at `y=1103px`), so mobile buyers typed their name and phone (triggering debounced server capture) before ever seeing the notice below the fold. Moved `#capture-notice` to the top of `3. Data penerima` (`y=1085px`, `160px` above `#buyerName` at `y=1245px`).<br>2. **Fixed competing active radio styling in `4. Pembayaran`**: when `Bayar di tempat (COD)` was checked, `Virtual account BCA` in the nested online-methods fieldset also showed a full-strength checked border. Added `group/pay` and `border-l-2 pl-3 group-has-[input[name=paymentMethod][value=cod]:checked]/pay:opacity-60` so online channels visually subordinate while COD is selected, and reduced left indent at 320px (`ml-3` vs `ml-6`).<br>3. **Fixed mixed English `"days"` in courier ETD**: normalized `o.etd` display (`Estimasi 1 - 2 days` → `Estimasi 1 - 2 hari`).<br>4. **Fixed `<24px` target size on `"Ubah"` destination link** and added a `"Kembali ke toko"` link on the empty-cart state. | Retaining typed recipient fields across a server-action redirect on non-JS submit failure (requires server action session/flash or `useActionState` change outside presentation-only scope; client voucher preview already preserves all typed fields). | PASS |
| `/checkout/confirmation` (`SF-08` Order Confirmation) | `320`, `390`, `1366`, `1536` CSS px; COD confirmation, online payment (`VABCA` virtual account, `QRIS` byte-for-byte payload, e-wallet), goods & shipping discount rows | 1. **Added explicit `Diskon ongkir` row (`data-testid="order-shipping-discount"`)** alongside `Diskon barang` (`−Rp ...`) and labelled net shipping as `Ongkir (setelah diskon)` when `shippingDiscount > 0`.<br>2. **Fixed missing `tabular-nums` and right alignment** on order line item totals (`shrink-0 text-right tabular-nums`) and `min-w-0` on line titles.<br>3. **Added `<CopyButton>`** next to Virtual Account (`payment-va`) and Payment Code (`payment-code`) for 1-tap mobile copying.<br>4. **Removed tracked uppercase micro-label tell** on `Terima kasih` and ensured `>=24px` target height on `Kembali ke toko` and `Buka halaman pembayaran`. | — | PASS |
| `/checkout/h/invalid` & `/checkout/r/[token]` (`SF-10` / `HTTP-32` Dead-End Handoff / Resume) | `320`, `390`, `1366`, `1536` CSS px; expired/used/tampered handoff and WhatsApp resume tokens | Verified `/checkout/r/[token]` redirects invalid/expired/completed tokens with `303` and `no-referrer` to `/checkout/h/invalid` with no cookie set; verified `role="alert"` and clear Indonesian recovery instructions at all 4 viewports. | — | PASS |
| `/o/[token]` & `/o/[token]/not-found.tsx` (`SF-11` Buyer Order Status) | `320`, `390`, `1366`, `1536` CSS px; active order with tracking timeline, cancelled paid order with discount rows + pending refund destination form, saved destination (`••••last4`), redacted order (`[dihapus]`), invalid/expired token 404 | 1. **Added explicit `Diskon ongkir` row (`data-testid="order-shipping-discount"`)** and `Diskon barang` (`data-testid="order-goods-discount"`) with right-aligned `tabular-nums`.<br>2. **Unified WIB date formatting in `Perjalanan paket`**: formatted `DD-MM-YYYY HH:mm` provider timestamps through `Intl.DateTimeFormat` (`28 Okt 2026, 21.21 WIB`) to match local milestone timestamps.<br>3. **Handled redacted state (`[dihapus]`) gracefully**: when `tracking.providerStatus === "[dihapus]"`, fell back to `SHIPMENT_STATUS_LABEL[tracking.status]` instead of showing `"Status sedang diperbarui..."`; when timeline descriptions contain `[dihapus]`, rendered an explanatory privacy note (`data-testid="tracking-redacted-note"`).<br>4. **Polished refund destination form**: preserved previously selected bank (`defaultValue={refund.destinationBank ?? "BCA"}`) without ever echoing the account number, and added `aria-describedby="refund-account-help"` format hint (`5–24 angka saja tanpa spasi atau tanda hubung.`).<br>5. **Removed tracked uppercase micro-label tell** on store name header. | — | PASS |
| `/r/[token]` (`HTTP-27` Affiliate Referral Redirect) | Verified route handler & `e2e/t52.spec.ts` | No UI (302 redirect on valid navigation, identical 404 on invalid/revoked/suspended link). | — | PASS |
| `/login` (`AU-01`), `/account/recovery` & `/reset` (`AU-02`), `/account/support-recovery/[token]` & `/invalid` (`AU-06`), `/account/security` (`AU-05`), `/invite/[token]` (`AU-04`) | `320`, `390`, `1366`, `1536` CSS px; password step, TOTP/backup step, rate-limited/invalid states, recovery sent, invalid reset token, support recovery landing & invalid, TOTP secret & backup codes, pending/revoked/used invite | 1. **Fixed `<24px` target height (`20px`)** on secondary links/buttons across all 7 identity screens (`Lupa kata sandi?`, `Gunakan kode cadangan`, `Kembali ke halaman masuk`, `Minta tautan baru`, `Masuk dengan kata sandi baru`, `Lanjut ke Owner console / Seller Admin`, `Ke halaman masuk`) using `inline-flex min-h-6 w-fit items-center py-1` (`28px` height) and left-aligned the TOTP/backup toggle button.<br>2. **Linked error banners to form inputs** via `id`, `aria-invalid`, and `aria-describedby` in `login-form.tsx` and `recovery-form.tsx`.<br>3. **Added `<CopyButton>`** for the TOTP manual secret and backup codes in `security-enrol.tsx` (kept outside `data-testid="totp-secret"` so its text content remains pure base32) and added `<SubmitButton>` on `invite/[token]/page.tsx`. | QR code rendering on `/account/security` (documented ceiling in `docs/17` AU-05 to avoid adding a QR dependency; manual secret + `CopyButton` + `otpauth://` URI are provided). | PASS |
| `error.tsx`, `global-error.tsx`, `not-found.tsx` & `/dev/outbox` | `320`, `390`, `1366`, `1536` CSS px; unmatched 404, DB-unreachable 500 error boundary, populated dev mail outbox | 1. **Added `<CopyButton>`** next to `Kode permintaan` (`requestId`) on `error.tsx` and `not-found.tsx`.<br>2. **Added `:focus-visible` ring and `Ke beranda` link** on `global-error.tsx` to match `error.tsx`.<br>3. **Formatted `/dev/outbox` timestamps in WIB (`tanggal()`)** inside `<time dateTime>`, added `tabular-nums`, and added an explicit note when `bodiesPurgedAt` is set (T-73 purged bodies). | — | PASS |

## Render critique

Fresh narrow (`320px` / `390px`) and wide (`1366px`) screenshots were captured after all code edits and inspected side-by-side against `C1`–`C4` and `design-taste` §4.3.1:

- Storefront Home (`responsive` & `mobile` themes):
  - `docs/evidence/ux/uxp/desktop-ux-storefront-home-responsive.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-home-responsive.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-home-mobile.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-home-mobile.png`
  - *Critique:* In `responsive` theme, the 4-column desktop product grid (`@5xl:grid-cols-4`) and 2-column mobile grid maintain square aspect-ratio covers, balanced 2-line titles, and tabular IDR prices. In `mobile` theme (`docs/evidence/ux/uxp/desktop-ux-storefront-home-mobile.png`), the storefront stays inside its `480px` centred column on a `1366px` viewport, and removing `shrink-0` from the store brand link eliminated the `16px` horizontal overflow at `320px` on 3-word store names (`Dapur Bunda Frozen`).
- Storefront Product, Collection, CMS Page, Search, In-Shell 404, Cart, and Independent LP:
  - `docs/evidence/ux/uxp/desktop-ux-storefront-product-responsive.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-product-responsive.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-product-mobile.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-product-mobile.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-collection.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-collection.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-page.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-page.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-search.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-search.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-not-found.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-not-found.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-cart.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-cart.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-lp.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-lp.png`
  - *Critique:* Product pages present media, title, price range, variant radio cards with tabular prices/stock, quantity, and primary purchase button in clear decision order. Section headings (`Koleksi`, `Deskripsi`) use clean sentence case rather than tracked uppercase micro-labels. The independent LP (`docs/evidence/ux/uxp/desktop-ux-storefront-lp.png`, `docs/evidence/ux/uxp/mobile-ux-storefront-lp.png`) renders its own editorial column and teal accent tokens without storefront shell leakage.
- Storefront Promo Hub (`/s/[store]/promo` in `responsive` and `mobile` themes):
  - `docs/evidence/ux/uxp/desktop-ux-storefront-promo-responsive.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-promo-responsive.png`
  - `docs/evidence/ux/uxp/desktop-ux-storefront-promo-mobile.png`
  - `docs/evidence/ux/uxp/mobile-ux-storefront-promo-mobile.png`
  - *Critique:* Switching flash-sale and voucher grids from `sm:grid-cols-2` to `@2xl:grid-cols-2` resolved the cramped 2-column squeeze inside the 480px `mobile` theme on desktop (`docs/evidence/ux/uxp/desktop-ux-storefront-promo-mobile.png`): 24-hex voucher codes now sit on one line with the `Salin` button aligned at the top-right of each card, while `responsive` theme (`docs/evidence/ux/uxp/desktop-ux-storefront-promo-responsive.png`) expands to a balanced 2-column grid.
- Hosted Checkout, Confirmation, and Invalid Handoff/Resume:
  - `docs/evidence/ux/uxp/mobile-320-ux-checkout.png`
  - `docs/evidence/ux/uxp/mobile-ux-checkout.png`
  - `docs/evidence/ux/uxp/desktop-ux-checkout.png`
  - `docs/evidence/ux/uxp/desktop-ux-checkout-confirmation.png`
  - `docs/evidence/ux/uxp/mobile-ux-checkout-confirmation.png`
  - `docs/evidence/ux/uxp/desktop-ux-checkout-invalid.png`
  - `docs/evidence/ux/uxp/mobile-ux-checkout-invalid.png`
  - *Critique:* At `320px` (`docs/evidence/ux/uxp/mobile-320-ux-checkout.png`), `#capture-notice` now sits at the top of `3. Data penerima` (`y=1085px`) directly above `Nama` (`y=1245px`) instead of `410px` below it, so buyers read the 30-day retention notice before typing. When `Bayar di tempat (COD)` is selected, the nested online payment channels are visually subordinated with a left border and reduced opacity (`opacity-60`), removing the dual-active radio ambiguity; when online payment is selected (`docs/evidence/ux/uxp/desktop-ux-checkout.png`), the chosen channel is full contrast and the read-only voucher preview (`Diskon barang −Rp 55.000`, `Diskon ongkir −Rp 10.500`) aligns with the final confirmation breakdown (`docs/evidence/ux/uxp/desktop-ux-checkout-confirmation.png`).
- Buyer Order Status (`/o/[token]` tracked, refund destination, and redacted states):
  - `docs/evidence/ux/uxp/desktop-ux-order-status-tracked.png`
  - `docs/evidence/ux/uxp/mobile-ux-order-status-tracked.png`
  - `docs/evidence/ux/uxp/desktop-ux-order-status-refund.png`
  - `docs/evidence/ux/uxp/mobile-ux-order-status-refund.png`
  - `docs/evidence/ux/uxp/desktop-ux-order-status-redacted.png`
  - `docs/evidence/ux/uxp/mobile-ux-order-status-redacted.png`
  - *Critique:* All timeline timestamps in `Perjalanan paket` now share one consistent WIB format (`28 Okt 2026, 21.21 WIB`). Discount rows (`Diskon barang` and `Diskon ongkir`) render as separate right-aligned tabular rows (`docs/evidence/ux/uxp/desktop-ux-order-status-refund.png`). Redacted shipments (`docs/evidence/ux/uxp/desktop-ux-order-status-redacted.png`) explain why `[dihapus]` appears in the courier log while keeping timestamps and status intact.
- Identity, Error/404, and Dev Outbox surfaces:
  - `docs/evidence/ux/uxp/desktop-ux-login.png`
  - `docs/evidence/ux/uxp/mobile-ux-login.png`
  - `docs/evidence/ux/uxp/desktop-ux-recovery.png`
  - `docs/evidence/ux/uxp/mobile-ux-recovery.png`
  - `docs/evidence/ux/uxp/desktop-ux-recovery-reset.png`
  - `docs/evidence/ux/uxp/mobile-ux-recovery-reset.png`
  - `docs/evidence/ux/uxp/desktop-ux-support-recovery.png`
  - `docs/evidence/ux/uxp/mobile-ux-support-recovery.png`
  - `docs/evidence/ux/uxp/desktop-ux-security-mfa.png`
  - `docs/evidence/ux/uxp/mobile-ux-security-mfa.png`
  - `docs/evidence/ux/uxp/desktop-ux-invite.png`
  - `docs/evidence/ux/uxp/mobile-ux-invite.png`
  - `docs/evidence/ux/uxp/desktop-ux-not-found.png`
  - `docs/evidence/ux/uxp/mobile-ux-not-found.png`
  - `docs/evidence/ux/uxp/desktop-ux-dev-outbox.png`
  - `docs/evidence/ux/uxp/mobile-ux-dev-outbox.png`
  - *Critique:* All secondary navigation links and mode toggles across the identity cards now have `>=28px` vertical hit areas and left alignment; TOTP enrolment (`docs/evidence/ux/uxp/desktop-ux-security-mfa.png`) includes a copy button beside the secret key; `/dev/outbox` renders WIB timestamps and wraps long links cleanly.

## Geometry, `tells-scan.py`, and `design-gate.py` results

- **`tells-scan.py` (text and `--css` modes) on all changed public/buyer/identity/error files:**
  - Before fixes: 1 text question (`cta-intent`) and 7 CSS questions (`micro-labels` on 6 files, `outline-removed` on `landing-renderer.tsx`).
  - After fixes:
    - `python3 ~/.omp/agent/skills/design-taste/scripts/tells-scan.py "apps/web/src/app/(storefront)" "apps/web/src/app/(checkout)" "apps/web/src/app/(public-services)" "apps/web/src/app/(identity)" "apps/web/src/app/(platform)" apps/web/src/app/error.tsx apps/web/src/app/global-error.tsx apps/web/src/app/not-found.tsx` → **exit 0**, `scanned 44 file(s), 0 question(s) for the brief`.
    - `python3 ~/.omp/agent/skills/design-taste/scripts/tells-scan.py --css ... apps/web/src/app/globals.css` → **exit 0**, `scanned 46 file(s), 0 question(s) for the brief`.
- **`design-gate.py`:**
  - Default invocation `python3 ~/.omp/agent/skills/design-taste/scripts/design-gate.py .`: **exit 2** (`not applicable: /home/ongki/.omp/wt/t5c26dc18b/m/DESIGN.md missing (report as NOT CHECKED)`).
  - Directed invocation against this report `python3 ~/.omp/agent/skills/design-taste/scripts/design-gate.py . --design docs/tracks/ux-uxp.md --src "apps/web/src/app/(storefront)"`:
    - `PASS refs: 4 decoded reference image(s) cited (need at least 1)`
    - `PASS critique: 43 screenshot(s) cited` (narrow `<600px` and wide `>=900px`, all newer than source)
    - `PASS mono: 1`, `PASS slash: 1`, `PASS numbered: 0`, `PASS accent: 0`, `PASS headline: 0`, `PASS stat: 0`, `PASS labels: 0 tracked uppercase label(s) vs 19 <section>(s)`
    - `FAIL review: missing: run the independent review in references/visual-review.md` → **exit 1** (`FAIL: 1 failing check(s) (review)`), because `design/review.md` requires spawning an external `ai-ask` reviewer process outside this worker environment.
- **Playwright geometry & WCAG 2.5.8 target-size audit across 33 routes × 4 viewports (`320`, `390`, `1366`, `1536` CSS px = 132 page checks):**
  - Before fixes: `overflow=16` at `320px` on `mobile` theme storefront pages (`demo-dapur-bunda`) and 8 routes with `<24px` link heights (`19px`–`22px`).
  - After fixes: **0 overflow issues (`overflow = 0` at 320, 390, 1366, 1536 CSS px on all 33 routes) and 0 target-size violations (`>= 24px` on every interactive control)**.

## Accessibility checks run

1. **WCAG 1.4.10 Reflow at `320 CSS px`:** Verified `document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1` at `320px`, `390px`, `1366px`, and `1536px` across every storefront (both `responsive` and `mobile` themes), LP, checkout, confirmation, order status (`/o/[token]`), identity, error, and dev outbox route.
2. **WCAG 2.5.8 Target Size (Minimum, `24x24 CSS px`):** Measured `getBoundingClientRect()` on all visible `a, button, input, select, textarea, summary, [role=button]` elements across all 33 routes; raised all `<24px` links/buttons (`19px`–`22px`) to `>=24px` (`28px`–`44px`).
3. **Keyboard order, focus visibility, and skip links:**
   - Verified skip links (`Langsung ke konten` → `#sf-main` on storefront and `#lp-main` on landing pages) become visible on focus and move focus to `<main tabIndex={-1}>`.
   - Verified `Enter` key on `#voucherCode` triggers `previewVoucher` without submitting the outer checkout form (`e2e/t46.spec.ts`), and `Enter` on the promo hub `CopyButton` copies the voucher code and announces `"Tersalin."` via `aria-live="polite"`.
   - Added missing `:focus-visible` rings to storefront footer links, flash-sale product links, checkout `"Ubah"` and `"Kembali ke toko"` links, identity secondary links/buttons, and `global-error.tsx` actions.
4. **Form labels, help text, and error associations:**
   - Verified every input has a persistent `<Label>` (or `sr-only` label for search/cart quantity).
   - Linked `#login-error` (`login-form.tsx`), `#recovery-error` (`recovery-form.tsx`), and `#refund-account-help` (`o/[token]/page.tsx`) to their inputs via `aria-describedby` and `aria-invalid`.

## Console errors seen

- On `/s/demo-batik-nusantara` (seeded by `seed-demo` with fake Google Ads ID `AW-000000001`), headless Chromium with internet access fetches `https://www.googletagmanager.com/gtag/js?id=AW-000000001`, which then attempts to connect to `https://ad.doubleclick.net/ccm/s/collect` and is blocked by the intentional CSP `connect-src` allowlist (`apps/web/src/lib/security-headers.ts`). No application JS errors, hydration errors, or unhandled rejections occurred on any route.
- During Playwright e2e redirects after Server Actions, Next.js occasionally logs `⨯ Error: The destination stream closed early.` on server stdout when the browser aborts an in-flight flight stream mid-redirect (pre-existing Next 16 behaviour noted in `docs/tracks/content.md`).

## Verification commands and exact results

| Command | Result |
|---|---|
| `pnpm lint` | **0 errors, 0 warnings** (`apps/web lint: Done`) |
| `pnpm typecheck` | **0 errors** (`packages/db` Done, `apps/web` `next typegen && tsc --noEmit` Done) |
| `pnpm build` | **Compiled successfully** (61 static/dynamic route entries generated) |
| `pnpm map:check` | **OK** (`102 route files in code, 103 map rows (96 Implemented)`) |
| `playwright test e2e/channels.spec.ts e2e/checkout2.spec.ts e2e/content.spec.ts e2e/fulfillment.spec.ts e2e/landing.spec.ts e2e/notify.spec.ts --project=mobile-320 --project=desktop` | **26 passed, 0 failed** |
| `playwright test e2e/accounts.spec.ts e2e/ops.spec.ts e2e/privacy.spec.ts e2e/purchase.spec.ts --project=mobile-320 --project=desktop` | **23 passed, 1 skipped** (pre-existing desktop-only skip on DB-unreachable server spawn), **0 failed** |
| `playwright test e2e/t45.spec.ts e2e/t46.spec.ts e2e/t49.spec.ts e2e/t52.spec.ts --project=mobile-320 --project=desktop` | **36 passed, 0 failed** |
| `playwright test e2e/t37.spec.ts e2e/t63.spec.ts --project=mobile-320 --project=desktop` | **24 passed, 0 failed** (`t37.spec.ts`: 10/10 passed; `t63.spec.ts`: 14/14 passed) |

## Doc changes for the conductor

- `docs/10-DESIGN-SYSTEM-WHITELABEL.md` **UI-5 / UI-6 / UI-9 / UI-10**: Update status notes from "rendered verification is pending / visual UNVERIFIED" to **Verified** with rendered evidence in `docs/evidence/ux/uxp/` across `320px`, `390px`, `1366px`, and `1536px` in both `responsive` and `mobile` themes.
- `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md` **SF-07 / UX-15**: Note that `#capture-notice` on `/checkout` is positioned at the top of `3. Data penerima` (before the `Nama` input) so buyers on `320px` viewports see the 30-day temporary capture notice before typing into any contact field.
- `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md` **SF-08 / SF-11 / UX-16**: Note that `/checkout/confirmation` and `/o/[token]` both render separate `Diskon barang` (`data-testid="order-goods-discount"`) and `Diskon ongkir` (`data-testid="order-shipping-discount"`) rows when discounts apply, and `/o/[token]` displays an explicit privacy explanation (`data-testid="tracking-redacted-note"`) when courier free-text descriptions have been redacted to `[dihapus]`.
