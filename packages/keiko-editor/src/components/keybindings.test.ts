import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_SAVE_ACTION_ID,
  EDITOR_SAVE_ACTION_LABEL,
  buildSaveActionDescriptor,
  buildSaveKeybinding,
} from "./keybindings.js";

// Mirror Monaco's enum values: KeyMod.CtrlCmd = 2048, KeyCode.KeyS = 49.
const keys = { KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } };

describe("buildSaveKeybinding", () => {
  it("ORs the platform-aware Ctrl/Cmd modifier with the S key", () => {
    expect(buildSaveKeybinding(keys)).toBe(2048 | 49);
  });

  it("uses the injected constants (no hard-coded monaco runtime reference)", () => {
    expect(buildSaveKeybinding({ KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 4 } })).toBe(5);
  });
});

describe("buildSaveActionDescriptor", () => {
  it("uses the stable Keiko save id and label", () => {
    const descriptor = buildSaveActionDescriptor({ keys, run: () => undefined });
    expect(descriptor.id).toBe(EDITOR_SAVE_ACTION_ID);
    expect(descriptor.id).toBe("keiko.editor.save");
    expect(descriptor.label).toBe(EDITOR_SAVE_ACTION_LABEL);
    expect(descriptor.label).toBe("Save Document");
  });

  it("binds the descriptor to the Ctrl/Cmd+S chord", () => {
    const descriptor = buildSaveActionDescriptor({ keys, run: () => undefined });
    expect(descriptor.keybindings).toEqual([2048 | 49]);
  });

  it("wires run to the injected handler", () => {
    const run = vi.fn();
    const descriptor = buildSaveActionDescriptor({ keys, run });
    void descriptor.run({} as never);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
