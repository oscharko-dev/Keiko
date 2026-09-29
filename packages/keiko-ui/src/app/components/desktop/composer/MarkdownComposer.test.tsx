import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { ComposerEditorController } from "./composer-editor-controller";
import { MarkdownComposer } from "./MarkdownComposer";
import { parseComposerMarkdown } from "./composer-markdown";
import { composerEnterSubmits } from "./ComposerShell";
import type { ComposerInputHandle, MarkdownComposerProps } from "./composer-editor-types";

vi.mock("./composer-code-runtime", () => ({
  mountComposerCode: (): Promise<never> => new Promise(() => undefined),
}));

const labels = {
  code: "Code",
  plainText: "Plain text",
  language: "Code language",
  continueText: "Continue below",
  loading: "Loading",
  unavailable: "Unavailable",
  limit: "Message too long",
  hint: "Markdown supported",
};
function props(value = ""): MarkdownComposerProps {
  return {
    value,
    placeholder: "Ask",
    ariaLabel: "Message",
    maxLength: 10000,
    documentKey: "chat-1",
    inputRef: createRef<ComposerInputHandle>(),
    labels,
    onChange: vi.fn(),
    onSelect: vi.fn(),
    onKeyDown: vi.fn(),
  };
}
const editors: ComposerEditorController[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function setup(
  value = "",
  overrides: Partial<MarkdownComposerProps> = {},
): {
  editor: ComposerEditorController;
  config: MarkdownComposerProps;
  notice: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const config = { ...props(value), ...overrides };
  const notice = vi.fn();
  const editor = new ComposerEditorController(host, config, notice);
  editors.push(editor);
  editor.view.focus();
  editor.view.dispatch(
    editor.view.state.tr.setSelection(TextSelection.atEnd(editor.view.state.doc)),
  );
  return { editor, config, notice };
}

function type(editor: ComposerEditorController, value: string): void {
  for (const text of value) {
    const { view } = editor;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, from, to, text, () => view.state.tr.insertText(text)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(text));
  }
}

