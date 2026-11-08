import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import type { MarkdownDocumentController } from "./markdown-document-controller";

vi.mock("../composer/composer-code-runtime", () => ({
  mountComposerCode: (): Promise<never> => new Promise(() => undefined),
}));

const controllers = vi.hoisted(() => [] as MarkdownDocumentController[]);
vi.mock("./markdown-document-controller", async (importOriginal) => {
  const original = await importOriginal<typeof import("./markdown-document-controller")>();
  class Recording extends original.MarkdownDocumentController {
    constructor(...args: ConstructorParameters<typeof original.MarkdownDocumentController>) {
      super(...args);
      controllers.push(this);
    }
  }
  return { ...original, MarkdownDocumentController: Recording };
});

const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: diagnostics.report }));

afterEach(() => {
  controllers.length = 0;
  diagnostics.report.mockClear();
  vi.restoreAllMocks();
});

function selectedText(): string {
  const { state } = editorView();
  return state.doc.textBetween(state.selection.from, state.selection.to);
}

interface HarnessProps {
  readonly initial: string;
  readonly documentKey?: string;
  readonly onChange?: (value: string) => void;
  readonly selectTitleOnOpen?: boolean;
}

function Harness({
  initial,
  documentKey = "doc-1",
  onChange,
  selectTitleOnOpen,
}: HarnessProps): ReactNode {
  const [value, setValue] = useState(initial);
  return (
    <main>
      <MarkdownEditor
        value={value}
        documentKey={documentKey}
        ariaLabel="Prompt"
        placeholder="Write here"
        maxLength={50_000}
        {...(selectTitleOnOpen === undefined ? {} : { selectTitleOnOpen })}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </main>
  );
}

function activities(): string[] {
  return diagnostics.report.mock.calls.map(
    (call) => (call[1] as { composerActivity?: string } | undefined)?.composerActivity ?? "",
  );
}

function editorView(): EditorView {
  const controller = controllers.at(-1);
  if (controller === undefined) throw new TypeError("No formatted view was opened");
  return controller.view;
}

function viewButton(name: string): HTMLButtonElement {
  return within(screen.getByRole("group", { name: "View" })).getByRole("button", {
    name,
  });
}

