import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import { ComposerEditorController } from "./composer-editor-controller";
import { MarkdownComposer } from "./MarkdownComposer";
import { parseComposerMarkdown, serializeComposerMarkdown } from "./composer-markdown";
import { composerEnterSubmits } from "./ComposerShell";
import type { ComposerInputHandle, MarkdownComposerProps } from "./composer-editor-types";

vi.mock("./composer-code-runtime", () => ({
  mountComposerCode: (): Promise<never> => new Promise(() => undefined),
}));

const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: diagnostics.report }));

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
  diagnostics.report.mockClear();
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
  it("retains the code input and focus when detecting or changing its language", () => {
    const { editor } = setup("```\n\n```");
    const input = screen.getByRole("textbox", { name: "Code" });
    input.focus();
    fireEvent.input(input, { target: { value: "export interface Probe { count: number; }" } });
    expect(screen.getByRole("textbox", { name: "Code" })).toBe(input);
    expect(input).toHaveFocus();
    fireEvent.change(screen.getByRole("combobox", { name: "Code language" }), {
      target: { value: "plaintext" },
    });
    expect(screen.getByRole("textbox", { name: "Code" })).toBe(input);
  });
  it("detects unlabelled TypeScript and preserves a manual plain-text choice", () => {
    const { editor } = setup("```\nexport interface Probe { readonly count: number; }\n```");
    const language = screen.getByRole("combobox", { name: "Code language" });
    expect(language).toHaveValue("typescript");
    fireEvent.change(language, { target: { value: "plaintext" } });
    expect(screen.getByRole("combobox", { name: "Code language" })).toHaveValue("plaintext");
    expect(serializeComposerMarkdown(editor.view.state.doc)).toContain("```plaintext");
  });
  it("describes keyboard help without adding a permanent instruction row to the input", () => {
    const { editor } = setup();
    expect(editor.view.dom).toHaveAttribute("aria-description", labels.hint);
  });
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

  it.each([
    "SELECT * FROM t WHERE a * b > 3",
    "2 * 3 * 4",
    "rm -rf **/node_modules and **/dist",
    "x ** 2 + y ** 2",
    "delete all *.js and *.ts files",
    "SELECT COUNT(*) FROM t WHERE x * 2 > y",
    "`a * b * c`",
    "`*literal*`",
  ])("keeps literal punctuation through the actual typing rules: %s", (value) => {
    const { editor, config } = setup();
    type(editor, value);
    expect(serializeComposerMarkdown(editor.view.state.doc)).toBe(value);
    expect(vi.mocked(config.onChange).mock.lastCall?.[0]).toBe(value);
  });

  it("keeps typed literal repository paths and mention offsets", () => {
    const value = "@src/__tests__/file.ts C:\\temp\\[1] 2 * 3 * 4";
    const { editor, config } = setup();
    type(editor, value);
    expect(config.onChange).toHaveBeenLastCalledWith(value, value.length);
    for (let offset = 0; offset <= value.length; offset += 1) {
      editor.setSelectionRange(offset, offset);
      expect(editor.selectionStart).toBe(offset);
    }
  });

  it.each([
    ["```ts\ncode\n```", "```ts\ncode\n``` explain this"],
    ["**bold @sr**", "**bold @src/a.ts **"],
    ["* first @src/a.ts\n* second  item", "* first\n* second item"],
  ])(
    "keeps external edits to formatted drafts equal to the submitted value: %s",
    (initial, value) => {
      const { editor, config } = setup(initial);
      for (let render = 0; render < 3; render += 1) {
        editor.update({ ...config, value });
        expect(serializeComposerMarkdown(editor.view.state.doc)).toBe(value);
      }
      editor.setSelectionRange(value.length, value.length);
      type(editor, "!");
      expect(vi.mocked(config.onChange).mock.lastCall?.[0]).toBe(value + "!");
    },
  );

  it("keeps displayed link destinations outside the editable content", () => {
    const value = '[the docs](https://example.com/x "visible title")';
    const { editor } = setup(value);
    const destination = editor.view.dom.querySelector("[data-markdown-destination]");
    expect(destination?.getAttribute("contenteditable")).toBe("false");
    expect(destination?.textContent).toContain('https://example.com/x "visible title"');
    editor.view.dispatch(editor.view.state.tr.delete(1, 9));
    expect(serializeComposerMarkdown(editor.view.state.doc)).toBe("");
    expect(editor.view.dom.querySelector("[data-markdown-destination]")).toBeNull();
  });

  it.each(["image/png", "application/pdf"])(
    "leaves selected text intact for a %s-only paste",
    (mime) => {
      const { editor, config } = setup("keep this text");
      editor.view.dispatch(
        editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 6, 10)),
      );
      fireEvent.paste(editor.view.dom, {
        clipboardData: {
          types: [mime],
          getData: () => "",
          files: [new File(["fixture"], "file", { type: mime })],
        },
      });
      expect(serializeComposerMarkdown(editor.view.state.doc)).toBe("keep this text");
      expect(config.onChange).not.toHaveBeenCalled();
      expect(diagnostics.report).toHaveBeenCalledWith(
        "Keiko composer non-text clipboard left unchanged.",
        { composerActivity: "non-text-paste-ignored" },
      );
    },
  );

  it.each([
    ["# Hello world", "ello"],
    ["* item", "ite"],
    ["> quote", "uote"],
  ])("copies a partial block without unselected wrappers: %s", (source, selected) => {
    const { editor } = setup(source);
    let from = 0;
    editor.view.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.includes(selected))
        from = position + node.text.indexOf(selected);
    });
    editor.view.dispatch(
      editor.view.state.tr.setSelection(
        TextSelection.create(editor.view.state.doc, from, from + selected.length),
      ),
    );
    const setData = vi.fn();
    fireEvent.copy(editor.view.dom, { clipboardData: { clearData: vi.fn(), setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", selected);
    expect(diagnostics.report).toHaveBeenCalledWith("Keiko composer selection copied.", {
      composerActivity: "text-copied",
    });
  });

  it("copies a fully selected block with its Markdown syntax", () => {
    const { editor } = setup("# Hello world");
    editor.view.dispatch(
      editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, 0)),
    );
    const setData = vi.fn();
    fireEvent.copy(editor.view.dom, { clipboardData: { clearData: vi.fn(), setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "# Hello world");
  });

  it("reports preserved punctuation and resynchronized drafts as routine activity", () => {
    const { editor } = setup();
    type(editor, "2 * 3 * 4");
    expect(diagnostics.report).toHaveBeenCalledWith(
      "Keiko composer literal punctuation preserved.",
      { composerActivity: "literal-input-preserved" },
    );
    const formatted = setup("```ts\ncode\n```");
    formatted.editor.update({ ...formatted.config, value: "```ts\ncode\n``` explain this" });
    expect(diagnostics.report).toHaveBeenCalledWith(
      "Keiko composer external draft resynchronized.",
      { composerActivity: "draft-resynchronized" },
    );
  });

  it("reports initialization through the routine activity producer", () => {
    setup();
    expect(diagnostics.report).toHaveBeenCalledWith("Keiko Markdown composer initialized.", {
      composerActivity: "initialized",
      composerFocusIndicator: "keyboard",
    });
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
      expect(diagnostics.report).toHaveBeenCalledWith("Keiko composer block formatting removed.", {
        composerActivity: "format-removed",
      });
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
      expect(diagnostics.report).toHaveBeenCalledWith("Keiko composer block formatting removed.", {
        composerActivity: "format-removed",
      });
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
    expect(diagnostics.report).toHaveBeenCalledWith(
      "Keiko Markdown composer input limit reached.",
      { composerActivity: "input-limit" },
    );
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
