/**
 * Locators for the multi-root editor switcher (`MultiRootEditorHost`), whose tabs select a
 * workspace root.
 *
 * Deliberately NOT in `editorWorkspace.ts`. That module is a member of
 * `D12_MEASUREMENT_TOOLCHAIN_PATHS` (scripts/d12-measurement-toolchain.mjs) because
 * `editor-performance.spec.ts` and `editor-debugging-2348.spec.ts` import from it, and the
 * freshness digest is file-granular — any byte added there invalidates the committed D12 evidence
 * and demands a full reference-machine re-measurement. Nothing here is reachable from a measured
 * spec, so binding it to the measurement ruler would force re-measurement for a change that
 * provably cannot move a measured number, which ADR-0139 D10 explicitly does not want.
 */
import { type Locator, type Page } from "@playwright/test";

/**
 * Accessible name of the multi-root switcher tablist (`editor.multiRoot.switcher`). It is what
 * separates the root tabs from the `"Open documents"` tablist each mounted workspace also renders.
 */
const EDITOR_ROOT_SWITCHER_LABEL = "Editor workspace roots";

/**
 * The multi-root switcher's tab strip, whose tabs select a workspace root.
 *
 * Every root-tab query must be scoped through here. The strip belongs to the enclosing host, not to
 * either root's workspace panel, and each mounted workspace owns its own `role="tab"` open-document
 * strip — inactive roots stay mounted. So a page-wide `role="tab"` search spans both tab families
 * across every root: it can resolve to more than one selected tab, and can match a document tab
 * where a root tab was meant.
 *
 * `includeHidden` because the workspace-trust prompt deliberately makes the background inert. The
 * strip stays on screen and stays clickable — Playwright's actionability checks are unaffected —
 * but it leaves the accessibility tree, so a default role query would not see it while the prompt
 * that the caller is about to answer is open.
 *
 * Pass a `scope` to bind the lookup to one seeded editor window when a journey has several.
 */
export function editorRootTabs(scope: Page | Locator): Locator {
  return scope.getByRole("tablist", { name: EDITOR_ROOT_SWITCHER_LABEL, includeHidden: true });
}

/** The multi-root switcher tab for one root, scoped away from every mounted document tablist. */
export function editorRootTab(scope: Page | Locator, name: RegExp | string): Locator {
  return editorRootTabs(scope).getByRole("tab", { name, includeHidden: true });
}
