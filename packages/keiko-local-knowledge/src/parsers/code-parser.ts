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

// `mts`/`cts` are TypeScript in exactly the way `mjs`/`cjs` are JavaScript: the extension selects
// the module system, never the syntax, so the same strict (void-blocking) pattern set applies. They
// were missing while their JavaScript siblings were present, which routed every `.mts`/`.cts` file
// to the permissive text adapter — whole-file chunking with no symbol anchor, and the anchor label
// is a citation section path. Pinned by "routes the mts TypeScript extension to the code parser".
const CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  cjs: "javascript",
  cs: "csharp",
  cts: "typescript",
  go: "go",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  pyi: "python",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
});

// Extensions where the method-declaration pattern must accept `void` at the return-type
// position (Issue #2636). On these languages a `void` head is only ever a return type, so
// blocking it there systematically misses every `void`-returning method and hands the
// downstream chunker a boundary that does not name the method (which is a citation section
// path). Elsewhere — TypeScript, JavaScript — `void expr();` is a legal fire-and-forget
// expression statement (`void reload();`) and treating it as a declaration mislabels every
// fire-and-forget in the repository, so the strict pattern still blocks `void` there.
const VOID_RETURN_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set(["java", "cs"]);

interface SymbolPattern {
  readonly kind: "constant" | "function" | "type";
  readonly pattern: RegExp;
}

// A declaration line in real source is short. Probing an arbitrarily long line (minified
// bundles, embedded blobs, generated single-line output) buys no symbol we would keep and
// hands a hostile input an unbounded regex budget, so the probe refuses oversized lines
// outright. 4 KiB is far beyond any genuine declaration line.
const MAX_SYMBOL_LINE_LENGTH = 4096;

// Lines scanned between two deadline probes. The check has to sit INSIDE the per-line scan:
// when it only ran at unit-emission boundaries, a hostile file burned tens of seconds in the
// scan before the first probe was ever reached, so `timeoutMs` could not stop it.
const SYMBOL_SCAN_DEADLINE_STRIDE = 64;

// Words that never legitimately head the return-type position of a declaration line and would
// otherwise turn control flow, calls, and expression statements into false anchors — a broad
// method-shaped pattern would mine `for await (const x of xs) {`, `return build(a);`, and
// `throw new StoreError(msg);` as declarations without this guard. `void` is deliberately NOT
// in this list: on Java and C# it is only ever a return type (Issue #2636), and blocking it
// here would systematically miss every void-returning method. On JS/TS `void` at the head of
// a line IS an expression-statement operator (`void reload();`), so a separate `WITH_VOID`
// variant carries the strict block for the pattern applied to those extensions.
const RESERVED_STATEMENT_KEYWORDS = [
  "await",
  "break",
  "case",
  "catch",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "while",
  "with",
  "yield",
] as const;

const RESERVED_STATEMENT_KEYWORDS_WITH_VOID = [...RESERVED_STATEMENT_KEYWORDS, "void"] as const;

// Names that a captured symbol anchor must never equal. Superset of the return-type-blocking
// list plus `void` — even where `void` may head a return type, nothing declares a symbol
// literally called `void`, so a captured anchor of `void` is always a false positive.
const RESERVED_WORD_SET: ReadonlySet<string> = new Set<string>(
  RESERVED_STATEMENT_KEYWORDS_WITH_VOID,
);

// The broad method/call-shaped pattern, built from the reserved-word list so the two never
// drift apart. Two properties matter and are load-bearing:
//   * No character class that can match a space sits in front of `\s+`. The previous
//     `[\w$<>, ?.[\]]*\s+` form was ambiguous over whitespace and backtracked quadratically —
//     a long run of spaces cost seconds per line. Generic argument lists that legitimately
//     contain spaces are expressed explicitly by the delimited `<[^<>]*>` group instead.
//   * The line must terminate a declaration with `{` or `;`. Call sites, SQL fragments inside
//     template literals, and constructor invocations do not, which is what kept this pattern
//     from being the "conservative" table this module promises.
// Modifier alternatives are literal tokens with no embedded whitespace so the alternation
// stays deterministic per position — every added token (Java's original list plus C#'s
// `override|virtual|sealed|internal|async`) is disjoint from `void expr;`-shaped expression
// statements at line start because those never begin with a modifier keyword, and adding
// them here does not enlarge the fire-and-forget false-positive surface. `async` sits in the
// modifier position so `public async Task<int> ComputeAsync()` (a common C# shape whose type
// argument list would otherwise leave the return-type slot pointed at `async` and the name
// slot pointed at `Task`, terminating at `<int>`) and `async void OnClick(...)` (the C# event
// handler idiom) both anchor to their method name; the existing TypeScript form
// `public async foo(): Promise<S>` keeps working because the greedy `(?:MOD\s+)*` backtracks
// to one modifier when the two-modifier greedy fails to line up name/params, so `async`
// falls back into the return-type position that it already occupied before this addition.
const METHOD_MODIFIER_ALTERNATION =
  "(?:public|private|protected|static|final|abstract|synchronized|native|override|virtual|sealed|internal|async)";

