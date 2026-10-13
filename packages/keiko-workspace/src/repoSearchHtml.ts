import { LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import type { LineMatcher } from "./repoSearchMatchers.js";
import { decodeHTML } from "entities";

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS);

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

export function htmlEntityLineMatcher(matcher: LineMatcher): LineMatcher {
  return {
    requiresSourceClassification: matcher.requiresSourceClassification,
    match: (line, sourceLine): number =>
      Math.max(matcher.match(line, sourceLine), matcher.match(projectedLine(line), sourceLine)),
  };
}
