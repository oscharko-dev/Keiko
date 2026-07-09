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
  - `packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorDiffSurface.test.ts`
  - `packages/keiko-workspace/src/symbolGraph.test.ts`

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

Fourth hardening pass (independent post-merge audit of rounds 1–3, seven parallel reviews — one per
child issue plus one epic-level integration review — each with a two-skeptic adversarial
verification pass; 8/8 reported defects confirmed, 0 refuted):

- **F17 — Replace-preview route crashed on a validator-approved regex containing an unescaped
  quantifier-like character (fixed).** `buildMatchRegex` in `workspaceSearchRoutes.ts` constructed
  its `RegExp` with a `"u"` (unicode) flag that neither `regexSafetyIssue`'s validity check nor the
  sibling search route's `buildRegexMatcher` uses. A query such as `items{` passes validation and
  matches fine on the plain search route, but `new RegExp("items{", "giu")` throws
  `SyntaxError: Incomplete quantifier`, escaping as an uncaught exception into an opaque `500` on
  the replace-preview route only. Fixed: `buildMatchRegex` now uses the same `"g"`/`"gi"` flags as
  the validator and the shared matcher. Regression test: a fixture file containing literal
  `items{`, replaced in regex mode.
- **F18 — Replace could silently skip the exact line that matched, when that line followed a
  brace-delimited block in the same file (fixed).** The replace-preview/apply path decided which
  lines were eligible for rewriting from `searchText`'s RAG-oriented "best representative lines"
  sampling (`collectBestLines`/`insertBestLine`/`braceRange` in
  `packages/keiko-workspace/src/repoSearchLineSelection.ts`), which is tuned for LLM
  context-evidence diversity, not replace completeness. `braceRange`'s backward brace scan could
  compute an enclosing range that ended before the very line that matched, and the two match groups
  would then merge into one, dropping the match. An already-merged test encoded this broken
  behavior as expected. Fixed: the replace route no longer gates on the search engine's per-line
  sample at all — `buildReplacePreviewFiles`/`buildReplaceFileEdit` now exhaustively re-scan the
  full (already byte-bounded) content of every file the search identified as having a match, using
  the same validated pattern, rather than trusting a "best lines" subset. Regression test: a fixture
  where a match immediately follows a brace-delimited block, asserting both matches are found.
- **F19 — Replace silently dropped matches in a file with more than three non-overlapping match
  locations (fixed, same root cause as F18).** `collectBestLines`'s `MAX_MATCHES_PER_FILE = 3`
  per-file cap (an Epic #177 retrieval-diversity heuristic) silently discarded the 4th+ match group
  with no truncation signal, once again because replace reused a RAG-sampling primitive not
  designed for write completeness. Fixed by the same F18 change: replace no longer depends on this
  cap at all. Regression test: a 5-function fixture file, each with one non-overlapping match,
  asserts all 5 are replaced.
- **F20 — `buildSymbolGraph`'s deadline/abort bound (F9, round 3) had zero regression test
  coverage (fixed).** The cancellation guard added in round 3 was real and correctly wired, but no
  test anywhere exercised it — a future refactor could silently drop it undetected. Fixed:
  `symbolGraph.test.ts` now asserts an already-aborted `AbortSignal` stops the scan before any file
  is read (`truncated: true`, zero records, zero files scanned). The deadline half of the guard
  (`Date.now() - startedAt > limits.elapsedMsMax`) is intentionally not separately tested with real
  wall-clock timing, since `buildSymbolGraph` has no injectable clock (unlike `searchText`'s
  `nowMs`) and a timing-based test would be racy; the abort-signal half exercises the identical
  guard clause deterministically.
- **F21 — No Playwright coverage exercised an editor-scoped command through the unified
  quick-access palette's command mode (fixed).** The only e2e test touching the unified palette
  seeded zero windows, so no editor-scoped command (`view.splitRight`, `files.saveAll`, etc.) was
  ever reachable in that test, despite issue #2112's Deliverables explicitly requiring this
  coverage. Fixed: a new e2e spec seeds an editor window with two open tabs, opens the unified
  palette from outside the editor, confirms both an app-level and an editor-level command appear in
  the same `>` result list, executes "Split Editor Right", and asserts the pane count actually
  becomes 2. (Two open tabs are required deliberately — see Engineering Notes below.)
- **F22 — The replace-preview diff-rendering logic had zero direct test coverage (fixed).**
  `EditorDiffSurface.buildWorkspaceReplacePatchModel`/`replaceEditToEditorEdit` (added in round 2,
  commit `daaf3a25`) convert 1-indexed server edit ranges into 0-indexed editor ranges; both unit
  tests that reference the module stub it out entirely (`vi.mock`), and the e2e replace test only
  asserted a summary status string, never the diff view's content. Fixed: a new
  `EditorDiffSurface.test.ts` calls the real function directly with known multi-line/column edits
  (mid-file, start-of-file, end-of-file cases) and asserts the resulting before/after text is
  exactly correct; the e2e replace spec now also asserts `keiko-diff-editor`/`keiko-diff-file`
  render with the correct file count and that the diff panes show the expected original/modified
  text before Apply is clicked.
- **F23 — `dedupeCommands`/`dedupeFileResults` were never exercised with actual colliding input
  (fixed).** Both de-duplication functions existed and were called in production, but every test
  fixture used non-overlapping ids/paths, so the actual collision-collapsing branch was untested —
  a regression that kept the wrong duplicate, or stopped deduping altogether, would not have been
  caught. Fixed: added a colliding-id test to `quickAccessRegistry.test.ts` (asserting the app
  command wins over an editor command sharing its id) and a colliding-path test to
  `UnifiedQuickAccessPalette.test.tsx` (asserting only one row renders when both the filename-search
  and text-search mocks return the same path).
- **F24 — This closure evidence existed but was never linked from Epic #2090's Definition of Done
  (fixed).** The demo script and findings ledger in this document were real and reproducible, but
  issue #2090's body still read the generic, unchecked closure line with no reference to this file.
  Fixed: linked from the epic (see the epic's Definition of Done / a closure comment referencing
  this document).

**Engineering note on F21's two-open-tab requirement:** `splitPane` (`packages/keiko-contracts/src/editor-layout.ts`)
implements a split by moving the active file into a brand-new pane; if the source pane has only one
open file, moving it away would leave nothing behind, so the reducer intentionally no-ops
(`withoutFile(source.openFiles, activeFile).length === 0 → return layout`). This is correct,
pre-existing, load-bearing behavior — not a defect — but it means any test (or interactive demo)
of "Split Editor Right"/"Split Editor Down" must open at least two tabs in the target pane first,
regardless of which surface (toolbar button, keyboard chord, or unified quick-access command)
triggers the split.
