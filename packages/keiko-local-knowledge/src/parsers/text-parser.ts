// Plain-text + lightweight-markup adapter (Epic #189, Issue #266). Pure: takes bytes, returns a
// ParserResult. Plain text emits a single section unit covering the whole document; Markdown,
// reStructuredText and AsciiDoc are split on their headings into one section per heading run with
// the hierarchical sectionPath populated from heading text (see text-structure.ts for the heading
// forms and what is not structure).
//
// Configuration and text-like formats without a dedicated structural parser route here too via
// `languageHint`. Source-code formats owned by code-parser.ts are registered before this adapter.
// The lexical scan runs once over the decoded string and stops emitting units the moment any
// limit (deadline / cancellation / unit count) trips.

import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";
import { LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import {
  binaryContentReason,
  decodeUtf8,
  diagnostic,
  emptyResult,
  encodingDiagnostic,
  limitSeverity,
  shouldStop,
  textInputRefusal,
} from "./_internal.js";
import {
  isMarkdownTableSeparator,
  liveLines,
  scanHeadings,
  sourceLines,
  type Heading,
  type MarkupKind,
  type SourceLine,
} from "./text-structure.js";
import type {
  InternalParserResult,
  ParserAdapter,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

const PARSER_ID = "text";
const PARSER_VERSION = "2";

// Extensions accepted by the text adapter. The list is intentionally explicit so unknown
// binary extensions fall through to the unsupported adapter rather than being mis-parsed as
// "plain text". `languageHint` is emitted for source / config files so #195 (chunker) can
// route them through code-aware splitters when those land.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS);

const TEXT_MEDIA_PREFIXES: readonly string[] = ["text/"];

const MARKUP_BY_EXTENSION: Readonly<Record<string, MarkupKind>> = Object.freeze({
  md: "markdown",
  markdown: "markdown",
  rst: "rst",
  adoc: "asciidoc",
  asciidoc: "asciidoc",
});

const MARKUP_BY_MEDIA_TYPE: Readonly<Record<string, MarkupKind>> = Object.freeze({
  "text/markdown": "markdown",
  "text/x-rst": "rst",
  "text/asciidoc": "asciidoc",
});

function markupKind(input: ParserSelectionInput): MarkupKind {
  return (
    MARKUP_BY_EXTENSION[input.extension.toLowerCase()] ??
    MARKUP_BY_MEDIA_TYPE[input.mediaType.toLowerCase()] ??
    "plain"
  );
}

// Well-known files that have no extension and are plain text. The caller derives an empty extension
// for all of them, so the name is the only evidence; an arbitrary extension-less file (a binary, a
// dotfile that may hold credentials) is not claimed.
const EXTENSIONLESS_TEXT_FILE_NAMES: ReadonlySet<string> = new Set([
  "authors",
  "changelog",
  "changes",
  "codeowners",
  "containerfile",
  "contributing",
  "contributors",
  "copying",
  "dockerfile",
  "gemfile",
  "gnumakefile",
  "jenkinsfile",
  "license",
  "licence",
  "maintainers",
  "makefile",
  "notice",
  "procfile",
  "rakefile",
  "readme",
  "vagrantfile",
]);

// Text exactly when the bytes carry no binary evidence.
function isExtensionlessText(input: ParserSelectionInput): boolean {
  return (
    input.extension === "" &&
    input.mediaType === "" &&
    input.fileName !== undefined &&
    EXTENSIONLESS_TEXT_FILE_NAMES.has(input.fileName.toLowerCase()) &&
    input.bytes.length > 0 &&
    binaryContentReason(input.bytes) === undefined
  );
}

function isTextLike(input: ParserSelectionInput): boolean {
  const ext = input.extension.toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (isExtensionlessText(input)) return true;
  const media = input.mediaType.toLowerCase();
  for (const prefix of TEXT_MEDIA_PREFIXES) {
    if (media.startsWith(prefix)) return true;
  }
  return false;
}

interface MarkupEmission {
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
  current: Heading,
  next: Heading | undefined,
  text: string,
  input: ParserSelectionInput,
): ParsedUnit {
  while (stack.length >= current.level) stack.pop();
  stack.push(current.text);
  const sectionEnd = next === undefined ? text.length : next.characterStart;
  return sectionUnit(input, [...stack], current.characterStart, sectionEnd);
}

function emitPlainSection(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): MarkupEmission {
  const limit = shouldStop(startedAt, options, 0);
  if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
    return {
      units: [],
      diagnostics: [
        diagnostic(limit.code, limit.message, input.documentId, limitSeverity(limit.code)),
      ],
    };
  }
  return { units: [sectionUnit(input, [], 0, text.length)], diagnostics: [] };
}

function emitHeadingSections(
  headings: readonly Heading[],
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): MarkupEmission {
  if (headings.length === 0) return emitPlainSection(text, input, options, startedAt);
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const stack: string[] = [];
  const firstStart = headings[0]?.characterStart ?? 0;
  if (firstStart > 0) units.push(sectionUnit(input, [], 0, firstStart));
  for (const [index, current] of headings.entries()) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(
        diagnostic(limit.code, limit.message, input.documentId, limitSeverity(limit.code)),
      );
      break;
    }
    units.push(pushHeading(stack, current, headings[index + 1], text, input));
  }
  return { units, diagnostics };
}

