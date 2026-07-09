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
