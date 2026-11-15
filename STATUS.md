# Bukalaris — status

Updated: 2026-11-16. `main` = `origin/main` = `2b4d0a4` (T-100), repository PUBLIC on GitHub, nothing deployed. CI on `main` is green (`verify` and `image`). Work in progress lives in task worktrees under `../bukalaris-wt/`, uncommitted until the owner asks: `t102-two-roots` (T-102), `t103-store-host-checkout` (T-103, built on T-102), `t104-provider-accounts` (T-104), `t122-doc-precision` (T-122).

This file owns the current state and the next task. Evidence: `BUILD-LOG.md`, `docs/TASKS.md` and the track reports in `docs/tracks/`. Earlier checkpoints: [`docs/archive/STATUS-history-2026-11-05.md`](docs/archive/STATUS-history-2026-11-05.md).

## Where the project stands

- **Code:** `main` implements the earlier platform-managed model (platform-held money, Partner Mengantar accounts, platform affiliate wallet) on fake adapters; CI green at `2b4d0a4`. The new direction is being built task by task in the worktrees above.
- **Documents:** carry the owner's direction change as accepted decisions (D-27 to D-33, ADR-0013 to ADR-0016). Accepted decisions are not implementation evidence; nothing of the new direction is built.
- **Owner instruction (2026-11-16):** development resumed, in parallel streams: the task order below plus the precision fixes of the 2026-11-14 review (T-122, from the `pi` session's findings).

## Decisions in force (2026-11-14 and 2026-11-15)

| Decision | Content | Record |
|---|---|---|
| D-27 | Each store uses its own Mengantar and AutoLaris accounts. Buyer payments and COD cash go to the seller. Bukalaris holds no seller money; subscription is its only revenue | ADR-0013 |
| D-28 | Platform on `bukalaris.com`, storefronts on `<slug>.bukalaris.id`, custom domains point at `cname.bukalaris.id`, checkout on the store host | ADR-0014 |
| D-29 | Store affiliate programme run by the seller: one platform affiliate account, membership per store, commission paid by the seller and recorded with typed bank data | ADR-0015 |
| D-30 | Digital products: prepaid only, no shipment, access links hosted by the seller (no upload), granted when the order is paid. Member area prepared as empty, non-public structure | ADR-0016 |
| D-31 | Recommended defaults accepted; bank transfer to the seller's own account added. Owner answers: the pasted Partner Secret is not rotated (exposure accepted, Partner model superseded); the repository stays public for now; both domains are registered (owner statement); the AutoLaris payment-only profile is requested by hand per seller | DECISIONS |
| D-32 | Clarifications accepted: Bukalaris is a written record of platform transactions and reconciles nothing; shipping money is between seller and Mengantar; Mengantar is the only, locked aggregator on a new dedicated account with parcel sync; the buyer uploads a proof of transfer; affiliate links live on the store host | DECISIONS |
| D-33 | AutoLaris needs no IP allow-list (owner statement, payment gateway only); proof files kept 90 days after the order closes; the seller is responsible for buyer data in its own provider accounts (working position); starting rate limits for the new actions | DECISIONS, doc 16 |

## Next

1. **T-101** (Partial): document alignment. Remaining parts are done by the task that builds each feature.
2. **T-114** (Partial, structure done 2026-11-15): this file trimmed, open-task index at the top of `docs/TASKS.md`, ADRs in `docs/adr/`, superseded material in `docs/archive/`, links and checks updated. `RUNBOOK.md`, `DEPLOY-COOLIFY.md` and `DEMO.md` stay in `docs/` because code and applied migrations cite their paths. Left: the final search for superseded text, done with the T-101 remainder.
3. **T-100** Done 2026-11-16: CI on `main` green with `verify` and `image` (run 43740385003, second attempt; the first attempt hit an intermittent test, now T-123).
4. **T-102** Done locally (two root domains; independent review accepted after fixes; `pnpm verify` green). **T-103** in progress on top of it. **T-104** in progress in parallel. **T-122** done locally (review findings F-02, F-04 to F-17; owner-gated parts of F-15 left).
5. Then: T-105 and T-106 → T-115 → T-107 → T-113 → T-116 → T-111 → T-112 → T-117 → T-108 → T-109 → T-110. Deferred: T-118 to T-121. New findings: T-123 (intermittent CI test), T-124 (`BETTER_AUTH_SECRETS` override, unverified).

## Open items that need a person

| Item | Who | Blocks |
|---|---|---|
| Confirm the privacy working position of D-33 and the seller terms wording | Privacy or legal adviser | Production switch (T-116), not local work |
| Provider facts: sandbox origins, AutoLaris payment-only request shape and paid status words, Mengantar per-parcel money fields | Read from official documentation in T-105, T-106, T-115 | Any sandbox or live call |
| Retention periods for logs, clicks, callbacks and audit (Q-11) | Owner or adviser | Purge jobs stay off |
| Mail provider and sender domain (Q-16), hosting and DNS (D-23) | Owner | Deployment |

## Standing rules

Local only: no deploy, no DNS, no live provider call, no real secret. No commit or push unless the owner asks. Mengantar and AutoLaris are fake adapters. Known and accepted by the owner: the Mengantar Partner Secret pasted in chat on 2026-10-27 is not rotated, and the repository is public.
