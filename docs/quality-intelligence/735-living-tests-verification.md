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
(gpt-oss-120b)** — no mocks, no fixtures. It also documents the gaps the live run surfaced in the
already-merged feature (PR [#773](https://github.com/oscharko-dev/Keiko/pull/773) +
[#821](https://github.com/oscharko-dev/Keiko/pull/821)) and the fixes that closed them.

The feature shipped to `dev` in two waves: the original Living-Tests slice
([#773](https://github.com/oscharko-dev/Keiko/pull/773), `b152bd9`) and a follow-up drift/regenerate
hardening ([#821](https://github.com/oscharko-dev/Keiko/pull/821), `aecbe4f`) that introduced
atom-level fingerprints. This note covers the live re-hardening on top of both.

## Acceptance criteria → evidence

### #742 — Source-fingerprint diff + per-test staleness model

| AC                                                                                    | Evidence                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A changed source marks EXACTLY the candidates derived from the changed atoms as stale | `compareStaleness` atom-level path (`packages/keiko-quality-intelligence/src/domain/staleness.ts:140` `classifyCandidateWithAtomFingerprints`). Live: editing one of six requirement statements flagged exactly the 6 derived candidates, 34 fresh (see below). |
| Unchanged sources mark NONE                                                           | `staleness.ts:42` test + live: re-check of the identical source → `staleCount: 0, fresh: 40`.                                                                                                                                                                   |
| Removed atom → orphaned-stale, surfaced distinctly                                    | `staleness.ts:114` (`source-removed`), `classifyMissingCurrentAtom` (`staleness.ts:127`).                                                                                                                                                                       |
| Empty current source → all candidates orphaned-stale (not an exception)               | `staleness.ts:166` unit test (pure function returns all-orphaned for empty `currentFingerprints`).                                                                                                                                                              |
| Pure + deterministic                                                                  | `compareStaleness` is IO-free; candidate input order preserved (`staleness.ts:235`).                                                                                                                                                                            |

### #743 — Re-check + targeted regeneration

| AC                                                                                  | Evidence                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-check reports the stale set                                                      | `POST …/re-check` → `handleQiReCheck` (`packages/keiko-server/src/qualityIntelligence/reCheckRoutes.ts`).                                                                                    |
| Targeted regeneration replaces ONLY stale candidates; preserves fresh + human edits | `narrowRegeneration` + `persistMergedRun` (`reCheckRoutes.ts`); preserved edited revisions filtered to preserved candidate ids (`buildPreservedState`).                                      |
| The original immutable manifest is NEVER mutated                                    | New `qi-run-<uuid>` written; original untouched. Live: original manifest byte-identical after regeneration. Pinned by `reCheckRoutes.test.ts` "the original immutable run is never mutated". |

### #744 — Drift indicator + regenerate-stale action (UI)

| AC                                                                          | Evidence                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card shows how many tests are stale and lets the user regenerate only those | `DriftPanel.tsx` (`DriftIndicator` + "Regenerate N stale tests").                                                                                                                                                |
| a11y: drift indicator is NOT colour-only                                    | `DriftPanel.tsx` pairs an icon (`✓`/`⚠`, `aria-hidden`) with meaning-bearing text; `DriftPanel.test.tsx` asserts the text.                                                                                       |
| Card is refreshed after regeneration                                        | Regeneration opens the NEW immutable run on the canvas (`widgets/index.tsx` `qiRun` render `onRegenerated` → `ctx.openWindow("qiRun", …)`); the stale indicator is cleared (`DriftPanel.tsx` `setReport(null)`). |

### #745 — Verification (this note)

Only tests derived from the changed requirement are flagged + regenerated; others (and edits)
preserved; immutable manifest unchanged. **Proven live below.**

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
  connected sources, reconstructed in the RunLauncher's exact order via a shared
  `buildConnectedInlineSources` (`connectedSources.ts`) used by both generation and drift so the
  reconstructed sources match the generated ones byte-for-byte.
- **The regenerated run was not surfaced** — `onRegenerated` reloaded the old (immutable) card.
  It now opens the new run on the canvas and clears the now-stale drift indicator.
- **Explicit run-id validation** on both POST routes (400 instead of a generic 500 for a
  traversal-shaped id).

## Design notes (intended behaviour, not gaps)

- **Connected-source paths are NOT persisted in the `qiRun` window cfg** (the window's persistence
  policy is `evidence-reference` — opaque ids only, no local filesystem paths in durable storage). The
  drift affordance is therefore available in-session: the QI hub threads the live connection into the
  run card when the run is opened. After a reload the user re-opens the run from the hub (whose
  connection is still live). This matches the epic invariant that run sources are not persisted.
- A single-file source is one atom (whole document); statement-level precision applies to
  `requirements` text and multi-file folders. Editing a single connected file marks its tests stale as
  a unit — correct, just coarser than the multi-statement case.

## Gates

- Root: `npm run typecheck`, `eslint . --max-warnings=0`, `npm test` (incl. the new staleness /
  reCheck / store / scopedRegeneration tests).
- UI (separate): `( cd packages/keiko-ui && npx tsc --noEmit && npx vitest run … )` — DriftPanel,
  QiRunCard, RunLauncher, connectedSources.
