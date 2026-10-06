# Track `ui` — Seller and Super Admin UI consistency pass (T-28)

Branch `m2/ui`, worktree `~/Projects/bukalaris-wt/ui`. Dev DB `bukalaris_ui`, ports 3250 (manual) /
3251 (e2e). Implements T-28 (PR-2; NFR-3, UX-2, UI-1, UI-7, UI-8). Presentation only: no service, schema,
checkout or storefront logic changed; the one `packages/db` edit is message text (see "Shared edits").

## Patterns introduced (all in `apps/web/src/components/`, reused by every seller/admin page)

| File | Pattern |
|---|---|
| `admin-shell.tsx` (new) | One operator shell for both consoles: skip link ("Lewati ke konten utama" → `<main id="main" tabIndex=-1>`), brand + account row, persistent context row (store name · role, store switcher only when the account has several stores; "Operator platform" for Bos), navigation strip that **scrolls horizontally inside the header** below `md` (no page overflow at 320 px), `aria-label="Seller"` / `"Super Admin"`. Seller keeps the light header, Super Admin keeps the dark one so the console is always identifiable. `ShellNotice` renders the layout-level denials (not a member, suspended store, not an operator). |
| `nav-link.tsx` (new, client) | `aria-current="page"` from `usePathname()` (section match: `/seller/products` is active on `/seller/products/12`, `/admin` only on `/admin`), active underline + weight, focus-visible ring; the active item scrolls itself into view when the strip overflows. |
| `page-header.tsx` (new) | Title (one `h1`), optional status badge inline, one-line description, primary action (drops under the title on narrow screens), optional back link with icon. Used on every page. |
| `status-badge.tsx` + `lib/status.ts` (new) | Every enum the admin renders has exactly one Indonesian label and badge tone: orders (incl. `awaiting_confirmation`, `on_hold`), order actions, payment, product status, publish status (collections/pages), store status, roles, invitation status, channel state, job status, log levels, store theme, audit action codes. Pages never print a raw enum. Order labels are read from `ORDER_STATUS_LABEL` in `packages/db` so the user-facing error message and the UI share one source. |
| `ui/badge.tsx` | Two new variants `success` / `warning` (text ≥ 4.5:1 on their tinted backgrounds in light mode: emerald-800 on 10 % emerald, amber-900 on 15 % amber; status is always text + colour, never colour alone). |
| `ui/table.tsx` | Container keeps `overflow-x-auto` (tables scroll inside, never the page) and gains a border; `stickyHeader` pins `<thead>` to the viewport from `lg` (the container stops clipping there); `numeric` on `TableHead`/`TableCell` = right-aligned `tabular-nums`; header cells small-caps muted; every table has an `sr-only` caption. |
| `ui/native-select.tsx` (new) | Native `<select>` styled like `<Input>` (chevron, focus ring, disabled). Replaces the ad-hoc `fieldClass` selects in seller/admin; `fieldClass` itself is unchanged for the storefront quantity inputs (content track). |
| `notice.tsx` | Same `role="alert"` / `role="status"` contract (one per page), now bordered with an icon; `savedText` prop. |
| `submit-button.tsx` (new, client) | `useFormStatus` pending state: label → "Menyimpan…" (or a verb per action), `disabled`, `aria-busy`. Used on every mutating form. |
| `confirm-submit.tsx` (moved from `seller/orders/`) | Destructive actions confirm with a message that names the object; `when(form)` confirms only for a destructive branch (member "Hapus dari toko"). Now also on: image delete, channel revoke, store suspend (list + detail). Reversible actions (invitation revoke, reactivate) do not confirm. |
| `empty-state.tsx` (new) | Why it is empty + next action, as paragraphs (no extra heading, so each page keeps one `h1` and `getByRole("heading")` stays unambiguous). First-run and filtered-empty are distinct copies. |
| `route-loading.tsx` + `loading.tsx` | Skeleton (header + rows, `role="status"`, `motion-safe` pulse) **only** in segments without a `notFound()`/redirect below them: `seller/{inventory,members,shipping,channels,settings}`, `admin/{shipping,logs}`. Not under `s/**`, and not in `products/orders/collections/pages/stores`, whose `[id]` pages must keep a real 404 (docs/tracks/catalog.md finding). Verified by `ui.spec.ts`: unknown ids → 404, unauthenticated → 307. |
| `route-error.tsx` + `seller/error.tsx`, `admin/error.tsx` | In-shell error boundary: nav stays, request id + digest, "Coba lagi". |
| `copy-button.tsx` (moved) | One implementation for product ids/URLs and log ids/request ids (the logs copy had a permanent `role="status"`; now `aria-live="polite"` only). |
| `lib/format.ts` | `tanggal()` (date + minute), `tanggalSaja()` (date), `waktuLog()` (date + second), all `Asia/Jakarta` with an explicit " WIB" suffix; `rupiah()` unchanged. Replaced six local `Intl.DateTimeFormat` instances, one `toLocaleString` and one formatter without a timezone (channels). |

