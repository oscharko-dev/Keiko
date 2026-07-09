// Plain-text + markdown adapter (Epic #189, Issue #266). Pure: takes bytes, returns a
// ParserResult. Plain text emits a single section unit covering the whole document; markdown
// is split on ATX-style headings (`^#{1,6}\\s`) into one section per heading run with the
// hierarchical sectionPath populated from heading text.
//
// Source code (.ts/.js/.py/.yaml/etc) routes here too via `languageHint`. The lexical scan
// runs once over the decoded string and stops emitting units the moment any limit (deadline
// / cancellation / unit count) trips.

import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts";

import {
  decodeUtf8,
  diagnostic,
  emptyResult,
  oversizeDiagnostic,
  shouldStop,
} from "./_internal.js";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "text";
const PARSER_VERSION = "1";

// Extensions accepted by the text adapter. The list is intentionally explicit so unknown
// binary extensions fall through to the unsupported adapter rather than being mis-parsed as
// "plain text". `languageHint` is emitted for source / config files so #195 (chunker) can
// route them through code-aware splitters when those land.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS);

const TEXT_MEDIA_PREFIXES: readonly string[] = ["text/"];

function isMarkdown(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (ext === "md" || ext === "markdown") return true;
  return input.mediaType.toLowerCase() === "text/markdown";
}

function isTextLike(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const media = input.mediaType.toLowerCase();
  for (const prefix of TEXT_MEDIA_PREFIXES) {
    if (media.startsWith(prefix)) return true;
  }
  return false;
}

// ATX heading line: zero leading spaces, 1-6 `#`, at least one space, then text.
// Strict ATX: setext headings (=== / ---) are deliberately out of scope to keep the scanner
// simple and one-pass.
interface MarkdownHeading {
  readonly level: number;
  readonly text: string;
  readonly characterStart: number;
}

interface MarkdownLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function scanHeadings(text: string): readonly MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let inFence = false;
  let pendingSetext: MarkdownLine | undefined;
  for (const lineInfo of markdownLines(text)) {
    const line = lineInfo.text;
    if (isFenceLine(line)) {
      inFence = !inFence;
      pendingSetext = undefined;
      continue;
    }
    if (inFence) continue;
    const setext = matchSetextUnderline(line);
    if (setext !== null && pendingSetext !== undefined) {
      out.push({
        level: setext,
        text: pendingSetext.text.trim(),
        characterStart: pendingSetext.start,
      });
      pendingSetext = undefined;
      continue;
    }
    const heading = matchAtxHeading(line);
    if (heading !== null) {
      out.push({ ...heading, characterStart: lineInfo.start });
      pendingSetext = undefined;
      continue;
    }
    pendingSetext =
      line.trim().length > 0 && !isMarkdownTableSeparator(line) ? lineInfo : undefined;
  }
  return out;
}

const HASH = 0x23;
const SPACE = 0x20;
const TAB = 0x09;

function isHSpace(code: number): boolean {
  return code === SPACE || code === TAB;
}

function countHashes(line: string): number {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === HASH && i < 6) i += 1;
  return i;
}

function skipHSpace(line: string, from: number): number {
  let i = from;
  while (i < line.length && isHSpace(line.charCodeAt(i))) i += 1;
  return i;
}

function trimAtxTrailing(line: string, start: number): number {
  let end = line.length;
  while (end > start && isHSpace(line.charCodeAt(end - 1))) end -= 1;
  while (end > start && line.charCodeAt(end - 1) === HASH) end -= 1;
  while (end > start && isHSpace(line.charCodeAt(end - 1))) end -= 1;
  return end;
}

function matchAtxHeading(line: string): { readonly level: number; readonly text: string } | null {
  const level = countHashes(line);
  if (level < 1 || level > 6) return null;
  if (level >= line.length || !isHSpace(line.charCodeAt(level))) return null;
  const textStart = skipHSpace(line, level + 1);
  const textEnd = trimAtxTrailing(line, textStart);
  if (textEnd <= textStart) return null;
  return { level, text: line.slice(textStart, textEnd) };
}

function markdownLines(text: string): readonly MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    lines.push({ text: text.slice(cursor, lineEnd), start: cursor, end: lineEnd });
    cursor = lineEnd + 1;
  }
  return lines;
}

