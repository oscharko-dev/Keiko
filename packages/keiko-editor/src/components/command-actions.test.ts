import { describe, expect, it, vi } from "vitest";

import {
  buildGenerateTestsActionDescriptor,
  buildGenerateTestsKeybinding,
  EDITOR_COMMAND_KEYBINDINGS,
  EDITOR_GENERATE_TESTS_ACTION_ID,
  EDITOR_GENERATE_TESTS_ACTION_LABEL,
  MONACO_BUILTIN_ACTION_IDS,
  type CommandActionKeys,
} from "./command-actions.js";

// Monaco's real bit values (KeyMod is a high-bit flag set; KeyCode is a small enum), so the OR is a
// faithful, non-overlapping composition.
const KEYS: CommandActionKeys = {
  KeyMod: { CtrlCmd: 2048, Alt: 512 },
  KeyCode: { KeyT: 53 },
};

describe("buildGenerateTestsKeybinding", () => {
  it("packs Cmd/Ctrl+Alt+T as the bitwise OR of the three constants", () => {
    expect(buildGenerateTestsKeybinding(KEYS)).toBe(2048 | 512 | 53);
  });

  it("includes every modifier and the letter bit", () => {
    const chord = buildGenerateTestsKeybinding(KEYS);
    expect(chord & KEYS.KeyMod.CtrlCmd).toBe(KEYS.KeyMod.CtrlCmd);
    expect(chord & KEYS.KeyMod.Alt).toBe(KEYS.KeyMod.Alt);
    expect(chord & KEYS.KeyCode.KeyT).toBe(KEYS.KeyCode.KeyT);
  });
});

describe("buildGenerateTestsActionDescriptor", () => {
  it("builds a palette + context-menu action bound to the chord and the host handler", () => {
    const run = vi.fn();
    const descriptor = buildGenerateTestsActionDescriptor({ keys: KEYS, run });
    expect(descriptor.id).toBe(EDITOR_GENERATE_TESTS_ACTION_ID);
    expect(descriptor.label).toBe(EDITOR_GENERATE_TESTS_ACTION_LABEL);
    expect(descriptor.keybindings).toEqual([buildGenerateTestsKeybinding(KEYS)]);
    // A context-menu group makes it discoverable for mouse users (right-click), not just F1.
    expect(descriptor.contextMenuGroupId).toBe("1_modification");
    expect(typeof descriptor.contextMenuOrder).toBe("number");
  });

  it("delegates the run to the injected host handler exactly once", () => {
    const run = vi.fn();
    const descriptor = buildGenerateTestsActionDescriptor({ keys: KEYS, run });
    // Monaco passes the editor instance; the descriptor ignores it and calls the host handler.
    void descriptor.run({} as never);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("MONACO_BUILTIN_ACTION_IDS", () => {
  it("references Monaco's stable built-in ids for the editor-intrinsic commands", () => {
    expect(MONACO_BUILTIN_ACTION_IDS.find).toBe("actions.find");
    expect(MONACO_BUILTIN_ACTION_IDS.format).toBe("editor.action.formatDocument");
    expect(MONACO_BUILTIN_ACTION_IDS.acceptInlineCompletion).toBe(
      "editor.action.inlineSuggest.commit",
    );
    expect(MONACO_BUILTIN_ACTION_IDS.rejectInlineCompletion).toBe(
      "editor.action.inlineSuggest.hide",
    );
    expect(MONACO_BUILTIN_ACTION_IDS.commandPalette).toBe("editor.action.quickCommand");
    expect(MONACO_BUILTIN_ACTION_IDS.accessibilityHelp).toBe("editor.action.accessibilityHelp");
  });
});

describe("EDITOR_COMMAND_KEYBINDINGS", () => {
  it("documents a platform-specific label for each surfaced command", () => {
    for (const display of Object.values(EDITOR_COMMAND_KEYBINDINGS)) {
      expect(display.mac.length).toBeGreaterThan(0);
      expect(display.pc.length).toBeGreaterThan(0);
    }
  });

  it("binds Generate Tests to Cmd/Ctrl+Alt+T to match the registered chord", () => {
    expect(EDITOR_COMMAND_KEYBINDINGS["editor.generateTests"]).toEqual({
      mac: "⌘⌥T",
      pc: "Ctrl+Alt+T",
    });
  });
});