describe("MarkdownEditor", () => {
  it("keeps the formatted document a single keyboard stop inside its scrolling page", () => {
    render(<Harness initial="text" />);
    const textbox = screen.getByRole("textbox", { name: "Prompt" });
    expect(textbox.getAttribute("tabindex")).toBe("0");
    expect(textbox.parentElement?.hasAttribute("tabindex")).toBe(false);
  });

  it("opens formatted by default with the toolbar", () => {
    render(<Harness initial={"# Title\n\ntext"} />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    expect(viewButton("Formatted").getAttribute("aria-pressed")).toBe("true");
    expect(viewButton("Formatted").disabled).toBe(false);
    expect(activities()).not.toContain("markdown-rich-unavailable");
  });

  it("falls back to source only for GFM tables, with a notice and one diagnostic", () => {
    const { rerender } = render(<Harness initial={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    expect(viewButton("Formatted").disabled).toBe(true);
    expect(viewButton("Markdown").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toBe("");
    expect(activities().filter((a) => a === "markdown-rich-unavailable")).toHaveLength(1);
    rerender(<Harness initial={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    expect(activities().filter((a) => a === "markdown-rich-unavailable")).toHaveLength(1);
  });

  it.each(["- [ ] todo", "a ~~b~~", "x <b>y</b>"])("keeps %s in source", (body) => {
    render(<Harness initial={body} />);
    expect(viewButton("Formatted").disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: /Markdown/u }) as HTMLTextAreaElement).value).toBe(
      body,
    );
  });

  it("reports one diagnostic per new source-only document", () => {
    const { rerender } = render(
      <MarkdownEditor
        value="a ~~b~~"
        documentKey="one"
        ariaLabel="Prompt"
        maxLength={1000}
        onChange={() => undefined}
      />,
    );
    rerender(
      <MarkdownEditor
        value="c ~~d~~"
        documentKey="two"
        ariaLabel="Prompt"
        maxLength={1000}
        onChange={() => undefined}
      />,
    );
    expect(activities().filter((a) => a === "markdown-rich-unavailable")).toHaveLength(2);
  });

  it("switches views without calling onChange and reports a diagnostic each time", () => {
    const onChange = vi.fn();
    render(<Harness initial={"# Title"} onChange={onChange} />);
    fireEvent.click(viewButton("Markdown"));
    expect((screen.getByRole("textbox", { name: /Markdown/u }) as HTMLTextAreaElement).value).toBe(
      "# Title",
    );
    fireEvent.click(viewButton("Split"));
    expect(screen.getByRole("region", { name: "Preview" })).toBeTruthy();
    fireEvent.click(viewButton("Formatted"));
    expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(activities().filter((a) => a === "markdown-view-changed")).toHaveLength(3);
    // Choosing the active view again is not a change.
    fireEvent.click(viewButton("Formatted"));
    expect(activities().filter((a) => a === "markdown-view-changed")).toHaveLength(3);
  });

  it("calls onChange when typing in source view and keeps the front matter", () => {
    const onChange = vi.fn();
    render(<Harness initial={"---\nname: a\n---\n\nbody"} onChange={onChange} />);
    fireEvent.click(viewButton("Markdown"));
    fireEvent.change(screen.getByRole("textbox", { name: /Markdown/u }), {
      target: { value: "new body" },
    });
    expect(onChange).toHaveBeenLastCalledWith("---\nname: a\n---\n\nnew body");
  });

  it("preserves the body when the front matter is edited", () => {
    const onChange = vi.fn();
    render(<Harness initial={"---\nname: a\n---\n\nbody"} onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Metadata (YAML)" }), {
      target: { value: "name: b\nversion: 2" },
    });
    expect(onChange).toHaveBeenLastCalledWith("---\nname: b\nversion: 2\n---\n\nbody");
  });

  it("shows no metadata field without front matter", () => {
    render(<Harness initial="body" />);
    expect(screen.queryByText("Metadata (YAML)")).toBeNull();
  });

  it("shows the line count of the front matter", () => {
    render(<Harness initial={"---\na: 1\nb: 2\n---\nbody"} />);
    expect(screen.getByText("2 lines")).toBeTruthy();
  });

  it("opens a new document with its own view when the key changes", () => {
    const { rerender } = render(
      <MarkdownEditor
        value="a ~~b~~"
        documentKey="one"
        ariaLabel="Prompt"
        maxLength={1000}
        onChange={() => undefined}
      />,
    );
    expect(viewButton("Markdown").getAttribute("aria-pressed")).toBe("true");
    rerender(
      <MarkdownEditor
        value="plain"
        documentKey="two"
        ariaLabel="Prompt"
        maxLength={1000}
        onChange={() => undefined}
      />,
    );
    expect(viewButton("Formatted").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Prompt" }).textContent).toBe("plain");
  });

  it("applies the Bold toolbar button to the selection and reports the Markdown", () => {
    const onChange = vi.fn();
    render(<Harness initial="hello" onChange={onChange} />);
    const view = editorView();
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    });
    const bold = screen.getByRole("button", { name: /Bold/u });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      fireEvent.click(bold);
    });
    expect(onChange).toHaveBeenLastCalledWith("**hello**");
    expect(screen.getByRole("button", { name: /Bold/u }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: /Undo/u }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("starts a new block on Enter-equivalent edits and keeps front matter in rich view", () => {
    const onChange = vi.fn();
    render(<Harness initial={"---\nk: v\n---\n\nhello"} onChange={onChange} />);
    const view = editorView();
    act(() => {
      view.dispatch(view.state.tr.insertText(" world", 6));
    });
    expect(onChange).toHaveBeenLastCalledWith("---\nk: v\n---\n\nhello world");
  });

  it("counts characters of the whole file without repeating the format name", () => {
    render(<Harness initial={"---\nk: v\n---\n\nhello"} />);
    expect(screen.getByText(/19 characters/u)).toBeTruthy();
    expect(screen.getByText(/19 characters/u).parentElement).not.toHaveTextContent("Markdown");
  });

  it.each([
    ["MacIntel", "Bold (⌘B)", "Redo (⇧⌘Z)"],
    ["Win32", "Bold (Ctrl+B)", "Redo (Shift+Ctrl+Z)"],
  ])("writes shortcuts for the platform %s", (platform, bold, redo) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<Harness initial="hello" />);
    expect(screen.getByRole("button", { name: bold })).toBeTruthy();
    expect(screen.getByRole("button", { name: redo })).toBeTruthy();
  });

  it("handles a very long line and HTML in source view without throwing", () => {
    const long = "<script>alert(1)</script> ".repeat(5_000);
    render(<Harness initial={long} />);
    expect(viewButton("Formatted").disabled).toBe(true);
    fireEvent.click(viewButton("Split"));
    expect(document.querySelector("script")).toBeNull();
  });

  it("has no detectable accessibility violations in any view", async () => {
    const { container } = render(<Harness initial={"---\nk: v\n---\n\n# Title\n\ntext"} />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(viewButton("Split"));
    expect(await axe(container)).toHaveNoViolations();
  });

  describe("selectTitleOnOpen", () => {
    function editor(value: string, key: string, select: boolean | undefined): ReactNode {
      return (
        <MarkdownEditor
          value={value}
          documentKey={key}
          ariaLabel="Prompt"
          maxLength={1000}
          {...(select === undefined ? {} : { selectTitleOnOpen: select })}
          onChange={() => undefined}
        />
      );
    }

    it("selects the first block once per document and again for a new key", () => {
      const { rerender } = render(editor("# Title\n\nbody", "one", true));
      expect(selectedText()).toBe("Title");
      // Switching views later must not select the title again.
      fireEvent.click(viewButton("Markdown"));
      fireEvent.click(viewButton("Formatted"));
      const view = editorView();
      expect(view.state.selection.empty).toBe(true);
      rerender(editor("# Other\n\nbody", "two", true));
      expect(selectedText()).toBe("Other");
    });

    it("leaves the selection alone when not requested", () => {
      render(editor("# Title", "one", undefined));
      expect(selectedText()).toBe("");
      render(editor("# Title", "two", false));
      expect(selectedText()).toBe("");
    });

    it("does not select an empty first block or a non-text first block", () => {
      render(editor("", "empty", true));
      expect(selectedText()).toBe("");
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Prompt" }));
    });

    it("does not select when the document opens as source", () => {
      render(editor("a ~~b~~", "src", true));
      expect(controllers).toHaveLength(0);
    });
  });
});

function paste(text: string, type: "text/markdown" | "text/plain" = "text/markdown"): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: [type], getData: (wanted: string) => (wanted === type ? text : "") },
  });
  act(() => {
    editorView().dom.dispatchEvent(event);
  });
}

