# Bukalaris — status

Updated: 2026-11-15. `main` = `origin/main` (documentation commit after `938138b`), repository PUBLIC on GitHub, nothing deployed. The documentation changes of 2026-11-14 and 2026-11-15 are committed on `main` (see `git log`). The T-100 code changes (4 files) are commit `457662f` on branch `task/t100-ci`, pull request #1; not merged.

This file owns the current state and the next task. Evidence: `BUILD-LOG.md`, `docs/TASKS.md` and the track reports in `docs/tracks/`. Earlier checkpoints: [`docs/archive/STATUS-history-2026-11-05.md`](docs/archive/STATUS-history-2026-11-05.md).

## Where the project stands

- **Code:** implements the earlier platform-managed model (platform-held money, Partner Mengantar accounts, platform affiliate wallet) on fake adapters. Last full local baseline: T-85 green at `141e030` (DB 1428/1428, build, E2E 261 passed / 2 skipped, `verify:docker`). GitHub CI is not green (T-100).
- **Documents:** carry the owner's direction change as accepted decisions (D-27 to D-33, ADR-0013 to ADR-0016). Accepted decisions are not implementation evidence; nothing of the new direction is built.
- **Owner instruction (2026-11-14, repeated 2026-11-15):** no development yet. Finish the documents, tidy the folder and document structure, then develop.

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
3. **T-100** (Partial, 2026-11-15): causes found and fixed on branch `task/t100-ci` (commit `457662f`, pull request #1, CI run 43709386002 started 2026-11-15): job timeout 60 minutes, two 320 px overflows caused by the wider runner font, one test that recorded a tolerated sign-in 429. Left: a green CI run including the `image` job, then the merge when the owner asks.
4. Build order: T-102 → T-103 → T-104 → T-105 and T-106 → T-115 → T-107 → T-113 → T-116 → T-111 → T-112 → T-117 → T-108 → T-109 → T-110. Deferred: T-118 to T-121.

## Open items that need a person

| Item | Who | Blocks |
|---|---|---|
| Merge pull request #1 after its CI run is green | Owner says when | T-100 Done-when (4) |
| Confirm the privacy working position of D-33 and the seller terms wording | Privacy or legal adviser | Production switch (T-116), not local work |
| Provider facts: sandbox origins, AutoLaris payment-only request shape and paid status words, Mengantar per-parcel money fields | Read from official documentation in T-105, T-106, T-115 | Any sandbox or live call |
| Retention periods for logs, clicks, callbacks and audit (Q-11) | Owner or adviser | Purge jobs stay off |
| Mail provider and sender domain (Q-16), hosting and DNS (D-23) | Owner | Deployment |

## Standing rules

Local only: no deploy, no DNS, no live provider call, no real secret. No commit or push unless the owner asks. Mengantar and AutoLaris are fake adapters. Known and accepted by the owner: the Mengantar Partner Secret pasted in chat on 2026-10-27 is not rotated, and the repository is public.
