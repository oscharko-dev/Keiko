# Editor browser regression, accessibility, and performance gate (Issue #1377)

## Purpose

This is the reusable editor **browser quality backbone** for the editor roadmap (Epic #1491). It
gives the editor a single, deterministic, browser-level regression matrix that drives the real
packaged application and asserts that the load-bearing editor behaviors keep working as later child
issues evolve the code:

- opening files from the project tree,
- the tab strip (switch, close, keyboard reorder, persistence across reload),
- split panes and deterministic separator resize,
- the dirty-buffer lifecycle, the unsaved-changes close guard, and hot-exit recovery,
- the empty state and the load-failure state,
- keyboard and focus accessibility for tabs, the project tree, the resize separator, and the
  unsaved-changes dialog.

The gate intentionally tests **functional regressions only**. Performance, bundle size, and memory
budgets are owned by separate, purpose-built harnesses (see the budget notes below) so each concern
can fail independently and be read in isolation.

The matrix is built entirely on a small, shared helper library so that a future child issue plugs a
new scenario into the existing backbone rather than re-deriving workspace seeding, layout driving, or
evidence collection.

## How to run

```
npm run test:e2e:editor-baseline-1377
```

The Playwright config (`../../playwright.issue-1377-editor-baseline.config.ts`) builds the full
application and then serves it from the packaged CLI (`node dist/cli/index.js ui`), so the tests
exercise the real product path, not a mock. The suite runs with a single worker on the default port
`32201` (override with `KEIKO_E2E_UI_PORT`). It is deterministic and locally runnable; it does not
depend on the network, wall-clock time, or test execution order.

## Regression matrix

Every scenario asserts a deterministic signal — a role, an ARIA attribute, persisted layout state,
or an IndexedDB key — and never a timing hack. Each key UI state is also captured as a screenshot
attachment for run evidence.

| Scenario             | Behavior under test                                  | Deterministic signal                                                                                                                           | Issue AC    |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| a. Tree open         | Clicking a project-tree row opens the file           | Tab gains `aria-selected='true'` and the Monaco surface is visible                                                                             | AC1         |
| b. Tabs              | Switching and closing tabs                           | `aria-selected` toggles; the closed tab row disappears                                                                                         | AC1         |
| c. Tab persistence   | Keyboard reorder survives a reload                   | Persisted first-pane `tabOrder` equals the new order, then is restored after reload                                                            | AC2         |
| d. Split and resize  | Split right, resize, then nested split down          | Pane count 1 then 2 then 3; separator `aria-valuenow` 50 then 54; two separators                                                               | AC2         |
| e. Dirty buffer      | Typing marks the buffer dirty                        | Tab `data-dirty='true'` and the status `save` field reads `Unsaved`                                                                            | AC2         |
| f. Dirty close guard | Closing a dirty tab is blocked                       | `role='dialog'` unsaved-changes prompt; Cancel and Escape keep the tab and its dirty state                                                     | AC2         |
| g. Recovery          | Recovery is offered after a reload                   | Hot-exit snapshot key appears in IndexedDB; `.ed-recovery[role='status']` is visible after reload                                              | AC2         |
| h. Empty state       | No root or file                                      | `.ed-empty[role='note']` is visible and no Monaco surface renders                                                                              | AC1         |
| i. Load failure      | A missing open file                                  | `role='alert'` with a Retry button and no Monaco surface                                                                                       | AC1         |
| j. Accessibility     | Keyboard and focus for tabs, tree, separator, dialog | Stable roles and accessible names; Alt+Arrow tab switch; tree `aria-expanded` toggle; focusable separator; dialog focus containment and Escape | AC1 and AC2 |

The whole file is tagged with the stable `@editor-baseline` annotation in its `test.describe`
title so it can be selected or excluded as one unit.

## Reusable helper API

All scenarios are written against the shared helper library at
`../../tests/e2e/support/editorWorkspace.ts`. It exposes:

- `EDITOR_SELECTORS` — the stable, accessibility-anchored DOM contract (workspace, sidebar, tablist,
  tab, pane, separator name, dirty dialog, recovery bar, empty state, host, Monaco, status bar).
- `createEditorWorkspace(files)` and `cleanupEditorWorkspaces()` — temp-project fixtures with cleanup.
- `seedEditorWindow(page, opts)` — seed the persisted editor window (or an empty window) without
  overwriting an already-persisted layout, so reload scenarios prove real round-trips.
- `openEditorWorkspace(page)`, `firstPane`, `paneCount`, `tabLabels`, `activeTabName`.
- `splitActivePane`, `reorderActiveTab`, `moveActiveTabToAdjacentPane`, `openTreeFile`.
- `persistedFirstPaneTabOrder` and `readPersistedEditorWindow` — read persisted layout state.
- `readHotExitSnapshotKeys` — read the `keiko-editor-hot-exit` snapshot keys for deterministic polling.
- `typeIntoActiveEditor` — make a buffer dirty deterministically.
- `collectPageErrors` and `isBenignMonacoCancellation` — assert no unexpected console or page errors
  leaked, filtering benign Monaco cancellations.

### How future child issues plug in

A new editor child issue adds its scenario as another test in
`../../tests/e2e/editor-baseline-1377.spec.ts` (or a sibling spec) that reuses these helpers. If the
new behavior needs a new stable hook, add it to `EDITOR_SELECTORS` once and reference it from there,
so the DOM contract stays in a single place. Prefer a deterministic signal — a role, an ARIA
attribute, persisted state, or an IndexedDB key — over any timing assumption.

## Accessibility coverage

The gate validates the editor's keyboard and focus accessibility directly, using manual ARIA, role,
keyboard, and focus assertions (no automated axe pass, to avoid adding a dependency):

- **Tabs** — `role='tablist'` with an accessible name, `role='tab'` items with accessible names and a
  single `aria-selected='true'`, switchable from the keyboard with Alt+Arrow while focus stays in the
  tablist.
- **Project tree** — `role='treeitem'` rows; a directory row toggles `aria-expanded` with ArrowLeft
  and ArrowRight.
- **Resize separator** — a focusable `role='separator'` exposing `aria-orientation` and a live
  `aria-valuenow` that responds to Arrow keys.
- **Unsaved-changes dialog** — `role='dialog'` with `aria-modal='true'` and a labelled title, focus
  moved into the dialog on open, and dismissal with Escape and with Cancel.

## Performance and memory budget notes

This baseline gate asserts **functional** regressions only; it does not measure timing, frame rate,
bundle size, or memory. That separation of concerns is deliberate so a functional failure and a
budget failure never mask each other. The editor performance and memory budgets are owned by:

- `1207-performance-budgets.md` — the editor performance and memory budget reference in this same
  documentation set.
- `../../tests/e2e/editor-performance.spec.ts` — the browser performance and memory harness that
  exercises the editor against those budgets.
- `../../scripts/editor-bundle-size.mjs` — the `check:editor-bundle-size` CI gate that enforces the
  editor bundle budget.

When a scenario in this gate exposes a behavior whose cost matters (for example a large-buffer or
many-pane layout), record the budget expectation in `1207-performance-budgets.md` and assert the
timing or memory there, keeping this gate focused on correctness.

## CI integration

This gate is a deterministic, locally runnable harness used as a **coordinator-evidence gate**: it
is run on demand (and by the coordinator when reviewing editor changes) rather than wired into the
required CI checks. It drives a full application build and the packaged CLI, which is too heavy and
too slow to belong in the per-PR required set alongside the unit and contract suites. Keeping it out
of required CI — while keeping it deterministic and runnable with a single command — gives reviewers
high-signal browser evidence without adding a long pole to every pull request. The lighter, fast
editor regressions remain covered by the jsdom unit suites in `keiko-ui` and `keiko-editor`.

## Related decisions

The architecture and scope of this gate are recorded in
[ADR-0066](../adr/ADR-0066-editor-browser-regression-accessibility-performance-gate.md).
