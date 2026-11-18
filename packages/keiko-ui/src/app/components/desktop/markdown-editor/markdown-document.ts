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

// A fence may carry trailing blanks, as the server's template parser reads it (it trims line ends).
const FRONT_MATTER = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u;

export function splitMarkdownDocument(text: string): MarkdownDocumentParts {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return { frontMatter: undefined, body: text };
  const rest = text.slice(match[0].length);
  return { frontMatter: match[1] ?? "", body: rest.replace(/^\r?\n/u, "") };
}

export function joinMarkdownDocument(parts: MarkdownDocumentParts): string {
  if (parts.frontMatter === undefined) return parts.body;
  const body = parts.body.length > 0 ? `\n${parts.body}` : "";
  return `---\n${parts.frontMatter}\n---\n${body}`;
}

/**
 * The text with its body replaced and everything before the body kept byte for byte: the fences (with
 * any trailing blanks), the line endings and the front matter. A document without front matter is its body.
 */
export function replaceMarkdownBody(text: string, body: string): string {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return body;
  if (body.length === 0) return match[0];
  const head = match[0].endsWith("\n") ? match[0] : `${match[0]}\n`;
  const blank = /^\r?\n/u.exec(text.slice(match[0].length))?.[0];
  return head + (blank ?? "") + body;
}

export function replaceMarkdownFrontMatter(text: string, frontMatter: string): string {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return text;
  const start = text.indexOf("\n") + 1;
  return text.slice(0, start) + frontMatter + text.slice(start + (match[1]?.length ?? 0));
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
