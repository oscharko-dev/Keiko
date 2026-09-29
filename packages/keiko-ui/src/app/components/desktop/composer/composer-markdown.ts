import { Schema, type Node as DocumentNode } from "prosemirror-model";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  schema,
} from "prosemirror-markdown";
import { TextSelection, type Selection, type EditorState } from "prosemirror-state";

// Drafts are inert: links cannot navigate and Markdown images never fetch remote resources.
export const composerSchema = new Schema({
  nodes: schema.spec.nodes.update("image", {
    ...schema.spec.nodes.get("image"),
    toDOM: (node) => ["span", { "data-markdown-image": "" }, String(node.attrs.alt ?? "")],
  }),
  marks: schema.spec.marks.update("link", {
    ...schema.spec.marks.get("link"),
    toDOM: () => ["span", { "data-markdown-link": "" }, 0],
  }),
});

const tokenizer = defaultMarkdownParser.tokenizer;
const parser = new MarkdownParser(composerSchema, tokenizer, defaultMarkdownParser.tokens);

export function parseComposerMarkdown(value: string): DocumentNode {
  return parser.parse(value);
}

export function serializeComposerMarkdown(doc: DocumentNode): string {
  return defaultMarkdownSerializer.serialize(doc);
}

/** Locate the caret in the Markdown handed to existing mention/dictation integrations. */
export function markdownCursor(state: EditorState): number {
  const marker = "\uE000";
  const marked = state.tr.insertText(marker, state.selection.head).doc;
  return serializeComposerMarkdown(marked).indexOf(marker);
}

export function selectionFromMarkdown(
  state: EditorState,
  offset: number,
  value: string,
): Selection {
  const marker = "\uE000";
  const marked = parseComposerMarkdown(value.slice(0, offset) + marker + value.slice(offset));
  let position = state.doc.content.size;
  marked.descendants((node, pos) => {
    const index = node.text?.indexOf(marker) ?? -1;
    if (index >= 0) position = pos + index;
  });
  return TextSelection.near(state.doc.resolve(Math.min(position, state.doc.content.size)));
}
