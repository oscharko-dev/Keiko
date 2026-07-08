import { describe, expect, it, vi } from "vitest";

import {
  buildRenameSymbolActionDescriptor,
  buildRenameSymbolKeybinding,
  EDITOR_RENAME_SYMBOL_ACTION_ID,
  EDITOR_RENAME_SYMBOL_ACTION_LABEL,
} from "./rename-bridge.js";

describe("buildRenameSymbolKeybinding", () => {
  it("binds Rename Symbol to F2 without modifiers", () => {
    expect(buildRenameSymbolKeybinding({ KeyCode: { F2: 60 } })).toBe(60);
  });
});

describe("buildRenameSymbolActionDescriptor", () => {
  it("builds a host-owned Monaco action descriptor", () => {
    const run = vi.fn();
    const descriptor = buildRenameSymbolActionDescriptor({
      keys: { KeyCode: { F2: 60 } },
      run,
    });
    expect(descriptor.id).toBe(EDITOR_RENAME_SYMBOL_ACTION_ID);
    expect(descriptor.label).toBe(EDITOR_RENAME_SYMBOL_ACTION_LABEL);
    expect(descriptor.keybindings).toEqual([60]);
    expect(descriptor.contextMenuGroupId).toBe("1_modification");
    const editor = {} as Parameters<typeof descriptor.run>[0];
    void descriptor.run(editor);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