function buildMethodDeclarationPattern(notReserved: string): RegExp {
  return new RegExp(
    [
      String.raw`^\s*`,
      String.raw`(?:${METHOD_MODIFIER_ALTERNATION}\s+)*`,
      String.raw`(?:<[^<>]{1,200}>\s+)?`,
      String.raw`${notReserved}[A-Za-z_$][\w$.]{0,200}(?:<[^<>]{0,200}>)?\??(?:\[\]){0,8}\s+`,
      String.raw`([A-Za-z_$][\w$]*)\s*`,
      String.raw`\([^()]{0,400}\)`,
      // Everything between the parameter list and the declaration terminator: the space before `{`,
      // a TypeScript return-type annotation (`): Promise<string> {` — the dominant method form, and
      // a recall hole if excluded), and a Java `throws` clause. One bounded class covers all three.
      // It excludes `;{()`, so it can neither swallow the terminator nor let a call site through,
      // and NOTHING whitespace-matching follows it — a class that can match spaces sitting in front
      // of `\s+`/`\s*` is precisely the ambiguity that made the previous table backtrack
      // quadratically, so the terminator is a disjoint single-character class instead.
      "[^;{()]{0,200}",
      String.raw`[{;]\s*$`,
    ].join(""),
    "u",
  );
}

const NOT_RESERVED_STRICT = String.raw`(?!(?:${RESERVED_STATEMENT_KEYWORDS_WITH_VOID.join(
  "|",
)})\b)`;
const NOT_RESERVED_ALLOW_VOID = String.raw`(?!(?:${RESERVED_STATEMENT_KEYWORDS.join("|")})\b)`;

const METHOD_DECLARATION_PATTERN_STRICT = buildMethodDeclarationPattern(NOT_RESERVED_STRICT);
const METHOD_DECLARATION_PATTERN_ALLOW_VOID =
  buildMethodDeclarationPattern(NOT_RESERVED_ALLOW_VOID);

// Derived from grounded-orchestrator.ts's symbolDefinitionPatterns table (Issue #2569). Keep the
// table local: importing a server module here would reverse the ADR-0019 dependency direction.
// The table deliberately diverges from that seed on two points — every entry must be anchored to
// a real declaration shape, and no entry may contain a whitespace-ambiguous character class —
// because here the table also decides chunk boundaries and citation section paths, so a false
// anchor is a retrieval-precision defect rather than a spare search hit.
// Modifier runs are expressed as a bounded repetition over alternatives that contain NO internal
// whitespace, for the same reason the method pattern above avoids space-matching classes in front
// of `\s+`: an alternative that can itself consume the separator makes the split ambiguous, and the
// engine explores every split before failing. `extern "C"` is therefore two tokens rather than one
// alternative carrying its own `\s+`. The counts are the realistic maxima with headroom (Rust tops
// out near `pub async unsafe extern "C" fn`), so bounding them costs no recall and removes the
// unbounded `*` that made a long modifier-looking run super-linear.
const RUST_FN_MODIFIER = String.raw`(?:pub(?:\([^()]{0,80}\))?|async|unsafe|extern|"[^"]{1,64}")`;
const KOTLIN_FUN_MODIFIER =
  "(?:public|private|protected|internal|open|override|suspend|inline|operator|tailrec)";
const JVM_TYPE_MODIFIER = "(?:public|private|protected|abstract|final|sealed|data|open|internal)";

// Language-agnostic patterns applied on every line regardless of extension. These cover
// TS/JS (function/class/const), Python (def), Go (func/type), Rust (fn/struct/trait/enum),
// Kotlin (fun/data class/class), and the JVM type-declaration shape. The C-style method
// pattern is intentionally last because it is the widest and would otherwise shadow the
// narrower language-specific entries; it is applied per-extension below.
const SYMBOL_PATTERNS_SHARED: readonly SymbolPattern[] = Object.freeze([
  {
    kind: "function",
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/u,
  },
  { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u },
  {
    kind: "function",
    pattern: /^\s*func\s+(?:\([^()]{0,200}\)\s*)?([A-Za-z_]\w*)\s*\(/u,
  },
  {
    kind: "function",
    pattern: new RegExp(
      String.raw`^\s*(?:${RUST_FN_MODIFIER}\s+){0,6}fn\s+([A-Za-z_]\w*)\s*(?:<[^<>]{0,200}>)?\s*\(`,
      "u",
    ),
  },
  {
    kind: "function",
    pattern: new RegExp(
      String.raw`^\s*(?:${KOTLIN_FUN_MODIFIER}\s+){0,8}fun\s+(?:<[^<>]{0,200}>\s*)?([A-Za-z_]\w*)\s*\(`,
      "u",
    ),
  },
  {
    kind: "type",
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)\b/u,
  },
  // `type` is split out of the class/interface/enum alternation and required to carry its `=`.
  // A bare `type Name` line is far more often a member of an unterminated `import { … }` block
  // (`  type KnowledgeSourceId,`) than a declaration; the probe is line-local — it is called
  // per line by the chunker with no file context — so the terminator is what distinguishes the
  // two. Go's `type Name struct` keeps its own pattern below.
  {
    kind: "type",
    pattern:
      /^\s*(?:(?:export|declare|pub)\s+){0,3}type\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>]{0,200}>\s*)?=/u,
  },
  {
    kind: "type",
    pattern: new RegExp(
      String.raw`^\s*(?:${JVM_TYPE_MODIFIER}\s+){0,8}(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)\b`,
      "u",
    ),
  },
  { kind: "type", pattern: /^\s*(?:pub\s+)?(?:struct|trait|enum)\s+([A-Za-z_]\w*)\b/u },
  {
    kind: "type",
    pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/u,
  },
  { kind: "type", pattern: /^\s*class\s+([A-Za-z_]\w*)\b/u },
  {
    kind: "constant",
    pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/u,
  },
]);

