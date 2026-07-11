# Epic #2093 source-control regression evidence

Closure-evidence ledger for Epic #2093 (Built-in editor M5 — source control in the editor) and child
issues #2227–#2235. It records the implemented evidence surface and reserves explicit result slots
for final execution by the coordinator. A `PENDING` entry is not a pass and must be replaced with the
exact final command outcome, commit, platform, and relevant counts before this document can support
closure. This document makes no claim that a pull request was merged or that any issue was closed.

## Maintained policy

The human-control invariant remains unchanged. The editor receives bounded, read-only status,
structured diff, and blame data through the existing server-side `keiko-git` boundary. Conflict
resolution changes only the in-memory buffer through the normal undoable editor path; persistence is
a separate explicit save, and staging, commit, push, pull-request creation, and merge remain in the
governed Git Client/delivery surfaces. No complete file sides are fabricated from bounded hunks.

ADR-0127 owns the shared contract, staged/worktree separation, fixed caps, two-renderer decision,
closed marker grammar, and stale conflict-action rejection. The implementation reuses the existing
Git routes, editor host bridges, Files tree, Git Client, and M3 coding-context assembly rather than
creating parallel Git, diff, tree-status, conflict, or agent-context systems.

## End-to-end evidence

The required closeout suite is `tests/e2e/editor-source-control-2235.spec.ts`, configured by
`tests/e2e/config/playwright.issue-2235-editor-source-control.config.ts` and invoked with
`npm run test:e2e:editor-source-control-2235`. It must drive the real BFF with a hermetic,
Git-initialized workspace and cover all five required loop segments:

1. edit → distinct staged/unstaged gutter markers → activate marker → inline hunk peek;
2. bounded blame toggle → keyboard/pointer commit link-out;
3. real conflicted file → navigate → accept theirs → undo → accept ours → explicit save;
4. file and directory tree badges, including conflicted propagation and refresh after save; and
5. docked-agent coding-context assembly reporting conflict/read-only Git context through the real
   governed server path.

Chromium is the reference browser. WebKit timing/render artifacts are non-gating under repository
policy.

> E2E result: **PENDING — coordinator must record exact command, commit, browser, test count,
> duration, and outcome.**

## Focused regression facts already executed

These are narrow facts, not substitutes for the final gates:

