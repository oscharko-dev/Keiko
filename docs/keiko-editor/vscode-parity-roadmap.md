# Keiko Editor — VS Code Parity Roadmap

Status: living document. Wave 1 delivered; later waves are planned and sequenced.

The Keiko editor is a Monaco-based, agent-native coding surface inside the Workspace. It already has
a deep foundation: the Monaco runtime, tabs / split panes / pane resize, dirty-buffer and hot-exit
recovery, version-aware save with optimistic concurrency, deterministic TS/JS language intelligence
(diagnostics / hover / symbols / formatting / completion / inline completion), a governed LSP process
manager, patch-apply, the agent-editor bridge, and Git status / diff. That foundation was closed under
[Epic #1491](https://github.com/oscharko-dev/Keiko/issues/1491) and audited in
[1491-production-readiness-audit.md](1491-production-readiness-audit.md).

This roadmap is the single source of truth for the remaining work to bring the editor to a VS
Code-like quality bar for **everyday editing, file management, and multi-pane performance**. It is
honest about what "parity" realistically means for a governed, browser-hosted, enterprise editor:
some VS Code capabilities (a full extension host, native debugging via DAP, an OS-integrated
terminal) are explicit non-goals.

---

## Wave 1 — delivered (this change)

The first wave closed the single largest user-facing gap — the file tree was read-only — and took the
safe, high-confidence ergonomics and performance wins that needed no risky refactor.

| Item                            | What shipped                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File create / folder create** | `POST /api/files/create` (atomic, no-overwrite via `O_EXCL` / non-recursive `mkdir`) + a New File / New Folder toolbar and context-menu, with an inline name editor. New files open immediately.                                          |
| **Rename / move**               | `POST /api/files/rename` (contained both ends, deny-checked, no-clobber, case-only rename allowed via realpath identity) + inline rename (context menu, `F2`).                                                                            |
| **Delete**                      | `POST /api/files/delete` (recursive for folders, symlinks rejected, root rejected) + a confirm dialog and the `Delete` key.                                                                                                               |
| **Open-tab re-homing**          | New `rename-file` / `remove-file` reducer actions re-home (rename) or close (delete) any open editor tab across every pane, so a mutated file never leaves a stale tab that 404s. The stale hot-exit snapshot is dropped.                 |
| **Tab ergonomics**              | Middle-click closes a tab (routed through the dirty-close guard).                                                                                                                                                                         |
| **Editor render cost**          | `EditorSurface` (the Monaco wrapper) is wrapped in `React.memo`, so frequent host re-renders that leave the editor-relevant props untouched (cursor/selection moves, diagnostic-count updates) no longer re-reconcile the Monaco surface. |

Security posture is unchanged: every mutation reuses the existing `/api/files` containment model
(realpath resolution, root containment, the segment-wise deny-list for `.git` / `node_modules` /
secrets, and metadata redaction), is non-destructive by default, and is reachable only through
state-changing methods so the server CSRF + JSON gate applies. See
[ADR-0097](../adr/ADR-0097-files-tree-mutations-and-tab-rehoming.md).

---

## Wave 2 — delivered (multi-pane render performance, item 2.1)

The headline Wave-2 item — the multi-pane render-performance refactor (§2.1 below) — is now done,
applying the proven [#1580](https://github.com/oscharko-dev/Keiko/issues/1580) pattern to the editor
host (`EditorWidget`):

- **Stable callback identity** — every pane callback reads the live layout from a `layoutRef` instead
  of closing over `layout`, so its identity no longer churns on each `setLayout`.
- **Memoized per-pane bindings + agent snapshots** — built once per pane SET, so a layout mutation
  that does not touch a given pane leaves its prop bundle referentially identical.
- **`React.memo` on `EditorRuntimeWidget`** — with stable props, panes the mutation did not touch bail
  out of the re-render. A tab-select, split, or resize in one pane no longer re-renders every pane.
- **Resize via CSS variable during the gesture** — a split/sidebar drag writes the ratio/width
  straight to the DOM and commits to layout state (and persists) only on release, so a drag is a pure
  style update with no per-frame React render or persistence. Keyboard resize still commits per step.

The remaining Wave-2 items (2.2 onward) are unchanged below.

---

## Capability gap analysis (where Keiko stands today)

Legend: ✅ present · 🟧 partial · ⬜ absent · 🚫 out of scope.

| Capability                                              | State | Notes                                                                                                                                                                                        |
| ------------------------------------------------------- | :---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open file / arbitrary folder                            |  ✅   | Files widget browses any machine folder under containment.                                                                                                                                   |
| Create / rename / delete / move (tree)                  |  ✅   | Wave 1. Copy / duplicate / drag-move in the tree are still absent.                                                                                                                           |
| Multi-file tabs, split panes, pane resize, drag tabs    |  ✅   | Layout state machine with persistence.                                                                                                                                                       |
| Tab overflow                                            |  🟧   | Collapses to a `+N` summary menu; a horizontally **scrollable** strip is the VS Code behavior.                                                                                               |
| Dirty buffers, hot-exit, reload recovery                |  ✅   | Version-aware save with optimistic concurrency.                                                                                                                                              |
| Find / replace **in file**                              |  ✅   | Monaco's built-in widget (`Ctrl/Cmd+F`, `Ctrl/Cmd+H`).                                                                                                                                       |
| Multi-cursor, column select, go-to-line                 |  ✅   | Monaco built-ins.                                                                                                                                                                            |
| Diagnostics / hover / symbols / formatting / completion |  ✅   | Deterministic TS/JS language service; degrades gracefully.                                                                                                                                   |
| Inline (ghost-text) completion                          |  ✅   | Governed, content-free.                                                                                                                                                                      |
| Language intelligence beyond TS/JS                      |  🟧   | Governed LSP process-manager foundation exists; host provider pilots (Java/Python/Go/Rust/Shell) are not yet wired into the surface.                                                         |
| Quick-open (`Ctrl/Cmd+P` fuzzy file open)               |  ✅   | Wave 2: `EditorCommandPalette` over `/api/files/search`.                                                                                                                                     |
| Command palette (`Ctrl/Cmd+Shift+P`)                    |  ✅   | Wave 2: host command registry surfaced in the same palette (`>` toggle) + browser-safe keybindings.                                                                                          |
| Find in files / replace across files                    |  ⬜   | Single-file search only.                                                                                                                                                                     |
| Go-to-definition / find-references / rename-symbol      |  🟧   | Hover + symbols exist; cross-file navigation and symbol rename are not surfaced.                                                                                                             |
| Breadcrumbs / outline view / sticky scroll / minimap    |  🟧   | Symbols power an outline path; breadcrumbs and minimap are not enabled.                                                                                                                      |
| Source control (stage / commit / branch UI)             |  🟧   | A separate governed **Git Delivery** surface owns commit/push/PR; the editor shows status + diff and links into it.                                                                          |
| External-change detection / auto-reload                 |  ⬜   | No filesystem watcher; out-of-app renames/deletes are not reflected until refresh.                                                                                                           |
| Multi-pane performance at scale                         |  ✅   | Wave 2: cross-pane re-render fan-out removed via memo + stable bindings; resize is a gesture-time CSS update. Each pane is still a full Monaco instance (a shared model registry is Wave 3). |
| Integrated terminal                                     |  🟧   | Governed command execution exists; no interactive terminal panel in the editor.                                                                                                              |
| Debugging (DAP)                                         |  🚫   | Out of scope for the governed editor.                                                                                                                                                        |
| Extension host / marketplace                            |  🚫   | Out of scope.                                                                                                                                                                                |
| Settings / keybinding customization UI                  |  ⬜   | No in-app editor-settings surface yet.                                                                                                                                                       |

---

## Wave 2 — next (the high-value, medium-risk work)

### 2.1 Multi-pane render performance (top priority) — ✅ delivered

> Delivered. The four steps below were implemented on `EditorWidget` / `EditorRuntimeWidget`; see the
> "Wave 2 — delivered" section above. This entry is kept for the rationale and the technique.

**Problem.** The editor host (`EditorWidget`) re-renders on every layout mutation, and `renderPane`
rebuilds each pane's props and callbacks with fresh identity every render, while no pane component is
memoized. So a tab-select, a split, or — worst — a **split-resize drag** in one pane re-renders **all**
panes (each a full Monaco host). With several splits this is the felt slowness.

**Plan** (the proven approach from the Workspace multi-window fix,
[PR #1610 / Issue #1580](https://github.com/oscharko-dev/Keiko/issues/1580)):

1. Read the live layout from a `layoutRef` inside the pane callbacks (`selectOpenFile`, `splitPane`,
   `closeOpenFile`, `markDirty`, …) and drop `layout` from their dependency arrays, so their identity
   is stable across layout mutations.
2. Build a per-pane stable callback set (memoized by `paneId`) and memoize `layoutPaneSnapshots`.
3. Wrap `EditorRuntimeWidget` in `React.memo`, which now has teeth because its props are stable.
4. Apply the split ratio via the existing CSS variable during a resize **gesture** and commit to
   layout state only at gesture end, so a drag does not thrash React.

Effort: large. Risk: medium — `sessionCacheRef` is the save-correctness store for background tabs;
the `layoutRef` must always read current layout, and stale-response / save invariants must hold.
Ships with its own e2e perf check.

### 2.2 View-state and undo preserved across `editorSurfaceKey` remounts — ✅ delivered

A theme switch and crossing the large-file boundary used to change the surface's React `key` and fully
**remount** Monaco — discarding the undo stack and scroll/folding. Both are now applied imperatively on
the SAME live editor: `editorSurfaceKey` no longer includes the theme variant or large-file mode, a
theme toggle re-registers the theme via `setTheme` (keiko-editor `reapplyEditorTheme` /
`useThemeReapply`), and the degraded options flip via the live `options` prop (`editor.updateOptions`).
The provider-id flip still remounts, but it happens once on load before any edit, so no undo/view state
is at risk. (A host-cache view-state seed for that remaining remount is a small follow-up.)

### 2.3 Quick-open and command palette — ✅ delivered

`Ctrl/Cmd+P` fuzzy file open (over the existing `/api/files/search` endpoint) and `Ctrl/Cmd+Shift+P`
command palette over a new host command registry. One `EditorCommandPalette` overlay with both modes
(a leading `>` toggles command mode), reusing the existing `.ed-dialog-*` / `.edm-item` /
`.files-root-input` classes + popover tokens — no `globals.css` change.

### 2.4 Native editor keybinding layer — ✅ delivered

A container-level capturing keydown listener on `.editor-workspace` (mirrors the on-mount save
backstop) maps browser-safe chords to the command registry: `Ctrl/Cmd+P` / `Ctrl/Cmd+Shift+P`
(palette), `Ctrl/Cmd+Alt+→/←` (next/prev tab), `Ctrl/Cmd+Alt+T` (reopen), `Ctrl/Cmd+Alt+\` (split),
`Ctrl/Cmd+Alt+S` (save-all). `Ctrl/Cmd+W` and `Ctrl/Cmd+Shift+T` remain unbound (browser-reserved) —
close stays on ×/middle-click/palette; deferred to a future desktop shell.

### 2.5 Closed-tab history / reopen stack — ✅ delivered

A bounded (20) deduped MRU of recently-closed `(paneId, file)`, captured in the close path
(`closeOpenFile`/`closePane`), surfaced as the "Reopen Closed Editor" command + `Ctrl/Cmd+Alt+T`.

### 2.6 Optimistic-concurrency for destructive mutations

Let rename/delete optionally carry a `baseVersion` and assert the on-disk content still matches before
destroying it, so an agent cannot delete a file a human just changed. Effort: medium.

### 2.7 Tree polish

Copy / duplicate, drag-move within the tree, and a horizontally **scrollable** tab strip (replacing
the `+N` collapse). The scrollable strip touches `globals.css` and so must re-pin the
[#1300 visual-regression proof](https://github.com/oscharko-dev/Keiko/issues/1300). Effort: medium–large.

### 2.8 Bound the host session cache — ✅ delivered

The per-window content cache (`sessionCacheRef`) grew unbounded as files were opened. It is now a
bounded `LruSessionCache` (cap 64, API-compatible with the `Map` it replaced) that evicts the
least-recently-used entry on overflow but never the active file, a mid-save, or a dirty buffer — the
background-tab save-correctness invariants.

---

## Wave 3 — later

| Item                                                                              | Effort | Why                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared Monaco model registry keyed by URI across panes                            | xlarge | Same file in two split panes should share one model/undo stack and halve diagnostics/worker work — true VS Code split-view semantics. |
| Visibility-gate / suspend off-screen pane editors                                 | large  | So N-pane layouts do not multiply per-frame and per-keystroke worker cost (mirrors the #1580 visibility gating).                      |
| Watcher-driven external-change detection → tab update on out-of-app rename/delete | medium | Completes the file lifecycle when the change originates outside the app.                                                              |
| Host language provider pilots (Java/Python/Go/Rust/Shell) wired into the surface  | large  | Extends governed language intelligence beyond TS/JS using the existing LSP process manager.                                           |
| Go-to-definition / find-references / rename-symbol surfaced                       | large  | Cross-file navigation on top of the symbol provider.                                                                                  |
| Breadcrumbs / minimap / sticky scroll                                             | medium | Monaco features behind explicit, governed enablement.                                                                                 |
| Audit/evidence ledger for destructive file mutations                              | large  | Content-free evidence (op, path, kind, outcome, counts) for recursive delete, matching the Git-delivery ledger.                       |
| Atomic, crash-safe cross-device directory move/copy (`EXDEV` fallback)            | xlarge | Contained, deny-checked recursive copy+verify+delete when a root is a bind-mount/external volume.                                     |

---

## Out of scope (explicit non-goals)

- **Debugging (DAP)**, **an extension host / marketplace**, and an **OS-integrated interactive
  terminal** are not goals for the governed editor.
- **Agent-reachable file mutations under a policy/approval pipeline** (parity with the editor-agent
  action governance of #1395) are deferred pending a product decision: the Wave-1 endpoints are
  human-driven (CSRF-gated). If agents are to call them, recursive delete and move-out-of-subtree must
  pass the same policy gate rather than relying on CSRF alone.

---

## Invariants any contributor to this roadmap must respect

- **Security boundary:** never mutate or traverse outside the realpath-resolved root; deny-check every
  affected path on both ends; no-overwrite is atomic, not check-then-write; reject the root itself and
  symlinks; keep error messages non-probeable (no path / errno leakage).
- **globals.css #1300 proof gate:** prefer reusing existing `.ed-*` / `.tr-*` / `.edm-*` classes and
  inline styles; only re-pin the SHA proof when a `globals.css` change is unavoidable.
- **Reducer purity:** new layout actions return structurally valid state, return the input unchanged on
  a no-op, and keep `openFiles === tabOrder` de-duped.
- **keiko-ui strictness:** run `npm run typecheck --workspace @oscharko-dev/keiko-ui` (a stricter
  package-local `tsc`) before pushing any editor-host change, and never subclass `ApiError`.
