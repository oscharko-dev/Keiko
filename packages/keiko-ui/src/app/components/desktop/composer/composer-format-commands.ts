import { chainCommands, liftEmptyBlock, setBlockType } from "prosemirror-commands";
import { liftListItem } from "prosemirror-schema-list";
import type { Command } from "prosemirror-state";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

const clearEmptyMarks: Command = (state, dispatch) => {
  if ((state.storedMarks ?? state.selection.$from.marks()).length === 0) return false;
  dispatch?.(state.tr.setStoredMarks([]));
  return true;
};

const clearFormatting: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const paragraph = state.schema.nodes.paragraph;
  const listItem = state.schema.nodes.list_item;
  if (!empty || $from.parentOffset !== 0 || !paragraph || !listItem) return false;
  if ($from.parent.type.name === "heading") return setBlockType(paragraph)(state, dispatch);
  if ($from.parent.content.size !== 0) return false;
  if ($from.parent.type.name === "code_block") return setBlockType(paragraph)(state, dispatch);
  if (chainCommands(liftListItem(listItem), liftEmptyBlock)(state, dispatch)) return true;
  return clearEmptyMarks(state, dispatch);
};

/** Backspace at a block's start removes its formatting before deleting neighbouring content. */
export const clearComposerFormatting: Command = (state, dispatch) => {
  const handled = clearFormatting(state, dispatch);
  if (handled && dispatch) reportClientDiagnostic("Keiko composer block formatting removed.");
  return handled;
};