| Command                                                                                                                                                                                                                                                                          | Recorded result                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/keiko-git/src/runner.test.ts packages/keiko-server/src/gitBlameParser.test.ts packages/keiko-server/src/gitRoutes.test.ts packages/keiko-editor/src/components/conflict-bridge.test.ts packages/keiko-server/src/editor/codingContextProviders.test.ts` | PASS on 2026-07-11: 5 files, 78 tests                                                                        |
| `npm test --workspace @oscharko-dev/keiko-ui -- src/app/components/desktop/widgets/gitObjectId.test.ts`                                                                                                                                                                          | PASS on 2026-07-11: 1 file, 1 test                                                                           |
| `npm run check:editor-bundle-size`                                                                                                                                                                                                                                               | Previously supplied implementation fact: B10 observed 98,029 B / 98,304 B ceiling; final rerun still PENDING |

## Coverage verification

`npm run test:coverage:quality` is the authoritative release-affecting chain. No floor may be
lowered and no assertion may be weakened. The five package floors required by #2235 are the
committed values in `docs/qa/package-coverage-baseline.json`:

| Package           | Line floor | Branch floor | Final observed lines | Final observed branches | Result      |
| ----------------- | ---------: | -----------: | -------------------- | ----------------------- | ----------- |
| `keiko-git`       |     94.87% |       78.57% | **PENDING**          | **PENDING**             | **PENDING** |
| `keiko-server`    |     88.44% |       75.87% | **PENDING**          | **PENDING**             | **PENDING** |
| `keiko-editor`    |     96.87% |       88.58% | **PENDING**          | **PENDING**             | **PENDING** |
| `keiko-ui`        |     88.91% |       76.70% | **PENDING**          | **PENDING**             | **PENDING** |
| `keiko-contracts` |     91.92% |       87.67% | **PENDING**          | **PENDING**             | **PENDING** |

> Coverage-chain result: **PENDING — coordinator must record package and UI test counts, all five
> observed line/branch values, branch-gate outcome, and whether any file floor failed.**

## Editor performance and resilience evidence

The source-control surface must preserve the authoritative budgets in
`docs/keiko-editor/1207-performance-budgets.md`:

| Budget | Requirement                                                | Source-control-specific proof                                                                                                                                                              | Final result                                               |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| B5     | Per-keystroke main-thread work `< 50 ms` with no long task | Gutter/conflict recomputation is asynchronous, debounced, stale-discarding, and outside the direct keystroke path; browser evidence must run with source-control features active.          | **PENDING — exact observed max/p95 and command**           |
| B8     | Degraded mode above 500 KiB or 10,000 lines                | Git gutter and blame bridges do zero work when degraded; large-file boundary regression exists in `git-gutter-bridge.test.ts` and stale/degraded blame coverage in `blame-bridge.test.ts`. | **PENDING — final test/gate output**                       |
| B9     | No Monaco editable path above 1,000,000 bytes              | Existing server `413 FILE_TOO_LARGE` boundary remains authoritative; source-control additions must not bypass it.                                                                          | **PENDING — final test/gate output**                       |
| B10    | Editor package own code `<= 98,304` gzip bytes             | `npm run check:editor-bundle-size`; previously supplied observation is 98,029 B, leaving 275 B headroom.                                                                                   | **PENDING final rerun**; prior fact: **98,029 / 98,304 B** |

`npm run check:perf-evidence` and the production-build editor performance Playwright gate remain the
authoritative aggregate evidence. B10's narrow 275-byte headroom makes the final clean-build rerun
load-bearing; the previously supplied value must not be treated as a waiver or future margin.

## Accessibility evidence

The source-control additions include non-color-only gutter metadata, keyboard-operable blame and
commit link-out, an Escape-dismissable/focus-managed hunk peek, named conflict actions/status, and
tree badges with textual/accessible state. Relevant focused suites include
`EditorGitHunkPeek.a11y.test.tsx`, `ConflictStatus.a11y.test.tsx`,
`GitClientWindow.a11y.test.tsx`, and `FilesWidget.a11y.test.tsx`.

> Accessibility result: **PENDING — coordinator must record the exact focused and aggregate UI
> commands, test counts, and axe outcomes.**

## Linux editor release evidence

Any `keiko-ui` change invalidates the editor release-evidence fingerprint. The authoritative value is
generated and validated on Linux/CI; a macOS fingerprint is platform-specific and must not replace
the committed Linux evidence.

> Linux release-evidence result: **PENDING — coordinator must record Linux runner/commit,
> `npm run check:editor-release-evidence` outcome, and resulting authoritative fingerprint or
> artifact reference.**

## Required final gates

Every row below is required by #2235, AGENTS.md, or the affected-surface addenda. Pending rows must be
replaced only with actually executed outcomes.

| Area                           | Command / check                                                       | Final result                                                 |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Source-control E2E             | `npm run test:e2e:editor-source-control-2235`                         | **PENDING**                                                  |
| Typecheck                      | `npm run typecheck`                                                   | **PENDING**                                                  |
| UI typecheck                   | `npm run typecheck --workspace @oscharko-dev/keiko-ui`                | **PENDING**                                                  |
| Lint                           | `NODE_OPTIONS='--max-old-space-size=8192' npm run lint`               | **PENDING**                                                  |
| UI lint                        | `npm run lint --workspace @oscharko-dev/keiko-ui`                     | **PENDING**                                                  |
| Format                         | `npm run format:check`                                                | **PENDING**                                                  |
| Unit/integration               | `npm test`                                                            | **PENDING**                                                  |
| Architecture                   | `npm run arch:check`                                                  | **PENDING**                                                  |
| Negative architecture          | `npm run arch:check:negative`                                         | **PENDING**                                                  |
| UI coverage                    | `npm run test:coverage:ui`                                            | **PENDING**                                                  |
| Full coverage quality          | `npm run test:coverage:quality`                                       | **PENDING**                                                  |
| Package surface/public exports | `npm run build && npm run check:package-surface`                      | **PENDING**                                                  |
| ADR index                      | `npm run check:adr-index`                                             | **PENDING**                                                  |
| UI i18n guard                  | `npm run check:ui-i18n`                                               | **PENDING**                                                  |
| Error observability            | `npm run check:error-observability`                                   | **PENDING**                                                  |
| Security regression matrix     | `npm run check:security-regression-matrix`                            | **PENDING**                                                  |
| Editor bundle/B10              | `npm run check:editor-bundle-size`                                    | **PENDING final rerun**; prior fact 98,029 / 98,304 B        |
| Performance evidence           | `npm run check:perf-evidence` plus editor performance Playwright gate | **PENDING**                                                  |
| Editor release evidence        | `npm run check:editor-release-evidence` on Linux/CI                   | **PENDING**                                                  |
| Required GitHub check          | `ci` on the final implementation PR head                              | **PENDING**                                                  |
| Remaining protected checks     | Current branch-protection checks listed in `CONTRIBUTING.md`          | **PENDING — enumerate exact final check names and outcomes** |

## Completion matrix

| Epic outcome / closeout criterion       | Implementation evidence                                                                                         | Closure status                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Staged/unstaged gutter markers          | Separate-layer structured reads and `git-gutter-bridge` identities; hunk peek uses shared bounded contract.     | **IMPLEMENTED; final E2E/gates PENDING**        |
| Inline diff peek                        | Shared hunk renderer preserves binary/truncated states and never invents full sides.                            | **IMPLEMENTED; final E2E/a11y PENDING**         |
| Bounded blame and Git Client link-out   | Privacy-minimized blame contract/route/bridge; strict SHA-1/SHA-256 object-id gate.                             | **IMPLEMENTED; final E2E/gates PENDING**        |
| Marker-based conflict editing           | Closed grammar, navigation, ours/theirs/both, one undoable edit, stale/digest fail-closed.                      | **IMPLEMENTED; final E2E/gates PENDING**        |
| Explicit-save boundary                  | Conflict resolution is buffer-only; existing human save is separate; no implicit index mutation.                | **IMPLEMENTED; final E2E PENDING**              |
| Editor ↔ Git Client interlock           | Same-root file/diff and validated-commit handoff reuse existing windows.                                        | **IMPLEMENTED; final E2E PENDING**              |
| File/directory Git decorations          | M/A/D/U/conflicted propagation and ignored dimming reuse status reads.                                          | **IMPLEMENTED; final E2E/a11y PENDING**         |
| Docked-agent Git context                | Existing M3 context provider adds bounded conflict/diff/blame excerpts and content-free citations/omissions.    | **IMPLEMENTED; final real-BFF E2E PENDING**     |
| Security review                         | Adversarial matrix and four fixed implementation findings recorded in `2093-source-control-security-review.md`. | **DOCUMENTED; aggregate security gate PENDING** |
| Performance, coverage, release evidence | B5/B8/B9/B10, five coverage floors, and Linux evidence slots above.                                             | **PENDING**                                     |
| Formal merge/issue closure              | Maintainer action after accepted evidence and protected checks.                                                 | **NOT CLAIMED**                                 |

## Known limits

- Conflict resolution is a marker-based two-way/diff3 block UI, not a full three-way merge editor.
- Push-driven workspace watch refresh waits for M7; the current surface refreshes on open/save/focus
  and explicit refresh without introducing a polling storm.
- Blame is current-file/current-revision only; blame-at-revision is not implemented.
- Editor/Git interlock reveals a line only; it has no column-level reveal contract.

## Closure assessment

The implementation and focused regression facts are sufficient to prepare closure evidence, but not
to assert final closure. The source-control E2E, full local gates, all five observed coverage pairs,
B5/B8/B9 and final B10 evidence, accessibility aggregate, Linux release fingerprint, and protected
GitHub checks remain pending. No merge or issue-closure claim is made by this document.
