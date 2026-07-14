import { describe, expect, it, vi } from "vitest";

import {
  buildDebugCommandActionDescriptors,
  type DebugCommandActionKeys,
  type EditorDebugCommandHandlers,
} from "./debug-command-actions.js";

const KEYS: DebugCommandActionKeys = {
  KeyMod: { Shift: 1024 },
  KeyCode: { F5: 62, F6: 63, F10: 67, F11: 68 },
};

const LABELS = {
  continue: "Debuggen: Fortsetzen",
  pause: "Debuggen: Pausieren",
  stepOver: "Debuggen: Schritt über",
  stepInto: "Debuggen: Schritt hinein",
  stepOut: "Debuggen: Schritt heraus",
  stop: "Debuggen: Beenden",
};

function handlers(): EditorDebugCommandHandlers {
  return {
    labels: LABELS,
    continue: vi.fn(),
    pause: vi.fn(),
    stepOver: vi.fn(),
    stepInto: vi.fn(),
    stepOut: vi.fn(),
    stop: vi.fn(),
  };
}

describe("buildDebugCommandActionDescriptors", () => {
  it("registers every bounded debug control with its conventional keyboard chord", () => {
    const callbacks = handlers();
    const descriptors = buildDebugCommandActionDescriptors({ keys: KEYS, handlers: callbacks });

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "keiko.editor.debugContinue",
      "keiko.editor.debugPause",
      "keiko.editor.debugStepOver",
      "keiko.editor.debugStepInto",
      "keiko.editor.debugStepOut",
      "keiko.editor.debugStop",
    ]);
    expect(descriptors.map((descriptor) => descriptor.keybindings?.[0])).toEqual([
      62,
      63,
      67,
      68,
      1024 | 68,
      1024 | 62,
    ]);
    expect(descriptors.map((descriptor) => descriptor.label)).toEqual(Object.values(LABELS));
    for (const descriptor of descriptors)
      expect(descriptor.contextMenuGroupId).toBe("1_modification");
  });

  it("delegates every command directly to its host callback", () => {
    const callbacks = handlers();
    for (const descriptor of buildDebugCommandActionDescriptors({
      keys: KEYS,
      handlers: callbacks,
    }))
      void descriptor.run({} as never);
    for (const handler of Object.values(callbacks).filter(
      (value): value is ReturnType<typeof vi.fn> => typeof value === "function",
    ))
      expect(handler).toHaveBeenCalledOnce();
  });

  it("does not invoke a host callback when the current debug state rejects the action", () => {
    const callbacks = handlers();
    const descriptors = buildDebugCommandActionDescriptors({
      keys: KEYS,
      handlers: { ...callbacks, isAvailable: (action) => action === "pause" },
    });

    for (const descriptor of descriptors) void descriptor.run({} as never);

    expect(callbacks.pause).toHaveBeenCalledOnce();
    expect(callbacks.continue).not.toHaveBeenCalled();
    expect(callbacks.stepOver).not.toHaveBeenCalled();
    expect(callbacks.stepInto).not.toHaveBeenCalled();
    expect(callbacks.stepOut).not.toHaveBeenCalled();
    expect(callbacks.stop).not.toHaveBeenCalled();
  });

  it("does not expose the forbidden lifecycle-reset command", () => {
    const callbacks = handlers();
    const forbiddenId = ["keiko.editor.debug", "Re", "start"].join("");
    expect(
      buildDebugCommandActionDescriptors({ keys: KEYS, handlers: callbacks }).map(
        (item) => item.id,
      ),
    ).not.toContain(forbiddenId);
  });
});
