import { LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import type { LineMatcher } from "./repoSearchMatchers.js";
import { decodeHTML } from "entities";
import { htmlProbeTagEnd } from "./binaryDetect.js";

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS);
const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "var",
]);
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
const TAG_HEAD_RE = /<\/?([A-Za-z][A-Za-z0-9-]{0,31})/uy;

function descriptorHtmlTag(
  source: string,
  opening: number,
):
  | {
      readonly name: string;
      readonly end: number;
    }
  | undefined {
  TAG_HEAD_RE.lastIndex = opening;
  const name = TAG_HEAD_RE.exec(source)?.[1]?.toLowerCase();
  const doctype = /^<!doctype\b/iu.test(source.slice(opening, opening + 10));
  if ((!doctype && name === undefined) || RAW_TEXT_TAGS.has(name ?? "")) return undefined;
  const end = htmlProbeTagEnd(source, doctype ? opening + 2 : TAG_HEAD_RE.lastIndex);
  return end === undefined ? undefined : { name: name ?? "doctype", end };
}

function descriptorHtmlFileSafe(source: string): boolean {
  let cursor = 0;
  for (;;) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) return true;
    const tag = descriptorHtmlTag(source, opening);
    if (tag === undefined) return false;
    if (source.slice(opening, tag.end).includes("\n")) return false;
    cursor = tag.end;
  }
}

function descriptorHtmlLine(line: string): string | undefined {
  if (line.length > 4096) return undefined;
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const opening = line.indexOf("<", cursor);
    if (opening < 0) break;
    const tag = descriptorHtmlTag(line, opening);
    if (tag === undefined) return undefined;
    parts.push(line.slice(cursor, opening), INLINE_TAGS.has(tag.name) ? "" : "\n");
    cursor = tag.end;
  }
  parts.push(line.slice(cursor));
  return parts.join("").split("\n").map(projectedLine).join("\n");
}

function htmlDescriptorWitness(matcher: LineMatcher, content: string): boolean {
  if (matcher.matchesSourceDescriptor === undefined) return false;
  return content.split("\n").some((line) => {
    const projected = descriptorHtmlLine(line);
    return projected !== undefined && matcher.matchesSourceDescriptor?.(projected) === true;
  });
}

export function isHtmlSearchPath(scopePath: string): boolean {
  return HTML_EXTENSIONS.has(scopePath.slice(scopePath.lastIndexOf(".") + 1).toLowerCase());
}

function projectedLine(line: string): string {
  // Encoded line breaks separate human terms but cannot introduce new physical source lines.
  return decodeHTML(line).replaceAll("\r", " ").replaceAll("\n", " ");
}

export function htmlEntitySearchText(scopePath: string, text: string): string {
  if (!isHtmlSearchPath(scopePath) || !text.includes("&")) return text;
  return text.split("\n").map(projectedLine).join("\n");
}

export function htmlEntityLineMatcher(matcher: LineMatcher, documentText?: string): LineMatcher {
  const base = matcher.matchWithoutSourceDescriptor ?? matcher.match;
  // Optional relevance declines for raw text/comments or multiline tags whose local line is
  // not independently known to be document text. Ordinary source matching stays available.
  const descriptorAllowed =
    matcher.matchesSourceDescriptor !== undefined &&
    documentText !== undefined &&
    descriptorHtmlFileSafe(documentText);
  return {
    ...matcher,
    matchesSourceDescriptor: descriptorAllowed
      ? (content: string): boolean => htmlDescriptorWitness(matcher, content)
      : undefined,
    match: (line, sourceLine): number =>
      Math.max(
        base(line, sourceLine),
        base(projectedLine(line), sourceLine),
        descriptorAllowed && htmlDescriptorWitness(matcher, line) ? 1 : 0,
      ),
  };
}
