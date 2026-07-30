// The shell's persisted-keybinding boundary. Before the fix this module resolved shell chords
// through a SECOND, weaker override parser (globalKeyboardShortcuts.ts) that validated only the
// "version|commandId|binding" shape and the binding→chord mapping — never the reserved-chord or
// collision rules the settings layer enforces. `useKeyboardShortcuts` throws on either, IN RENDER,
// so one hand-edited or imported settings line ("1|undo|CtrlOrMeta+T") white-screened the whole
// desktop on every load with no in-product way out. The render tests below reproduce exactly that.

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveShellShortcutState } from "./shellShortcutState";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

// Mirrors AppShellInner's own use of the substrate: resolved shell bindings straight into the
// hook that fails closed on a conflicting or browser-reserved chord.
function ShellShortcutHost({ overrides }: { readonly overrides: readonly string[] }): ReactNode {
  const state = resolveShellShortcutState(overrides);
  useKeyboardShortcuts({ bindings: state.bindings, dispatch: vi.fn(), platform: "other" });
  return <div>shell rendered</div>;
}

describe("shellShortcutState", () => {
  it("resolves global bindings and labels from editor setting overrides", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.labels.get("quick-access.files")).toMatch(/O$/u);
  });

  it("resolves the shell default shortcuts for every global command", () => {
    const state = resolveShellShortcutState([]);

    expect([...state.labels.keys()]).toEqual([
      "undo",
      "redo",
      "focus-status",
      "focus-workspace-search",
      "quick-access.files",
      "quick-access.commands",
    ]);
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
