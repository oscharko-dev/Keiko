import { defaultMarkdownParser, defaultMarkdownSerializer } from "prosemirror-markdown";
import type { Node as DocumentNode } from "prosemirror-model";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { parseComposerMarkdown } from "../composer/composer-markdown";

/** A Markdown file split into its optional YAML front matter and the Markdown a person reads. */
export interface MarkdownDocumentParts {
  /** The YAML between the `---` fences, or undefined when the file has none. */
  readonly frontMatter: string | undefined;
  readonly body: string;
}

// A fence may carry trailing blanks, as the contracts template parser reads it (it trims line ends).
const FENCE_LINE = /^---[^\S\r\n]*$/u;

interface FrontMatterSpan {
  /** The YAML between the fences. */
  readonly yaml: string;
  /** Offset of the first YAML character (the start of the closing fence for an empty block). */
  readonly yamlStart: number;
  /** True when the closing fence directly follows the opening fence. */
  readonly emptyBlock: boolean;
  /** Offset just past the closing fence line, including its line break when it has one. */
  readonly end: number;
  /** The line break after the opening fence. */
  readonly eol: string;
}

function lineEnd(text: string, from: number): { readonly stop: number; readonly next: number } {
  const lf = text.indexOf("\n", from);
  if (lf === -1) return { stop: text.length, next: text.length };
  return { stop: text[lf - 1] === "\r" && lf > from ? lf - 1 : lf, next: lf + 1 };
}

/**
 * Finds the front matter the way the contracts parser does: an opening fence on the first line and
 * the first following line that is a fence (trailing blanks allowed, other text rejected).
 */
function findFrontMatter(text: string): FrontMatterSpan | undefined {
  const first = lineEnd(text, 0);
  if (first.next === first.stop || !FENCE_LINE.test(text.slice(0, first.stop))) return undefined;
  const eol = text.slice(first.stop, first.next);
  let from = first.next;
  while (from < text.length) {
    const line = lineEnd(text, from);
    if (FENCE_LINE.test(text.slice(from, line.stop))) {
      const emptyBlock = from === first.next;
      const yamlEnd = emptyBlock ? from : from - eolLengthBefore(text, from);
      return {
        yaml: text.slice(first.next, yamlEnd),
        yamlStart: first.next,
        emptyBlock,
        end: line.next,
        eol,
      };
    }
    from = line.next;
  }
  return undefined;
}

function eolLengthBefore(text: string, offset: number): number {
  return text[offset - 2] === "\r" ? 2 : 1;
}

export function splitMarkdownDocument(text: string): MarkdownDocumentParts {
  const span = findFrontMatter(text);
  if (span === undefined) return { frontMatter: undefined, body: text };
  const rest = text.slice(span.end);
  return { frontMatter: span.yaml, body: rest.replace(/^\r?\n/u, "") };
}

export function joinMarkdownDocument(parts: MarkdownDocumentParts): string {
  if (parts.frontMatter === undefined) return parts.body;
  const body = parts.body.length > 0 ? `\n${parts.body}` : "";
  return `---\n${parts.frontMatter}\n---\n${body}`;
}

/**
 * The text with its body replaced and everything before the body kept byte for byte: the fences (with
 * any trailing blanks), the line endings, the front matter and an existing blank separator. A
 * document without front matter is its body.
 */
export function replaceMarkdownBody(text: string, body: string): string {
  const span = findFrontMatter(text);
  if (span === undefined) return body;
  const head = text.slice(0, span.end);
  const separator = /^\r?\n/u.exec(text.slice(span.end))?.[0];
  if (body.length === 0) return head + (separator ?? "");
  const closed = head.endsWith("\n") ? head : head + span.eol;
  if (separator !== undefined) return closed + separator + body;
  // The body's own leading line break must survive the next split, which consumes one separator.
  return /^\r?\n/u.test(body) ? closed + span.eol + body : closed + body;
}

export function replaceMarkdownFrontMatter(text: string, frontMatter: string): string {
  const span = findFrontMatter(text);
  if (span === undefined) return text;
  if (span.emptyBlock) {
    if (frontMatter.length === 0) return text;
    return text.slice(0, span.yamlStart) + frontMatter + span.eol + text.slice(span.yamlStart);
  }
  return (
    text.slice(0, span.yamlStart) + frontMatter + text.slice(span.yamlStart + span.yaml.length)
  );
}

/**
 * Documents keep the author's code fences as written and escape literal Markdown characters; the
 * chat composer's serializer instead labels unlabelled code and keeps typed text literal.
 */
export function serializeMarkdownDocument(doc: DocumentNode): string {
  return defaultMarkdownSerializer.serialize(doc);
}

export function parseMarkdownDocument(body: string): DocumentNode {
  return parseComposerMarkdown(body);
}

/** GitHub Markdown the CommonMark editor schema cannot hold: a delimiter row starts a table. */
function hasUnsupportedLine(line: string): boolean {
  const text = line.trim();
  if (text.includes("|") && text.includes("-") && /^[|:\- ]+$/u.test(text)) return true;
  return /^[-*+] +\[[ xX]\]/u.test(text);
}

function hasUnsupportedInline(body: string): boolean {
  return body.includes("~~") || /\[\^[^\]\n]+\]/u.test(body) || /<\/?[A-Za-z!][^>\n]*>/u.test(body);
}

function renderedText(markdown: string): string {
  return defaultMarkdownParser.tokenizer.render(markdown).replace(/\s+/gu, " ").trim();
}

/**
 * The formatted view rewrites the Markdown it saves. It is offered only when that rewrite keeps
 * what the file means: same rendered result, and nothing the editor schema would flatten
 * (tables, task lists, strikethrough, footnotes, HTML).
 */
export function supportsFormattedEditing(body: string): boolean {
  if (hasUnsupportedInline(body) || body.split("\n").some(hasUnsupportedLine)) return false;
  try {
    const rewritten = serializeMarkdownDocument(parseMarkdownDocument(body));
    return renderedText(rewritten) === renderedText(body);
  } catch {
    // A token the editor schema has no node for: the document stays editable as Markdown source.
    reportClientDiagnostic("Keiko Markdown editor kept a document in Markdown source.", {
      composerActivity: "markdown-rich-unavailable",
    });
    return false;
  }
}
