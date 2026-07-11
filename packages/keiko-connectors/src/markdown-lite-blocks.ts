// Shared markdown-lite block parser for the deterministic write composers (Issue #2244, Epic
// #2238, ADR-0128 D1).
//
// ONE parser feeds BOTH renderers (plain-text→ADF and plain-text→storage-format), so the two
// output formats can never drift on what the input dialect means. The dialect is deliberately
// SMALL and closed — there is no inline markup, no nesting, no HTML passthrough, and no model
// involvement anywhere:
//
//   - Blank lines separate blocks.
//   - `# ` … `###### ` at line start opens a heading (level = number of `#`).
//   - `- ` at line start opens a bullet-list item; consecutive items form one list.
//   - `<digits>. ` at line start opens an ordered-list item; consecutive items form one list and
//     the first item's number is the list's start.
//   - ``` opens a code fence (optional language word after the fence); the matching ``` line
//     closes it; an unterminated fence runs to end of input. Fence content is verbatim text.
//   - Every other run of non-blank lines is one paragraph; single newlines inside a paragraph
//     are preserved as explicit line breaks by the renderers.
//
// Hostile input is rejected with a typed result, never partially parsed: input longer than
// `MARKDOWN_LITE_MAX_INPUT_CHARS` is `input-too-large`, and any control character other than
// `\n`/`\t` (after `\r\n`/`\r` → `\n` normalization) — including DEL and the C1 range — is
// `control-characters`. Parsing is pure and deterministic: the same input always yields the
// same block list, and output size is linear in input size by construction (every input
// character lands in at most one block).

// Bounded composer input (well below the serialized request-body ceiling, see
// ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES in atlassian-http-port.ts).
export const MARKDOWN_LITE_MAX_INPUT_CHARS = 100_000;
// Language word after a code fence: bounded, word-ish characters only; anything else is dropped
// (the fence still opens — a hostile "language" can never smuggle markup or attributes).
const CODE_FENCE_LANGUAGE_PATTERN = /^[A-Za-z0-9+#.-]{1,32}$/u;
// C0 controls except \t (\n is the line separator and \r is normalized away first), plus DEL and
// the C1 range. Any match rejects the whole input — silent stripping could change meaning.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const FORBIDDEN_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export type MarkdownLiteRejectionReason = "input-too-large" | "control-characters";

export type MarkdownLiteHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MarkdownLiteBlock =
  | { readonly kind: "paragraph"; readonly lines: readonly string[] }
  | { readonly kind: "heading"; readonly level: MarkdownLiteHeadingLevel; readonly text: string }
  | { readonly kind: "bulletList"; readonly items: readonly string[] }
  | { readonly kind: "orderedList"; readonly start: number; readonly items: readonly string[] }
  | { readonly kind: "codeBlock"; readonly language: string; readonly lines: readonly string[] };

export type MarkdownLiteParseResult =
  | { readonly ok: true; readonly blocks: readonly MarkdownLiteBlock[] }
  | { readonly ok: false; readonly reason: MarkdownLiteRejectionReason };

const HEADING_PATTERN = /^(#{1,6}) (.*)$/u;
const BULLET_ITEM_PATTERN = /^- (.*)$/u;
const ORDERED_ITEM_PATTERN = /^(\d{1,9})\. (.*)$/u;
const CODE_FENCE_PATTERN = /^```(.*)$/u;

interface ParserState {
  readonly blocks: MarkdownLiteBlock[];
  paragraph: string[];
  bullets: string[];
  ordered: { start: number; items: string[] } | undefined;
}

function flushParagraph(state: ParserState): void {
  if (state.paragraph.length > 0) {
    state.blocks.push({ kind: "paragraph", lines: state.paragraph });
    state.paragraph = [];
  }
}

function flushLists(state: ParserState): void {
  if (state.bullets.length > 0) {
    state.blocks.push({ kind: "bulletList", items: state.bullets });
    state.bullets = [];
  }
  if (state.ordered !== undefined) {
    state.blocks.push({
      kind: "orderedList",
      start: state.ordered.start,
      items: state.ordered.items,
    });
    state.ordered = undefined;
  }
}

function flushAll(state: ParserState): void {
  flushParagraph(state);
  flushLists(state);
}

function fenceLanguageOf(fenceRest: string): string {
  const candidate = fenceRest.trim();
  return CODE_FENCE_LANGUAGE_PATTERN.test(candidate) ? candidate : "";
}

// Consumes the fence body starting AFTER the opening fence line; returns the index of the line
// after the closing fence (or lines.length for an unterminated fence, which runs to the end).
function consumeCodeFence(state: ParserState, lines: readonly string[], openIndex: number): number {
  const language = fenceLanguageOf(CODE_FENCE_PATTERN.exec(lines[openIndex] ?? "")?.[1] ?? "");
  const body: string[] = [];
  let index = openIndex + 1;
  while (index < lines.length && lines[index] !== "```") {
    body.push(lines[index] ?? "");
    index += 1;
  }
  state.blocks.push({ kind: "codeBlock", language, lines: body });
  return index < lines.length ? index + 1 : index;
}

// A parsed ordered-list start is bounded by the 9-digit pattern, so it is always a safe integer.
function handleListOrParagraphLine(state: ParserState, line: string): void {
  const bullet = BULLET_ITEM_PATTERN.exec(line);
  if (bullet !== null) {
    flushParagraph(state);
    if (state.ordered !== undefined) flushLists(state);
    state.bullets.push(bullet[1] ?? "");
    return;
  }
  const ordered = ORDERED_ITEM_PATTERN.exec(line);
  if (ordered !== null) {
    flushParagraph(state);
    if (state.bullets.length > 0) flushLists(state);
    const start = Number.parseInt(ordered[1] ?? "1", 10);
    state.ordered ??= { start, items: [] };
    state.ordered.items.push(ordered[2] ?? "");
    return;
  }
  flushLists(state);
  state.paragraph.push(line);
}

function handleLine(state: ParserState, line: string): void {
  if (line.trim().length === 0) {
    flushAll(state);
    return;
  }
  const heading = HEADING_PATTERN.exec(line);
  if (heading !== null) {
    flushAll(state);
    const level = (heading[1] ?? "#").length as MarkdownLiteHeadingLevel;
    state.blocks.push({ kind: "heading", level, text: heading[2] ?? "" });
    return;
  }
  handleListOrParagraphLine(state, line);
}

// Parse one bounded markdown-lite input into its closed block list. Total over its accepted
// domain; hostile input (oversized, control characters) is rejected with a typed reason.
export function parseMarkdownLiteBlocks(input: string): MarkdownLiteParseResult {
  if (input.length > MARKDOWN_LITE_MAX_INPUT_CHARS) {
    return { ok: false, reason: "input-too-large" };
  }
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (FORBIDDEN_CONTROL_PATTERN.test(normalized)) {
    return { ok: false, reason: "control-characters" };
  }
  const lines = normalized.split("\n");
  const state: ParserState = { blocks: [], paragraph: [], bullets: [], ordered: undefined };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (CODE_FENCE_PATTERN.test(line)) {
      flushAll(state);
      index = consumeCodeFence(state, lines, index);
      continue;
    }
    handleLine(state, line);
    index += 1;
  }
  flushAll(state);
  return { ok: true, blocks: state.blocks };
}
