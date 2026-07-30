// Epic #518 / Issue #527 + 0.3.0 release audit — the shell's LIVE keyboard state.
//
// `resolveShellShortcutState` produces the two things AppShell consumes: the binding table it feeds
// to `useKeyboardShortcuts`, and the chord-label map the quick-access palette renders. The
// reserved-chord and conflict pins live here (relocated from shell-undo-bindings.test.ts, where they
// guarded a hardcoded copy nothing read) so they guard the table the product actually dispatches.
//
// This file also owns the persisted-keybinding boundary. Before the audit fix the module resolved
// shell chords through a SECOND, weaker override parser (globalKeyboardShortcuts.ts) that validated
// only the "version|commandId|binding" shape and the binding→chord mapping — never the
// reserved-chord or collision rules the settings layer enforces. `useKeyboardShortcuts` throws on
// either, IN RENDER, so one hand-edited or imported settings line ("1|undo|CtrlOrMeta+T")
// white-screened the whole desktop on every load with no in-product way out. The render tests below
// reproduce exactly that, which is why this suite renders and therefore lives in a .tsx file.

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  WORKSPACE_TRUST_SCHEMA_VERSION,
  workspaceChordKey,
} from "@oscharko-dev/keiko-contracts";

import { resolveShellShortcutState } from "./shellShortcutState";
import {
  detectReservedBindings,
  detectShortcutConflicts,
  useKeyboardShortcuts,
} from "./hooks/useKeyboardShortcuts";
import { buildUnifiedQuickAccessCommands, type Command } from "./quickAccessRegistry";
import { EDITOR_PALETTE_COMMANDS, type EditorPaletteHost } from "./widgets/cards/editorCommands";
import { translate } from "@/lib/i18n";

// The palette builder requires a translator (a caller that forgets the locale must not compile),
// and "en" is simply the locale under test here.
const enTranslate = (key: Parameters<typeof translate>[1]): string => translate("en", key);

// The six commands the shell itself dispatches. The label map is deliberately WIDER than this (it
// covers every bound editor command too, see the palette suite below), so these are asserted as a
// present subset rather than as the whole key set.
const GLOBAL_SHELL_COMMAND_IDS = [
  "undo",
  "redo",
  "focus-status",
  "focus-workspace-search",
  "quick-access.files",
  "quick-access.commands",
] as const;

function paletteHost(): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 2,
    activeFile: "src/app.ts",
    closedTabCount: 1,
    dirtyCount: 1,
    verificationRunning: false,
    verifiableTarget: "src/app.test.ts",
    workspaceTrustUiAvailable: false,
    verificationCatalog: {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId: "/repo",
      workspaceTrust: {
        kind: "workspace-trust-status",
        schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
        projectId: "/repo",
        trust: "trusted",
        decidedBy: "server",
        reason: "human-grant",
        revision: 1,
      },
      kinds: [],
    },
    splitActive: () => undefined,
    closeActiveSplit: () => undefined,
    closeActiveTab: () => undefined,
    nextTab: () => undefined,
    prevTab: () => undefined,
    reopenClosed: () => undefined,
    saveAll: () => undefined,
    runFileTests: () => undefined,
    runWorkspaceVerification: () => undefined,
    cancelVerification: () => undefined,
    trustWorkspaceScripts: () => undefined,
    revokeWorkspaceScriptTrust: () => undefined,
    openProblems: () => undefined,
    openFileHistory: () => undefined,
  };
}

function appCommand(id: string): Command {
  return { id, label: `App ${id}`, group: "App", icon: "spark", run: () => undefined };
}

// Mirrors AppShellInner's own use of the substrate: resolved shell bindings straight into the
// hook that fails closed on a conflicting or browser-reserved chord.
function ShellShortcutHost({ overrides }: { readonly overrides: readonly string[] }): ReactNode {
  const state = resolveShellShortcutState(overrides);
  useKeyboardShortcuts({ bindings: state.bindings, dispatch: vi.fn(), platform: "other" });
  return <div>shell rendered</div>;
}

describe("shellShortcutState — the live shell binding table", () => {
  it("claims undo, redo, footer-status, workspace search, and quick-access chords", () => {
    const ids = resolveShellShortcutState([]).bindings.map((binding) => binding.commandId);

    expect(ids).toEqual([...GLOBAL_SHELL_COMMAND_IDS]);
  });

  it("uses the governed shell chords", () => {
    const map = new Map(
      resolveShellShortcutState([]).bindings.map((binding) => [binding.commandId, binding.chord]),
    );

    expect(map.get("undo")).toEqual({ key: "z", mod: ["cmd"] });
    expect(map.get("redo")).toEqual({ key: "z", mod: ["cmd", "shift"] });
    expect(map.get("focus-status")).toEqual({ key: "s", mod: ["alt"] });
    expect(map.get("focus-workspace-search")).toEqual({ key: "f", mod: ["cmd", "shift"] });
    expect(map.get("quick-access.files")).toEqual({ key: "p", mod: ["cmd"] });
    expect(map.get("quick-access.commands")).toEqual({ key: "p", mod: ["cmd", "shift"] });
  });

  it("contains no browser-reserved chord", () => {
    expect(detectReservedBindings(resolveShellShortcutState([]).bindings)).toEqual([]);
  });

  it("contains no internal chord conflict", () => {
    expect(detectShortcutConflicts(resolveShellShortcutState([]).bindings)).toEqual([]);
  });

  // The reserved/conflict contract must hold for a REBOUND table too — the input a hardcoded copy
  // of the table could never exercise.
  it("resolves a user override into the dispatched chord, still reserved-free and conflict-free", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(detectReservedBindings(state.bindings)).toEqual([]);
    expect(detectShortcutConflicts(state.bindings)).toEqual([]);
    expect(state.bindings.map((binding) => workspaceChordKey(binding.chord))).toContain(
      workspaceChordKey({ key: "o", mod: ["cmd", "shift"] }),
    );
  });
});

