# T-114 step 1 — structure inventory and proposed layout

- **Date:** 2026-11-15
- **Status:** Approved by the owner on 2026-11-15 and carried out the same day, with one deviation: `RUNBOOK.md`, `DEPLOY-COOLIFY.md` and `DEMO.md` were not moved to `docs/ops/`, because code comments, the Dockerfile, CI and two applied migrations cite their paths. The owner accepted all four recommendations of section 5. The text below is the proposal as written before the move; paths in it are the old ones.
- **Task:** [T-114](../TASKS.md). Read from disk on 2026-11-15; no tracked file was moved, renamed or deleted to write this.

## 1. What is on disk

| Place | Content | Tracked |
|---|---|---|
| Repository root | `AGENTS.md`, `STATUS.md`, `BUILD-LOG.md` (825 lines), `REVIEW.md`, `BRIEF-M1.md`, code and config | Yes |
| `docs/` top level | 38 tracked files: 16 numbered specifications (02 to 17), 16 ADRs, `TASKS.md`, `DECISIONS.md`, `README.md`, `CONTEXT-RECORD.md`, `context.json`, `openapi.yaml`, `check-spec.py`, `RUNBOOK.md`, `DEPLOY-COOLIFY.md`, `DEMO.md` (four ADRs are new and untracked) | Mostly |
| `docs/tracks/` | 46 track reports | Yes |
| `docs/reviews/` | 4 dated reviews plus this file (three untracked) | Partly |
| `docs/research/2026-11-portfolio-scan/` | 25 files | Yes |
| `docs/mockups/` | 7 HTML and CSS mockups of the platform affiliate and subscription screens | Yes |
| `docs/evidence/m1`, `m2-content-before` | 344 tracked screenshots | Yes |
| `docs/evidence/ux/` | 183 screenshots | No |
| `docs/archive/` | `STATUS-history-2026-11-05.md` (created 2026-11-15) | No |
| `.pi/` | Tool folder (`tasks`) | No |

## 2. Verdict per file

| File or folder | Verdict | Reason |
|---|---|---|
| `docs/02-PRD.md` to `docs/17-UX-FLOWS-SCREEN-CONTRACTS.md` | Keep in place | The pack. `check-spec.py` reads `docs/*.md`, and about every document links to them by this path |
| `docs/TASKS.md`, `docs/DECISIONS.md`, `docs/README.md`, `docs/openapi.yaml`, `docs/check-spec.py` | Keep in place | Contracts and their checker; `scripts/check-system-map.mjs` reads `docs/TASKS.md` and `docs/04-SYSTEM-ARCHITECTURE.md` by path |
| `docs/CONTEXT-RECORD.md`, `docs/context.json` | Keep in place | Part of the pack (CTX facts) |
| `docs/ADR-0001-…md` to `docs/ADR-0016-…md` | Move to `docs/adr/`, names unchanged | 16 files beside the specifications; 26 files link to them, all updated in the same change; `check-spec.py` gets `adr/*.md` added to its file list |
| `docs/RUNBOOK.md`, `docs/DEPLOY-COOLIFY.md`, `docs/DEMO.md` | Move to `docs/ops/` | Operations documents, not specifications. `DEMO.md` is stale and is corrected when the demo seed changes (T-107) |
| `BRIEF-M1.md` | Move to `docs/archive/` | A finished milestone brief from 2026-10 |
| `REVIEW.md` | Keep in root | `AGENTS.md` tells every phase to read it first |
| `BUILD-LOG.md` | Keep in root, unsplit | Append-only evidence log; splitting it breaks references from task blocks |
| `STATUS.md` | Keep in root | Trimmed on 2026-11-15 (section 4) |
| `AGENTS.md` | Keep; edit two parts | "Layout" gains the new folders; the "Parallel tracks (M2)" table moves to `docs/archive/` with a one-line pointer, because its file names no longer exist |
| `docs/tracks/` | Keep in place | Task blocks and `BUILD-LOG.md` cite these paths as evidence |
| `docs/reviews/`, `docs/research/` | Keep in place | Already dated folders |
| `docs/mockups/` | Move to `docs/archive/mockups/` | They show the platform-funded affiliate wallet that D-29 replaced; kept as history |
| `docs/evidence/m1`, `m2-content-before` | Keep in place | Cited by task evidence |
| `docs/evidence/ux/` (untracked) | Keep in place; owner choice on committing, section 5 | 183 files cited as evidence by `BUILD-LOG.md`, `docs/DECISIONS.md`, `docs/TASKS.md` and the three `docs/tracks/ux-*.md` reports |
| `.pi/` (untracked) | Add to `.gitignore` | Local tool folder |

## 3. Proposed layout (needs approval before any move)

```text
AGENTS.md  STATUS.md  BUILD-LOG.md  REVIEW.md
docs/
  README.md  TASKS.md  DECISIONS.md  CONTEXT-RECORD.md  context.json
  02-PRD.md … 17-UX-FLOWS-SCREEN-CONTRACTS.md
  openapi.yaml  check-spec.py
  adr/        ADR-0001 … ADR-0016
  ops/        RUNBOOK.md  DEPLOY-COOLIFY.md  DEMO.md
  reviews/    research/    tracks/    evidence/
  archive/    STATUS-history-2026-11-05.md  BRIEF-M1.md  AGENTS-m2-tracks.md  mockups/
```

The move is one change: `git mv` for 16 ADRs, 3 operations documents, `BRIEF-M1.md` and `docs/mockups/`; every link in the 26 linking files; the `AGENTS.md` layout table; the file list in `check-spec.py`. `git mv` stages the renames, so it is run only after the owner approves. IDs and file names do not change. Checks after the move: `python3 docs/check-spec.py`, `pnpm map:check`, a repository-wide search for links to the old paths, and `git status` showing renames and documentation edits only.

A smaller alternative is to move nothing and keep the flat `docs/` folder. It costs no link edits and leaves 16 ADRs beside 16 specifications. Recommended: the layout above, because the ADR count keeps growing and the next tasks add more.

## 4. Done on 2026-11-15 without moving a tracked file

- `STATUS.md` now holds the current state, the decisions in force, the next tasks and the open items (44 lines). Its older sections were moved unchanged to `docs/archive/STATUS-history-2026-11-05.md`.
- `docs/TASKS.md` opens with an index of open tasks in work order. Task blocks were not moved, so every existing reference still resolves.
- 23 open tasks from before the direction change gained a dated direction note, and tasks T-116 to T-121 were added for decisions that had no owning task.

## 5. Owner choices

| Question | Recommendation |
|---|---|
| Approve the moves of section 3? | Yes |
| `docs/TASKS.md`: keep done tasks in the file, or move them to `docs/archive/TASKS-done.md`? | Keep them in the file. 40 of 121 tasks are Done, and other blocks cite them by ID; the index already gives the reading order |
| `docs/evidence/ux/` (183 untracked screenshots cited as evidence): commit them with the next commit, or leave them untracked? | Commit them: the documents that cite them are tracked, so a clone today has dangling evidence paths. Nothing is deleted either way |
| `.pi/` | Add to `.gitignore` |
