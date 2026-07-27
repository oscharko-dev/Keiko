# Epic 2285 M11 regression and migration evidence

Evidence prepared: 2026-07-20 against the Issue #2533 child branch created from
`origin/feat/epic-built-in-editor-2285-M11@8dcb88fe97b01e0fe483453aaaaa431975efa853` with Node.js
24.18.0. The focused closeout receipts below are recorded only from commands actually executed.
Linux-authoritative D12 evidence remains separately governed by ADR-0139.

That milestone branch and that commit are historical: the branch was squash-merged into `dev` and
deleted, so the SHA above is no longer reachable in the repository and is recorded only to say where
the original measurement was taken. Anyone re-running this evidence uses `dev`, which carries the
merged milestone and the repairs that followed it; the clean-checkout reproduction in
[the demo](2285-m11-demo.md) is the executable form.

Receipt provenance: the focused-closeout and supplemental-measurement numbers below were re-recorded
under #2626 on `darwin-arm64` with Node.js 24.18.0, on the current `dev` line. The previous
focused-closeout receipt reported only the first half of a two-command collection — the `keiko-ui`
workspace half ran and passed but was absent from the number, so the figure understated the
collection rather than overstating it. Both halves are reported now.

The focused-closeout and Playwright numbers were re-recorded again on `darwin-arm64` with Node.js
24.18.0 during the epic audit. The `keiko-ui` half moved from 9 files / 99 tests to 11 files / 120
tests: it gained `MultiRootFilesWidget.a11y.test.tsx`, which scans the real multi-root Explorer
instead of a mocked file tree, and `SelectionAwareWorkspaceHosts.test.tsx`, which owns the
model-disposal assertion this document bullets and previously did not execute.

## Closeout status

| Evidence                         | Disposition                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency entry condition       | **PASS** — all thirteen prerequisite M11 child issues #2520–#2532 are closed.                                                                                     |
| Adversarial matrix ownership     | **IMPLEMENTED** — 16 named rows are mapped to executable child tests and collected by one focused command.                                                        |
| Migration and rollback ownership | **IMPLEMENTED** — four named drills cover pre-M11 upgrade, downgrade guard, corrupt trust, and explicit re-grant.                                                 |
| Supplemental M11 measurement     | **PASS** — local `darwin-arm64` informational run; every deterministic disposition and every observed local budget passed.                                        |
| Focused M11 closeout             | **PASS** — both halves of the one command: 18 files / 201 tests in the package collection, then 11 files / 120 tests in the `keiko-ui` workspace collection.      |
| Real product-path Playwright     | **PASS** — one Chromium journey passed in 20.5 s; every scanned surface, the multi-root Explorer included, is now asserted free of serious/critical axe findings. |
| Exact epic-head CI               | **REMOTE RECEIPT AFTER PUSH** — the integration-branch push triggers the repository workflows; local evidence does not replace them.                              |

## Focused executable collection

`npm run test:editor-m11-closeout` builds internal packages and executes only the files that can
prove #2533. It is one command with two halves — a root Vitest run over the package and
repository-level files, then the `keiko-ui` workspace run — and a receipt for it must report both.
The collection includes:

- closed manifest, trust, profile, and local-history contract tests;
- canonical trust persistence, manifest migration/mutation, explicit dispatch, agent-root, managed
  LSP live-trust, profile portability, encrypted history, authenticated history routes, and
  forbidden-field tests;
- the measurement harness tests, browser source-contract guard, and this evidence guard; and
- the M11 multi-root, trust, profile, history, Settings/search, axe, keyboard, responsive, and i18n
  UI component tests.

No full repository test, aggregate pre-PR wrapper, mutation run, or unrelated quality gate belongs
to this child-to-epic closeout command.

## Migration and rollback drills

| Row                                | Drill                                                                                   | Fail-closed result                                                                                                                                                                                                   | Executable owner                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `MIGRATION-PRE-M11-UPGRADE`        | Open a user-version 11 store containing a legacy project.                               | Migration creates one deterministic manifest, preserves the project registry, and remains idempotent.                                                                                                                | `store/workspaceManifests.test.ts` |
| `MIGRATION-DOWNGRADE-GUARD`        | Open state written by a schema newer than the current binary.                           | The typed `UI_STORE_SCHEMA_NEWER` error is returned; state is not quarantined or reinterpreted as V1.                                                                                                                | `store/workspaceManifests.test.ts` |
| `MIGRATION-CORRUPT-TRUST-RECOVERY` | Read malformed persisted trust JSON.                                                    | Trust projects to restricted and no corrupt bytes become authority.                                                                                                                                                  | `workspace-script-trust.test.ts`   |
| `MIGRATION-TRUST-REGRANT`          | Change the trust basis after an explicit grant, then roll it back to the granted bytes. | The demotion is read back at the same revision from a closed and reopened database, restored bytes do not resurrect the grant, and only a new explicit server grant returns the root to trusted at a newer revision. | `workspace-script-trust.test.ts`   |

