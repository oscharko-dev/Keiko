// Code-aware text parser (Issue #2569, ADR-0152 D8).
//
// This adapter owns no syntax tree and no second ingestion lane. It derives a conservative
// cross-language symbol table from the repository-search definition patterns that pre-date this
// pod, then emits ordinary `section` ParsedUnits through the existing registry. The section path
// is a display-safe symbol label; code-only chunking behavior is selected by this parser's stable
// identity rather than by smuggling a new ParsedUnit kind through contracts.

import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";

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

export const CODE_PARSER_ID = "code-text" as const;
const CODE_PARSER_VERSION = "1";

const CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  cjs: "javascript",
  go: "go",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  mjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
});

interface SymbolPattern {
  readonly kind: "constant" | "function" | "type";
  readonly pattern: RegExp;
}

// Derived from grounded-orchestrator.ts's symbolDefinitionPatterns table (Issue #2569). Keep the
// table local: importing a server module here would reverse the ADR-0019 dependency direction.
const SYMBOL_PATTERNS: readonly SymbolPattern[] = Object.freeze([
  {
    kind: "function",
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/u,
  },
  { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/u },
  {
    kind: "function",
    pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/u,
  },
  {
    kind: "function",
    pattern:
      /^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|extern(?:\s+"[^"]+")?)\s+)*fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]+>)?\s*\(/u,
  },
  {
    kind: "function",
    pattern:
      /^\s*(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|tailrec)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_][\w]*)\s*\(/u,
  },
  {
    kind: "type",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/u,
  },
  {
    kind: "type",
    pattern:
      /^\s*(?:(?:public|private|protected|abstract|final|sealed|data|open|internal)\s+)*(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)\b/u,
  },
  { kind: "type", pattern: /^\s*(?:pub\s+)?(?:struct|trait|enum|type)\s+([A-Za-z_][\w]*)\b/u },
  {
    kind: "type",
    pattern: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/u,
  },
  { kind: "type", pattern: /^\s*class\s+([A-Za-z_][\w]*)\b/u },
  {
    kind: "constant",
    pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/u,
  },
  {
    kind: "function",
    pattern:
      /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)*(?:<[^>]+>\s+)?[A-Za-z_$][\w$<>, ?.[\]]*\s+([A-Za-z_$][\w$]*)\s*\(/u,
  },
]);

interface CodeLine {
  readonly start: number;
  readonly text: string;
}

interface SymbolAnchor {
  readonly characterStart: number;
  readonly label: string;
}

function codeLanguage(input: ParserSelectionInput): string | undefined {
  return CODE_LANGUAGE_BY_EXTENSION[input.extension.toLowerCase()];
}

function codeLines(text: string): readonly CodeLine[] {
  if (text.length === 0) return [];
  const lines: CodeLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, text: text.slice(start, end).replace(/\r$/u, "") });
    start = end + 1;
  }
  return lines;
}

export function codeSymbolLabel(line: string): string | undefined {
  for (const candidate of SYMBOL_PATTERNS) {
    const match = candidate.pattern.exec(line);
    const name = match?.[1];
    if (name !== undefined) return `${candidate.kind} ${name}`;
  }
  return undefined;
}

export function isCodeSymbolDefinitionLine(line: string): boolean {
  return codeSymbolLabel(line) !== undefined;
}

function symbolAnchors(text: string): readonly SymbolAnchor[] {
  const anchors: SymbolAnchor[] = [];
  for (const line of codeLines(text)) {
    const label = codeSymbolLabel(line.text);
    if (label !== undefined) anchors.push({ characterStart: line.start, label });
  }
  return anchors;
}

function sectionUnit(
  input: ParserSelectionInput,
  label: string,
  start: number,
  end: number,
): ParsedUnit {
  return {
    kind: "section",
    documentId: input.documentId,
    sectionPath: [label],
    characterStart: start,
    characterEnd: end,
  };
}

interface CodeEmission {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
}

function stopDiagnostic(
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
  emittedUnits: number,
): ParserDiagnostic | undefined {
  const limit = shouldStop(startedAt, options, emittedUnits);
  if (!limit.stop || limit.code === undefined || limit.message === undefined) return undefined;
  return diagnostic(limit.code, limit.message, input.documentId, "info");
}

function unitAnchors(text: string, language: string): readonly SymbolAnchor[] {
  const anchors = symbolAnchors(text);
  if (anchors.length === 0 || anchors[0]?.characterStart === 0) return anchors;
  return [{ characterStart: 0, label: `${language} module` }, ...anchors];
}

function emitCodeSections(
  text: string,
  language: string,
  input: ParserSelectionInput,
  options: ParserOptions,
  startedAt: number,
): CodeEmission {
  const anchors = unitAnchors(text, language);
  const effective =
    anchors.length === 0 ? [{ characterStart: 0, label: `${language} module` }] : anchors;
  const units: ParsedUnit[] = [];
  for (let index = 0; index < effective.length; index += 1) {
    const stopped = stopDiagnostic(input, options, startedAt, units.length);
    if (stopped !== undefined) return { units, diagnostics: [stopped] };
    const anchor = effective[index];
    if (anchor === undefined) break;
    const end = effective[index + 1]?.characterStart ?? text.length;
    units.push(sectionUnit(input, anchor.label, anchor.characterStart, end));
  }
  return { units, diagnostics: [] };
}

export const codeParser: ParserAdapter = Object.freeze({
  capability: Object.freeze({
    parserId: CODE_PARSER_ID,
    parserVersion: CODE_PARSER_VERSION,
    matches: (input: ParserSelectionInput): boolean => codeLanguage(input) !== undefined,
  }),
  parse: (input: ParserSelectionInput, options: ParserOptions) => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(codeParser.capability, input.documentId, options, [
        oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes),
      ]);
    }
    const startedAt = options.now();
    const decoded = decodeUtf8(input.bytes);
    const language = codeLanguage(input) ?? "code";
    const emission = emitCodeSections(decoded.text, language, input, options, startedAt);
    return {
      ...emptyResult(
        codeParser.capability,
        input.documentId,
        options,
        emission.diagnostics,
        emission.units,
      ),
      normalizedText: decoded.text,
    } satisfies InternalParserResult;
  },
});
