import { Slice } from "prosemirror-model";
import { TextSelection, type Command, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { createMarkdownDocumentState } from "../composer/composer-editor-state";
import { ComposerCodeView } from "../composer/composer-code-view";
import type { ComposerEditorLabels } from "../composer/composer-editor-types";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./markdown-document";

export interface MarkdownDocumentOptions {
  readonly body: string;
  readonly maxLength: number;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly className: string;
  readonly labels: ComposerEditorLabels;
  readonly onChange: (body: string) => void;
  /** Selection or history changed, so the toolbar re-reads its pressed and enabled states. */
  readonly onState: () => void;
  readonly onLimit: () => void;
}

/** Pasted Markdown or plain text is read as Markdown: this edits a Markdown document. */
function pasteMarkdown(view: EditorView, event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  const text = data?.types.includes("text/markdown")
    ? data.getData("text/markdown")
    : data?.getData("text/plain");
  if (!text) return false;
  view.dispatch(
    view.state.tr
      .replaceSelection(Slice.maxOpen(parseMarkdownDocument(text).content))
      .scrollIntoView(),
  );
  return true;
}

function placeholder(text: string): (state: EditorView["state"]) => DecorationSet | null {
  return (state) => {
    const first = state.doc.firstChild;
    if (state.doc.childCount !== 1 || first?.type.name !== "paragraph" || first.content.size > 0)
      return null;
    return DecorationSet.create(state.doc, [
      Decoration.node(0, first.nodeSize, { "data-placeholder": text }),
    ]);
  };
}

/**
 * The formatted view of the shared Markdown editor: the chat composer's schema, input rules,
 * shortcuts and code blocks, in document mode (Enter starts a new block) with its own serializer.
 */
export class MarkdownDocumentController {
  readonly view: EditorView;
  private body: string;

  constructor(
    host: HTMLElement,
    private readonly options: MarkdownDocumentOptions,
  ) {
    this.body = options.body;
    this.view = new EditorView(host, {
      state: createMarkdownDocumentState(
        parseMarkdownDocument(options.body),
        options.maxLength,
        options.onLimit,
        serializeMarkdownDocument,
      ),
      attributes: {
        class: options.className,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": options.ariaLabel,
        spellcheck: "true",
        "data-shell-chord-bypass": "",
      },
      dispatchTransaction: (tr): void => this.dispatch(tr),
      handlePaste: pasteMarkdown,
      nodeViews: {
        code_block: (node, view, getPos): ComposerCodeView =>
          ComposerCodeView.create(node, view, getPos, options.labels),
      },
      decorations: placeholder(options.placeholder),
    });
    reportClientDiagnostic("Keiko Markdown editor initialized.", {
      composerActivity: "initialized",
    });
  }

  private dispatch(tr: Transaction): void {
    const before = this.view.state;
    const next = before.apply(tr);
    this.view.updateState(next);
    if (!before.doc.eq(next.doc)) {
      const body = serializeMarkdownDocument(next.doc);
      if (body !== this.body) {
        this.body = body;
        this.options.onChange(body);
      }
    }
    this.options.onState();
  }

  run(command: Command): void {
    command(this.view.state, (tr) => this.view.dispatch(tr), this.view);
    this.view.focus();
  }

  /** Focuses the document with the text of its first block selected, so typing replaces it. */
  selectFirstBlock(): void {
    const first = this.view.state.doc.firstChild;
    if (first?.isTextblock === true && first.content.size > 0) {
      const { tr } = this.view.state;
      this.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 1, 1 + first.content.size)));
    }
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }
}
