import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { type Transaction } from "prosemirror-state";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { createComposerState, pasteComposerMarkdown } from "./composer-editor-state";
import {
  markdownCursor,
  parseComposerMarkdown,
  selectionFromMarkdown,
  serializeComposerMarkdown,
} from "./composer-markdown";
import { ComposerCodeView } from "./composer-code-view";
import type { ComposerInputHandle, MarkdownComposerProps } from "./composer-editor-types";
import styles from "./MarkdownComposer.module.css";

export class ComposerEditorController implements ComposerInputHandle {
  readonly view: EditorView;
  private value: string;

  constructor(
    host: HTMLElement,
    private props: MarkdownComposerProps,
    private readonly onNotice: (notice: string) => void,
  ) {
    this.value = props.value;
    this.view = new EditorView(host, {
      state: this.createState(props.value),
      attributes: this.attributes(),
      dispatchTransaction: (tr): void => this.dispatch(tr),
      handlePaste: pasteComposerMarkdown,
      handleDrop: (): boolean => true,
      handleDOMEvents: {
        keydown: (_view, event): boolean => {
          if (event.isComposing) return false;
          this.props.onKeyDown(event);
          return event.defaultPrevented;
        },
      },
      nodeViews: {
        code_block: (node, view, getPos): ComposerCodeView =>
          ComposerCodeView.create(node, view, getPos, this.props.labels),
      },
      decorations: (state): DecorationSet | null =>
        state.doc.childCount === 1 &&
        state.doc.firstChild?.type.name === "paragraph" &&
        state.doc.firstChild.content.size === 0
          ? DecorationSet.create(state.doc, [
              Decoration.node(0, state.doc.firstChild.nodeSize, {
                "data-placeholder": this.props.placeholder,
              }),
            ])
          : null,
      clipboardTextSerializer: (slice): string =>
        serializeComposerMarkdown(this.view.state.schema.node("doc", null, slice.content)),
    });
    reportClientDiagnostic("Keiko Markdown composer initialized.");
  }

  private createState(value: string): ReturnType<typeof createComposerState> {
    return createComposerState(value, this.props.maxLength, () => {
      this.onNotice(this.props.labels.limit);
      reportClientDiagnostic("Keiko Markdown composer input limit reached.");
    });
  }

  private mentionCursor(): number {
    return this.view.state.selection.$from.parent.type.name === "code_block"
      ? -1
      : this.selectionStart;
  }

  private attributes(): Record<string, string> {
    return {
      class: styles.cmpEditor ?? "",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": this.props.ariaLabel,
      ...(this.props.ariaControls ? { "aria-controls": this.props.ariaControls } : {}),
      tabindex: "0",
      "data-shell-chord-bypass": "",
      "data-markdown-composer": "",
      spellcheck: "true",
    };
  }

  private dispatch(tr: Transaction): void {
    const before = this.view.state;
    const next = before.apply(tr);
    this.view.updateState(next);
    if (before.doc !== next.doc) {
      this.value = serializeComposerMarkdown(next.doc);
      this.onNotice("");
      this.props.onChange(this.value, this.mentionCursor());
    } else if (!before.selection.eq(next.selection)) {
      this.props.onSelect(this.value, this.mentionCursor());
    }
  }

  update(props: MarkdownComposerProps): void {
    this.props = props;
    this.view.setProps({ attributes: this.attributes() });
    if (props.value === this.value) return;
    this.value = props.value;
    if (!props.value) {
      this.view.updateState(this.createState(""));
      return;
    }
    const doc = parseComposerMarkdown(props.value);
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
    this.view.updateState(this.view.state.apply(tr));
  }

  focus(): void {
    this.view.focus();
  }
  get selectionStart(): number {
    return markdownCursor(this.view.state);
  }
  setSelectionRange(start: number, _end: number): void {
    this.view.dispatch(
      this.view.state.tr.setSelection(selectionFromMarkdown(this.view.state, start, this.value)),
    );
  }
  destroy(): void {
    this.view.destroy();
  }
}
