# ADR-0115: Workspace multi-window selection and local duplication

## Status

Accepted (Epic #2055, Issue #2056, 2026-07-07).

## Context

Epic #2055 adds OS-style multi-window selection to the Keiko desktop workspace: a user can drag a
marquee on empty workspace space, select several workspace windows, move the selected group, and
duplicate the selected group with local copy/paste commands.

Several existing decisions already own most of this surface:

- ADR-0026 says the existing `useWorkspace` hook is the workspace editor, `Workspace.tsx` is the
  DOM renderer, and no independent canvas or graph substrate is adopted.
- ADR-0027 partitions selection as browser UI transient state and durable layout as
  `useWorkspace`-owned browser-local layout state.
- ADR-0028 reserves `WorkspaceUiSelectionState`, defines the `ui.selection.change` undo action, and
  explicitly notes that runtime multi-selection was deferred until a downstream issue proved the
  need.
- ADR-0030 forbids UI bypasses of model, filesystem, tool, evidence, memory, durable config, and
  patch authority boundaries.
- ADR-0049 and ADR-0050 govern runtime design-system fidelity. Selected states resolve through the
  accent family, so the marquee and selected-window affordance must use Keiko green tokens such as
  `--accent`, `--accent-line`, `--accent-glow`, `--surface-accent-subtle`, `--selection-surface`, and
  `--focus-ring`, not Windows blue.
- ADR-0064 records the editor layout invariant that layout operations never mutate content or dirty
  state. Workspace group movement follows the same rule at the window-layout layer.
- ADR-0097 is a negative boundary: file create/rename/delete remains governed by the Files surface
  and BFF route. Selecting or duplicating windows is not a repository file operation.
- ADR-0113 shows the current pattern for first-class desktop widget additions: reuse the existing
  desktop shell and registry, declare precise trust limits, and avoid a parallel browser/workspace
  subsystem.

The relevant implementation seams on `dev` are:

- `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts` owns windows, focus,
  z-ordering, pan/zoom, connection state, persistence scheduling, and the `WorkspaceApi` object.
- `packages/keiko-ui/src/app/components/desktop/hooks/workspaceActions.ts` owns deterministic
  window mutations such as update, focus, add, close, tile, split, cascade, and connection helpers.
- `packages/keiko-ui/src/app/components/desktop/Workspace.tsx` owns background/canvas gestures,
  pan/zoom, drop handling, scene projection, and window rendering.
- `packages/keiko-ui/src/app/components/desktop/windows/WindowFrame.tsx` owns per-window header
  drag, resize, focus, content zoom, connection ports, and window controls.
- `packages/keiko-contracts/src/workspace-ui.ts` already exposes `WorkspaceUiSelectionState` and
  the `ui.selection.change` action family.

The capability gap is therefore not "build a window manager"; it is:

1. expose multi-selection from the existing workspace state owner,
2. add canvas hit-testing and group movement to the existing DOM workspace renderer,
3. add local-only, content-free duplication of eligible window layout descriptors, and
4. verify accessibility, embedded-control isolation, design-system fidelity, and trust boundaries.

## Decision

### D1 - Reuse `useWorkspace` as the only workspace selection owner

Multi-window selection is implemented inside the existing `useWorkspace` ownership boundary. No
Redux/Zustand store, independent canvas package, second workspace manager, graph grouping subsystem,
or out-of-band event bus is introduced.

`WorkspaceApi` gains selection operations only after Issue #2057 defines the exact shape. The
expected API direction is:

- read the current selected-window set,
- replace/toggle/clear selection,
- prune selection when windows close, minimize, restore, or become ineligible,
- move the selected set as one deterministic layout mutation, and
- duplicate eligible selected windows through a validated local descriptor.

Selection is browser UI transient state by default. It is not persisted to `localStorage`, server
workspace state, evidence, memory, durable config, or repository files unless a future issue amends
this ADR with a concrete compatibility need. The durable layout may change when windows are moved or
duplicated, but the fact that a window is selected does not survive reload.

### D2 - Selection semantics are layout-only and fail closed

An eligible selected window is a visible, non-minimized, non-maximized workspace window whose
descriptor and current state allow layout-only movement. Ineligible, stale, hidden, closed,
minimized, maximized, or unknown ids are ignored by selection reads and rejected by group operations.

Group movement preserves each selected window's relative offset and clamps the group against the same
viewport/title-bar recovery rules already used for single-window movement. It is one UI layout
operation, not a permanent group object. It must not mutate:

- editor buffers, editor dirty state, tab order, or file contents,
- repository files or workspace filesystem state,
- evidence manifests or verification records,
- model/tool/workflow/memory state,
- connection authority or source binding snapshots, except where the existing window geometry update
  naturally moves the visible endpoints of an already existing connection.

### D3 - Marquee selection belongs to `Workspace.tsx`, not embedded windows

The marquee gesture starts only on eligible empty workspace canvas space. It must not start from:

- window headers or bodies,
- resize handles,
- connection ports,
- text inputs, editors, terminals, file trees, diff viewers, scrollable output, or other embedded
  controls,
- active connect mode, active pan/hand-tool gestures, or modal/overlay locked states.

`Workspace.tsx` owns pointer capture and hit-testing because it already owns canvas gestures and
scene projection. `WindowFrame.tsx` keeps owning per-window drag and resize. Dragging a selected
window may route to the group-move action; dragging an unselected window keeps existing single-window
behavior or replaces selection according to Issue #2058's tests.

### D4 - Visual selection uses Keiko green tokens, never Windows blue

The marquee rectangle and selected-window state use the Keiko accent family:

- fill: `--selection-surface`, `--accent-glow`, or `--surface-accent-subtle`,
- border: `--accent-line` or `--border-accent`,
- focus/keyboard indication: `--focus-ring` / `--focus-width`,
- selected affordance text/icon color, if needed: `--text-accent` or `--accent-text`.

No blue Windows-style selection color is introduced. No new raw color is introduced. If implementation
needs a new semantic token, that is a token proposal first under ADR-0050. New workspace selection
styles must be component-scoped and must not extend `packages/keiko-ui/**/globals.css`; the
`globals.css` visual-proof gate remains untouched unless a separate approved design-system issue
explicitly owns that update.

### D5 - Copy/paste duplicates only content-free local layout descriptors

Copying selected windows is a local workspace command with `authority: "user"` and category
`"selection"`. It does not use model, tool, patch, filesystem, memory, evidence, or workflow
authority.

The copied payload is a schema-versioned, content-free layout descriptor:

- window type,
- geometry,
- content zoom if safe,
- descriptor-approved non-secret `cfg` fields that are already safe for `durable.ui` workspace
  layout persistence,
- no raw file bodies, chat transcripts, terminal output, model output, repository diffs, API tokens,
  endpoints with credentials, evidence bodies, memory bodies, or unredacted local paths.

Paste validates the descriptor, regenerates window ids, offsets the pasted set so the duplicate is
visible, and adds only eligible windows to the current local workspace. Malformed, stale,
unsupported, cross-workspace, over-limit, or secret-shaped payloads fail closed. Unsupported widgets
are skipped with a documented reason rather than widened into a more privileged copy path.

Browser or OS clipboard integration is optional. If browser clipboard permissions are unreliable, an
internal clipboard abstraction is acceptable, but it must still store only the validated content-free
descriptor.

### D6 - Keyboard and accessibility are first-class

Pointer marquee is not the only selection path. Implementation issues must provide keyboard and
assistive-technology coverage where a reasonable workspace equivalent exists:

- selected windows expose selected state through ARIA/data attributes that tests can assert,
- clearing selection is keyboard reachable,
- copy/paste commands do not intercept focused editor, terminal, text input, file tree, diff viewer,
  or embedded widget clipboard behavior,
- focus remains visible and deterministic after selection, group drag, paste, close, minimize, and
  restore operations,
- selected state is not conveyed by color alone.

### D7 - Verification is staged by child issue

The epic is implemented in the following order:

1. Issue #2057: selection model and layout invariants in `useWorkspace`, `workspaceActions`, and
   adjacent tests.
2. Issue #2058: marquee selection and grouped window drag in `Workspace.tsx`, `WindowFrame.tsx`, scoped
   styles, i18n, and interaction tests.
3. Issue #2059: validated local copy/paste descriptors and command routing tests.
4. Issue #2060: accessibility, visual, release-impact, and closure evidence.

For any `packages/keiko-ui` change, the applicable local gates include:

- `npm run typecheck --workspace @oscharko-dev/keiko-ui`,
- `npm run lint --workspace @oscharko-dev/keiko-ui`,
- `npm run test:coverage:ui`,
- `npm run check:ui-i18n` when user-visible or accessible strings change,
- `npm run check:editor-release-evidence`.

Contract/package-surface changes additionally require `npm run build && npm run check:package-surface`.
Architecture-sensitive changes require `npm run arch:check` and `npm run arch:check:negative`.

## Consequences

- The epic extends existing workspace, command, layout, registry, and design-system surfaces instead
  of introducing a parallel subsystem.
- Multi-selection remains local UI state. Window layout changes caused by move/paste remain durable
  through the existing workspace persistence sanitizer.
- Clipboard duplication is intentionally narrower than OS object copy/paste: it copies layout
  descriptors, not content.
- Green selection styling is an architecture decision, not a later visual preference.
- Follow-up implementation issues have explicit write ownership and verification expectations.

## Alternatives considered

- **Adopt a canvas/window-manager library.** Rejected. ADR-0026 already chose the existing DOM
  workspace substrate, and the current gap can be solved by extending that substrate.
- **Persist selected-window state.** Rejected for this epic. ADR-0027 classifies selection as
  transient browser UI state, and reload persistence would add compatibility surface without a proven
  user need.
- **Use native OS clipboard contents directly.** Rejected. Raw OS clipboard integration could leak
  user content or unredacted state. Keiko copies only its own validated content-free descriptor.
- **Use Windows-blue marquee styling for familiarity.** Rejected. Runtime UI states resolve through
  Keiko's accent/selected token family under ADR-0049 and ADR-0050.
- **Make group selection a permanent grouping object.** Rejected. The requested behavior is transient
  multi-selection and layout movement, not a new graph/grouping model.

## Related

- Epic #2055 - Multi-window workspace selection and clipboard duplication.
- Issue #2056 - Architecture and reuse review for workspace multi-selection.
- Issue #2057 - Selection model and layout invariants.
- Issue #2058 - Marquee selection and grouped window drag.
- Issue #2059 - Validated local copy and paste.
- Issue #2060 - Accessibility, visual, and release verification.
- ADR-0026 - Workspace substrate.
- ADR-0027 - Workspace state ownership and persistence boundaries.
- ADR-0028 - Workspace commands, events, selection, undo/redo boundaries.
- ADR-0029 - Workspace object registry and extension contract.
- ADR-0030 - Workspace security, evidence, and trust boundaries.
- ADR-0049 - Design System fidelity measurable gates.
- ADR-0050 - Component state, documentation, and governance contract.
- ADR-0064 - Editor layout reducer invariants and regression hardening.
- ADR-0097 - Editor file-tree mutations and open-tab re-homing.
- ADR-0113 - Governed documentation browser trust model and first-release host strategy.
