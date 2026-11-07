import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { Slice, type Node as DocumentNode } from "prosemirror-model";
import { baseKeymap, chainCommands, exitCode, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { EditorState, Plugin, type Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import {
  composerSchema,
  parseComposerMarkdown,
  parseComposerDraft,
  parseComposerText,
  serializeComposerMarkdown,
} from "./composer-markdown";
import { composerInputRules, composerNewline } from "./composer-input-rules";
import { clearComposerFormatting } from "./composer-format-commands";

/** A document line break inside a paragraph; a code block's own editor handles its newlines. */
const insertHardBreak: Command = (state, dispatch) => {
  const hardBreak = composerSchema.nodes.hard_break;
  if (!hardBreak) return false;
  dispatch?.(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
  return true;
};

/**
 * The chat composer sends on Enter (its owner handles the key) and starts a new block on
 * Shift+Enter; a Markdown document starts a new block on Enter and breaks the line on Shift+Enter.
 */
export type ComposerEditingMode = "composer" | "document";

function editorKeymap(mode: ComposerEditingMode): Plugin {
  const { strong, em, code } = composerSchema.marks;
  const item = composerSchema.nodes.list_item;
  if (!strong || !em || !code || !item) throw new TypeError("Invalid composer schema");
  return keymap({
    ...baseKeymap,
    Enter: mode === "composer" ? (): boolean => true : composerNewline(),
    "Shift-Enter":
      mode === "composer" ? composerNewline() : chainCommands(exitCode, insertHardBreak),
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(strong),
    "Mod-i": toggleMark(em),
    "Mod-`": toggleMark(code),
    Backspace: chainCommands(clearComposerFormatting, undoInputRule),
    Delete: (state, dispatch, view) =>
      state.selection.$from.parent.content.size === 0 && clearComposerFormatting(state, dispatch),
    Tab: sinkListItem(item),
    "Shift-Tab": liftListItem(item),
  });
}

function editorPlugins(
  mode: ComposerEditingMode,
  maxLength: number,
  onLimit: () => void,
  serialize: (doc: DocumentNode) => string,
): Plugin[] {
  return [
    composerInputRules(),
    editorKeymap(mode),
    keymap(baseKeymap),
    history(),
    new Plugin({
      filterTransaction: (tr): boolean => {
        if (!tr.docChanged || serialize(tr.doc).length <= maxLength) return true;
        onLimit();
        return false;
      },
    }),
  ];
}

export function createComposerState(
  value: string,
  maxLength: number,
  onLimit: () => void,
): EditorState {
  return EditorState.create({
    doc: parseComposerDraft(value),
    plugins: editorPlugins("composer", maxLength, onLimit, serializeComposerMarkdown),
  });
}

/** The same schema, input rules, shortcuts and history for a Markdown document editor. */
export function createMarkdownDocumentState(
  doc: DocumentNode,
  maxLength: number,
  onLimit: () => void,
  serialize: (doc: DocumentNode) => string,
): EditorState {
  return EditorState.create({
    doc,
    plugins: editorPlugins("document", maxLength, onLimit, serialize),
  });
}

export function pasteComposerMarkdown(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return false;
  const markdown = event.clipboardData?.types?.includes("text/markdown")
    ? event.clipboardData.getData("text/markdown")
    : undefined;
  if (!text && !markdown) {
    reportClientDiagnostic("Keiko composer non-text clipboard left unchanged.", {
      composerActivity: "non-text-paste-ignored",
    });
    return false;
  }
  view.dispatch(
    view.state.tr
      .replaceSelection(
        Slice.maxOpen(
          (markdown ? parseComposerMarkdown(markdown) : parseComposerText(text)).content,
        ),
      )
      .scrollIntoView(),
  );
  return true;
}
