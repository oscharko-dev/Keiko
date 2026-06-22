# Living Tests — drift detection + targeted regeneration verification note (#745)

## Context

Epic [#735](https://github.com/oscharko-dev/Keiko/issues/735) makes Quality Intelligence test
suites **living**: when a connected source (a Fachkonzept file, folder, or capsule) changes, QI
detects exactly which previously-generated tests are now stale — by comparing the current source
fingerprints against the per-atom fingerprints persisted with the run — and offers one-click
**targeted regeneration** of only the affected tests, preserving the rest (including human edits).
The immutable run manifest is never mutated; a regeneration is a brand-new run.

This page is the closure deliverable for the verification child
[#745](https://github.com/oscharko-dev/Keiko/issues/745): it cross-references every acceptance
criterion to file:line evidence, and records a **live drift→regenerate cycle against real Azure
(gpt-oss-120b)** — no mocks, no fixtures. It also documents the gaps the live run and release
re-audit surfaced in the already-merged feature (PR
[#773](https://github.com/oscharko-dev/Keiko/pull/773) +
[#821](https://github.com/oscharko-dev/Keiko/pull/821)) and the fixes that closed them.

The implementation reached `dev` in four waves: the original Living-Tests slice
([#773](https://github.com/oscharko-dev/Keiko/pull/773), `b152bd9`), atom-level
drift/regenerate hardening ([#821](https://github.com/oscharko-dev/Keiko/pull/821), `aecbe4f`),
live verification hardening ([#841](https://github.com/oscharko-dev/Keiko/pull/841), `4f9bffa`),
and the manual-run visibility fix ([#899](https://github.com/oscharko-dev/Keiko/pull/899),
`ec0eb57`). The `release/0.2.0` branch additionally carries release-targeted hardening for
[#742](https://github.com/oscharko-dev/Keiko/issues/742)
([#1058](https://github.com/oscharko-dev/Keiko/pull/1058), `44a5eda`), #743
([#1062](https://github.com/oscharko-dev/Keiko/pull/1062), `fb64aab`), and #744
([#1064](https://github.com/oscharko-dev/Keiko/pull/1064), `5e5f242`).

## Acceptance criteria → evidence

### #742 — Source-fingerprint diff + per-test staleness model

| AC                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A changed source marks EXACTLY the candidates derived from the changed atoms as stale | `compareStaleness` atom-level path (`packages/keiko-quality-intelligence/src/domain/staleness.ts:372` `classifyCandidateWithAtomFingerprints`). Release tests: `reCheckRoutes.test.ts:906` marks only the candidate derived from the edited requirement line stale; `staleness.test.ts:122` and `staleness.test.ts:145` cover replacement alignment for edited document requirement atoms. Live: editing one of six requirement statements flagged exactly the 6 derived candidates, 34 fresh (see below). |
| Unchanged sources mark NONE                                                           | `staleness.test.ts:51` + `reCheckRoutes.test.ts:488`; live: re-check of the identical source → `staleCount: 0, fresh: 40`.                                                                                                                                                                                                                                                                                                                                                                                 |
| Removed atom → orphaned-stale, surfaced distinctly                                    | `classifyMissingCurrentAtom` (`packages/keiko-quality-intelligence/src/domain/staleness.ts:349`), and `reCheckRoutes.test.ts:960` for deleted requirement lines.                                                                                                                                                                                                                                                                                                                                           |
| Empty current source → all candidates orphaned-stale (not an exception)               | `staleness.test.ts:242` pure-function unit coverage for empty `currentFingerprints`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Pure + deterministic                                                                  | `compareStaleness` is IO-free and preserves candidate input order (`packages/keiko-quality-intelligence/src/domain/staleness.ts:473`, `staleness.test.ts:311`).                                                                                                                                                                                                                                                                                                                                            |

### #743 — Re-check + targeted regeneration

| AC                                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-check reports the stale set                                                      | `POST …/re-check` → `handleQiReCheck` (`packages/keiko-server/src/qualityIntelligence/reCheckRoutes.ts:1486`). `reCheckRoutes.test.ts:906` pins the edited-requirement stale set.                                                                                                                                                                                                                                                                                                                                   |
| Targeted regeneration replaces ONLY stale candidates; preserves fresh + human edits | `narrowRegeneration` (`reCheckRoutes.ts:919`) + `persistRegenerationResult` (`reCheckRoutes.ts:1412`); preserved edited revisions are filtered to preserved candidate ids (`buildPreservedState`, `reCheckRoutes.ts:571`). Tests: preserved fresh edit history (`reCheckRoutes.test.ts:1070`), pasted edited-line-only regeneration (`reCheckRoutes.test.ts:1142`), workspace Markdown edited-line-only regeneration (`reCheckRoutes.test.ts:1202`), and stale edit history dropped (`reCheckRoutes.test.ts:1617`). |
| The original immutable manifest is NEVER mutated                                    | New `qi-run-<uuid>` written; original untouched. Live: original manifest byte-identical after regeneration. Pinned by `reCheckRoutes.test.ts:1564` "the original immutable run is never mutated".                                                                                                                                                                                                                                                                                                                   |

### #744 — Drift indicator + regenerate-stale action (UI)

| AC                                                                          | Evidence                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card shows how many tests are stale and lets the user regenerate only those | `DriftPanel.tsx` (`DriftIndicator`, `packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/DriftPanel.tsx:50`, and "Regenerate N stale tests", `DriftPanel.tsx:174`).              |
| a11y: drift indicator is NOT colour-only                                    | `DriftPanel.tsx:50` pairs icon-only decoration (`aria-hidden`) with meaning-bearing text; `DriftPanel.test.tsx:53` and `DriftPanel.test.tsx:68` assert stale/fresh text.                               |
| Card is refreshed after regeneration                                        | Regeneration opens the NEW immutable run on the canvas (`widgets/index.tsx:204` `qiRun` render `onRegenerated` → `ctx.openWindow("qiRun", …)`); the stale indicator is cleared (`DriftPanel.tsx:113`). |

### #745 — Verification (this note)

Only tests derived from the changed requirement are flagged + regenerated; others (and edits)
preserved; immutable manifest unchanged. **Proven live below.**

Release `0.2.0` re-audit note: the live Azure cycle below is retained as the no-mock closure
evidence from #841. The current release branch also has deterministic regression coverage for the
same acceptance contract: edited requirement lines only (`reCheckRoutes.test.ts:906`), targeted
regeneration of the edited pasted requirement line only (`reCheckRoutes.test.ts:1142`), targeted
regeneration of an edited requirement inside a multi-requirement workspace Markdown document
(`reCheckRoutes.test.ts:1202`), fresh edit preservation (`reCheckRoutes.test.ts:1070`), stale edit
exclusion (`reCheckRoutes.test.ts:1617`), immutable original manifest/candidate artifacts
(`reCheckRoutes.test.ts:1564`), workspace file-order drift defence (`reCheckRoutes.test.ts:1429`),
and the empty-merge fail-closed guard (`reCheckRoutes.test.ts:1487`).

## Live drift→regenerate cycle (real Azure, gpt-oss-120b)

Environment: local production-style server (`node --experimental-sqlite dist/cli/index.js ui`),
gateway configured from the repo `.env` (one chat provider, `gpt-oss-120b`, structured output).
Isolated evidence dir + ui-db. Sources are real files/text; no mocks.

### A. Requirements source — statement-level atom precision

1. Generated a run from a 6-statement Fachkonzept (login, account-lock, payments, invoice, email,
   reporting) → **40 candidates**, each attributed to its statement's atom (clean 1:1 atom map).
2. Re-check with the **unchanged** source → `staleCount: 0, fresh: 40`. No false-positive drift.
3. Edited **only the payments statement** (added "and PayPal"), every other line byte-identical →
   re-check → `staleCount: 6, fresh: 34`. The 6 stale candidates were **exactly** the payment tests;
   login/lockout/invoice/email/reporting stayed fresh.
4. Inline-edited a fresh login candidate's title (`"EDITED: … (human-curated)"`).
5. `regenerate-stale` → new run id; `regeneratedCount: 15, preservedCount: 34`. The 6 old payment
   candidate ids were **gone**; 4 new candidates mention **PayPal** (the regeneration reflects the
   changed statement). The edited login candidate is **preserved with its edited title**.
6. The original run reloaded **byte-identical** (status/candidates/findings/timestamps unchanged).

### B. Workspace folder — file-level atom precision + the BLOCKER

1. Connected a folder of 4 Fachkonzept files → run with **49 candidates**.
2. Re-check unchanged → `staleCount: 0`.
3. Edited **only** `02-payments.md` → re-check → `staleCount: 12`, all 12 the payment/invoice/checkout
   tests; the 37 auth/notification/reporting tests stayed fresh.

### BLOCKER found + fixed live: workspace atom-id positional drift

The shipped `workspaceAtom`/`capsuleDocAtom` derived the atom id from the file's **position in the
discovery order** (`qi-atom-ws-v1|<env>|<index>|<path>`). Adding or removing any file shifted the
indices of all later files, changing their atom ids even though their content was untouched.

- **Before fix (live):** adding one unrelated intro file to the connected folder → re-check reported
  **37 of 37 candidates orphaned-stale**; `regenerate-stale` then produced a run with **0 candidates**
  — every test silently destroyed by adding a file.
- **Fix:** derive the atom id from the stable path/document id only
  (`qi-atom-ws-v2|<env>|<path>`, `qi-atom-cap-v2|<env>|<docId>`) — content changes are still caught by
  the `canonicalHashSha256Hex` diff (`runIngestion.ts`).
- **After fix (live):** the identical add-a-file action → `staleCount: 0` (every unchanged file stays
  fresh); a real in-place content edit still flags exactly the edited file's tests.
- **Defence in depth:** `regenerate-stale` now fails closed with `QI_REGEN_WOULD_EMPTY` (409) rather
  than ever turning a non-empty run into an empty one (`reCheckRoutes.ts`).
- **Regression test:** `reCheckRoutes.test.ts` "workspace file order changes do NOT false-orphan
  unchanged files".

## Other gaps closed during live hardening

- **`sourceFingerprints` were not integrity-hashed** (only `atomFingerprints` were). Added them to the
  manifest integrity hashes (backward-compatible: enforced only when a stored hash is present), so a
  tampered envelope fingerprint set is detectable (`store.ts`, `manifestSchema.ts`).
- **Drift was unavailable for capsule / figma-snapshot / multi-source runs** — the run card could only
  reconstruct a single connected file/folder. Generalised the drift panel to re-check against **all**
  connected sources, reconstructed in the RunLauncher's exact order via the shared
  `buildConnectedRunSources` (`connectedSources.ts:200`) used by both generation and drift so the
  reconstructed sources match the generated ones byte-for-byte.
- **The regenerated run was not surfaced** — `onRegenerated` reloaded the old (immutable) card.
  It now opens the new run on the canvas and clears the now-stale drift indicator.
- **Explicit run-id validation** on both POST routes (400 instead of a generic 500 for a
  traversal-shaped id).
- **Manual local-folder runs could reopen without a visible drift path** — fixed in #899 by carrying
  launch-time source handles into the opened run card and exposing browser-safe drift capability
  metadata. Release #1064 then tightened the historical run-list path so old rows pass an explicit
  empty source-handle set instead of borrowing any currently connected source (`QiHubPanel.tsx:124`,
  `QiHubPanel.test.tsx:55`).

## Release re-audit gaps closed for #745

- **Workspace Markdown replacement was still too coarse for targeted regeneration.** Multi-line
  requirements extracted from a `.md` workspace document intentionally get new atom ids when a
  statement's content changes. Without replacement metadata and sequence alignment, the stale old atom
  could be classified as changed but not mapped back to the current replacement atom for regeneration,
  so `regenerate-stale` could preserve every fresh test and drop the stale one. A raw ordinal-only
  mapping was also unsafe when a new requirement was inserted before the edited one. The release fix
  persists hashed replacement metadata (`manifestSchema.ts:135`, `modelRoutedTestDesign.ts:57`),
  stamps requirements and document-derived requirement atoms during ingestion (`runIngestion.ts:265`,
  `runIngestion.ts:280`, `runIngestion.ts:377`), aligns old/current replacement sequences
  (`staleness.ts:293`, `reCheckRoutes.ts:799`), and refuses to regenerate against atoms that already
  belonged to the old run (`reCheckRoutes.ts:845`). Regressions: `staleness.test.ts:145`,
  `reCheckRoutes.test.ts:1202`.
- **Reopened historical runs could retain stale connected-source handles.** The desktop window focus
  path merges new cfg into an existing `qiRun` card. A requirements-only or historical-row reopen used
  to serialize no connected-source cfg, which meant an existing card could keep old source handles and
  offer drift actions against the wrong source. The release fix serializes explicit empty connected
  source sets as `connectedSourcesJson: "[]"` (`connectedSources.ts:94`) and pins both the pure
  serializer and the window-focus merge path (`connectedSources.test.ts:249`,
  `workspaceActions.test.ts:768`).

## Design notes (intended behaviour, not gaps)

- **Connected-source paths are NOT persisted in the durable `qiRun` window cfg** (the window's
  persistence policy is `evidence-reference` — opaque ids only, no local filesystem paths in durable
  storage). The drift affordance is available when the current card has live source handles: completion
  of a manual local-folder run carries those handles into the opened run card, and regenerated cards
  carry the same connected-source set forward (`widgets/index.tsx:177`, `widgets/index.tsx:208`).
  Historical run-list rows intentionally pass an empty handle set; the empty set is serialized into
  existing `qiRun` windows so stale handles are cleared. When the run has drift metadata but no current
  handle, the card shows disabled guidance instead of silently hiding the feature (`QiRunCard.tsx:260`).
- A file source is at least file-level and can be statement-level for text/Markdown documents with
  multiple extractable requirement statements; unsupported or non-requirement file content remains a
  whole-file atom. Statement-level precision always applies to `requirements` text and can apply inside
  connected files/folders when document requirement extraction yields multiple atoms.

## Gates

- Historical closure gates: root `npm run typecheck`, `eslint . --max-warnings=0`, `npm test`; UI
  `npx tsc --noEmit` and focused Vitest coverage for DriftPanel, QiRunCard, RunLauncher, and
  connectedSources.
- Release #745 focused gates: `npm test -- packages/keiko-quality-intelligence/src/__tests__/staleness.test.ts packages/keiko-server/src/qualityIntelligence/__tests__/reCheckRoutes.test.ts packages/keiko-evidence/src/qualityIntelligence/__tests__/localStoreCrud.test.ts`;
  `npm --prefix packages/keiko-ui test -- connectedSources.test.ts workspaceActions.test.ts QiHubPanel.test.tsx QiRunCard.test.tsx QiRunCard.a11y.test.tsx DriftPanel.test.tsx RunLauncher.test.tsx`.
