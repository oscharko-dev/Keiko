import { posix as path } from "node:path";
import type { SymbolDefinitionKind } from "./symbolGraphTypes.js";
import type { WorkspaceLanguage } from "./types.js";

export interface DefinitionHit {
  readonly symbol: string;
  readonly line: number;
  readonly ordinal: number;
  readonly definitionKind: SymbolDefinitionKind;
}

export interface IdentifierHit {
  readonly symbol: string;
  readonly line: number;
  readonly ordinal: number;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const SUPPORTED_LANGUAGES = new Set<WorkspaceLanguage>(["typescript", "javascript"]);
const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";

const DEFINITION_PATTERNS: readonly {
  readonly regex: RegExp;
  readonly definitionKind: SymbolDefinitionKind;
}[] = [
  {
    regex: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+(${IDENTIFIER})\\b`,
      "gmu",
    ),
    definitionKind: "function",
  },
  {
    regex: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENTIFIER})\\b`,
      "gmu",
    ),
    definitionKind: "class",
  },
  {
    regex: new RegExp(`^\\s*(?:export\\s+)?interface\\s+(${IDENTIFIER})\\b`, "gmu"),
    definitionKind: "interface",
  },
  {
    regex: new RegExp(`^\\s*(?:export\\s+)?type\\s+(${IDENTIFIER})\\b`, "gmu"),
    definitionKind: "type",
  },
  {
    regex: new RegExp(`^\\s*(?:export\\s+)?enum\\s+(${IDENTIFIER})\\b`, "gmu"),
    definitionKind: "enum",
  },
  {
    regex: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\b`, "gmu"),
    definitionKind: "variable",
  },
];

export const IDENTIFIER_REGEX = new RegExp(`\\b(${IDENTIFIER})\\b`, "gu");
export const CALL_REGEX = new RegExp(`\\b(${IDENTIFIER})\\s*\\(`, "gu");
const IDENTIFIER_TERMS = new RegExp(`\\b${IDENTIFIER}\\b`, "gu");
const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "var",
  "while",
]);

function lineNumberOf(text: string, charIndex: number): number {
  let line = 1;
  for (let index = 0; index < charIndex && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function isSymbolSource(scopePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(scopePath).toLowerCase());
}

export function unsupportedLanguages(
  languages: readonly WorkspaceLanguage[],
): readonly WorkspaceLanguage[] {
  return [...new Set(languages.filter((language) => !SUPPORTED_LANGUAGES.has(language)))].sort(
    (a, b) => a.localeCompare(b),
  );
}

export function collectDefinitions(text: string): readonly DefinitionHit[] {
  const hits: DefinitionHit[] = [];
  for (const pattern of DEFINITION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.regex.exec(text);
    while (match !== null) {
      const symbol = match[1];
      if (symbol !== undefined) {
        hits.push({
          symbol,
          line: lineNumberOf(text, match.index),
          ordinal: hits.length,
          definitionKind: pattern.definitionKind,
        });
      }
      match = pattern.regex.exec(text);
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.ordinal - b.ordinal);
}

export function collectIdentifiers(text: string, regex: RegExp): readonly IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const symbol = match[1];
    if (symbol !== undefined && !KEYWORDS.has(symbol)) {
      hits.push({ symbol, line: lineNumberOf(text, match.index), ordinal: hits.length });
    }
    match = regex.exec(text);
  }
  return hits;
}

export function candidateSymbolsForText(text: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  IDENTIFIER_TERMS.lastIndex = 0;
  let match: RegExpExecArray | null = IDENTIFIER_TERMS.exec(text);
  while (match !== null) {
    const symbol = match[0];
    if (!KEYWORDS.has(symbol) && !seen.has(symbol)) {
      seen.add(symbol);
      out.push(symbol);
    }
    match = IDENTIFIER_TERMS.exec(text);
  }
  return out;
}

export function enclosingSymbol(
  definitions: readonly DefinitionHit[],
  line: number,
): string | undefined {
  let enclosing: DefinitionHit | undefined;
  for (const definition of definitions) {
    if (definition.line > line) break;
    enclosing = definition;
  }
  return enclosing?.line === line ? undefined : enclosing?.symbol;
}

export function isDefinitionHit(
  definitions: readonly DefinitionHit[],
  symbol: string,
  line: number,
): boolean {
  return definitions.some((definition) => definition.symbol === symbol && definition.line === line);
}