describe("Markdown composer editing", () => {
  it("preserves unfenced plain clipboard text and every newline without Markdown rewriting", () => {
    const value =
      'C:\\temp\\[report]\\__tests__\\file.ts\nconst amount = 42;\n  run(amount);\n\n{"path":"C:\\\\temp","items":["*", "_"]}\n';
    const { editor, config } = setup();
    fireEvent.paste(editor.view.dom, {
      clipboardData: { getData: (kind: string) => (kind === "text/plain" ? value : ""), files: [] },
    });
    expect(config.onChange).toHaveBeenLastCalledWith(value, value.length);
    expect(editor.view.dom.querySelector("strong")).toBeNull();
  });

  it("applies external mentions and dictated text literally while retaining existing formatting", () => {
    const { editor, config } = setup("# Review");
    const value = "# Review\n\n@src/__tests__/file.ts ";
    editor.update({ ...config, value });
    editor.setSelectionRange(value.length, value.length);
    type(editor, "weiter");
    expect(config.onChange).toHaveBeenLastCalledWith(value + "weiter", value.length + 6);
    expect(editor.view.dom.querySelector("h1")?.textContent).toBe("Review");
    expect(editor.view.dom.querySelector("strong")).toBeNull();
    const dictated = value + "weiter\n  literal * [value] \\path";
    editor.update({ ...config, value: dictated });
    editor.setSelectionRange(dictated.length, dictated.length);
    type(editor, "!");
    expect(config.onChange).toHaveBeenLastCalledWith(dictated + "!", dictated.length + 1);
  });

  it("restores raw draft paths, newlines and trailing spaces without reinterpretation", () => {
    const value = "C:\\temp\\[report]\\__tests__\\file.ts\n  indented\n";
    const { editor, config } = setup(value);
    type(editor, "next");
    expect(config.onChange).toHaveBeenLastCalledWith(value + "next", value.length + 4);
    expect(editor.view.dom.querySelector("strong")).toBeNull();
  });

  it("keeps typed literal punctuation in the outgoing prompt and repository mention offsets", () => {
    const value = "@src/__tests__/file.ts C:\\temp\\[1] *literal*";
    const { editor, config } = setup();
    editor.view.dispatch(editor.view.state.tr.insertText(value));
    expect(config.onChange).toHaveBeenLastCalledWith(value, value.length);
    for (let offset = 0; offset <= value.length; offset += 1) {
      editor.setSelectionRange(offset, offset);
      expect(editor.selectionStart).toBe(offset);
    }
  });

  it.each(["> ```typescript\n> const x = 1;\n> ```", "* ```typescript\n  const x = 1;\n  ```"])(
    "continues outside the enclosing quote or list after a final code block: %s",
    (value) => {
      const { editor, config } = setup(value);
      fireEvent.click(screen.getByRole("button", { name: "Continue below" }));
      type(editor, "Ordinary prose");
      expect(editor.view.state.selection.$from.depth).toBe(1);
      expect(editor.view.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(config.onChange).toHaveBeenLastCalledWith(
        expect.stringContaining("\n\nOrdinary prose"),
        expect.any(Number),
      );
    },
  );

  it("does not strip a nonempty heading when Delete is pressed at its start", () => {
    const { editor } = setup("# Title");
    editor.view.dispatch(
      editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1)),
    );
    expect(
      editor.view.someProp("handleKeyDown", (handler) =>
        handler(editor.view, new KeyboardEvent("keydown", { key: "Delete" })),
      ),
    ).not.toBe(true);
    expect(editor.view.state.doc.firstChild?.type.name).toBe("heading");
  });
  it.each(["> Hallo", "* Hallo", "1. Hallo"])(
    "removes empty quote/list formatting from %s before deleting neighbouring text",
    (source) => {
      const { editor } = setup(source);
      const { $from } = editor.view.state.selection;
      editor.view.dispatch(editor.view.state.tr.delete($from.start(), $from.end()));
      fireEvent.keyDown(editor.view.dom, { key: "Backspace" });
      expect(editor.view.state.doc.firstChild?.type.name).toBe("paragraph");
      type(editor, "Normal");
      expect(editor.view.state.doc.textContent).toBe("Normal");
    },
  );

  it("removes an empty code block with Backspace and restores the normal composer", () => {
    const { editor, config } = setup();
    type(editor, "```");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Code" }), { key: "Backspace" });
    expect(editor.view.dom.querySelector("[data-composer-code]")).toBeNull();
    expect(editor.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(config.onChange).toHaveBeenLastCalledWith("", 0);
    expect(editor.view.dom).toHaveFocus();
  });

  it("keeps a typed at-sign inside code literal instead of opening repository suggestions", () => {
    const { editor, config } = setup();
    type(editor, "```");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    fireEvent.input(screen.getByRole("textbox", { name: "Code" }), {
      target: { value: "@decorator" },
    });
    expect(config.onChange).toHaveBeenLastCalledWith("```\n@decorator\n```", -1);
  });

  it.each(["#", "##", "###", "####", "#####", "######"])(
    "removes %s formatting with one more Backspace after the last letter",
    (heading) => {
      const { editor, config } = setup(`${heading} Hallo`);
      editor.view.dispatch(editor.view.state.tr.delete(1, 6));
      expect(editor.view.state.doc.firstChild?.type.name).toBe("heading");
      fireEvent.keyDown(editor.view.dom, { key: "Backspace" });
      expect(editor.view.state.doc.firstChild?.type.name).toBe("paragraph");
      type(editor, "Normal");
      expect(config.onChange).toHaveBeenLastCalledWith("Normal", 6);
    },
  );

  it("renders headings, marks and lists while typing and emits semantic Markdown", () => {
    const { editor, config } = setup();
    type(editor, "# Review");
    expect(editor.view.dom.querySelector("h1")?.textContent).toBe("Review");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    type(editor, "**bold** and `inline`");
    expect(editor.view.dom.querySelector("strong")?.textContent).toBe("bold");
    expect(editor.view.dom.querySelector("code")?.textContent).toBe("inline");
    expect(config.onChange).toHaveBeenLastCalledWith(
      "# Review\n\n**bold** and `inline`",
      expect.any(Number),
    );
  });

  it("opens code with three backticks and Shift+Enter, preserves code and continues below", () => {
    const { editor, config } = setup();
    type(editor, "```typescript");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    const code = screen.getByRole("textbox", { name: "Code" });
    expect(code).toHaveFocus();
    fireEvent.change(code, { target: { value: 'const greeting = "Grüße";\n  run();' } });
    fireEvent.input(code);
    fireEvent.click(screen.getByRole("button", { name: "Continue below" }));
    type(editor, "Explain this.");
    expect(config.onChange).toHaveBeenLastCalledWith(
      '```typescript\nconst greeting = "Grüße";\n  run();\n```\n\nExplain this.',
      expect.any(Number),
    );
    expect(editor.view.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("does not submit inside code or while confirming IME composition", () => {
    const send = vi.fn();
    const { editor } = setup("", {
      onKeyDown: (event) => {
        if (composerEnterSubmits(event)) send();
      },
    });
    fireEvent.keyDown(editor.view.dom, { key: "Enter", isComposing: true });
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    type(editor, "```");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Code" }), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue below" }));
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("shares undo/redo between prose and code and restores a fence gesture", () => {
    const { editor } = setup();
    type(editor, "```");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    const code = screen.getByRole("textbox", { name: "Code" });
    fireEvent.input(code, { target: { value: "hello" } });
    expect(editor.view.state.doc.firstChild?.textContent).toBe("hello");
    undo(editor.view.state, editor.view.dispatch);
    expect(editor.view.state.doc.textContent).not.toContain("hello");
    redo(editor.view.state, editor.view.dispatch);
    expect(editor.view.state.doc.firstChild?.textContent).toBe("hello");
  });

  it("rejects oversize edits atomically instead of truncating code", () => {
    const { editor, notice } = setup("safe", { maxLength: 8 });
    editor.view.dispatch(editor.view.state.tr.insertText("too long", 1, 1));
    expect(editor.view.state.doc.textContent).toBe("safe");
    expect(notice).toHaveBeenCalledWith("Message too long");
  });

  it("pastes plain Markdown with literal HTML and no remote images", () => {
    const { editor, config } = setup();
    fireEvent.paste(editor.view.dom, {
      clipboardData: {
        types: ["text/markdown", "text/plain"],
        getData: (type: string) =>
          type === "text/markdown" || type === "text/plain"
            ? "# Review\n\n<script>bad()</script>\n\n![alt](https://example.com/a.png)"
            : "<b>ignored</b>",
        files: [],
      },
    });
    expect(editor.view.dom.querySelector("h1")?.textContent).toBe("Review");
    expect(editor.view.dom.querySelector("img[src], script, a[href]")).toBeNull();
    expect(editor.view.state.doc.textContent).toContain("<script>bad()</script>");
    expect(config.onChange).toHaveBeenCalled();
  });

  it("preserves long pasted code blocks, tabs, Unicode and literal Markdown through serialization", () => {
    const code = Array.from(
      { length: 120 },
      (_, index) => `\tconst row${index} = "Grüße <div> # **";`,
    ).join("\n");
    const second = "print('next block')\n\t# keep indentation";
    const markdown = `# Review\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nContinue here.\n\n\`\`\`python\n${second}\n\`\`\``;
    const { editor, config } = setup();
    fireEvent.paste(editor.view.dom, {
      clipboardData: { types: ["text/markdown", "text/plain"], getData: () => markdown, files: [] },
    });
    const serialized = vi.mocked(config.onChange).mock.lastCall?.[0] ?? "";
    const document = parseComposerMarkdown(serialized);
    expect(document.child(1).textContent).toBe(code);
    expect(document.child(3).textContent).toBe(second);
    expect(editor.view.dom.querySelectorAll("[data-composer-code]")).toHaveLength(2);
    expect(editor.view.dom.querySelectorAll("h1")).toHaveLength(1);
  });

  it("keeps draft changes through rerenders and resets history on chat switches", () => {
    const config = props("# First");
    const rendered = render(<MarkdownComposer {...config} />);
    expect(screen.getByRole("heading", { name: "First" })).toBeVisible();
    const first = config.inputRef.current;
    if (!(first instanceof ComposerEditorController)) throw new TypeError("Missing composer");
    type(first, "Changed ");
    rendered.rerender(<MarkdownComposer {...config} value="**Second**" documentKey="chat-2" />);
    expect(screen.queryByRole("heading", { name: "First" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent("Second");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), {
      key: "z",
      ctrlKey: true,
    });
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent("Second");
    act(() => config.inputRef.current?.setSelectionRange(4, 4));
  });
});
