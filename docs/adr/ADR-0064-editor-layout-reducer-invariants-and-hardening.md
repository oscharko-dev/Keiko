# ADR-0064: Editor layout reducer invariants and regression hardening

## Status

Accepted

## Context

Issue #1375 hardens the existing editor layout system — multi-tab strips, split panes, drag/drop
tab movement, and recursive pane resize — so that it behaves like a stable IDE layout rather than a
temporary widget arrangement. The layout state machine already exists:

- `keiko-contracts/src/editor-layout.ts` holds `EditorLayoutStateV2` and the pure
  `editorLayoutReducer` (open/select/close-tab, reorder/move/drop-tab, split-pane, close-pane,
  resize-split, sidebar, replace-root), plus persisted-state parsing with V1→V2 migration.
- `keiko-ui/.../EditorWidget.tsx` renders the pane tree, drag-and-drop zones, split resizers, and
  the keyboard fallbacks (Alt+Arrow reorders within a pane, Alt+Shift+Arrow moves a tab to an
  adjacent pane), and translates pointer/keyboard intents into reducer actions.

The reducer and its contract tests are mature. The hardening gaps Issue #1375 targets are:

1. The reducer's guarantees were not written down, so reviewers could not tell which behaviours are
   invariants versus incidental (Deliverable: "Documented reducer invariants").
2. The UI tracks unsaved buffers in a per-pane index, `dirtyByPane: Record<paneId, Record<file,
true>>`. The authoritative dirty state lives in the shared Monaco model (keyed by `(root, file)`,
   so unsaved content survives a tab moving panes), but the per-pane index was never re-homed when a
   tab moved or a pane collapsed. A moved dirty tab left an orphaned flag on its former pane; the
   close prompt and `savePendingClose` could then resolve the wrong pane, risking a dirty buffer
   closing without a save prompt and a save request that targets a pane no longer showing the file
   (AC3).
3. Split resizers were keyboard-operable but did not expose the WAI-ARIA window-splitter semantics
   (role, orientation, value), so assistive technology could not announce or report the split
   position (AC5, Accessibility).
4. The acceptance criteria lacked executable regression coverage at the UI and browser layers
   (dirty-preserving move, reload persistence, empty-pane collapse, nested resize, keyboard
   fallback), and there was no accessibility smoke test for the layout chrome.

## Decision

### D1 — The reducer is the documented authority for layout invariants

The layout reducer remains the single authority for layout structure: UI drag and keyboard logic
produces intents that are applied through `editorLayoutReducer`; pane state is never mutated
directly. The invariants the reducer maintains are documented at the top of `editor-layout.ts` and
are the contract reviewers check against:

1. **Tab order is stable and lossless.** A pane's `openFiles` and `tabOrder` are the same
   de-duplicated, non-empty list; reorder/move only permute it, and the order survives a
   serialize → parse round trip, so tabs never reshuffle on reload (AC1).
2. **Layout operations never touch content or dirty state.** Files are identified by path, so
   reorder/move/drop cannot mutate a buffer or its dirty marker (AC2).
3. **Empty panes collapse predictably.** Removing the last tab from a pane removes the pane (when
   others remain) and promotes the sibling of its enclosing split; the final pane is kept even when
   empty (AC4).
4. **Splits are binary and resize never restructures.** `resize-split` only clamps an existing
   split's ratio into `[15, 85]`; it adds or removes no pane, so nested splits resize without
   orphan panes or jumps (AC5).
5. **Identifiers are unique and resolvable**, and **persisted values are clamped on read and
   write**, with malformed persisted state falling back to a fresh single-pane layout.

### D2 — The UI re-homes the dirty index onto the layout, rather than migrating per handler

A pure helper `reconcileEditorDirtyByPane(dirtyByPane, layout)`
(`keiko-ui/.../editorDirtyState.ts`) re-assigns every still-dirty file to exactly the panes that
currently hold it and drops entries for panes or files the layout no longer contains. `EditorWidget`
runs it inside `commitLayout`, so the dirty index is reconciled after **every** layout mutation.

This is preferred over migrating the flag inside each move handler: a per-handler approach would
have to special-case `move-tab`, `drop-tab` (whose split target is a freshly allocated pane id the
handler does not know), and the keyboard move, and would still not prune ghost entries left by a
pane that collapsed. Reconciling against the committed layout is one rule that covers all paths,
keeps the move-as-pure-layout-operation invariant (D1.2) intact, and is unit-testable in isolation.
The helper returns the same reference when nothing changes so React state stays stable.

### D3 — Split resizers adopt the WAI-ARIA window-splitter pattern

Each split resizer is a focusable `role="separator"` with `aria-orientation` derived from the split
direction (a side-by-side `row` split has a vertical separator; a stacked `column` split has a
horizontal one), `aria-valuemin`/`aria-valuemax` set to the clamp bounds, and `aria-valuenow`
tracking the live ratio. This adds no visible DOM structure — only ARIA attributes on the existing
button — and preserves the existing Arrow-key resize behaviour.

### D4 — Acceptance criteria are proven by executable regression tests plus browser evidence

- Contract: a serialize → reload round-trip test asserts tab order, structure, and active state are
  byte-stable (AC1), alongside the existing split/move/drop/resize/collapse coverage.
- UI (jsdom): reload persistence (AC1), drag-changes-only-layout (AC2), dirty-tab move re-homes the
  marker and active selection and clears cleanly in its new pane (AC3), empty-pane collapse (AC4),
  and accessible split-resizer semantics (AC5); a dedicated accessibility smoke (`jest-axe` plus the
  splitter pattern and accessible-name checks) for the layout chrome.
- Browser: a Playwright spec (`tests/e2e/editor-layout-1375.spec.ts`, run against the packaged app
  via `playwright.issue-1375-editor-layout.config.ts`) exercises split creation, recursive nested
  resize, keyboard tab reorder and cross-pane move, and reload persistence against the real app
  path. As with the other editor specs, it is coordinator-run evidence and is not part of the
  required `ci` check.

### D5 — Visual regression is not triggered

The change reconciles UI state, adds ARIA attributes to an existing control, and adds tests and
documentation. It introduces no new or changed visible DOM structure, so the Studio visual
regression gate (a manual, post-merge process on this branch) is not required for this issue.

## Consequences

- A dirty tab keeps its marker and unsaved-changes prompt as it moves between panes; a saved file
  clears its marker everywhere; and saves resolve the pane that actually shows the file.
- Assistive technology can announce and report split positions.
- The documented invariants give reviewers a fixed checklist for future layout changes.
- No contract wire shape changed; the reducer, its schema version, and persisted format are
  unchanged. The reconciliation lives entirely in the UI layer, keeping the contract free of
  dirty-state concerns.

## Alternatives considered

- **Migrate the dirty flag inside each move handler.** Rejected: incomplete for split drops and
  collapses, and duplicated across handlers (see D2).
- **Make dirty state global per file (drop the per-pane index).** Rejected as out of scope: it would
  change the close-prompt scoping semantics for a file open in multiple panes; reconciliation keeps
  the existing per-pane model sound with a minimal change.
- **Add the dirty reconciliation to the contract reducer.** Rejected: dirty state is UI runtime
  state, not layout structure; keeping it out of the contract preserves the reducer's purity.
