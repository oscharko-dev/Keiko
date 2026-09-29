import { fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { ComposerCodeView } from "./composer-code-view";
import { parseComposerMarkdown } from "./composer-markdown";
import { CLIENT_COMPOSER_CODE_STAGES } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { ComposerCodeEditor, ComposerCodePort } from "./composer-code-runtime";
import styles from "./MarkdownComposer.module.css";

const runtime = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock("./composer-code-runtime", () => ({ mountComposerCode: runtime.mount }));
const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: diagnostics.report }));
const labels = {
  code: "Code",
  plainText: "Plain text",
  language: "Language",
  continueText: "Continue",
  loading: "Loading",
  unavailable: "Unavailable",
  limit: "Limit",
  hint: "Hint",
};
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
  runtime.mount.mockReset();
  diagnostics.report.mockReset();
});

function editorAdapter(): ComposerCodeEditor {
  return { update: vi.fn(), select: vi.fn(), focus: vi.fn(), dispose: vi.fn() };
}

function setup(): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: parseComposerMarkdown("```typescript\nconst x = 1;\n```\n\nNext"),
    }),
    nodeViews: {
      code_block: (node, outer, getPos): ComposerCodeView =>
        ComposerCodeView.create(node, outer, getPos, labels),
    },
  });
  views.push(view);
  return view;
}

describe("composer code runtime lifecycle", () => {
  it("actually hides the loading notice after Monaco mounts, including the production CSS", async () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "MarkdownComposer.module.css"),
      "utf8",
    ).replaceAll(".cmpNotice", `.${styles.cmpNotice}`);
    document.head.append(stylesheet);
    try {
      runtime.mount.mockResolvedValue(editorAdapter());
      const view = setup();
      await vi.waitFor(() => expect(runtime.mount).toHaveBeenCalledOnce());
      const notice = view.dom.querySelector<HTMLElement>(`.${styles.cmpNotice}`)!;
      await vi.waitFor(() => expect(notice.hidden).toBe(true));
      expect(getComputedStyle(notice).display).toBe("none");
      expect(diagnostics.report).toHaveBeenCalledWith("Keiko composer code editor ready.", {
        composerActivity: "code-ready",
      });
    } finally {
      stylesheet.remove();
    }
  });

  it("preserves edits made while Monaco loads and does not steal focus after leaving", async () => {
    let resolve: (editor: ComposerCodeEditor) => void = () => undefined;
    runtime.mount.mockImplementation(
      () =>
        new Promise<ComposerCodeEditor>((done) => {
          resolve = done;
        }),
    );
    const view = setup();
    await vi.waitFor(() => expect(runtime.mount).toHaveBeenCalledOnce());
    const textarea = view.dom.querySelector("textarea")!;
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "updated while loading" } });
    fireEvent.click(view.dom.querySelector("button")!);
    const adapter = editorAdapter();
    resolve(adapter);
    await vi.waitFor(() => expect(adapter.update).toHaveBeenCalledWith("updated while loading"));
    expect(adapter.focus).not.toHaveBeenCalled();
    expect(view.state.doc.firstChild?.textContent).toBe("updated while loading");
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("disposes an editor that resolves after its code node was removed", async () => {
    let resolve: (editor: ComposerCodeEditor) => void = () => undefined;
    runtime.mount.mockImplementation(
      () =>
        new Promise<ComposerCodeEditor>((done) => {
          resolve = done;
        }),
    );
    const view = setup();
    await vi.waitFor(() => expect(runtime.mount).toHaveBeenCalledOnce());
    view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild!.nodeSize));
    const adapter = editorAdapter();
    resolve(adapter);
    await vi.waitFor(() => expect(adapter.dispose).toHaveBeenCalledOnce());
    expect(adapter.focus).not.toHaveBeenCalled();
  });

  it("keeps the fallback editable and reports a body-free failure", async () => {
    runtime.mount.mockRejectedValue(new Error("customer code and secret must never be logged"));
    const view = setup();
    await vi.waitFor(() => expect(view.dom.textContent).toContain("Unavailable"));
    const textarea = view.dom.querySelector("textarea")!;
    fireEvent.input(textarea, { target: { value: "still editable" } });
    expect(view.state.doc.firstChild?.textContent).toBe("still editable");
    expect(JSON.stringify(diagnostics.report.mock.calls)).not.toContain("customer code");
    expect(diagnostics.report).toHaveBeenCalled();
  });

  it.each(CLIENT_COMPOSER_CODE_STAGES)(
    "preserves the actual %s failure stage at the producer",
    async (stage) => {
      runtime.mount.mockImplementation((_host: HTMLElement, port: ComposerCodePort) => {
        port.onStage(stage);
        return Promise.reject(new Error("private code must not appear"));
      });
      const view = setup();
      await vi.waitFor(() => expect(view.dom.textContent).toContain("Unavailable"));
      expect(diagnostics.report).toHaveBeenCalledWith(
        expect.stringContaining(`(${stage})`),
        expect.objectContaining({
          kind: "other",
          composerCodeStage: stage,
          errorEvidence: expect.any(Object),
        }),
      );
      expect(JSON.stringify(diagnostics.report.mock.calls)).not.toContain("private code");
    },
  );

  it("synchronizes Monaco edits and selections with the Markdown document", async () => {
    runtime.mount.mockResolvedValue(editorAdapter());
    const view = setup();
    await vi.waitFor(() => expect(runtime.mount).toHaveBeenCalledOnce());
    const port = runtime.mount.mock.calls[0]?.[1] as ComposerCodePort;
    port.onChange("const value = 42;", 6, 11);
    expect(view.state.doc.firstChild?.textContent).toBe("const value = 42;");
    expect(view.state.selection).toEqual(TextSelection.create(view.state.doc, 7, 12));
    port.onSelect(0, 5);
    expect(view.state.selection.from).toBe(1);
    expect(view.state.selection.to).toBe(6);
  });
});
