# Epic #2093 source-control regression evidence

Closure-evidence ledger for Epic #2093 (Built-in editor M5 — source control in the editor) and child
issues #2227–#2235. It records the implemented evidence surface and the local closeout results from
the final implementation branch. Protected GitHub checks are recorded on the pull request because
they do not exist before publication. This document makes no claim that a pull request was merged or
that any issue was closed.

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

> E2E result: **PASS** — `npm run test:e2e:editor-source-control-2235` on Chromium, source tree
> captured by commit `391e6e27`, 5/5 tests passed in 25.9 seconds on 2026-07-11.

## Focused regression facts already executed

These are narrow facts, not substitutes for the final gates:

| Command                                                                                                                                                                                                                                                                          | Recorded result                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/keiko-git/src/runner.test.ts packages/keiko-server/src/gitBlameParser.test.ts packages/keiko-server/src/gitRoutes.test.ts packages/keiko-editor/src/components/conflict-bridge.test.ts packages/keiko-server/src/editor/codingContextProviders.test.ts` | PASS on 2026-07-11: 5 files, 78 tests                                                                              |
| `npm test --workspace @oscharko-dev/keiko-ui -- src/app/components/desktop/widgets/gitObjectId.test.ts`                                                                                                                                                                          | PASS on 2026-07-11: 1 file, 1 test                                                                                 |
| `npm run check:editor-bundle-size -- --require-static-export`                                                                                                                                                                                                                    | PASS on 2026-07-11: B10 98,159 / 98,304 B; 13 first-load scripts scanned; first-load footprint 310,375 / 311,296 B |

## Coverage verification

`npm run test:coverage:quality` is the authoritative release-affecting chain. No floor may be
lowered and no assertion may be weakened. The five package floors required by #2235 are the
recorded baseline values in `docs/qa/package-coverage-baseline.json`. Effective line floors are
85%, while branch floors use the repository's target-or-ratchet policy:

| Package           | Recorded lines | Recorded branches | Final observed lines | Final observed branches | Result   |
| ----------------- | -------------: | ----------------: | -------------------: | ----------------------: | -------- |
| `keiko-git`       |         94.87% |            78.57% |               98.86% |                  89.23% | **PASS** |
| `keiko-server`    |         88.44% |            75.87% |               88.61% |                  76.33% | **PASS** |
| `keiko-editor`    |         96.87% |            88.58% |               93.28% |                  85.20% | **PASS** |
| `keiko-ui`        |         88.91% |            76.70% |               88.73% |                  77.08% | **PASS** |
| `keiko-contracts` |         91.92% |            87.67% |               91.06% |                  86.75% | **PASS** |

> Coverage-chain result: **PASS** — `npm run test:coverage:quality` ran 1,093 package test files
> (18,633 passed, 2 skipped) and 299 UI test files (4,814 passed). The final UI-only rerun after the
> empty-preview hardening ran 4,815 tests. All package and release-target line floors, all branch
> ratchets, and all 26 governed file floors passed with zero violations.

## Editor performance and resilience evidence

The source-control surface must preserve the authoritative budgets in
`docs/keiko-editor/1207-performance-budgets.md`:

| Budget | Requirement                                                | Source-control-specific proof                                                                                                                                                              | Final result                                                             |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| B5     | Per-keystroke main-thread work `< 50 ms` with no long task | Gutter/conflict recomputation is asynchronous, debounced, stale-discarding, and outside the direct keystroke path; production editor-performance Playwright evidence exercised the editor. | **PASS** — p95 0 ms, max 0 ms, 0 long tasks                              |
| B8     | Degraded mode above 500 KiB or 10,000 lines                | Git gutter and blame bridges do zero work when degraded; large-file boundary regressions run in the package tests.                                                                         | **PASS** — focused regressions and aggregate performance evidence passed |
| B9     | No Monaco editable path above 1,000,000 bytes              | Existing server `413 FILE_TOO_LARGE` boundary remains authoritative; source-control additions do not bypass it.                                                                            | **PASS** — package regressions and 413 degradation evidence passed       |
| B10    | Editor package own code `<= 98,304` gzip bytes             | `npm run check:editor-bundle-size -- --require-static-export` against the production static export.                                                                                        | **PASS** — 98,159 / 98,304 B (145 B headroom)                            |

`npm run check:perf-evidence`, `npm run test:e2e:editor-perf`, and
`npm run test:e2e:workspace-perf` passed. Editor cold start measured p50 859 ms / p95 863 ms,
interaction p75/max 24 ms, and 31.2 MB baseline/peak/residual memory. Chromium workspace pan, zoom,
and drag remained inside frame-gap budgets with zero long tasks. B10's 145-byte headroom and the
first-load budget's 921-byte headroom remain narrow and must not be treated as future margin.

## Accessibility evidence

The source-control additions include non-color-only gutter metadata, keyboard-operable blame and
commit link-out, an Escape-dismissable/focus-managed hunk peek, named conflict actions/status, and
tree badges with textual/accessible state. Relevant focused suites include
`EditorGitHunkPeek.a11y.test.tsx`, `ConflictStatus.a11y.test.tsx`,
`GitClientWindow.a11y.test.tsx`, and `FilesWidget.a11y.test.tsx`.

> Accessibility result: **PASS** — focused hunk-peek/conflict/Git Client/Files accessibility suites
> passed within `npm run test:coverage:ui`; the final UI run passed 299 files / 4,815 tests with no
> axe violation. The real-BFF E2E also verified the visible non-color staged, unstaged, and blame
> glyph channels plus keyboard commit handoff.

## Linux editor release evidence

Any `keiko-ui` change invalidates the editor release-evidence fingerprint. The authoritative value is
generated and validated on Linux/CI; a macOS fingerprint is platform-specific and must not replace
the committed Linux evidence.

> Linux release-evidence result: **PASS** — clean `node:22-bookworm` build from commit `391e6e27`;
> `npm run check:editor-release-evidence` passed with fingerprint
> `ba49c1483866b583330343f2e5c72451928540aa958a5c493c6626e29f5a66a8`. B1 was 0 markers in 13
> scripts, B2 was 1,180,140 / 2,621,440 B, and B3 was 106,160 / 768,000 B.

## Required final gates

Every row below is required by #2235, AGENTS.md, or the affected-surface addenda. Pending rows must be
replaced only with actually executed outcomes.

| Area                           | Command / check                                                      | Final result                                                 |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Source-control E2E             | `npm run test:e2e:editor-source-control-2235`                        | **PASS** — 5/5 Chromium, 25.9 s                              |
| Typecheck                      | `npm run typecheck`                                                  | **PASS**                                                     |
| UI typecheck                   | `npm run typecheck --workspace @oscharko-dev/keiko-ui`               | **PASS**                                                     |
| Lint                           | `NODE_OPTIONS='--max-old-space-size=8192' npm run lint`              | **PASS**, zero warnings                                      |
| UI lint                        | `npm run lint --workspace @oscharko-dev/keiko-ui`                    | **PASS**, zero warnings                                      |
| Format                         | `npm run format:check`                                               | **PASS**                                                     |
| Unit/integration               | `npm test`                                                           | **PASS** — 1,085 files; 18,543 passed, 2 skipped             |
| Architecture                   | `npm run arch:check`                                                 | **PASS** — 2,905 modules / 8,120 dependencies                |
| Negative architecture          | `npm run arch:check:negative`                                        | **PASS**                                                     |
| UI coverage                    | `npm run test:coverage:ui`                                           | **PASS** — 299 files / 4,815 tests                           |
| Full coverage quality          | `npm run test:coverage:quality`                                      | **PASS** — floors, release targets, branches, 26 file floors |
| Package surface/public exports | clean build/prune sequence plus `npm run check:package-surface`      | **PASS** — 4,530 files                                       |
| ADR index                      | `npm run check:adr-index`                                            | **PASS** — 100 unique indexed ADRs                           |
| UI i18n guard                  | `npm run check:ui-i18n`                                              | **PASS** — 10 changed UI files                               |
| Error observability            | `npm run check:error-observability`                                  | **PASS**                                                     |
| Security regression matrix     | `npm run check:security-regression-matrix`                           | **PASS** — 42 findings mapped                                |
| Editor bundle/B10              | `npm run check:editor-bundle-size -- --require-static-export`        | **PASS** — 98,159 / 98,304 B                                 |
| Performance evidence           | `npm run check:perf-evidence` plus editor/workspace Playwright gates | **PASS**                                                     |
| Editor release evidence        | `npm run check:editor-release-evidence` in `node:22-bookworm`        | **PASS** — fingerprint recorded above                        |
| Required GitHub check          | `ci` on the final implementation PR head                             | **PENDING**                                                  |
| Remaining protected checks     | Current branch-protection checks listed in `CONTRIBUTING.md`         | **PENDING — enumerate exact final check names and outcomes** |

## Completion matrix

| Epic outcome / closeout criterion       | Implementation evidence                                                                                         | Closure status  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------- |
| Staged/unstaged gutter markers          | Separate-layer structured reads and `git-gutter-bridge` identities; hunk peek uses shared bounded contract.     | **VERIFIED**    |
| Inline diff peek                        | Shared hunk renderer preserves binary/truncated states and never invents full sides.                            | **VERIFIED**    |
| Bounded blame and Git Client link-out   | Privacy-minimized blame contract/route/bridge; strict SHA-1/SHA-256 object-id gate.                             | **VERIFIED**    |
| Marker-based conflict editing           | Closed grammar, navigation, ours/theirs/both, one undoable edit, stale/digest fail-closed.                      | **VERIFIED**    |
| Explicit-save boundary                  | Conflict resolution is buffer-only; existing human save is separate; no implicit index mutation.                | **VERIFIED**    |
| Editor ↔ Git Client interlock           | Same-root file/diff and validated-commit handoff reuse existing windows.                                        | **VERIFIED**    |
| File/directory Git decorations          | M/A/D/U/conflicted propagation and ignored dimming reuse status reads.                                          | **VERIFIED**    |
| Docked-agent Git context                | Existing M3 context provider adds bounded conflict/diff/blame excerpts and content-free citations/omissions.    | **VERIFIED**    |
| Security review                         | Adversarial matrix and four fixed implementation findings recorded in `2093-source-control-security-review.md`. | **VERIFIED**    |
| Performance, coverage, release evidence | B5/B8/B9/B10, five coverage pairs, package surface, and Linux evidence above.                                   | **VERIFIED**    |
| Formal merge/issue closure              | Maintainer action after accepted evidence and protected checks.                                                 | **NOT CLAIMED** |

## Known limits

- Conflict resolution is a marker-based two-way/diff3 block UI, not a full three-way merge editor.
- Push-driven workspace watch refresh waits for M7; the current surface refreshes on open/save/focus
  and explicit refresh without introducing a polling storm.
- Blame is current-file/current-revision only; blame-at-revision is not implemented.
- Editor/Git interlock reveals a line only; it has no column-level reveal contract.

## Closure assessment

The implementation satisfies the Epic and all child acceptance criteria under the local production
gate surface. Publication and protected GitHub checks remain the final delivery step and are recorded
on the pull request; merge and issue closure remain maintainer actions and are not claimed here.