## Before → after per page

Screenshots: `docs/evidence/m1/{mobile-320,desktop}-<step>.png`, re-rendered by `pnpm e2e` (steps 70–96
are new and committed; earlier steps are restored before committing, as before).

| Page | Before | After | Evidence |
|---|---|---|---|
| Shell (both) | Header with wrapping inline links, no active state, no skip link; at 320 px the nav wrapped into 4 lines and the store context sat in the same row as the account | Skip link, brand row, context row, scrollable nav strip with `aria-current`, focus rings everywhere; one `max-w-6xl` grid | `70-ui-seller-products`, `90-ui-admin-stores` |
| `/seller/products` | h1 + button, raw badge variants, plain table | PageHeader + description, status badge from the shared map, numeric columns right-aligned, zero stock in red, sticky header on desktop, empty state with action | `70-ui-seller-products` |
| `/seller/products/new`, `/[id]` | No back link, no help on description/status, `<select>` unstyled, delete image without confirm | Back link, badge in header, id/URL block, help texts linked by `aria-describedby`, NativeSelect, pending buttons, image delete confirms | `72-ui-seller-product-new`, `73-ui-seller-product-detail` |
| `/seller/inventory` | h1 + inline text | PageHeader, status badge on draft/archived, "habis" for zero stock, hidden description for the delta field, pending button, empty state with action, dashed empty log | `71-ui-seller-inventory` |
| `/seller/orders` | Filter chips wrapping to 3 lines at 320 px | Filter strip scrolls horizontally, `<time>` elements, numeric total, filtered-empty vs first-run copy with "Tampilkan semua" | `74-ui-seller-orders`, `76-ui-seller-orders-filtered` |
| `/seller/orders/[id]` | Header text link, history as cards, `role="status"` on the risk line (collided with the Notice) | PageHeader with badge, help text under resi/hold/reason fields, pending verbs, history as a time-aligned list, COD note ("belum tercatat sebagai pembayaran") | `75-ui-seller-order-detail` |
| `/seller/collections*`, `/seller/pages*` | Inline status ternaries, `tracking-tight` h1 variant, uppercase eyebrow on the preview | Shared publish labels/tones, PageHeader + back links, NativeSelect, `<time>` on "Diubah", empty states with action | `77`–`80`, `85`, `86` |
| `/seller/members` | Role select unstyled, invitation status only as red text, remove without confirm | NativeSelect, invitation status badge, remove-from-store confirms (only for that branch), `<time>` on expiry, pending buttons | `81-ui-seller-members` |
| `/seller/shipping` | Plain labels, raw `<textarea>` with `fieldClass`, search error unlinked | `Label`/`Textarea`, search error linked via `aria-describedby`/`aria-invalid`, no-result copy with a hint, address help | `82-ui-seller-shipping` |
| `/seller/channels` | State as plain text, revoke without confirm, formatter without timezone | State badge, revoke confirms, WIB dates, help on return path / expiry, error linked to the submit button | `83-ui-seller-channels`, `87-ui-seller-channels-denied` |
| `/seller/settings` | h1 variant | PageHeader, store address is a link, theme labels from the map, read-only state for staff unchanged | `84-ui-seller-settings`, `88-ui-seller-settings-readonly` |
| `/admin` | Suspend without confirm | Store status badge, suspend confirms (names the store and its storefront), reactivate stays one click, empty state | `90-ui-admin-stores` |
| `/admin/stores/new`, `/[id]` | Raw `tema responsive`, raw audit codes (`store.suspended`), unlabelled reason | Theme label, audit action labels, back links, counts as a divided strip (not KPI cards), members empty state | `94-ui-admin-store-detail`, `95-ui-admin-store-new` |
| `/admin/shipping` | `toLocaleString` dates, no field help | WIB dates, help per field, numeric table, simulation explained | `96-ui-admin-shipping` |
| `/admin/logs`, `/[id]` | Local level map, `fieldClass` selects, time without seconds alignment | Shared level tones (warn = warning tone), NativeSelect, `<time>`, sticky header, filtered-empty with "Hapus filter", back link in header | `91`–`93` |
| Denied states | Plain `<p role="alert">` | `ShellNotice` panel (title + next step), text "Akses ditolak." unchanged | `89-ui-admin-denied` |