// ─── Markdown tables ─────────────────────────────────────────────────────────

function isTableHeader(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && isMarkdownTableSeparator(next);
}

function isTableRow(line: SourceLine | undefined, live: boolean): line is SourceLine {
  return line !== undefined && live && line.text.includes("|") && line.text.trim().length > 0;
}

interface TableRowScan {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly nextIndex: number;
  readonly stopped: boolean;
}

interface TableScanContext {
  readonly lines: readonly SourceLine[];
  readonly live: readonly boolean[];
  readonly input: ParserSelectionInput;
  readonly options: ParserOptions;
  readonly startedAt: number;
}

// Consumes the row lines of a single markdown table starting at `startIndex` (the first line
// after the header + separator). Stops at the first non-row line or once `shouldStop` trips.
function scanTableRows(
  context: TableScanContext,
  startIndex: number,
  tableName: string,
  baseUnitCount: number,
): TableRowScan {
  const { lines, live, input, options, startedAt } = context;
  const units: ParsedUnit[] = [];
  let index = startIndex;
  while (isTableRow(lines[index], live[index] === true)) {
    const row = lines[index];
    const limit = shouldStop(startedAt, options, baseUnitCount + units.length);
    if (row === undefined) break;
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      const stop = diagnostic(
        limit.code,
        limit.message,
        input.documentId,
        limitSeverity(limit.code),
      );
      return { units, diagnostics: [stop], nextIndex: index, stopped: true };
    }
    units.push({
      kind: "csv-row",
      documentId: input.documentId,
      tableName,
      rowIndex: units.length,
      characterStart: row.start,
      characterEnd: row.end,
    });
    index += 1;
  }
  return { units, diagnostics: [], nextIndex: index, stopped: false };
}

// The first table keeps the historical name; later tables of the same document are told apart by
// their ordinal so two tables never share a unit identity.
function tableNameFor(ordinal: number): string {
  return ordinal === 1 ? "markdown-table" : `markdown-table-${String(ordinal)}`;
}

function emitMarkdownTableRows(
  context: TableScanContext,
  initialUnitCount: number,
): MarkupEmission {
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  let tables = 0;
  let index = 0;
  while (index < context.lines.length) {
    const line = context.lines[index];
    const header =
      line !== undefined &&
      context.live[index] === true &&
      context.live[index + 1] === true &&
      isTableHeader(line.text, context.lines[index + 1]?.text);
    if (!header) {
      index += 1;
      continue;
    }
    tables += 1;
    const scan = scanTableRows(
      context,
      index + 2,
      tableNameFor(tables),
      initialUnitCount + units.length,
    );
    units.push(...scan.units);
    diagnostics.push(...scan.diagnostics);
    index = Math.max(scan.nextIndex, index + 2);
    if (scan.stopped) break;
  }
  return { units, diagnostics };
}

function emitStructure(
  text: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): MarkupEmission {
  const kind = markupKind(input);
  if (kind === "plain") return emitPlainSection(text, input, options, startedAt);
  const lines = sourceLines(text);
  const live = liveLines(lines, kind);
  const sections = emitHeadingSections(
    scanHeadings(lines, live, kind),
    text,
    input,
    options,
    startedAt,
  );
  if (kind !== "markdown") return sections;
  const tables = emitMarkdownTableRows(
    { lines, live, input, options, startedAt },
    sections.units.length,
  );
  return {
    units: [...sections.units, ...tables.units],
    diagnostics: [...sections.diagnostics, ...tables.diagnostics],
  };
}

export const textParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: PARSER_ID,
    parserVersion: PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => isTextLike(input),
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    const refusal = textInputRefusal(textParser.capability, input, options);
    if (refusal !== undefined) return refusal;
    const startedAt = options.now();
    const decoded = decodeUtf8(input.bytes);
    const encoding = encodingDiagnostic(decoded, input.documentId);
    const emission = emitStructure(decoded.text, input, options, startedAt);
    return {
      ...emptyResult(
        textParser.capability,
        input.documentId,
        options,
        [...(encoding === undefined ? [] : [encoding]), ...emission.diagnostics],
        emission.units,
      ),
      normalizedText: decoded.text,
    } satisfies InternalParserResult;
  },
});