function isFenceLine(line: string): boolean {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  if (indent > 3) return false;
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function matchSetextUnderline(line: string): 1 | 2 | null {
  const trimmed = line.trim();
  if (/^=+\s*$/u.test(trimmed)) return 1;
  if (/^-+\s*$/u.test(trimmed) && trimmed.length >= 3) return 2;
  return null;
}

function splitMarkdownTableRow(line: string): readonly string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  return body.split("|").map((part) => part.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function isMarkdownTableHeader(line: string, nextLine: string | undefined): boolean {
  return line.includes("|") && nextLine !== undefined && isMarkdownTableSeparator(nextLine);
}

interface MarkdownEmission {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

function sectionUnit(
  input: ParserSelectionInput,
  path: readonly string[],
  start: number,
  end: number,
): ParsedUnit {
  return {
    kind: "section",
    documentId: input.documentId,
    sectionPath: path,
    characterStart: start,
    characterEnd: end,
  };
}

function pushHeading(
  stack: string[],
  current: MarkdownHeading,
  next: MarkdownHeading | undefined,
  text: string,
  input: ParserSelectionInput,
): ParsedUnit {
  while (stack.length >= current.level) stack.pop();
  stack.push(current.text);
  const sectionEnd = next === undefined ? text.length : next.characterStart;
  return sectionUnit(input, [...stack], current.characterStart, sectionEnd);
}

function emitMarkdownSections(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): MarkdownEmission {
  const headings = scanHeadings(text);
  if (headings.length === 0) {
    return emitPlainSection(text, input, options, startedAt);
  }
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const stack: string[] = [];
  const firstStart = headings[0]?.characterStart ?? 0;
  if (firstStart > 0) units.push(sectionUnit(input, [], 0, firstStart));
  for (let i = 0; i < headings.length; i += 1) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    const current = headings[i];
    if (current === undefined) break;
    units.push(pushHeading(stack, current, headings[i + 1], text, input));
  }
  return { units, diagnostics };
}

// eslint-disable-next-line complexity
function emitMarkdownTableRows(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
  initialUnitCount: number,
): MarkdownEmission {
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const lines = markdownLines(text);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (isFenceLine(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!isMarkdownTableHeader(line.text, lines[i + 1]?.text)) continue;
    const tableName = "markdown-table";
    let rowIndex = 0;
    i += 2;
    while (i < lines.length) {
      const row = lines[i];
      if (row === undefined || !row.text.includes("|") || row.text.trim().length === 0) {
        i -= 1;
        break;
      }
      const limit = shouldStop(startedAt, options, initialUnitCount + units.length);
      if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
        diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
        return { units, diagnostics };
      }
      units.push({
        kind: "csv-row",
        documentId: input.documentId,
        tableName,
        rowIndex,
        characterStart: row.start,
        characterEnd: row.end,
      });
      rowIndex += 1;
      i += 1;
    }
  }
  return { units, diagnostics };
}

function emitPlainSection(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): MarkdownEmission {
  const limit = shouldStop(startedAt, options, 0);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    return {
      units: [],
      diagnostics: [diagnostic(limit.code, limit.message, input.documentId, "info")],
    };
  }
  return {
    units: [
      {
        kind: "section",
        documentId: input.documentId,
        sectionPath: [],
        characterStart: 0,
        characterEnd: text.length,
      },
    ],
    diagnostics: [],
  };
}

export const textParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isTextLike(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(textParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const startedAt = options.now();
    const decoded = decodeUtf8(input.bytes);
    const emission = isMarkdown(input)
      ? emitMarkdownSections(decoded.text, input, options, startedAt)
      : emitPlainSection(decoded.text, input, options, startedAt);
    const tableEmission = isMarkdown(input)
      ? emitMarkdownTableRows(decoded.text, input, options, startedAt, emission.units.length)
      : { units: [], diagnostics: [] };
    return {
      ...emptyResult(
        textParser.capability,
        input.documentId,
        options,
        [...emission.diagnostics, ...tableEmission.diagnostics],
        [...emission.units, ...tableEmission.units],
      ),
      normalizedText: decoded.text,
    } satisfies InternalParserResult;
  },
});
