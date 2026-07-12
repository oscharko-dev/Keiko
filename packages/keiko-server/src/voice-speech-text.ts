const SOURCE_HEADING =
  /^\s{0,3}(?:#{1,6}\s+|\*\*|__)?(?:sources|references|citations|quellen|belege|nachweise)\s*:?(?:\*\*|__)?\s*$/iu;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^\n)]*\)/gu;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\([^\n)]*\)/gu;
const AUTOLINK_URL = /<https?:\/\/[^\s<>]+>/giu;
const BARE_URL = /https?:\/\/[^\s<>]+/giu;
const CITATION_MARKER = /\s*\[(?:\^?\d+|[A-Za-z]+-?\d+)\]/gu;
const REFERENCE_DEFINITION = /^\s*\[(?:\^?\d+|[^\]]+)\]:\s+/u;

function isTagBoundary(value: string | undefined): boolean {
  return value === undefined || value === ">" || value === "/" || value.trim().length === 0;
}

function rawElementStart(lowerText: string, tagName: string, from: number): number {
  let cursor = from;
  while (cursor < lowerText.length) {
    const start = lowerText.indexOf(`<${tagName}`, cursor);
    if (start < 0) return -1;
    if (isTagBoundary(lowerText[start + tagName.length + 1])) return start;
    cursor = start + 1;
  }
  return -1;
}

function stripRawElement(text: string, tagName: "script" | "style"): string {
  const lowerText = text.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = rawElementStart(lowerText, tagName, cursor);
    if (start < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const close = lowerText.indexOf(`</${tagName}`, start + tagName.length + 1);
    if (close < 0) break;
    const closeEnd = text.indexOf(">", close + tagName.length + 2);
    if (closeEnd < 0) break;
    cursor = closeEnd + 1;
  }
  return parts.join("");
}

function stripHtml(text: string): string {
  const withoutRawContent = stripRawElement(stripRawElement(text, "script"), "style");
  const parts: string[] = [];
  let inTag = false;
  for (const character of withoutRawContent) {
    if (character === "<") inTag = true;
    else if (character === ">") inTag = false;
    else if (!inTag) parts.push(character);
  }
  return parts.join("");
}

function stripMarkdown(line: string): string {
  const withoutMarkdown = line
    .replace(MARKDOWN_IMAGE, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(AUTOLINK_URL, "")
    .replace(BARE_URL, "")
    .replace(CITATION_MARKER, "")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "");
  return stripHtml(withoutMarkdown).replace(/[*_~]+/gu, "");
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
