import { Selection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownDocumentState } from "../composer/composer-editor-state";
import {
  blockStyle,
  blockStyleCommand,
  codeBlockCommand,
  historyAvailable,
  markActive,
  type MarkdownBlockStyle,
  redoCommand,
  toggleMarkCommand,
  toggleWrapCommand,
  undoCommand,
  wrapActive,
} from "./markdown-editor-commands";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./markdown-document";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

function stateFor(markdown: string): EditorState {
  const state = createMarkdownDocumentState(
    parseMarkdownDocument(markdown),
    100_000,
    () => undefined,
    serializeMarkdownDocument,
  );
  return state.apply(
    state.tr.setSelection(
      TextSelection.between(Selection.atStart(state.doc).$from, Selection.atEnd(state.doc).$to),
    ),
  );
}

function cursorIn(markdown: string): EditorState {
  const state = stateFor(markdown);
  return state.apply(state.tr.setSelection(Selection.atEnd(state.doc)));
}

function run(
  state: EditorState,
  command: Command,
): { readonly state: EditorState; readonly applied: boolean } {
  let next = state;
  const applied = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { state: next, applied };
}

function markdown(state: EditorState): string {
  return serializeMarkdownDocument(state.doc);
}

describe("markdown editor commands", () => {
  it("toggles a mark on a selection and reports it active", () => {
    const state = stateFor("hello");
    expect(markActive(state, "strong")).toBe(false);
    const bold = run(state, toggleMarkCommand("strong"));
    expect(bold.applied).toBe(true);
    expect(markdown(bold.state)).toBe("**hello**");
    expect(markActive(bold.state, "strong")).toBe(true);
    expect(markdown(run(bold.state, toggleMarkCommand("strong")).state)).toBe("hello");
  });

  it("uses stored marks for an empty selection", () => {
    const state = cursorIn("hello");
    expect(markActive(state, "em")).toBe(false);
    const toggled = run(state, toggleMarkCommand("em")).state;
    expect(markActive(toggled, "em")).toBe(true);
    expect(markActive(toggled, "code")).toBe(false);
  });

  it("applies inline code", () => {
    expect(markdown(run(stateFor("x"), toggleMarkCommand("code")).state)).toBe("`x`");
  });

  it("reports and sets the block style", () => {
    const state = stateFor("text");
    expect(blockStyle(state)).toBe("paragraph");
    for (const level of [1, 2, 3] as const) {
      const style = `heading-${String(level)}` as MarkdownBlockStyle;
      const heading = run(state, blockStyleCommand(style)).state;
      expect(blockStyle(heading)).toBe(style);
      expect(markdown(heading)).toBe(`${"#".repeat(level)} text`);
      expect(blockStyle(run(heading, blockStyleCommand("paragraph")).state)).toBe("paragraph");
    }
  });

  it("reports other for a heading level above three and a code block", () => {
    expect(blockStyle(stateFor("#### four"))).toBe("other");
    expect(blockStyle(stateFor("```\ncode\n```"))).toBe("other");
  });

  it("wraps and unwraps bullet lists, ordered lists and quotes", () => {
    for (const [name, text] of [
      ["bullet_list", "* a"],
      ["ordered_list", "1. a"],
      ["blockquote", "> a"],
    ] as const) {
      const base = stateFor("a");
      expect(wrapActive(base, name)).toBe(false);
      const wrapped = run(base, toggleWrapCommand(name));
      expect(wrapped.applied).toBe(true);
      expect(markdown(wrapped.state)).toBe(text);
      expect(wrapActive(wrapped.state, name)).toBe(true);
      const unwrapped = run(wrapped.state, toggleWrapCommand(name)).state;
      expect(markdown(unwrapped)).toBe("a");
      expect(wrapActive(unwrapped, name)).toBe(false);
    }
  });

  it("reports only the innermost wrapper as active", () => {
    const state = cursorIn("> * a");
    expect(wrapActive(state, "bullet_list")).toBe(true);
    expect(wrapActive(state, "blockquote")).toBe(false);
    expect(wrapActive(cursorIn("1. a"), "bullet_list")).toBe(false);
  });

  it("turns a paragraph into a code block", () => {
    const result = run(stateFor("const a = 1;"), codeBlockCommand);
    expect(result.applied).toBe(true);
    expect(result.state.doc.firstChild?.type.name).toBe("code_block");
  });

  it("undoes and redoes and reports availability", () => {
    const state = stateFor("hello");
    expect(historyAvailable(state)).toEqual({ undo: false, redo: false });
    expect(run(state, undoCommand).applied).toBe(false);
    const bold = run(state, toggleMarkCommand("strong")).state;
    expect(historyAvailable(bold)).toEqual({ undo: true, redo: false });
    const undone = run(bold, undoCommand).state;
    expect(markdown(undone)).toBe("hello");
    expect(historyAvailable(undone)).toEqual({ undo: false, redo: true });
    expect(markdown(run(undone, redoCommand).state)).toBe("**hello**");
  });
});
