import { Schema, type Node as DocumentNode } from "prosemirror-model";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  schema,
} from "prosemirror-markdown";
import { TextSelection, type Selection, type EditorState } from "prosemirror-state";
import { detectComposerCodeLanguage } from "./composer-code-language";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

// Drafts are inert: links cannot navigate and Markdown images never fetch remote resources.
export const composerSchema = new Schema({
  nodes: schema.spec.nodes.update("image", {
    ...schema.spec.nodes.get("image"),
    toDOM: (node) => [
      "span",
      { "data-markdown-image": "" },
      `![${String(node.attrs.alt ?? "")}](${String(node.attrs.src ?? "")}${visibleTitle(node.attrs.title)})`,
    ],
  }),
  marks: schema.spec.marks.update("link", {
    ...schema.spec.marks.get("link"),
    toDOM: (mark) => [
      "span",
      { "data-markdown-link": "" },
      ["span", {}, 0],
      [
        "span",
        { "data-markdown-destination": "", contenteditable: "false" },
        ` (${String(mark.attrs.href ?? "")}${visibleTitle(mark.attrs.title)})`,
      ],
    ],
  }),
});

function visibleTitle(title: unknown): string {
  return typeof title === "string" && title.length > 0 ? ` "${title}"` : "";
}

const tokenizer = defaultMarkdownParser.tokenizer;
const parser = new MarkdownParser(composerSchema, tokenizer, defaultMarkdownParser.tokens);
const literalSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    text: (state, node): void => state.write(node.text ?? ""),
    hard_break: (state): void => state.write("\n"),
  },
  defaultMarkdownSerializer.marks,
);

const serializer = new MarkdownSerializer(
  {
    ...literalSerializer.nodes,
    code_block: (state, node, parent, index): void => {
      const params = node.attrs.params || detectComposerCodeLanguage(node.textContent) || "";
      const labelled = node.type.create({ ...node.attrs, params }, node.content, node.marks);
      defaultMarkdownSerializer.nodes.code_block!(state, labelled, parent, index);
    },
  },
  literalSerializer.marks,
);

export function parseComposerMarkdown(value: string): DocumentNode {
  return parser.parse(value);
}

export function serializeComposerMarkdown(doc: DocumentNode): string {
  return serializer.serialize(doc);
}

/** Clipboard and external draft text is literal; only explicit Markdown is interpreted. */
export function parseComposerText(value: string): DocumentNode {
  const content: DocumentNode[] = [];
  value.split("\n").forEach((line, index) => {
    if (index > 0) content.push(composerSchema.node("hard_break"));
    if (line) content.push(composerSchema.text(line));
  });
  return composerSchema.node("doc", null, composerSchema.node("paragraph", null, content));
}

/** Restore formatting only when interpretation would leave the complete saved draft unchanged. */
export function parseComposerDraft(value: string): DocumentNode {
  const doc = parseComposerMarkdown(value);
  return literalSerializer.serialize(doc) === value ? doc : parseComposerText(value);
}

/** Locate the caret in the Markdown handed to existing mention/dictation integrations. */
export function markdownCursor(state: EditorState): number {
  const marker = cursorMarker(serializeComposerMarkdown(state.doc));
  const marked = state.tr.insertText(marker, state.selection.head).doc;
  return serializeComposerMarkdown(marked).indexOf(marker);
}

export function selectionFromMarkdown(
  state: EditorState,
  offset: number,
  value: string,
): Selection {
  const marker = cursorMarker(value);
  let low = 0;
  let high = state.doc.content.size;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const selection = TextSelection.near(state.doc.resolve(mid));
    const marked = state.tr.insertText(marker, selection.head).doc;
    const current = serializeComposerMarkdown(marked).indexOf(marker);
    if (current < offset) low = mid + 1;
    else high = mid;
  }
  return TextSelection.near(state.doc.resolve(low));
}

function cursorMarker(value: string): string {
  let prefix = "\uE000";
  while (value.includes(`${prefix}\uE001`)) prefix += prefix;
  const marker = `${prefix}\uE001`;
  if (prefix.length > 1)
    reportClientDiagnostic("Keiko composer cursor marker collision avoided.", {
      composerActivity: "cursor-collision",
    });
  return marker;
}
