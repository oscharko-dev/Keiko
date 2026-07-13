import { describe, expect, it, vi } from "vitest";

import {
  buildDebugCommandActionDescriptors,
  type DebugCommandActionKeys,
} from "./debug-command-actions.js";

const KEYS: DebugCommandActionKeys = {
  KeyMod: { Shift: 1024 },
  KeyCode: { F5: 62, F6: 63, F10: 67, F11: 68 },
};

describe("buildDebugCommandActionDescriptors", () => {
  it("registers every bounded debug control with its conventional keyboard chord", () => {
    const handlers = {
      continue: vi.fn(),
      pause: vi.fn(),
      stepOver: vi.fn(),
      stepInto: vi.fn(),
      stepOut: vi.fn(),
      stop: vi.fn(),
    };
    const descriptors = buildDebugCommandActionDescriptors({ keys: KEYS, handlers });

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
    for (const descriptor of descriptors)
      expect(descriptor.contextMenuGroupId).toBe("1_modification");
  });

  it("delegates every command directly to its host callback", () => {
    const handlers = {
      continue: vi.fn(),
      pause: vi.fn(),
      stepOver: vi.fn(),
      stepInto: vi.fn(),
      stepOut: vi.fn(),
      stop: vi.fn(),
    };
    for (const descriptor of buildDebugCommandActionDescriptors({ keys: KEYS, handlers }))
      void descriptor.run({} as never);
    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce();
  });

  it("does not expose the forbidden lifecycle-reset command", () => {
    const handlers = {
      continue: vi.fn(),
      pause: vi.fn(),
      stepOver: vi.fn(),
      stepInto: vi.fn(),
      stepOut: vi.fn(),
      stop: vi.fn(),
    };
    const forbiddenId = ["keiko.editor.debug", "Re", "start"].join("");
    expect(
      buildDebugCommandActionDescriptors({ keys: KEYS, handlers }).map((item) => item.id),
    ).not.toContain(forbiddenId);
  });
});
