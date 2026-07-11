// Deterministic plain-text/markdown-lite → Confluence storage-format composition (Issue #2244,
// Epic #2238, ADR-0128 D1). Composes the OUTBOUND page/comment body (`representation:
// "storage"`) from bounded local input. Model-free, pure, and golden-tested.
//
// The input dialect is the shared markdown-lite block grammar (`markdown-lite-blocks.ts`) — the
// SAME parser that feeds the ADF composer, so the two output formats can never drift. Emitted
// XHTML vocabulary (deliberately small, plain storage-format elements only):
//
//   <p> (lines joined by <br/>) · <h1>-<h6> · <ul>/<ol start="n"> of <li> items ·
//   <pre><code> for code fences
//
// Injection safety by construction: EVERY text position is escaped through one escaper
// (& < > " ' → entities) before it enters the markup, and the dialect has no raw-HTML
// passthrough, no attribute-valued user input, and no CDATA section — so `<script>` (or any
// other tag) in the input can only ever appear as escaped text, never as markup. The code-fence
// language hint is intentionally dropped here: emitting it would require an attribute carrying
// user-adjacent input, and a `<pre><code>` block renders correctly without it. Hostile input
// (oversized, control characters) is rejected with the parser's typed reasons. Output size is
// linear in input size (bounded escape expansion factor), so a valid composition always fits
// the executors' serialized request-body ceiling for any input within the parser bound.

import {
  parseMarkdownLiteBlocks,
  type MarkdownLiteBlock,
  type MarkdownLiteRejectionReason,
} from "./markdown-lite-blocks.js";

export type PlainTextToStorageFormatResult =
  | { readonly ok: true; readonly xhtml: string }
  | { readonly ok: false; readonly reason: MarkdownLiteRejectionReason };

// The single escaper every text position flows through. `&` first, then the markup-significant
// characters; quotes are escaped too so the output stays safe even if a future change ever
// embeds it in an attribute position.
export function escapeStorageFormatText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphXhtml(lines: readonly string[]): string {
  return `<p>${lines.map(escapeStorageFormatText).join("<br/>")}</p>`;
}

function listXhtml(tag: "ul" | "ol", start: number, items: readonly string[]): string {
  const attrs = tag === "ol" && start !== 1 ? ` start="${String(start)}"` : "";
  const rendered = items.map((item) => `<li>${escapeStorageFormatText(item)}</li>`).join("");
  return `<${tag}${attrs}>${rendered}</${tag}>`;
}

function blockXhtml(block: MarkdownLiteBlock): string {
  switch (block.kind) {
    case "paragraph":
      return paragraphXhtml(block.lines);
    case "heading":
      return `<h${String(block.level)}>${escapeStorageFormatText(block.text)}</h${String(block.level)}>`;
    case "bulletList":
      return listXhtml("ul", 1, block.items);
    case "orderedList":
      return listXhtml("ol", block.start, block.items);
    case "codeBlock":
      return `<pre><code>${escapeStorageFormatText(block.lines.join("\n"))}</code></pre>`;
  }
}

// Compose one bounded markdown-lite input into escaped Confluence storage-format XHTML.
// Deterministic and total over the accepted domain; hostile input is rejected with the parser's
// typed reason and nothing is composed.
export function composePlainTextToStorageFormat(input: string): PlainTextToStorageFormatResult {
  const parsed = parseMarkdownLiteBlocks(input);
  if (!parsed.ok) return parsed;
  return { ok: true, xhtml: parsed.blocks.map(blockXhtml).join("") };
}
