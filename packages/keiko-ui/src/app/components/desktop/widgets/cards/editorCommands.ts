/**
 * Host-level editor command registry for the workspace command palette.
 *
 * Mirrors the editor-package command catalogue pattern (`packages/keiko-editor/src/commands.ts`:
 * a static command list plus a deterministic availability gate), but at the WORKSPACE/host level: each
 * command's `run` dispatches into the existing, identity-stable `EditorWidget` host callbacks, and
 * `isAvailable` derives purely from a content-free host snapshot.
 */

import type { EditorVerificationCatalog, VerificationKind } from "@oscharko-dev/keiko-contracts";
import type { MessageKey } from "@/lib/i18n-messages.en";

/** Content-free actions the host exposes to a command. Implemented in `EditorWidget`. */
export interface EditorPaletteHost {
  readonly root: string;
  readonly activePaneId: string;
  readonly paneCount: number;
  readonly activeFile: string | null;
  readonly closedTabCount: number;
  readonly dirtyCount: number;
  // Issue #2212 (ADR-0126) — run-affordance state and actions. `verificationRunning` gates cancel on
  // and the run actions off; `verifiableTarget` is the resolved file `runFileTests` would target (or
  // null). The actions dispatch into Issue #2211's governed route; the host owns the run identity.
  readonly verificationRunning: boolean;
  readonly verifiableTarget: string | null;
  readonly verificationCatalog: EditorVerificationCatalog | null;
  readonly workspaceTrustUiAvailable: boolean;
  splitActive(direction: "row" | "column"): void;
  closeActiveSplit(): void;
  closeActiveTab(): void;
  nextTab(): void;
  prevTab(): void;
  reopenClosed(): void;
  saveAll(): void;
  runFileTests(): void;
  runWorkspaceVerification(kind: VerificationKind): void;
  cancelVerification(): void;
  trustWorkspaceScripts(): void;
  revokeWorkspaceScriptTrust(): void;
  openProblems(): void;
  openFileHistory(): void;
  readonly openDebugPanel?: (() => void) | undefined;
}

export interface EditorPaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly titleKey?: MessageKey;
  /** Display-only chord hint shown in the palette row. */
  readonly keybinding?: string;
  readonly run: (host: EditorPaletteHost) => void;
  /** Extra precondition beyond "the editor is mounted"; absent means always available. */
  readonly isAvailable?: (host: EditorPaletteHost) => boolean;
}

// Every listed command runs an editor action and closes the command palette.
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
    keybinding: "Ctrl/⌘ ⌥ R",
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
  {
    id: "editor.openProblems",
    title: "Open Problems",
    titleKey: "editor.command.openProblems",
    run: (host) => host.openProblems(),
    isAvailable: (host) => host.root.length > 0,
  },
  {
    id: "editor.openFileHistory",
    title: "Open File History",
    titleKey: "editor.command.openFileHistory",
    run: (host) => host.openFileHistory(),
    isAvailable: (host) => host.root.length > 0 && host.activeFile !== null,
  },
  {
    id: "editor.openDebugPanel",
    title: "Open Debug",
    run: (host) => host.openDebugPanel?.(),
    isAvailable: (host) => host.root.length > 0 && host.openDebugPanel !== undefined,
  },
  // Issue #2212 (ADR-0126) — run affordances through the governed verification route. The four run
  // actions are available only while idle; cancel only while a run is active (mutually exclusive).
  {
    id: "run.fileTests",
    title: "Run Tests for File",
    titleKey: "editor.command.runFileTests",
    run: (host) => host.runFileTests(),
    isAvailable: (host) =>
      !host.verificationRunning &&
      host.verifiableTarget !== null &&
      catalogAllows(host, "targeted-test"),
  },
  {
    id: "run.typecheck",
    title: "Run Typecheck",
    titleKey: "editor.command.runTypecheck",
    run: (host) => host.runWorkspaceVerification("typecheck"),
    isAvailable: (host) => !host.verificationRunning && catalogAllows(host, "typecheck"),
  },
  {
    id: "run.lint",
    title: "Run Lint",
    titleKey: "editor.command.runLint",
    run: (host) => host.runWorkspaceVerification("lint"),
    isAvailable: (host) => !host.verificationRunning && catalogAllows(host, "lint"),
  },
  {
    id: "run.build",
    title: "Run Build",
    titleKey: "editor.command.runBuild",
    run: (host) => host.runWorkspaceVerification("build"),
    isAvailable: (host) => !host.verificationRunning && catalogAllows(host, "build"),
  },
  {
    id: "run.cancel",
    title: "Cancel Verification",
    titleKey: "editor.command.cancelVerification",
    run: (host) => host.cancelVerification(),
    isAvailable: (host) => host.verificationRunning,
  },
  {
    id: "verification.trustWorkspaceScripts",
    title: "Trust Workspace Scripts",
    titleKey: "editor.command.trustWorkspaceScripts",
    run: (host) => host.trustWorkspaceScripts(),
    isAvailable: (host) =>
      host.workspaceTrustUiAvailable &&
      !host.verificationRunning &&
      hasScriptTrustState(host, "approval-required"),
  },
  {
    id: "verification.revokeWorkspaceScriptTrust",
    title: "Revoke Workspace Script Trust",
    titleKey: "editor.command.revokeWorkspaceScriptTrust",
    run: (host) => host.revokeWorkspaceScriptTrust(),
    isAvailable: (host) =>
      host.workspaceTrustUiAvailable &&
      !host.verificationRunning &&
      hasScriptTrustState(host, "trusted"),
  },
];

function catalogAllows(host: EditorPaletteHost, kind: VerificationKind): boolean {
  const entry = host.verificationCatalog?.kinds.find((candidate) => candidate.kind === kind);
  return entry?.available === true && entry.trustState === "trusted";
}

function hasScriptTrustState(
  host: EditorPaletteHost,
  trustState: "trusted" | "approval-required",
): boolean {
  return (
    host.verificationCatalog?.kinds.some(
      (entry) =>
        entry.kind !== "targeted-test" && entry.available && entry.trustState === trustState,
    ) === true
  );
}

export function availablePaletteCommands(host: EditorPaletteHost): readonly EditorPaletteCommand[] {
  return EDITOR_PALETTE_COMMANDS.filter(
    (command) => command.isAvailable === undefined || command.isAvailable(host),
  );
}

// Issue #2212 (ADR-0126) — maps the active file to the file `run.fileTests` should target: a test file
// targets itself; a source file maps to its sibling `.test` counterpart; anything else (no active
// file, a non-code extension) resolves to null. Pure and path-based (no I/O), so it is unit-testable
// deterministically and reused by both the palette's `isAvailable` and the widget's `verifiableTarget`.
const VERIFICATION_TEST_MARKER = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const VERIFICATION_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Shared with the debug-launch seam (`debugLaunchTarget.ts`, epic #2096/ADR-0136 D4): a recognized
// test file prefers the discovered npm test script over a bare file launch, reusing this exact rule
// rather than growing a second test-file heuristic.
export function isTestFilePath(path: string): boolean {
  return VERIFICATION_TEST_MARKER.test(path);
}

export function resolveVerificationTarget(activeFile: string | null): string | null {
  if (activeFile === null || activeFile.length === 0) return null;
  if (isTestFilePath(activeFile)) return activeFile;
  const dot = activeFile.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = activeFile.slice(dot);
  if (!VERIFICATION_CODE_EXTENSIONS.has(ext)) return null;
  return `${activeFile.slice(0, dot)}.test${ext}`;
}