## A11y fixes

- Skip link and focusable `<main>`; `aria-current="page"` on the active nav item (both consoles).
- Every form field has a `<label>` (visible or `sr-only`); every help text is linked with `aria-describedby`
  (new: product description/status, image upload, inventory delta, tracking/hold reasons, admin reasons,
  margin fields, channel return path/expiry, request-id filter, address). Server-side error banners keep
  `role="alert"`; the channel form's error is linked to its submit button.
- Icon-only or ambiguous buttons carry names: "Hapus gambar n", "Naikkan gambar n", "Cabut <channel>",
  "Batalkan undangan <email>", "Pilih <area>", "Salin <label>".
- Status conveyed by text + tone; new badge tones measured ≥ 4.5:1 in light mode.
- `<time dateTime>` on every rendered timestamp; one explicit timezone (WIB).
- Pending state on every submit (`aria-busy`, disabled, verb label).
- Confirmations on destructive actions name the object and the consequence.
- `motion-safe:` on the skeleton pulse.

## Shared edits (outside `apps/web/src/{app/seller,app/admin,components}`)

- `packages/db/src/schema.ts`: added `ORDER_STATUS_LABEL` next to `ORDER_STATUSES` (labels only).
- `packages/db/src/orders.ts`: the `invalid_transition` message now prints the Indonesian label instead of
  the raw status (`Pesanan berstatus "Diproses" …`); re-exports the label map. No logic change.
- `apps/web/src/lib/format.ts`, `lib/status.ts` (status/copy helpers, allowed by the row).
- `apps/web/e2e/super-admin.spec.ts`, `e2e/channels.spec.ts`: accept the new confirm dialog before
  "Tangguhkan" / "Cabut" (behaviour the task asked for; 3 lines).
- `seller/layout.tsx`, `admin/layout.tsx`: rewritten on top of `AdminShell` (the task's deliverable 1;
  nav entries unchanged, `Lihat toko` kept as an external link).
- Not touched: `seller/marketing/**`, `components/pixels/**`, `s/**`, `checkout/**`, actions/services.

## Commands and results (worktree root, 2026-10-07, final build)