const SYMBOL_PATTERNS_STRICT: readonly SymbolPattern[] = Object.freeze([
  ...SYMBOL_PATTERNS_SHARED,
  { kind: "function", pattern: METHOD_DECLARATION_PATTERN_STRICT },
]);

const SYMBOL_PATTERNS_ALLOW_VOID: readonly SymbolPattern[] = Object.freeze([
  ...SYMBOL_PATTERNS_SHARED,
  { kind: "function", pattern: METHOD_DECLARATION_PATTERN_ALLOW_VOID },
]);

// `extension` is typed `unknown` so an accidental Array-callback usage — for example
// `lines.findIndex(codeSymbolLabel as unknown as ...)` where the runtime hands the callback
// `(value, index, array)` — falls through to the strict variant instead of crashing on the
// numeric index at `.toLowerCase()`. Legitimate string callers pay nothing: `typeof x ===
// "string"` narrows without an allocation, and TypeScript's public signature on
// `codeSymbolLabel` still declares `extension: string`, so the type discipline is intact.
// The leading-dot strip matches the no-dot contract every internal caller already honours
// (`ParserSelectionInput.extension` is documented that way) so a public consumer reaching in
// with `path.extname()`-shaped input — `".cs"`, `".java"` — takes the same void-allowing
// route as the internal pipeline. Without it a dotted extension would silently anchor to the
// strict variant and reintroduce the very recall loss this PR closes.
function symbolPatternsFor(extension: unknown): readonly SymbolPattern[] {
  const raw = typeof extension === "string" ? extension.toLowerCase() : "";
  const key = raw.startsWith(".") ? raw.slice(1) : raw;
  return VOID_RETURN_LANGUAGE_EXTENSIONS.has(key)
    ? SYMBOL_PATTERNS_ALLOW_VOID
    : SYMBOL_PATTERNS_STRICT;
}

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

export function codeSymbolLabel(line: string, extension = ""): string | undefined {
  if (line.length > MAX_SYMBOL_LINE_LENGTH) return undefined;
  for (const candidate of symbolPatternsFor(extension)) {
    const match = candidate.pattern.exec(line);
    const name = match?.[1];
    if (name !== undefined && !RESERVED_WORD_SET.has(name)) return `${candidate.kind} ${name}`;
  }
  return undefined;
}

export function isCodeSymbolDefinitionLine(line: string, extension = ""): boolean {
  return codeSymbolLabel(line, extension) !== undefined;
}

// The scan aborts on the deadline/cancellation signal mid-file rather than only between
// emitted units. `emitCodeSections` still reports the stop as a diagnostic on its first
// iteration, so the truncated anchor list never reaches a caller as a complete parse.
//
// The collected anchor count is what is handed to `shouldStop`, not a literal 0: every anchor
// becomes at most one unit, so once there are maxUnitsPerDocument of them the rest of the file
// cannot contribute anything the caller will ever see. Passing 0 made the unit cap unreachable
// during the pre-scan, leaving a pathological file free to grow the anchor list to one entry per
// definition line before any limit applied.
function symbolAnchors(
  text: string,
  extension: string,
  options: ParserOptions,
  startedAt: number,
): readonly SymbolAnchor[] {
  const anchors: SymbolAnchor[] = [];
  const lines = codeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (
      index % SYMBOL_SCAN_DEADLINE_STRIDE === 0 &&
      shouldStop(startedAt, options, anchors.length).stop
    ) {
      break;
    }
    const line = lines[index];
    if (line === undefined) continue;
    const label = codeSymbolLabel(line.text, extension);
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

function unitAnchors(
  text: string,
  language: string,
  extension: string,
  options: ParserOptions,
  startedAt: number,
): readonly SymbolAnchor[] {
  const anchors = symbolAnchors(text, extension, options, startedAt);
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
  const anchors = unitAnchors(text, language, input.extension.toLowerCase(), options, startedAt);
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
