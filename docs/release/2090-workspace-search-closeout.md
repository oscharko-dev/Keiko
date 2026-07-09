# Epic #2090 — Workspace Search Closeout Evidence

## Demo script

1. Start Keiko with a project containing `src/search-target.ts`, `src/replace-target.ts`,
   `src/closed-replace.ts`, and `src/quick.ts`.
2. Press `Cmd/Ctrl+Shift+F`, search for `workspaceSearchNeedle`, select the `src/search-target.ts`
   result, and confirm the editor opens that file at the reported line.
3. With `src/replace-target.ts` already open and dirty, search for `replaceNeedle`, enter
   replacement text, select **Preview replace**, and confirm the diff preview covers both the dirty
   open buffer and the closed `src/closed-replace.ts` file before any content changes.
4. Select **Apply reviewed replace** and confirm the open buffer changes in memory while its on-disk
   file remains unchanged until save, and the closed file is written through the governed write seam.
5. Press `Cmd/Ctrl+P`, search for `quick.ts`, confirm `src/quick.ts` appears by filename, then type
   `>theme` and confirm `Toggle light / dark theme` appears in the same quick-access surface.

## Automated evidence

- Route latency and result bounds: `npm run test:e2e:workspace-search-2090`.
- Evidence artifact: `docs/release/2090-workspace-search-evidence.json`.
- Budget rows: `docs/keiko-editor/1207-performance-budgets.md` B12 and B13.
- Focused UI/unit coverage:
  - `packages/keiko-contracts/src/workspace-search.test.ts`
  - `packages/keiko-server/src/editor/workspaceSearchRoutes.test.ts`
  - `packages/keiko-ui/src/app/components/desktop/widgets/panels/SearchPanel.test.tsx`
  - `packages/keiko-ui/src/app/components/desktop/modals/UnifiedQuickAccessPalette.test.tsx`
  - `packages/keiko-ui/src/app/components/desktop/quickAccessRegistry.test.ts`
  - `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorCommands.test.ts`
  - `packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorWidget.test.tsx`

## Command inventory evidence

The unified quick-access registry preserves the app-level command ids produced by
`buildAppShellCommands` and the editor command ids from `EDITOR_PALETTE_COMMANDS`. The regression
coverage is in `quickAccessRegistry.test.ts`; the expected editor ids include:

`view.splitRight`, `view.splitDown`, `view.closeSplit`, `tab.next`, `tab.prev`, `tab.close`,
`tab.reopenClosed`, and `files.saveAll`.

## Findings and dispositions

