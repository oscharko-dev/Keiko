import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { type Transaction } from "prosemirror-state";
import { Slice } from "prosemirror-model";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { createComposerState, pasteComposerMarkdown } from "./composer-editor-state";
import {
  markdownCursor,
  parseComposerText,
  parseComposerDraft,
  selectionFromMarkdown,
  serializeComposerMarkdown,
} from "./composer-markdown";
import { ComposerCodeView } from "./composer-code-view";
import type { ComposerInputHandle, MarkdownComposerProps } from "./composer-editor-types";
import styles from "./MarkdownComposer.module.css";

export class ComposerEditorController implements ComposerInputHandle {
  readonly view: EditorView;
  private value: string;
  private readonly trackKeyboardFocus = (event: KeyboardEvent): void => {
    if (event.key === "Tab") this.view.dom.dataset.keyboardFocus = "true";
  };
  private readonly trackPointerFocus = (): void => {
    this.view.dom.dataset.keyboardFocus = "false";
  };

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
      clipboardTextSerializer: (slice): string => this.clipboardText(slice),
    });
    this.view.dom.ownerDocument.addEventListener("keydown", this.trackKeyboardFocus, true);
    this.view.dom.ownerDocument.addEventListener("pointerdown", this.trackPointerFocus, true);
    reportClientDiagnostic("Keiko Markdown composer initialized.", {
      composerActivity: "initialized",
      composerFocusIndicator: "keyboard",
    });
  }

  private clipboardText(slice: Slice): string {
    const text =
      slice.openStart > 0 || slice.openEnd > 0
        ? slice.content.textBetween(0, slice.content.size, "\n", "\n")
        : serializeComposerMarkdown(this.view.state.schema.node("doc", null, slice.content));
    reportClientDiagnostic("Keiko composer selection copied.", { composerActivity: "text-copied" });
    return text;
  }

  private createState(value: string): ReturnType<typeof createComposerState> {
    return createComposerState(value, this.props.maxLength, () => {
      this.onNotice(this.props.labels.limit);
      reportClientDiagnostic("Keiko Markdown composer input limit reached.", {
        composerActivity: "input-limit",
      });
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
      "aria-description": this.props.labels.hint,
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
    if (!before.doc.eq(next.doc)) {
      this.value = serializeComposerMarkdown(next.doc);
      this.onNotice("");
      this.props.onChange(this.value, this.mentionCursor());
    } else {
      if (before.doc !== next.doc) {
        reportClientDiagnostic("Keiko composer equivalent document update ignored.", {
          composerActivity: "equivalent-edit-ignored",
        });
      }
      if (!before.selection.eq(next.selection)) {
        this.props.onSelect(this.value, this.mentionCursor());
      }
    }
  }

  update(props: MarkdownComposerProps): void {
    this.props = props;
    this.view.setProps({ attributes: this.attributes() });
    if (props.value === this.value) return;
    if (!props.value) {
      this.value = "";
      this.view.updateState(this.createState(""));
      return;
    }
    let tr = this.externalDraftTransaction(props.value);
    if (serializeComposerMarkdown(tr.doc) !== props.value) {
      const state = this.view.state;
      tr = state.tr.replaceWith(0, state.doc.content.size, parseComposerDraft(props.value).content);
      reportClientDiagnostic("Keiko composer external draft resynchronized.", {
        composerActivity: "draft-resynchronized",
      });
    }
    this.view.updateState(this.view.state.apply(tr));
    this.value = serializeComposerMarkdown(this.view.state.doc);
    if (this.value !== props.value) this.props.onChange(this.value, this.mentionCursor());
  }

  private externalDraftTransaction(value: string): Transaction {
    let start = 0;
    let oldEnd = this.value.length;
    let newEnd = value.length;
    while (start < Math.min(oldEnd, newEnd) && this.value[start] === value[start]) start += 1;
    while (oldEnd > start && newEnd > start && this.value[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    const state = this.view.state;
    const from = selectionFromMarkdown(state, start, this.value).head;
    const to = selectionFromMarkdown(state, oldEnd, this.value).head;
    let inserted = value.slice(start, newEnd);
    const tr = state.tr.delete(from, to);
    const $from = tr.doc.resolve(from);
    if (
      inserted.startsWith("\n\n") &&
      $from.depth === 1 &&
      $from.parentOffset === $from.parent.content.size
    ) {
      tr.split(from, 1, [{ type: state.schema.nodes.paragraph! }]);
      inserted = inserted.slice(2);
      tr.setSelection(selectionFromMarkdown(state, start, this.value).map(tr.doc, tr.mapping));
      tr.insert(from + 2, parseComposerText(inserted).firstChild!.content);
    } else {
      tr.replaceRange(from, from, Slice.maxOpen(parseComposerText(inserted).content));
    }
    return tr;
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
    this.view.dom.ownerDocument.removeEventListener("keydown", this.trackKeyboardFocus, true);
    this.view.dom.ownerDocument.removeEventListener("pointerdown", this.trackPointerFocus, true);
    this.view.destroy();
  }
}
