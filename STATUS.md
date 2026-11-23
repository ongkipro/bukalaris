# Bukalaris — status

Updated: 2026-11-23. Current commit: `git log -1 origin/main` (no hash here: every Records commit would make it stale). Repository PUBLIC on GitHub, nothing deployed. `main` is protected since 2026-11-23: every change reaches it through a pull request with the required checks `verify` and `image` green (admins included, no force push); the owner asked for commit and push of all work (2026-11-16). No pull request open.

This file owns the current state and the next task. Evidence: `BUILD-LOG.md`, `docs/TASKS.md` and the track reports in `docs/tracks/`. Earlier checkpoints: [`docs/archive/STATUS-history-2026-11-05.md`](docs/archive/STATUS-history-2026-11-05.md).

## Where the project stands

- **Code:** `main` still carries the earlier platform-managed model (platform-held money, Partner Mengantar accounts, platform affiliate wallet) on fake adapters, and now the first parts of the new direction: two root domains (T-102), checkout, order status and refund on the store's own host (T-103), seller provider accounts with sealed keys (T-104), Mengantar and AutoLaris on the seller's own key (T-105, T-106), the Mengantar account lock and parcel sync (T-115), the secret hardening of T-126, the money boundary for stores on their own accounts (T-107), bank transfer to the seller's own bank account (T-113), and versioned seller terms, notices and adviser-review production gates (T-116, draft until adviser review). CI green on every merge (runs listed in `BUILD-LOG.md`). The rest is built task by task.
- **Documents:** carry the owner's direction change as accepted decisions (D-27 to D-33, ADR-0013 to ADR-0016), with the precision fixes of the 2026-11-14 review (T-122). Accepted decisions are not implementation evidence beyond the tasks named Done.
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
4. Done and merged 2026-11-16: **T-102** (PR #3), **T-122** (PR #2; owner-gated parts of F-15 left), **T-104** (PR #6), **T-124** (PR #5, `BETTER_AUTH_SECRETS` refused), **T-103** (PR #7). **T-123** Partial (PR #4): two of five intermittent failures fixed, two unexplained.
5. Done and merged 2026-11-16 (second batch): **T-105** (PR #9), **T-106** (PR #10), **T-125** (PR #11, E2E never loads the real pixel scripts), **T-123** no-JS click hang (PR #12; the `content.spec.ts` save stays open).
6. Merged 2026-11-23: **T-115** (PR #14; one Done-when item open: the `in_transit` / `returning` categories are UNVERIFIED), **T-126** (PR #16: AES-GCM tag length pinned, `ORDER_LINK_SECRET` without fallback).
7. Merged 2026-11-23: **T-107** (PR #15: money boundary, migration `0022`), **T-113** (PR #19: bank transfer to the seller's own bank account, migration `0023`, D-36; also fixed the T82 `auth-csrf.spec.ts:469` intermittent), and **T-116** (PR #21: versioned seller terms, acceptance gate, adviser-review production gate and notices, migration `0024`; texts stay draft until adviser review is recorded). Now: **T-111** (product kind and checkout rules for digital and mixed orders). Then: T-112 → T-117 → T-108 → T-109 → T-110. Deferred: T-118 to T-121.

## Open items that need a person

| Item | Who | Blocks |
|---|---|---|
| Confirm the privacy working position of D-33 and the seller terms wording | Privacy or legal adviser | Production switch (T-116), not local work |
| Provider facts: sandbox origins, AutoLaris payment-only request shape and paid status words, Mengantar per-parcel money fields | Read from official documentation in T-105, T-106, T-115 | Any sandbox or live call |
| Retention periods for logs, clicks, callbacks and audit (Q-11) | Owner or adviser | Purge jobs stay off |
| Mail provider and sender domain (Q-16), hosting and DNS (D-23) | Owner | Deployment |

## Standing rules

Local only: no deploy, no DNS, no live provider call, no real secret. No commit or push unless the owner asks (asked on 2026-11-16 for the current work: pull requests into `main`, merged after green CI). Mengantar and AutoLaris are fake adapters. Known and accepted by the owner: the Mengantar Partner Secret pasted in chat on 2026-10-27 is not rotated, and the repository is public.