Second hardening pass (commit `daaf3a25`, PR #2146):

- **F1 — Exact-line reveal used `setSelection` only (fixed).** A result's reported line was
  selected but not always scrolled/positioned as the primary cursor. Fixed: `MountEditor` also
  calls `editor.setPosition`; regression coverage in `KeikoCodeEditor.test.tsx`.
- **F2 — Hot-exit index left a malformed local record after a purge, and a failed remote delete
  could leave stale local state (fixed).** Fixed in `editorHotExitStore.ts`: a malformed local
  index record is purged without a spurious remote delete, and the local index entry is cleared
  even when the remote delete call fails (the error still surfaces — no silent failure).
- **F3 — Unified quick access did not find files by filename (fixed).** Fixed: wired
  `fetchFilesSearch` into `UnifiedQuickAccessPalette`, clearing stale results on error.
- **F4 — Replace preview/apply error and conflict messages were computed but never rendered
  (fixed).** Fixed: `SearchPanel`'s status region now surfaces both success and failure paths.
- **F5 — Replace-preview model building was duplicated between `SearchPanel` and the shared diff
  surface (fixed).** Consolidated into `EditorDiffSurface.buildWorkspaceReplacePatchModel`, reusing
  `buildPatchPreview`/`EditorPreviewedPatch` from `keiko-editor` instead of a second
  preview-edit-application implementation.
- **F6 — Replace-apply preflight normalized no-final-newline files (fixed).** Fixed: the preflight
  routes through `keiko-tools`' `validatePatch`/`applyPatch` for scope/conflict semantics, then
  writes the exact range-applied text so the on-disk bytes are not renormalized by the hunk
  applier.

Third hardening pass (this PR — an independent post-merge audit of the above):

- **F7 — Duplicated ReDoS gate (fixed).** `packages/keiko-contracts/src/workspace-search.ts` carried
  its own copy of `regexSafetyIssue` instead of the canonical one in
  `packages/keiko-workspace/src/repoSearchRegexSafety.ts`, risking future drift between the two
  search surfaces' catastrophic-backtracking detection. Fixed: `regexSafetyIssue` is now defined
  once in `keiko-contracts` (the leaf package, per ADR-0019) and `repoSearchRegexSafety.ts`
  re-exports it.
- **F8 — Missing route-level coverage for unsafe regex on the replace-preview path, and undocumented
  literal-mode whitespace behavior (fixed).** Added a dedicated test asserting
  `POST /api/editor/workspace-search/replace-preview` rejects a known-unsafe pattern (400, no file
  mutation) — the search route already had this coverage, the replace-preview route did not. Added
  a test and a code comment documenting that literal-mode maps onto escaped-regex (not the
  whitespace-free exact-symbol kind), so multi-word literal queries match correctly.
- **F9 — Workspace symbol search had no deadline or cancellation bound (fixed).** `buildSymbolGraph`
  accepted no `AbortSignal` and never checked `DEFAULT_SEARCH_LIMITS.elapsedMsMax`, unlike the text
  search/replace-preview routes. Fixed: `buildSymbolGraph` now accepts an optional signal and
  deadline, and `handleEditorWorkspaceSymbols` passes the real client abort signal.
- **F10 — Global Cmd/Ctrl+P silently stopped working while editing (fixed — regression from the
  second pass).** Routing the editor's Quick-Open chord through the shared `useKeyboardShortcuts`
  substrate dropped the editor-local capturing listener that previously handled it, and that shared
  substrate deliberately ignores editable event targets (including Monaco's own hidden textarea) —
  contradicting the epic's own closure statement ("Cmd/Ctrl+P finds any file from anywhere"). Fixed:
  the editor's capture-phase container listener now opens the unified quick-access palette directly
  via `EditorQuickAccessTriggerContext`, bypassing the editable-target guard exactly as the
  pre-existing local listener did. Regression coverage in `EditorWidget.workspace.test.tsx`.
- **F11 — `CommandPalette.tsx` and `EditorCommandPalette.tsx` were retired but not deleted
  (fixed).** Both components (and their test suites) became fully unreachable once the unified
  quick-access palette replaced them, but were left in the tree — dead code that the epic's own
  Reuse-And-No-Duplication gate exists to prevent. Deleted both components and their tests; moved
  the `Command` type `CommandPalette.tsx` exported into `quickAccessRegistry.ts`; removed the
  now-dead `openQuickOpen`/`openCommandPalette` methods from `EditorPaletteHost` and the dead
  `openPalette` prop from `Header`.
- **F12 — Replace-apply spuriously failed on real-world-sized files (fixed).** The closed-file
  preflight renders the entire file as one diff hunk and validated it against
  `keiko-tools`' `DEFAULT_PATCH_LIMITS` (sized for small assistant-generated patches: 64 KB / 2,000
  changed lines), so a file only moderately larger than the search engine's own scan bound would be
  rejected even for a single-word replacement. Fixed: a dedicated `REPLACE_APPLY_PREFLIGHT_LIMITS`
  sized to the search/replace engine's own file-size bound. Regression test: a 3,000-line fixture
  file replaces cleanly.
- **F13 — Replace-apply preflight used a signal that could never abort (fixed).** Fixed: threads the
  real client abort signal (`clientAbortSignal(ctx)`) through `buildReplaceApplyResponse` →
  `applyReplaceFile` → `validateReplacePatchPreflight`, matching the pattern already used by the
  search and replace-preview routes.
- **F14 — Zero test coverage for the open-buffer replace-apply path (fixed).** The only
  replace-related coverage at the `SearchPanel` level stubbed out `applyWorkspaceReplaceBuffer`
  entirely, so a regression in its stale-content detection or edit-application logic would not have
  been caught. Fixed: `EditorRuntimeWidget.replaceBuffer.test.tsx` exercises the real function
  through the real `WorkspaceReplaceBufferProvider` registry (apply, stale-conflict, not-open).
- **F15 — B12/B13 performance evidence was measured against the dev server, not the packaged
  build (fixed).** `playwright.issue-2090-workspace-search.config.ts` started the server via
  `scripts/dev-runner.mjs` (an extra proxy hop), unlike the established `#1209` pattern
  (`playwright.workspace-performance.config.ts`), which measures against the packaged CLI. Fixed:
  the config now builds and serves `dist/cli/index.js ui`, matching precedent; evidence in
  `2090-workspace-search-evidence.json` was recaptured against the packaged build (p50 14 ms / p95
  40 ms against 200/500 ms budgets).
- **F16 — `WorkspaceSymbolSearchRequest.scopePath` is unused forward-looking plumbing (accepted, not
  a defect).** The field, its validation, and its deny/escape-rejection tests exist, but no shipped
  UI caller sets it yet. Recorded here so a future audit does not mistake it for dead code: it is
  reachable, tested, governed capability awaiting a UI consumer (e.g. scoping symbol search to the
  active file/folder), not a duplicate or abandoned subsystem.