Every drill above names the assertion that runs it, and the matrix guard
[`tests/qa/editor-m11-closeout-evidence.test.ts`](../../tests/qa/editor-m11-closeout-evidence.test.ts)
pins the mapping. `MIGRATION-TRUST-REGRANT` was mapped until #2626 to a test that grants once on a
fresh store and never touches the trust basis — it performed no leg of this drill, so the row rested
on its own wording. It now owns a test that runs the whole loop.

Profiles and local history have no legacy records. Missing state remains `absent`; corrupt or
future state remains `unavailable`. Rollback may remove M11 state, but it cannot reinterpret a V2
binding as the byte-identical V1 task-workspace contract.

## Product-path browser proof

`npm run test:e2e:editor-m11-closeout-2533` is registered in the required UI workflow lane. It
uses the shared real BFF/Next.js servers, a launcher-attested local app session, and disposable
filesystem roots. It covers the full loop required by #2533:

```text
clean state → two-root manifest → trusted Alpha + restricted Beta
→ profile create/switch → two saves → authenticated history restore
```

The journey proves that root focus does not copy trust, Restricted Mode remains visible, a profile
switch does not alter trust, restore writes only through the governed file route, the pre-restore
checkpoint is retained, and checkpoint content enters none of the browser's storage sinks — the
probe reads the context storage state for cookies, `localStorage`, and IndexedDB, plus
`sessionStorage` enumerated from the page. Each reader carries a positive control, so a probe that
captured nothing cannot report a clean sink. Real-browser axe checks cover the populated multi-root
Explorer, the Settings **Editor** tab carrying the profile controls, and the history panel; the
journey opens that tab and asserts the active profile is on screen before scanning, because the
settings window mounts on its Models tab. All three surfaces — Settings, history and the populated
multi-root Explorer — have no serious/critical violations. The Explorer scan recorded a two-node
critical `aria-required-children` defect, filed as #2605, until that defect was repaired at the
component that owns the tree markup; it is asserted green now, with no rule suppressed or excluded.

## Accessibility, visual, and i18n evidence

The focused UI collection executes existing component evidence rather than duplicating the design
system:

- multi-root Explorer arrow navigation, collapse, 320 px/200% zoom behavior, and axe;
- retained editor root session/layout behavior, and model disposal after root removal — the
  assertion that owns that claim is pinned as `MULTI-ROOT-REMOVED-ROOT-DISPOSAL`, because the
  collection previously contained only the retarget case, which asserts disposal is NOT called;
- trust prompt safe default, focus trap, malformed-success fail-closed handling, and English/German
  catalog ownership;
- profile creation/switching/portability and Settings source-provenance controls;
- history keyboard actions, compare/restore conflict handling, virtualization, content-free browser
  persistence, and axe; and
- ordered root search attribution, isolated root errors, total caps, and one-root-at-a-time replace.

All M11 styles remain component-scoped. `packages/keiko-ui/**/globals.css` is unchanged.

## Performance and D12 disposition

The supplemental `check:editor-m11-performance` harness measures the maximum 32-root projection,
32-root search fan-out, serialized editor root sessions, eight history roots, and a 64-checkpoint
history chain. The local informational result is detailed in the security/performance review.

This issue edits no file in the ADR-0139 measurement toolchain, but the milestone does: #2523 edited
`tests/e2e/support/editorWorkspace.ts`, which is a member of `D12_MEASUREMENT_TOOLCHAIN_PATHS`.
`check:perf-evidence:editor` evaluates the branch, not the issue, so the D12 evidence was
regenerated in flight on Linux (#2614). An earlier revision of this paragraph asserted the opposite
at issue scope while the gate was red.

The committed D12 comparison and deterministic bundle gates remain the Linux-authoritative release
evidence. The M11 harness follows the same discipline: real samples, p50/p95 summaries,
deterministic disk/retention enforcement everywhere, and wall-clock/RSS enforcement only when a
controlled runner sets `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1`.

## Capability delta against #2088

The clean-checkout demo records the exact before/after delta: single-root context becomes an
explicit ordered manifest, binary script trust becomes canonical per-root Restricted Mode, M7
settings gain profile/root layers, hot exit gains a separate bounded encrypted history chain, and
agent context becomes exact-root bound. The same document names the excluded remote, extension,
and cross-root-transaction claims so M11 does not overstate parity.

## Required #2533 commands

```bash
npm run test:editor-m11-closeout
npm run check:editor-m11-performance
npm run test:e2e:editor-m11-closeout-2533
```

The missing-dependency preflight and the macOS symlinked-temp fixture failure encountered while
building the measurement harness are setup/fixture failures, not passing evidence. The recorded
performance receipt is the subsequent successful run after locked dependencies were restored and
the fixture root was canonicalized. Browser repair runs exposed connection-pool-sensitive phase
composition and the #2605 accessibility defect; only the final passing functional receipt and its
unsuppressed axe assertions count as closeout evidence. #2605 has since been repaired, so that
assertion is a zero-violation one rather than an exact known-finding one.