describe("shellShortcutState — persisted override validation", () => {
  it("resolves global bindings and labels from editor setting overrides", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.labels.get("quick-access.files")).toMatch(/O$/u);
  });

  it("labels every global shell command by default", () => {
    const state = resolveShellShortcutState([]);

    for (const commandId of GLOBAL_SHELL_COMMAND_IDS) {
      expect(state.labels.has(commandId)).toBe(true);
    }
    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("applies validated global overrides and ignores editor-only override records", () => {
    const state = resolveShellShortcutState([
      "1|quick-access.files|CtrlOrMeta+Shift+O",
      "1|view.splitRight|CtrlOrMeta+Alt+\\",
    ]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.bindings.map((entry) => entry.commandId)).not.toContain("view.splitRight");
  });

  it("falls back to the default binding when a persisted override is malformed", () => {
    const state = resolveShellShortcutState(["not-a-valid-override"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("ignores a persisted override that claims a browser-reserved chord", () => {
    const state = resolveShellShortcutState(["1|undo|CtrlOrMeta+T"]);

    expect(state.bindings).toContainEqual({
      commandId: "undo",
      chord: { key: "z", mod: ["cmd"] },
    });
  });

  it("ignores a persisted override whose explicit modifier spelling hides a reserved chord", () => {
    const state = resolveShellShortcutState(["1|focus-status|Ctrl+T"]);

    expect(state.bindings).toContainEqual({
      commandId: "focus-status",
      chord: { key: "s", mod: ["alt"] },
    });
  });

  it("ignores a persisted override that collides with another command's chord", () => {
    const state = resolveShellShortcutState(["1|focus-status|Meta+Z"]);

    expect(state.bindings).toContainEqual({
      commandId: "undo",
      chord: { key: "z", mod: ["cmd"] },
    });
    expect(state.bindings).toContainEqual({
      commandId: "focus-status",
      chord: { key: "s", mod: ["alt"] },
    });
  });

  it.each([
    ["a browser-reserved chord", "1|undo|CtrlOrMeta+T"],
    ["an explicit-modifier reserved chord", "1|focus-status|Ctrl+T"],
    ["a chord already claimed by another command", "1|focus-status|Meta+Z"],
    ["an unparsable record", "1|undo"],
  ])("keeps the shell rendering when a persisted override carries %s", (_label, override) => {
    render(<ShellShortcutHost overrides={[override]} />);

    expect(screen.getByText("shell rendered")).toBeTruthy();
  });

  it("keeps the shell rendering for a valid override", () => {
    render(<ShellShortcutHost overrides={["1|quick-access.files|CtrlOrMeta+Shift+O"]} />);

    expect(screen.getByText("shell rendered")).toBeTruthy();
  });
});

describe("shellShortcutState — palette chord labels", () => {
  it("labels the global commands from the live bindings", () => {
    expect(
      resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]).labels.get(
        "quick-access.files",
      ),
    ).toMatch(/O$/u);
  });

  // Audit — the label map used to carry the six global command ids only, so no editor command could
  // ever pick up a rebind and the palette kept advertising the hardcoded chord.
  it("labels EVERY bound editor command, not just the global six", () => {
    const labels = resolveShellShortcutState([]).labels;

    expect(labels.has("view.splitRight")).toBe(true);
    expect(labels.has("tab.next")).toBe(true);
    expect(labels.has("tab.prev")).toBe(true);
    expect(labels.has("files.saveAll")).toBe(true);
    expect(labels.has("tab.reopenClosed")).toBe(true);
  });

  it("omits an unbound command so the palette renders no chord chip", () => {
    // `view.splitDown` ships with no default binding, and "Unbound" is settings wording, not a chord.
    expect(resolveShellShortcutState([]).labels.has("view.splitDown")).toBe(false);
  });

  // Widening the map must not advertise a chord nobody dispatches — that is the same defect one
  // command later. `open-editor-settings` is bound to CtrlOrMeta+, in the registry but its
  // "settings" context has no keydown listener, so it stays out until one exists.
  it("omits a bound command whose context has no dispatcher", () => {
    const labels = resolveShellShortcutState([]).labels;

    expect(labels.has("open-editor-settings")).toBe(false);
    // Monaco-owned chords ARE dispatched (by Monaco), so they stay in.
    expect(labels.has("editor.save")).toBe(true);
  });

  it("reaches the palette row with the REBOUND editor chord instead of the hardcoded hint", () => {
    const hardcoded = EDITOR_PALETTE_COMMANDS.find(
      (command) => command.id === "tab.next",
    )?.keybinding;
    const state = resolveShellShortcutState(["1|tab.next|CtrlOrMeta+Shift+ArrowRight"]);

    const row = buildUnifiedQuickAccessCommands(
      [appCommand("theme")],
      paletteHost(),
      enTranslate,
      state.labels,
    ).find((command) => command.id === "tab.next");

    expect(hardcoded).toBeDefined();
    expect(row?.shortcut).toBeDefined();
    expect(row?.shortcut).not.toBe(hardcoded);
    expect(row?.shortcut).toMatch(/Right$/u);
  });
});
