import { Slice } from "prosemirror-model";
import { baseKeymap, chainCommands, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { EditorState, Plugin } from "prosemirror-state";
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

function editorKeymap(): Plugin {
  const { strong, em, code } = composerSchema.marks;
  const item = composerSchema.nodes.list_item;
  if (!strong || !em || !code || !item) throw new TypeError("Invalid composer schema");
  return keymap({
    ...baseKeymap,
    Enter: () => true,
    "Shift-Enter": composerNewline(),
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

export function createComposerState(
  value: string,
  maxLength: number,
  onLimit: () => void,
): EditorState {
  return EditorState.create({
    doc: parseComposerDraft(value),
    plugins: [
      composerInputRules(),
      editorKeymap(),
      keymap(baseKeymap),
      history(),
      new Plugin({
        filterTransaction: (tr): boolean => {
          if (!tr.docChanged || serializeComposerMarkdown(tr.doc).length <= maxLength) return true;
          onLimit();
          return false;
        },
      }),
    ],
  });
}

export function pasteComposerMarkdown(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return false;
  const markdown = event.clipboardData?.types?.includes("text/markdown")
    ? event.clipboardData.getData("text/markdown")
    : undefined;
  view.dispatch(
    view.state.tr
      .replaceSelection(
        Slice.maxOpen(
          (markdown === undefined ? parseComposerText(text) : parseComposerMarkdown(markdown))
            .content,
        ),
      )
      .scrollIntoView(),
  );
  return true;
}
