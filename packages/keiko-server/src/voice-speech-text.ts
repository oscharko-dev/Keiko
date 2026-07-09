const SOURCE_HEADING =
  /^\s{0,3}(?:#{1,6}\s+|\*\*|__)?(?:sources|references|citations|quellen|belege|nachweise)\s*:?(?:\*\*|__)?\s*$/iu;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^\n)]*\)/gu;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\([^\n)]*\)/gu;
const AUTOLINK_URL = /<https?:\/\/[^\s<>]+>/giu;
const BARE_URL = /https?:\/\/[^\s<>]+/giu;
const CITATION_MARKER = /\s*\[(?:\^?\d+|[A-Za-z]+-?\d+)\]/gu;
const REFERENCE_DEFINITION = /^\s*\[(?:\^?\d+|[^\]]+)\]:\s+/u;
const HTML_RAW_CONTENT = /<(?:script|style)\b[^>]*>.*?(?:<\/(?:script|style)\s*>|$)/giu;
const HTML_TAG = /<\/?[A-Za-z][^>\n]*(?:>|$)/gu;

function stripMarkdown(line: string): string {
  return line
    .replace(MARKDOWN_IMAGE, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(AUTOLINK_URL, "")
    .replace(BARE_URL, "")
    .replace(CITATION_MARKER, "")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "")
    .replace(HTML_RAW_CONTENT, "")
    .replace(HTML_TAG, "")
    .replaceAll("<", "")
    .replaceAll(">", "")
    .replace(/[*_~]+/gu, "");
}

function normalizeProse(text: string): string {
  return text
    .replace(/\(\s*\)|\[\s*\]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([:;,])\s*([.!?])/gu, "$2")
    .trim();
}

function speakableLine(line: string): string | undefined {
  if (REFERENCE_DEFINITION.test(line)) return undefined;
  const heading = /^\s{0,3}#{1,6}\s+/u.test(line);
  const prose = normalizeProse(stripMarkdown(line));
  if (prose.length === 0) return undefined;
  return heading && !/[.!?]$/u.test(prose) ? `${prose}.` : prose;
}

/**
 * Produces a speech-only rendering of visible Markdown. The visible answer remains untouched for
 * review and clickable citations; URLs, citation syntax, source appendices, and fenced code never
 * reach synthesis or realtime response instructions.
 */
export function toSpeakableText(markdown: string): string {
  const parts: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (SOURCE_HEADING.test(line)) break;
    const part = speakableLine(line);
    if (part !== undefined) parts.push(part);
  }
  return normalizeProse(parts.join(" "));
}
