// Deterministic plain-text/markdown-lite → ADF composition (Issue #2244, Epic #2238, ADR-0128
// D1). The REVERSE direction of `adf-to-text.ts`: where that module makes hostile provider ADF
// readable, this one composes the OUTBOUND Jira document (issue descriptions and comments) from
// bounded local input. Model-free, pure, and golden-tested: the same input always produces a
// byte-identical document.
//
// The input dialect is the shared markdown-lite block grammar (`markdown-lite-blocks.ts`) — one
// parser feeds this composer and the Confluence storage-format composer, so the two formats can
// never drift. Emitted node vocabulary (deliberately small):
//
//   paragraph (lines joined by hardBreak) · heading 1-6 · bulletList/orderedList of single-
//   paragraph items · codeBlock with an optional bounded language attribute
//
// Hostile input never reaches the provider: oversized input and control characters are rejected
// with the parser's typed reasons. Output size is linear in input size by construction (every
// input character lands in exactly one text node), so a valid composition always fits the
// executors' serialized request-body ceiling for any input within the parser bound.

import {
  parseMarkdownLiteBlocks,
  type MarkdownLiteBlock,
  type MarkdownLiteRejectionReason,
} from "./markdown-lite-blocks.js";

export const ADF_COMPOSED_DOC_VERSION = 1;

export interface AdfComposedTextNode {
  readonly type: "text";
  readonly text: string;
}

export interface AdfComposedHardBreakNode {
  readonly type: "hardBreak";
}

export type AdfComposedInlineNode = AdfComposedTextNode | AdfComposedHardBreakNode;

export interface AdfComposedParagraphNode {
  readonly type: "paragraph";
  readonly content: readonly AdfComposedInlineNode[];
}

export interface AdfComposedHeadingNode {
  readonly type: "heading";
  readonly attrs: { readonly level: number };
  readonly content: readonly AdfComposedTextNode[];
}

export interface AdfComposedCodeBlockNode {
  readonly type: "codeBlock";
  readonly attrs?: { readonly language: string } | undefined;
  readonly content: readonly AdfComposedTextNode[];
}

export interface AdfComposedListItemNode {
  readonly type: "listItem";
  readonly content: readonly AdfComposedParagraphNode[];
}

export interface AdfComposedBulletListNode {
  readonly type: "bulletList";
  readonly content: readonly AdfComposedListItemNode[];
}

export interface AdfComposedOrderedListNode {
  readonly type: "orderedList";
  readonly attrs?: { readonly order: number } | undefined;
  readonly content: readonly AdfComposedListItemNode[];
}

export type AdfComposedBlockNode =
  | AdfComposedParagraphNode
  | AdfComposedHeadingNode
  | AdfComposedCodeBlockNode
  | AdfComposedBulletListNode
  | AdfComposedOrderedListNode;

export interface AdfComposedDocument {
  readonly version: typeof ADF_COMPOSED_DOC_VERSION;
  readonly type: "doc";
  readonly content: readonly AdfComposedBlockNode[];
}

export type PlainTextToAdfResult =
  | { readonly ok: true; readonly doc: AdfComposedDocument }
  | { readonly ok: false; readonly reason: MarkdownLiteRejectionReason };

// ADF text nodes must be non-empty; empty lines/items compose to structure without a text node.
function textNodes(text: string): readonly AdfComposedTextNode[] {
  return text.length === 0 ? [] : [{ type: "text", text }];
}

function paragraphNode(lines: readonly string[]): AdfComposedParagraphNode {
  const content: AdfComposedInlineNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...textNodes(line));
  });
  return { type: "paragraph", content };
}

function listItemNode(text: string): AdfComposedListItemNode {
  return { type: "listItem", content: [paragraphNode([text])] };
}

function codeBlockNode(language: string, lines: readonly string[]): AdfComposedCodeBlockNode {
  return {
    type: "codeBlock",
    ...(language.length === 0 ? {} : { attrs: { language } }),
    content: textNodes(lines.join("\n")),
  };
}

function blockNode(block: MarkdownLiteBlock): AdfComposedBlockNode {
  switch (block.kind) {
    case "paragraph":
      return paragraphNode(block.lines);
    case "heading":
      return { type: "heading", attrs: { level: block.level }, content: textNodes(block.text) };
    case "bulletList":
      return { type: "bulletList", content: block.items.map(listItemNode) };
    case "orderedList":
      return {
        type: "orderedList",
        ...(block.start === 1 ? {} : { attrs: { order: block.start } }),
        content: block.items.map(listItemNode),
      };
    case "codeBlock":
      return codeBlockNode(block.language, block.lines);
  }
}

// Compose one bounded markdown-lite input into an ADF v1 document. Deterministic and total over
// the accepted domain; hostile input is rejected with the parser's typed reason and nothing is
// composed.
export function composePlainTextToAdf(input: string): PlainTextToAdfResult {
  const parsed = parseMarkdownLiteBlocks(input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    doc: {
      version: ADF_COMPOSED_DOC_VERSION,
      type: "doc",
      content: parsed.blocks.map(blockNode),
    },
  };
}
