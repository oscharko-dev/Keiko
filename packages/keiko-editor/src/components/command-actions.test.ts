import { describe, expect, it } from "vitest";

import { EDITOR_COMMAND_KEYBINDINGS, MONACO_BUILTIN_ACTION_IDS } from "./command-actions.js";

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
});
