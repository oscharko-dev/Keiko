# ADR-0066: Editor Browser Regression, Accessibility, and Performance Gate

## Status

Accepted

## Context

Issue #1377 (Epic #1491) establishes a reusable, durable browser quality backbone for the
agent-native editor. The editor already has a mature browser test surface, but it grew one Playwright
spec per child issue, and each spec re-declared the same fixtures and helpers:

- `tests/e2e/editor-fidelity-1295.spec.ts`, `editor-agent-1296.spec.ts`,
  `editor-agent-1394.spec.ts`, `editor-agent-1395.spec.ts`, `editor-layout-1375.spec.ts`, and
  `editor-performance.spec.ts` each carry copy-pasted variants of `createWorkspace` /
  `createProjectFixture`, `seedEditorWindow`, `openEditor`, `openTreePath`, `collectPageErrors`, and
  `tabLabels`.

This duplication has three costs. First, a change to the seeding contract (for example the workspace
persistence key or the editor open sequence) must be edited in N places, and drifts silently when one
is missed. Second, there is no single consolidated baseline that asserts the core editor workflows —
project tree, tabs, splits, dirty buffers, reload, recovery, empty state, failure state — survive an
editor-touching change as a regression set; coverage is scattered per feature. Third, there is no
named, documented browser quality gate a future editor PR can be told to run.

The editor surfaces already emit deterministic DOM, ARIA, and storage signals that make
state-based assertions possible without arbitrary timing:

- Tabs: `[role=tab]` with `[data-dirty]` and `[aria-selected]`.
- Split: `[role=separator]` with `aria-valuenow` and the CSS variable `--ed-split-ratio`.
- Dirty dialog: `.ed-dirty-dialog[role=dialog][aria-modal=true]` labelled by
  `editor-dirty-close-title`.
- Recovery: `.ed-recovery[role=status]`, backed by the IndexedDB store `keiko-editor-hot-exit`.
- Empty state: `.ed-empty[role=note]`; load error: `role=alert` plus a Retry control.
- Tree: `button.tr-row` with `[data-path]`, `[data-active]`, and `[aria-expanded]`.
- Layout persistence: `localStorage` key `keiko.workspace.v4`.

Performance and memory budgets (B1–B11) are already documented in
`docs/keiko-editor/1207-performance-budgets.md` and enforced by `scripts/editor-bundle-size.mjs` (in
the required `ci` job) and `tests/e2e/editor-performance.spec.ts` (coordinator evidence). Issue #1377
does not change those budgets.

The implementation is test-only: no product, UI, server, or contract code changes. The required
GitHub check is the `ci` job, which runs no Playwright; browser e2e runs only in the `ui` job
(`test:e2e:smoke`), and the editor packaged-app suites run as coordinator evidence, not in required
CI. `feat/keiko-agent-native-editor-foundation-and-runtime` is already allowlisted in `ci.yml` and
`codeql.yml`.

## Decision

### D1 — One reusable editor browser-test support library

A single support module, `tests/e2e/support/editorWorkspace.ts`, becomes the source of editor
browser-test fixtures, seeding, and selectors. It exposes the small, workflow-aligned API the
per-issue specs previously re-declared — workspace and project-fixture creation, editor-window
seeding, opening the editor, navigating the tree, collecting page errors, and reading tab labels —
plus the named selectors for the deterministic signals listed above. New editor child issues import
this library instead of copy-pasting helpers, so a change to the seeding or selector contract is made
once. The API stays small and intent-named (open this, seed that, read this state); it is a test
harness, not a second editor model, and it owns no product behaviour.

### D2 — One consolidated baseline regression matrix against the real app

`tests/e2e/editor-baseline-1377.spec.ts` is the consolidated baseline. It drives the real packaged
editor application (not jsdom) through the core workflows as a single regression set: project tree
navigation, tab open/select/order, split creation and ratio, dirty-buffer marking and the
dirty-close dialog, reload persistence, hot-exit recovery, the empty state, and the load-failure
state with retry. It also asserts the accessibility contract for keyboard and focus across tabs,
tree, dialogs, and panes (tab/tree roving focus, modal focus trap and Escape, splitter role and
value semantics). This is the matrix a future editor-touching change is expected to keep green.

### D3 — Assertions are on app-emitted state; timing waits are forbidden

