import type { Node as DocumentNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import type { EditorView, NodeView } from "prosemirror-view";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary } from "@/lib/client-error-summary";
import type { ComposerEditorLabels } from "./composer-editor-types";
import { clearComposerFormatting } from "./composer-format-commands";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import type { ComposerCodeEditor, ComposerCodeStage } from "./composer-code-runtime";
import styles from "./MarkdownComposer.module.css";
import { detectComposerCodeLanguage } from "./composer-code-language";

const LANGUAGES = [
  "plaintext",
  "typescript",
  "javascript",
  "json",
  "python",
  "shell",
  "sql",
  "java",
  "go",
  "rust",
  "yaml",
  "html",
  "css",
  "markdown",
];
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  bash: "shell",
  sh: "shell",
  yml: "yaml",
  md: "markdown",
};

function languageFor(node: DocumentNode): string {
  const name = String(node.attrs.params).split(/\s/)[0] ?? "";
  return (
    LANGUAGE_ALIASES[name] ?? (name || detectComposerCodeLanguage(node.textContent) || "plaintext")
  );
}

export class ComposerCodeView implements NodeView {
  readonly dom = document.createElement("div");
  private readonly host = document.createElement("div");
  private readonly fallback = document.createElement("textarea");
  private readonly notice = document.createElement("div");
  private readonly languageSelect = document.createElement("select");
  private editor: ComposerCodeEditor | undefined;
  private disposed = false;
  private updating = false;

  static create(
    node: DocumentNode,
    view: EditorView,
    getPos: () => number | undefined,
    labels: ComposerEditorLabels,
  ): ComposerCodeView {
    const codeView = new ComposerCodeView(node, view, getPos, labels);
    void codeView.loadEditor();
    return codeView;
  }

  private constructor(
    private node: DocumentNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly labels: ComposerEditorLabels,
  ) {
    this.dom.className = styles.cmpCode ?? "";
    this.dom.contentEditable = "false";
    this.dom.dataset.composerCode = "";
    this.host.className = styles.cmpCodeHost ?? "";
    this.host.dataset.workspaceScrollOwner = "virtual";
    this.notice.className = styles.cmpNotice ?? "";
    this.notice.textContent = labels.loading;
    this.setupFallback();
    this.dom.append(this.header(), this.host, this.fallback, this.notice);
    this.host.hidden = true;
  }

  private header(): HTMLElement {
    const header = document.createElement("div");
    header.className = styles.cmpCodeHeader ?? "";
    const select = this.languageSelect;
    select.className = styles.cmpLanguage ?? "";
    select.setAttribute("aria-label", this.labels.language);
    const language = languageFor(this.node);
    if (this.node.attrs.params === "" && language !== "plaintext") {
      reportClientDiagnostic("Keiko composer code language detected.", {
        composerActivity: "code-language-detected",
      });
    }
    for (const name of new Set([...LANGUAGES, language])) {
      select.add(new Option(name === "plaintext" ? this.labels.plainText : name, name));
    }
    select.value = language;
    select.addEventListener("change", () => {
      const pos = this.getPos();
      if (pos !== undefined)
        this.view.dispatch(
          this.view.state.tr.setNodeMarkup(pos, undefined, {
            params: select.value,
          }),
        );
    });
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = styles.cmpContinue ?? "";
    exit.textContent = this.labels.continueText;
    exit.addEventListener("click", () => this.exit());
    header.append(select, exit);
    return header;
  }

  private setupFallback(): void {
    this.fallback.className = styles.cmpFallback ?? "";
    this.fallback.setAttribute("aria-label", this.labels.code);
    this.fallback.spellcheck = false;
    this.fallback.value = this.node.textContent;
    this.fallback.addEventListener("input", () =>
      this.change(this.fallback.value, this.fallback.selectionStart, this.fallback.selectionEnd),
    );
    this.fallback.addEventListener("select", () =>
      this.selectOuter(this.fallback.selectionStart, this.fallback.selectionEnd),
    );
    this.fallback.addEventListener("keydown", (event) => {
      if ((event.key === "Backspace" || event.key === "Delete") && this.fallback.value === "") {
        event.preventDefault();
        this.clearEmptyCode();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.exit();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        (event.shiftKey ? redo : undo)(this.view.state, this.view.dispatch);
      }
    });
  }

