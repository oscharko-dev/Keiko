import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { type Command, type Plugin } from "prosemirror-state";
import {
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
} from "prosemirror-commands";
import { splitListItem } from "prosemirror-schema-list";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { composerSchema } from "./composer-markdown";

function inlineRule(pattern: RegExp, name: "strong" | "em" | "code"): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const content = match[1];
    const mark = composerSchema.marks[name];
    if (!content || !mark) return null;
    const prefix = state.doc.textBetween(state.selection.$from.start(), start);
    if (name !== "code" && (content.trim() !== content || hasOpenCodeDelimiter(prefix))) {
      reportClientDiagnostic("Keiko composer literal punctuation preserved.", {
        composerActivity: "literal-input-preserved",
      });
      return null;
    }
    return state.tr
      .insertText(content, start, end)
      .addMark(start, start + content.length, mark.create())
      .removeStoredMark(mark);
  });
}

function hasOpenCodeDelimiter(prefix: string): boolean {
  let open = 0;
  for (const match of prefix.matchAll(/`+/g)) {
    if (open === 0) open = match[0].length;
    else if (open === match[0].length) open = 0;
  }
  return open > 0;
}

export function composerInputRules(): Plugin {
  const { heading, blockquote, bullet_list, ordered_list } = composerSchema.nodes;
  if (!heading || !blockquote || !bullet_list || !ordered_list)
    throw new TypeError("Invalid composer schema");
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, heading, (match) => ({
        level: match[1]?.length ?? 1,
      })),
      wrappingInputRule(/^>\s$/, blockquote),
      wrappingInputRule(/^[-*+]\s$/, bullet_list),
      wrappingInputRule(/^(\d+)\.\s$/, ordered_list, (match) => ({ order: Number(match[1]) })),
      inlineRule(/\*\*([^*]+)\*\*$/, "strong"),
      inlineRule(/(?<!\*)\*([^*]+)\*$/, "em"),
      inlineRule(/`([^`]+)`$/, "code"),
    ],
  });
}

/** A fence is an explicit Shift+Enter gesture, never an ordinary submit. */
export const openComposerCodeBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return false;
  const match = /^```([\w+-]*)$/.exec($from.parent.textContent);
  const code = composerSchema.nodes.code_block;
  if (!match || !code || $from.parentOffset !== $from.parent.content.size) return false;
  dispatch?.(
    state.tr
      .delete($from.start(), $from.end())
      .setBlockType($from.start(), $from.start(), code, { params: match[1] ?? "" }),
  );
  return true;
};

export function composerNewline(): Command {
  const item = composerSchema.nodes.list_item;
  if (!item) throw new TypeError("Invalid composer list schema");
  return chainCommands(
    openComposerCodeBlock,
    splitListItem(item),
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
}