Every assertion targets application-emitted DOM, ARIA, or storage state, never wall-clock timing
(Issue #1377 AC3). Tabs are checked through `[role=tab]`, `[data-dirty]`, and `[aria-selected]`;
splits through `[role=separator]`, `aria-valuenow`, and the `--ed-split-ratio` CSS variable; layout
persistence through the `keiko.workspace.v4` `localStorage` value; recovery through the
`keiko-editor-hot-exit` IndexedDB snapshot and the `.ed-recovery[role=status]` surface. The spec uses
Playwright web-first assertions and `expect.poll` to wait on state transitions, and
`page.waitForTimeout` (and equivalent fixed sleeps) is forbidden. Determinism is a property of the
gate, not a per-spec convention.

### D4 — Gate placement: deterministic, locally-runnable, plus coordinator evidence — not in required `ci`

The baseline matrix runs through a named configuration,
`playwright.issue-1377-editor-baseline.config.ts`, behind the npm script
`test:e2e:editor-baseline-1377`. It is a deterministic, locally-runnable gate and is run as
coordinator evidence on editor-touching pull requests. It is deliberately **not** added to the
required, time-boxed `ci` check.

This matches the established editor-e2e precedent (ADR-0064 D4): the per-feature packaged-app specs
are coordinator-run evidence, not required CI. Adding a full packaged-app browser matrix to the
required `ci` check would lengthen and destabilise the one gate every repository PR must pass, for a
suite whose value is concentrated on editor changes. The required `ci` check continues to enforce the
two deterministic, fast editor gates that belong there: the editor bundle-size budget
(`scripts/editor-bundle-size.mjs`) and the release end-to-end smoke (`test:e2e:smoke`). The baseline
matrix is the documented, named quality bar an editor-touching PR runs and presents as evidence.

### D5 — Functional regression and performance budgets are separated

The baseline matrix asserts **functional** regressions — that workflows still work and the
accessibility contract holds. It does not assert performance or memory numbers. Those budgets
(B1–B11) remain owned by `docs/keiko-editor/1207-performance-budgets.md`, enforced by
`scripts/editor-bundle-size.mjs` and `tests/e2e/editor-performance.spec.ts`. Issue #1377
cross-references those budgets and does not restate or re-enforce them. Keeping the two gates
separate gives each one reason to change: a budget revision touches the budgets doc and its
enforcers, and a workflow regression touches the baseline matrix, with no duplicated thresholds to
drift apart.

### D6 — Visual evidence is captured as run artifacts, not committed pixel baselines

The baseline run captures named screenshots of the key states (tree, tabs, split, dirty dialog,
recovery, empty, failure) as run artifacts for review. It does not commit pixel baselines and does
not assert pixel equality. This matches the repository's evidence-capture precedent and avoids the
flaky cross-platform PNG-baseline failure mode; pixel-level visual regression remains the separate,
manual Studio process where it already lives.

## Consequences

- The duplicated helper code now has one home; a change to the editor seeding or selector contract is
  made once in `tests/e2e/support/editorWorkspace.ts` instead of across six specs.
- The reuse migration is incremental and non-breaking: the existing per-issue specs keep their inline
  helpers and continue to pass; they may adopt the shared library later, spec by spec, without a
  coordinated rewrite. Issue #1377 ships the library and the new consolidated matrix; it does not
  refactor the prior specs.
- Editor PRs gain a named, documented browser quality bar (`test:e2e:editor-baseline-1377`) that runs
  the real app and asserts on deterministic signals, so regressions in core workflows and the
  keyboard/focus contract are caught with reproducible, evidence-backed runs.
- The required `ci` check keeps its determinism and speed, and continues to enforce the editor
  bundle-size budget and the release e2e smoke.
- Residual: the baseline matrix is opt-in-to-run — it is coordinator evidence, not an auto-enforced
  required check — so its execution depends on the editor-PR workflow invoking it rather than on a
  branch-protection rule. This is the accepted trade-off for CI determinism (D4); should the suite
  prove fast and stable enough, a future issue can promote it into a required browser job.

## Alternatives considered

- **Add the baseline matrix to the required `ci` check.** Rejected: the packaged-app browser suite is
  slower and more environment-sensitive than the bundle-size and smoke gates, and adding it would
  destabilise and lengthen the one check every repository PR must pass, for value concentrated on
  editor changes. It also breaks the established editor-e2e precedent (ADR-0064 D4). The named gate
  plus coordinator evidence delivers the regression coverage without that cost.
- **Keep per-issue specs with copy-pasted helpers and add the matrix in the same style.** Rejected: it
  perpetuates the silent-drift problem the issue exists to fix; a shared support library is the
  single source of truth for seeding and selectors.
- **Refactor all existing editor specs onto the shared library now.** Rejected as out of scope for a
  test-only issue: the migration is non-breaking and can proceed incrementally (Consequences); a
  large simultaneous rewrite would add review and flake risk without changing what is covered.
- **Fold performance and memory budget assertions into the baseline matrix.** Rejected: it would
  duplicate the B1–B11 thresholds already owned by the budgets doc and the bundle-size / performance
  enforcers, creating two places for a budget to drift. Functional and performance gates are kept
  separate (D5).
- **Commit pixel-level screenshot baselines for the editor states.** Rejected: cross-platform PNG
  baselines are a known flake source; the repository's precedent is to capture screenshots as review
  artifacts and keep pixel regression in the separate manual Studio process (D6).

## Related

- ADR-0064: Editor layout reducer invariants and regression hardening (editor-e2e-as-coordinator-evidence precedent).
- ADR-0065: Dirty-buffer, hot-exit, and recovery policy hardening (the dirty/recovery signals the matrix asserts on).
- `docs/keiko-editor/1207-performance-budgets.md`: performance/memory budgets B1–B11 (referenced, not duplicated).
- `docs/keiko-editor/1377-editor-browser-regression-gate.md`: the Issue #1377 test-design document.

## Date

2026-06-25
