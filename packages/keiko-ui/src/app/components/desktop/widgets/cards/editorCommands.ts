/**
 * Host-level editor command registry feeding the unified quick-access palette
 * (`UnifiedQuickAccessPalette`, Epic #2090) with editor-scoped commands.
 *
 * Mirrors the editor-package command catalogue pattern (`packages/keiko-editor/src/commands.ts`:
 * a static command list plus a deterministic availability gate), but at the WORKSPACE/host level: each
 * command's `run` dispatches into the existing, identity-stable `EditorWidget` host callbacks, and
 * `isAvailable` derives purely from a content-free host snapshot.
 */

/** Content-free actions the host exposes to a command. Implemented in `EditorWidget`. */
export interface EditorPaletteHost {
  readonly root: string;
  readonly activePaneId: string;
  readonly paneCount: number;
  readonly activeFile: string | null;
  readonly closedTabCount: number;
  readonly dirtyCount: number;
  splitActive(direction: "row" | "column"): void;
  closeActiveSplit(): void;
  closeActiveTab(): void;
  nextTab(): void;
  prevTab(): void;
  reopenClosed(): void;
  saveAll(): void;
}

export interface EditorPaletteCommand {
  readonly id: string;
  readonly title: string;
  /** Display-only chord hint shown in the palette row. */
  readonly keybinding?: string;
  readonly run: (host: EditorPaletteHost) => void;
  /** Extra precondition beyond "the editor is mounted"; absent means always available. */
  readonly isAvailable?: (host: EditorPaletteHost) => boolean;
}

// Action commands shown in the command palette. Opening Quick-Open / the palette itself are chords +
// the in-palette `>` toggle, not list entries, so every listed command runs an action and closes.
export const EDITOR_PALETTE_COMMANDS: readonly EditorPaletteCommand[] = [
  {
    id: "view.splitRight",
    title: "Split Editor Right",
    keybinding: "Ctrl/⌘ ⌥ \\",
    run: (host) => host.splitActive("row"),
    isAvailable: (host) => host.activeFile !== null,
  },
  {
    id: "view.splitDown",
    title: "Split Editor Down",
    run: (host) => host.splitActive("column"),
    isAvailable: (host) => host.activeFile !== null,
  },
  {
    id: "view.closeSplit",
    title: "Close Editor Split",
    run: (host) => host.closeActiveSplit(),
    isAvailable: (host) => host.paneCount > 1,
  },
  {
    id: "tab.next",
    title: "Next Tab",
    keybinding: "Ctrl/⌘ ⌥ →",
    run: (host) => host.nextTab(),
    isAvailable: (host) => host.activeFile !== null,
  },
  {
    id: "tab.prev",
    title: "Previous Tab",
    keybinding: "Ctrl/⌘ ⌥ ←",
    run: (host) => host.prevTab(),
    isAvailable: (host) => host.activeFile !== null,
  },
  {
    id: "tab.close",
    title: "Close Tab",
    run: (host) => host.closeActiveTab(),
    isAvailable: (host) => host.activeFile !== null,
  },
  {
    id: "tab.reopenClosed",
    title: "Reopen Closed Editor",
    keybinding: "Ctrl/⌘ ⌥ T",
    run: (host) => host.reopenClosed(),
    isAvailable: (host) => host.closedTabCount > 0,
  },
  {
    id: "files.saveAll",
    title: "Save All",
    keybinding: "Ctrl/⌘ ⌥ S",
    run: (host) => host.saveAll(),
    isAvailable: (host) => host.dirtyCount > 0,
  },
];

export function availablePaletteCommands(host: EditorPaletteHost): readonly EditorPaletteCommand[] {
  return EDITOR_PALETTE_COMMANDS.filter(
    (command) => command.isAvailable === undefined || command.isAvailable(host),
  );
}

/**
 * Case-insensitive subsequence fuzzy match, shared by Quick-Open (file paths) and the command palette
 * (titles). Returns a sortable score (LOWER is a better match) or `null` when `query` is not a
 * subsequence of `target`. Rewards contiguous runs, matches at the start or after a separator
 * (`/._- `), and an early first match — the heuristics VS Code's quick-open uses.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return target.length;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let qi = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    if (qi === 0) score += ti; // earlier first hit is better
    if (lastMatch === ti - 1) score -= 3; // contiguous run bonus
    const prev = ti === 0 ? "/" : t[ti - 1];
    if (prev === "/" || prev === "." || prev === "_" || prev === "-" || prev === " ") score -= 2;
    lastMatch = ti;
    qi += 1;
  }
  if (qi < q.length) return null; // not a subsequence
  return score + (target.length - lastMatch); // shorter tail after the last match is better
}