  private async loadEditor(): Promise<void> {
    let stage: ComposerCodeStage = "module-load";
    try {
      const { mountComposerCode } = await import("./composer-code-runtime");
      if (this.disposed) return;
      this.host.hidden = false;
      const editor = await mountComposerCode(this.host, {
        value: this.node.textContent,
        language: languageFor(this.node),
        label: this.labels.code,
        onChange: (value, anchor, head) => this.change(value, anchor, head),
        onSelect: (anchor, head) => this.selectOuter(anchor, head),
        onExit: () => this.exit(),
        onEmptyBackspace: () => this.clearEmptyCode(),
        onUndo: () => {
          undo(this.view.state, this.view.dispatch);
        },
        onStage: (next) => {
          stage = next;
        },
        onRedo: () => {
          redo(this.view.state, this.view.dispatch);
        },
      });
      if (this.disposed) {
        editor.dispose();
        return;
      }
      this.adoptEditor(editor);
      reportClientDiagnostic("Keiko composer code editor ready.", {
        composerActivity: "code-ready",
      });
    } catch (error) {
      reportClientDiagnostic(
        `Keiko composer code editor unavailable (${stage}): ${clientErrorSummary(error)}`,
        { kind: "other", errorEvidence: clientErrorEvidence(error), composerCodeStage: stage },
      );
      if (this.disposed) return;
      this.host.hidden = true;
      this.notice.textContent = this.labels.unavailable;
    }
  }

  private adoptEditor(editor: ComposerCodeEditor): void {
    const focused = document.activeElement === this.fallback;
    const selection: [number, number] = [this.fallback.selectionStart, this.fallback.selectionEnd];
    this.editor = editor;
    this.update(this.node);
    this.fallback.hidden = true;
    this.notice.hidden = true;
    if (focused) {
      editor.select(...selection);
      editor.focus();
    }
  }

  private change(value: string, anchor: number, head: number): void {
    if (this.updating || this.disposed) return;
    const pos = this.getPos();
    if (pos === undefined || value === this.node.textContent) return;
    const tr = this.view.state.tr.insertText(value, pos + 1, pos + 1 + this.node.content.size);
    const detected = this.node.attrs.params === "" ? detectComposerCodeLanguage(value) : undefined;
    if (detected !== undefined) {
      tr.setNodeMarkup(pos, undefined, { params: detected });
      reportClientDiagnostic("Keiko composer code language detected.", {
        composerActivity: "code-language-detected",
      });
    }
    tr.setSelection(TextSelection.create(tr.doc, pos + 1 + anchor, pos + 1 + head));
    this.view.dispatch(tr);
    this.update(this.node);
  }

  private selectOuter(anchor: number, head: number): void {
    if (this.updating || this.disposed) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    const selection = TextSelection.create(
      this.view.state.doc,
      pos + 1 + Math.min(anchor, this.node.content.size),
      pos + 1 + Math.min(head, this.node.content.size),
    );
    if (!selection.eq(this.view.state.selection))
      this.view.dispatch(this.view.state.tr.setSelection(selection));
  }

  private exit(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    let end = pos + this.node.nodeSize;
    const $end = this.view.state.doc.resolve(end);
    for (let depth = $end.depth; depth > 0; depth -= 1) {
      if ($end.end(depth) === end) end = $end.after(depth);
    }
    const tr = this.view.state.tr;
    const paragraph = this.view.state.schema.nodes.paragraph;
    if (end === tr.doc.content.size && paragraph) tr.insert(end, paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  }

  private clearEmptyCode(): void {
    if (this.node.content.size !== 0) return;
    this.selectOuter(0, 0);
    clearComposerFormatting(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  update(node: DocumentNode): boolean {
    if (node.type.name !== "code_block") return false;
    const previousLanguage = languageFor(this.node);
    this.node = node;
    this.updating = true;
    this.fallback.value = node.textContent;
    this.editor?.update(node.textContent);
    const language = languageFor(node);
    this.languageSelect.value = language;
    if (previousLanguage !== language) {
      void this.editor?.setLanguage(language).catch((error: unknown) => {
        reportClientDiagnostic("Keiko composer code language unavailable.", {
          kind: "other",
          errorEvidence: clientErrorEvidence(error),
          composerCodeStage: "language",
        });
      });
    }
    this.updating = false;
    return true;
  }

  setSelection(anchor: number, head: number): void {
    this.updating = true;
    if (this.editor) {
      this.editor.select(anchor, head);
      this.editor.focus();
    } else {
      this.fallback.focus();
      this.fallback.setSelectionRange(anchor, head);
    }
    this.updating = false;
  }

  stopEvent(): boolean {
    return true;
  }
  ignoreMutation(): boolean {
    return true;
  }
  destroy(): void {
    this.disposed = true;
    this.editor?.dispose();
  }
}