| Command | Result |
|---|---|
| `pnpm lint` | 0 errors |
| `pnpm typecheck` | 0 errors (db + web) |
| `pnpm test` | **104 passed**, 12 files (unchanged count; the `invalid_transition` message is not asserted by a test) |
| `pnpm build` | compiled, every route `ƒ (Dynamic)` as before |
| `pnpm e2e` (full suite, 3 runs on the final code) | **64 passed, 2 skipped, 2 failed** every run — the 2 failures are `orders.spec.ts:84` and `purchase.spec.ts:4` on the **desktop** project only, both on the checkout page with `Terlalu banyak percobaan. Coba lagi dalam 30x detik.` (T-30 `orderPhone` limit, 10 per fixed 600 s window on the shared buyer phone `081234567890`; `checkout2.spec` deliberately spends ≥ 6 of them). Not a UI regression: the same two specs pass when run alone (`playwright test e2e/orders.spec.ts e2e/purchase.spec.ts` → **8 passed**), and nothing in this track submits a checkout. See "Open issues". |
| `playwright test e2e/accounts.spec.ts e2e/ui.spec.ts` | 18 passed (both projects) |
| `pnpm e2e` → `ui.spec.ts` | 10/10 passed (5 tests × 2 projects) in every full run: 27 new evidence steps × 2 viewports = 54 PNGs, zero CSP violations, zero horizontal overflow at 320 px and 1440 px |
| `impeccable detect --json` over `components/`, `seller/`, `admin/` | 1 finding (`border-accent-on-rounded` on the nav underline `border-b-2`) — a false positive for a tab underline; kept |

Findings the gates caught and fixed during the pass (all in this track's files): server→client function prop in `ConfirmSubmit` (now declarative `onlyWhen`), `Notice` tag change breaking `p[role=alert]` selectors (reverted to `<p>`), "Tampilkan semua" colliding with the "Semua" filter (now "Hapus filter"), page-detail header URL overflowing 320 px (`overflow-wrap:anywhere`), channels empty row clipped inside the scrolling table (now `EmptyState` outside), `scrollIntoView()` on the active nav item moving Chrome's focus start point past the skip link (now `scrollLeft`), audit codes with parameters (`channel.create:4`, `invite.accept:3:staff`, `store.settings:mobile`) still raw (now labelled).

## Decisions and ceilings

- **Nav strip instead of a drawer.** A drawer needs a toggle button and JS; the strip works without JS,
  keeps the current location visible (UI-7 invariant) and passes the 320 px overflow assertion. If the
  nav grows past ~12 entries, move to the shadcn Sidebar/Sheet.
- **Sticky table header only from `lg`.** Below that the container must clip for horizontal scroll, and a
  viewport-sticky header inside a clipping container is impossible without a fixed-height inner scroll
  (nested scroll on a phone is worse than no sticky header).
- **Field-level server errors.** `DomainError` carries a code and a message, not a field. Errors from
  Server Actions therefore stay a single `role="alert"` banner above the form; native constraints
  (`required`, `pattern`, `min`) give per-field feedback. Mapping codes → fields would be a `packages/db`
  change outside this row.
- **No `loading.tsx` for list segments with `[id]` children.** Documented above; the lists are one or two
  indexed queries each.
- **Confirm = `window.confirm`.** Native, keyboard-accessible, no dependency; a shadcn AlertDialog would be
  the upgrade if the copy needs formatting.

## Open issues

- **Desktop `orders.spec`/`purchase.spec` fail in the full run** (see table). Root cause is shared test
  data, not this track: every spec checks out with the same buyer phone, and `checkout2.spec`'s
  rate-limit test alone spends most of the 10-per-600 s `orderPhone` budget; whether the desktop project's
  later checkouts land in the same fixed window depends on wall-clock alignment (main recorded 56 passed
  after the checkout2 merge; with this suite ~1.5 min longer per project it failed 4 of 5 full runs here).
  One-line fix for the `checkout2` owner: use a per-spec phone (e.g. `0812${Date.now() % 1e8}`) in the
  rate-limit test, or a distinct phone per project. Not changed here (outside this row).

- Dark mode is token-ready (badge tones have `dark:` values) but not rendered or screenshotted: the app
  has no theme switch.
- `getByRole("button")` count assertion in `orders.spec.ts` still holds (no new buttons in the shell for
  single-store accounts); a store switcher adds one "Ganti" button for multi-store accounts.
- Jobs have no admin page yet; `jobStatusLabel`/`jobStatusTone` are ready for one.
