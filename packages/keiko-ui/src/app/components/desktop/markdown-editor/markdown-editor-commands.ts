import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { MarkType, NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, EditorState } from "prosemirror-state";
import { composerSchema } from "../composer/composer-markdown";

export type MarkdownBlockStyle = "paragraph" | "heading-1" | "heading-2" | "heading-3";
export type MarkdownMarkFormat = "strong" | "em" | "code";
export type MarkdownWrapFormat = "bullet_list" | "ordered_list" | "blockquote";

function nodeType(name: string): NodeType {
  const type = composerSchema.nodes[name];
  if (!type) throw new TypeError(`Missing Markdown node ${name}`);
  return type;
}

function markType(name: MarkdownMarkFormat): MarkType {
  const type = composerSchema.marks[name];
  if (!type) throw new TypeError(`Missing Markdown mark ${name}`);
  return type;
}

export function markActive(state: EditorState, name: MarkdownMarkFormat): boolean {
  const type = markType(name);
  const { from, $from, to, empty } = state.selection;
  if (empty) return type.isInSet(state.storedMarks ?? $from.marks()) !== undefined;
  return state.doc.rangeHasMark(from, to, type);
}

export function blockStyle(state: EditorState): MarkdownBlockStyle | "other" {
  const parent = state.selection.$from.parent;
  if (parent.type.name === "paragraph") return "paragraph";
  const level = Number(parent.attrs.level);
  if (parent.type.name === "heading" && level >= 1 && level <= 3)
    return `heading-${String(level)}` as MarkdownBlockStyle;
  return "other";
}

/** The innermost list or quote around the selection, which its toolbar button reports as pressed. */
export function wrapActive(state: EditorState, name: MarkdownWrapFormat): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const type = $from.node(depth).type.name;
    if (type === "bullet_list" || type === "ordered_list" || type === "blockquote")
      return type === name;
  }
  return false;
}

export function toggleMarkCommand(name: MarkdownMarkFormat): Command {
  return toggleMark(markType(name));
}

export function blockStyleCommand(style: MarkdownBlockStyle): Command {
  if (style === "paragraph") return setBlockType(nodeType("paragraph"));
  return setBlockType(nodeType("heading"), { level: Number(style.slice(-1)) });
}

/** Pressing an active list or quote button removes it again. */
export function toggleWrapCommand(name: MarkdownWrapFormat): Command {
  return (state, dispatch, view) => {
    const active = wrapActive(state, name);
    if (name === "blockquote")
      return active ? lift(state, dispatch) : wrapIn(nodeType(name))(state, dispatch, view);
    if (active) return liftListItem(nodeType("list_item"))(state, dispatch, view);
    return wrapInList(nodeType(name))(state, dispatch, view);
  };
}

export const codeBlockCommand: Command = setBlockType(nodeType("code_block"));
export const undoCommand: Command = undo;
export const redoCommand: Command = redo;

export function historyAvailable(state: EditorState): { undo: boolean; redo: boolean } {
  return { undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 };
}
