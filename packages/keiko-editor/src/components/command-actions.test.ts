import { describe, expect, it, vi } from "vitest";

import {
  buildAskKeikoAboutSelectionActionDescriptor,
  buildAskKeikoAboutSelectionKeybinding,
  buildAskKeikoAboutSelectionRunHandler,
  buildGenerateTestsActionDescriptor,
  buildGenerateTestsKeybinding,
  EDITOR_COMMAND_KEYBINDINGS,
  EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_ID,
  EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_LABEL,
  EDITOR_GENERATE_TESTS_ACTION_ID,
  EDITOR_GENERATE_TESTS_ACTION_LABEL,
  MONACO_BUILTIN_ACTION_IDS,
  type AskKeikoAboutSelectionCommandActionKeys,
  type CommandActionKeys,
} from "./command-actions.js";

// Monaco's real bit values (KeyMod is a high-bit flag set; KeyCode is a small enum), so the OR is a
// faithful, non-overlapping composition.
const KEYS: CommandActionKeys = {
  KeyMod: { CtrlCmd: 2048, Alt: 512 },
  KeyCode: { KeyT: 53 },
};

const ASK_KEYS: AskKeikoAboutSelectionCommandActionKeys = {
  KeyMod: { CtrlCmd: 2048, Alt: 512 },
  KeyCode: { KeyK: 41 },
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

describe("buildAskKeikoAboutSelectionKeybinding", () => {
  it("packs Cmd/Ctrl+Alt+K without changing the Generate Tests chord", () => {
    expect(buildAskKeikoAboutSelectionKeybinding(ASK_KEYS)).toBe(2048 | 512 | 41);
    expect(buildGenerateTestsKeybinding(KEYS)).toBe(2048 | 512 | 53);
  });
});

describe("buildAskKeikoAboutSelectionActionDescriptor", () => {
  it("builds a selection-gated palette and context-menu action", () => {
    const run = vi.fn();
    const descriptor = buildAskKeikoAboutSelectionActionDescriptor({ keys: ASK_KEYS, run });
    expect(descriptor).toMatchObject({
      id: EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_ID,
      label: EDITOR_ASK_KEIKO_ABOUT_SELECTION_ACTION_LABEL,
      keybindings: [buildAskKeikoAboutSelectionKeybinding(ASK_KEYS)],
      precondition: "editorHasSelection",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 3,
    });
    const editor = {} as Parameters<typeof descriptor.run>[0];
    void descriptor.run(editor);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(editor);
  });
});

describe("buildAskKeikoAboutSelectionRunHandler", () => {
  it("captures only the live selected range and converts it to the public payload", () => {
    const selection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 4,
      endColumn: 6,
      isEmpty: (): boolean => false,
    };
    const getValueInRange = vi.fn(() => "selected text");
    const onAsk = vi.fn();
    const run = buildAskKeikoAboutSelectionRunHandler(onAsk);

    run({
      getSelection: () => selection,
      getModel: () => ({ getValueInRange }),
    } as never);

    expect(getValueInRange).toHaveBeenCalledOnce();
    expect(getValueInRange).toHaveBeenCalledWith(selection);
    expect(onAsk).toHaveBeenCalledWith({
      textMode: "selection",
      range: {
        start: { line: 1, column: 2 },
        end: { line: 3, column: 5 },
      },
      text: "selected text",
    });
  });

  it("does not read a model or invoke the host when the selection is empty", () => {
    const getModel = vi.fn();
    const onAsk = vi.fn();
    const run = buildAskKeikoAboutSelectionRunHandler(onAsk);

    run({
      getSelection: () => ({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
        isEmpty: (): boolean => true,
      }),
      getModel,
    } as never);

    expect(getModel).not.toHaveBeenCalled();
    expect(onAsk).not.toHaveBeenCalled();
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

  it("binds Ask Keiko to Cmd/Ctrl+Alt+K to match the registered chord", () => {
    expect(EDITOR_COMMAND_KEYBINDINGS["editor.askKeikoAboutSelection"]).toEqual({
      mac: "⌘⌥K",
      pc: "Ctrl+Alt+K",
    });
  });
});
