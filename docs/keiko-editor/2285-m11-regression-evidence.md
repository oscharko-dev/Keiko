# Epic 2285 M11 regression and migration evidence

Evidence prepared: 2026-07-20 against the Issue #2533 child branch created from
`origin/feat/epic-built-in-editor-2285-M11@8dcb88fe97b01e0fe483453aaaaa431975efa853` with Node.js
24.18.0. The focused closeout receipts below are recorded only from commands actually executed.
Linux-authoritative D12 evidence remains separately governed by ADR-0139.

## Closeout status

| Evidence                         | Disposition                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Dependency entry condition       | **PASS** — all thirteen prerequisite M11 child issues #2520–#2532 are closed.                                                        |
| Adversarial matrix ownership     | **IMPLEMENTED** — 16 named rows are mapped to executable child tests and collected by one focused command.                           |
| Migration and rollback ownership | **IMPLEMENTED** — four named drills cover pre-M11 upgrade, downgrade guard, corrupt trust, and explicit re-grant.                    |
| Supplemental M11 measurement     | **PASS** — local `darwin-arm64` informational run; every deterministic disposition and every observed local budget passed.           |
| Focused M11 closeout             | **PASS** — 18 files and 137 tests passed in the issue-scoped package/UI collection.                                                  |
| Real product-path Playwright     | **PASS WITH FILED FINDING** — one Chromium journey passed in 45.4 s; the exact multi-root ARIA finding is owned by #2605.            |
| Exact epic-head CI               | **REMOTE RECEIPT AFTER PUSH** — the integration-branch push triggers the repository workflows; local evidence does not replace them. |

## Focused executable collection

`npm run test:editor-m11-closeout` builds internal packages and executes only the files that can
prove #2533. The collection includes:

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

| Row                                | Drill                                                         | Fail-closed result                                                                                    | Executable owner                   |
| ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `MIGRATION-PRE-M11-UPGRADE`        | Open a user-version 11 store containing a legacy project.     | Migration creates one deterministic manifest, preserves the project registry, and remains idempotent. | `store/workspaceManifests.test.ts` |
| `MIGRATION-DOWNGRADE-GUARD`        | Open state written by a schema newer than the current binary. | The typed `UI_STORE_SCHEMA_NEWER` error is returned; state is not quarantined or reinterpreted as V1. | `store/workspaceManifests.test.ts` |
| `MIGRATION-CORRUPT-TRUST-RECOVERY` | Read malformed persisted trust JSON.                          | Trust projects to restricted and no corrupt bytes become authority.                                   | `workspace-script-trust.test.ts`   |
| `MIGRATION-TRUST-REGRANT`          | Change the bound manifest/basis after an explicit grant.      | The old grant stays invalid; only a new explicit server grant restores trusted state.                 | `workspace-script-trust.test.ts`   |

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
checkpoint is retained, and checkpoint content does not enter browser storage. Real-browser axe
checks cover the populated multi-root Explorer, Settings/profile surface, and history panel.
Settings and history have no serious/critical violations. The Explorer scan deterministically
records the two-node critical `aria-required-children` defect filed as #2605; it neither suppresses
the rule nor represents the surface as green.

## Accessibility, visual, and i18n evidence

The focused UI collection executes existing component evidence rather than duplicating the design
system:

- multi-root Explorer arrow navigation, collapse, 320 px/200% zoom behavior, and axe;
- retained editor root session/layout behavior and model disposal after root removal;
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

This issue does not edit the ADR-0139 measurement toolchain, so it does not regenerate D12 evidence
in flight. The committed D12 comparison and deterministic bundle gates remain the Linux-authoritative
release evidence. The M11 harness follows the same discipline: real samples, p50/p95 summaries,
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
composition and the filed #2605 accessibility defect; only the final passing functional receipt
and its exact, unsuppressed known-finding assertion count as closeout evidence.
