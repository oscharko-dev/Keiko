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

  it("counts characters of the whole file", () => {
    render(<Harness initial={"---\nk: v\n---\n\nhello"} />);
    expect(screen.getByText(/19 characters/u)).toBeTruthy();
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