function lastValue(onChange: ReturnType<typeof vi.fn>): string {
  return String(onChange.mock.calls.at(-1)?.[0]);
}

describe("pasting Markdown the formatted view cannot hold", () => {
  const EXISTING = "# Plan\n\nExisting paragraph.";

  it.each([
    ["strikethrough", "Please ~~do not~~ do this"],
    ["a table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["a task list", "- [x] done\n- [ ] open"],
  ])("keeps %s unchanged, with the existing document, in Markdown source", (_name, pasted) => {
    const onChange = vi.fn();
    render(<Harness initial={EXISTING} onChange={onChange} />);
    const { state } = editorView();
    act(() => {
      editorView().dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    });
    paste(pasted);
    const saved = lastValue(onChange);
    expect(saved).toContain(pasted);
    expect(saved).not.toContain("\\~");
    expect(saved).toContain("# Plan");
    expect(saved).toContain("Existing paragraph.");
    expect(viewButton("Markdown").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Prompt · Markdown" })).toHaveValue(saved);
  });

  it("still parses ordinary pasted Markdown into the formatted document", () => {
    const onChange = vi.fn();
    render(<Harness initial={EXISTING} onChange={onChange} />);
    paste("some **bold** words", "text/plain");
    expect(lastValue(onChange)).toContain("some **bold** words");
    expect(viewButton("Formatted").getAttribute("aria-pressed")).toBe("true");
  });

  function select(text: string, inner?: string): void {
    const view = editorView();
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text?.includes(text) === true)
        found = pos + node.text.indexOf(text);
      return found < 0;
    });
    if (found < 0) throw new TypeError("text not in document");
    const length = inner === undefined ? 0 : text.length;
    act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            found + (inner === undefined ? text.length : 0),
            found + (inner === undefined ? text.length : length),
          ),
        ),
      );
    });
  }

  it("inserts in the middle of a paragraph, keeping both halves", () => {
    const onChange = vi.fn();
    render(<Harness initial={"Start middle end"} onChange={onChange} />);
    select("Start ");
    paste("~~gone~~");
    expect(lastValue(onChange)).toBe("Start ~~gone~~middle end");
  });

  it("replaces a non-empty selection", () => {
    const onChange = vi.fn();
    render(<Harness initial={"Keep REPLACE keep"} onChange={onChange} />);
    select("REPLACE", "all");
    paste("~~new~~");
    expect(lastValue(onChange)).toBe("Keep ~~new~~ keep");
  });

  it("keeps multi-line text inside the list item it was pasted into", () => {
    const onChange = vi.fn();
    render(<Harness initial={"- first item tail\n- second"} onChange={onChange} />);
    select("first ");
    paste("~~x~~\n~~y~~");
    const lines = lastValue(onChange).split("\n");
    expect(lines).toEqual(["* first ~~x~~", "  ~~y~~item tail", "* second"]);
  });

  it("keeps a table pasted inside a list item as its own block of that item", () => {
    const onChange = vi.fn();
    render(<Harness initial={"- first item tail\n- second"} onChange={onChange} />);
    select("first ");
    paste("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(lastValue(onChange).split("\n")).toEqual([
      "* first",
      "",
      "  | a | b |",
      "  | - | - |",
      "  | 1 | 2 |",
      "",
      "  item tail",
      "* second",
    ]);
  });

  it("sets a pasted table apart from the paragraph it interrupts", () => {
    const onChange = vi.fn();
    render(<Harness initial={"Intro tail"} onChange={onChange} />);
    select("Intro");
    paste("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(lastValue(onChange)).toBe("Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntail");
  });

  it("turns CRLF clipboard text into line breaks without carriage returns", () => {
    const onChange = vi.fn();
    render(<Harness initial={"Existing."} onChange={onChange} />);
    select("Existing.");
    paste("| a |\r\n| - |\r\n| 1 |\r\n");
    expect(lastValue(onChange)).not.toContain("\r");
    expect(lastValue(onChange)).toContain("| a |\n| - |\n| 1 |");
  });

  it("keeps unsupported text/plain clipboard text too", () => {
    const onChange = vi.fn();
    render(<Harness initial={"Existing."} onChange={onChange} />);
    paste("a ~~b~~ c", "text/plain");
    expect(lastValue(onChange)).toContain("a ~~b~~ c");
    expect(viewButton("Markdown").getAttribute("aria-pressed")).toBe("true");
  });
});
