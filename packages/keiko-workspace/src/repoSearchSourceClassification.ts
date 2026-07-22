// Structural retrieval signals must come from executable source, never from comments, docstrings,
// or quoted examples. The raw line remains available for ordinary lexical matching; these masked
// views are used only for definition and route classification.

const CLASSIFIABLE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "cshtml",
  "csproj",
  "cts",
  "fs",
  "fsx",
  "fsproj",
  "go",
  "gradle",
  "groovy",
  "gvy",
  "h",
  "hpp",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "lua",
  "mod",
  "mjs",
  "mts",
  "nvmrc",
  "php",
  "proto",
  "props",
  "py",
  "pyi",
  "razor",
  "rb",
  "rs",
  "scala",
  "sc",
  "sh",
  "sql",
  "swift",
  "toml",
  "targets",
  "tool-versions",
  "ts",
  "tsx",
  "vb",
  "vbproj",
  "vue",
  "yaml",
  "yml",
  "xml",
  "ruby-version",
  "python-version",
]);
const HASH_COMMENT_EXTENSIONS = new Set([
  "php",
  "py",
  "pyi",
  "rb",
  "sh",
  "toml",
  "tool-versions",
  "yaml",
  "yml",
]);
const DASH_COMMENT_EXTENSIONS = new Set(["lua", "sql"]);
const REGEX_LITERAL_EXTENSIONS = new Set([
  "cjs",
  "cts",
  "js",
  "jsx",
  "mjs",
  "mts",
  "ts",
  "tsx",
  "vue",
]);
const CPP_RAW_STRING_EXTENSIONS = new Set(["c", "cc", "cpp", "h", "hpp"]);
const CSHARP_VERBATIM_STRING_EXTENSIONS = new Set(["cs", "cshtml", "razor"]);
const FSHARP_COMMENT_EXTENSIONS = new Set(["fs", "fsx"]);
const HTML_COMMENT_EXTENSIONS = new Set(["cshtml", "razor", "vue"]);
const NESTED_BLOCK_COMMENT_EXTENSIONS = new Set(["fs", "fsx", "rs"]);
const RAZOR_COMMENT_EXTENSIONS = new Set(["cshtml", "razor"]);
const TRIPLE_QUOTE_EXTENSIONS = new Set([
  "cs",
  "fs",
  "fsx",
  "groovy",
  "gvy",
  "java",
  "kt",
  "kts",
  "py",
  "pyi",
  "sc",
  "scala",
  "swift",
]);
const DOCUMENTATION_EXTENSIONS = new Set(["adoc", "html", "htm", "md", "mdx", "rst", "txt"]);
const TRIPLE_QUOTE_ESCAPE_EXTENSIONS = new Set(["groovy", "gvy", "java", "py", "pyi"]);
const YAML_EXTENSIONS = new Set(["yaml", "yml"]);
const DOCUMENTATION_BASENAMES = new Set([
  "changelog",
  "contributing",
  "license",
  "readme",
  "security",
]);
const CLASSIFIABLE_BASENAMES = new Set([
  "build",
  "cmakelists",
  "dockerfile",
  "gemfile",
  "makefile",
  "rakefile",
]);
const MARKUP_COMMENT_EXTENSIONS = new Set([
  "csproj",
  "fsproj",
  "props",
  "targets",
  "vbproj",
  "xml",
]);
const C_STYLE_COMMENT_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "cshtml",
  "cts",
  "go",
  "groovy",
  "gvy",
  "h",
  "hpp",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "mjs",
  "mod",
  "mts",
  "php",
  "proto",
  "razor",
  "rs",
  "scala",
  "sc",
  "swift",
  "ts",
  "tsx",
  "vue",
]);

interface SourceSyntax {
  readonly classifiable: boolean;
  readonly cppRawStrings: boolean;
  readonly csharpVerbatimStrings: boolean;
  readonly dashComments: boolean;
  readonly fsharpComments: boolean;
  readonly hashAttributeException: boolean;
  readonly hashComments: boolean;
  readonly htmlComments: boolean;
  readonly javaUnicodeComments: boolean;
  readonly luaLongComments: boolean;
  readonly nestedSlashComments: boolean;
  readonly razorComments: boolean;
  readonly regexLiterals: boolean;
  readonly rubyBlockComments: boolean;
  readonly rustRawStrings: boolean;
  readonly shellHeredocs: boolean;
  readonly slashBlockComments: boolean;
  readonly slashLineComments: boolean;
  readonly phpHeredocs: boolean;
  readonly templateLiterals: boolean;
  readonly tripleQuotedStrings: boolean;
  readonly tripleQuoteEscapes: boolean;
  readonly variableTripleQuoteDelimiter: boolean;
  readonly vbComments: boolean;
  readonly yamlBlockScalars: boolean;
}

interface HeredocDelimiter {
  readonly close: string;
  readonly indentation: "none" | "spaces" | "tabs";
}

interface TemplateLiteralFrame {
  escaped: boolean;
  expressionDepth: number;
}

interface SourceMaskState {
  blockClose: string | undefined;
  blockDepth: number;
  blockOpen: string | undefined;
  escaped: boolean;
  heredocCursor: number;
  lineBlockEnd: string | undefined;
  javaUnicodeBlock: boolean;
  heredocs: HeredocDelimiter[];
  quote: string | undefined;
  quoteDoubledEscape: boolean;
  quoteEscapes: boolean;
  quoteMultiline: boolean;
  rawStringClose: string | undefined;
  regexCharacterClass: boolean;
  regexClosureScanFailures: number;
  regexLiteral: boolean;
  templateStack: TemplateLiteralFrame[];
  yamlBlockContentIndent: number | undefined;
  yamlBlockParentIndent: number | undefined;
}

export interface RepositorySourceLine {
  readonly raw: string;
  /** Comments masked; string values remain available for bound route-path matching. */
  readonly code: string;
  /** Comments, docstrings, ordinary strings, and regex literals masked. */
  readonly structural: string;
}

function extension(scopePath: string): string {
  const normalized = scopePath.toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot < 0 ? "" : normalized.slice(dot + 1);
}

function basenameWithoutExtension(scopePath: string): string {
  const name = scopePath.toLowerCase().split("/").pop() ?? "";
  const dot = name.indexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

const GENERIC_SOURCE_SYNTAX: SourceSyntax = {
  classifiable: true,
  cppRawStrings: true,
  csharpVerbatimStrings: true,
  dashComments: false,
  fsharpComments: false,
  hashAttributeException: true,
  hashComments: true,
  htmlComments: false,
  javaUnicodeComments: true,
  luaLongComments: true,
  nestedSlashComments: false,
  razorComments: true,
  regexLiterals: true,
  rubyBlockComments: true,
  rustRawStrings: true,
  shellHeredocs: true,
  slashBlockComments: true,
  slashLineComments: true,
  phpHeredocs: true,
  templateLiterals: true,
  tripleQuotedStrings: true,
  tripleQuoteEscapes: true,
  variableTripleQuoteDelimiter: false,
  vbComments: false,
  yamlBlockScalars: true,
};

const HASH_BASENAME_SOURCE_SYNTAX: SourceSyntax = {
  ...GENERIC_SOURCE_SYNTAX,
  cppRawStrings: false,
  csharpVerbatimStrings: false,
  hashAttributeException: false,
  javaUnicodeComments: false,
  luaLongComments: false,
  razorComments: false,
  regexLiterals: false,
  rubyBlockComments: true,
  rustRawStrings: false,
  shellHeredocs: false,
  slashBlockComments: false,
  slashLineComments: false,
  phpHeredocs: false,
  templateLiterals: false,
  tripleQuotedStrings: false,
  tripleQuoteEscapes: false,
  variableTripleQuoteDelimiter: false,
  yamlBlockScalars: false,
};

function syntaxForExtension(ext: string): SourceSyntax {
  return {
    classifiable: CLASSIFIABLE_EXTENSIONS.has(ext) && !DOCUMENTATION_EXTENSIONS.has(ext),
    cppRawStrings: CPP_RAW_STRING_EXTENSIONS.has(ext),
    csharpVerbatimStrings: CSHARP_VERBATIM_STRING_EXTENSIONS.has(ext),
    dashComments: DASH_COMMENT_EXTENSIONS.has(ext),
    fsharpComments: FSHARP_COMMENT_EXTENSIONS.has(ext),
    hashAttributeException: ext === "php",
    hashComments: HASH_COMMENT_EXTENSIONS.has(ext),
    htmlComments: HTML_COMMENT_EXTENSIONS.has(ext) || MARKUP_COMMENT_EXTENSIONS.has(ext),
    javaUnicodeComments: ext === "java",
    luaLongComments: ext === "lua",
    nestedSlashComments: NESTED_BLOCK_COMMENT_EXTENSIONS.has(ext),
    razorComments: RAZOR_COMMENT_EXTENSIONS.has(ext),
    regexLiterals: REGEX_LITERAL_EXTENSIONS.has(ext),
    rubyBlockComments: ext === "rb",
    rustRawStrings: ext === "rs",
    shellHeredocs: ext === "sh",
    slashBlockComments: C_STYLE_COMMENT_EXTENSIONS.has(ext) || ext === "sql",
    slashLineComments: C_STYLE_COMMENT_EXTENSIONS.has(ext),
    phpHeredocs: ext === "php",
    templateLiterals: REGEX_LITERAL_EXTENSIONS.has(ext),
    tripleQuotedStrings: TRIPLE_QUOTE_EXTENSIONS.has(ext),
    tripleQuoteEscapes: TRIPLE_QUOTE_ESCAPE_EXTENSIONS.has(ext),
    variableTripleQuoteDelimiter: ext === "cs",
    vbComments: ext === "vb",
    yamlBlockScalars: YAML_EXTENSIONS.has(ext),
  };
}

function syntaxFor(scopePath: string | undefined): SourceSyntax {
  if (scopePath === undefined) return GENERIC_SOURCE_SYNTAX;
  const basename = basenameWithoutExtension(scopePath);
  const syntax = syntaxForExtension(extension(scopePath));
  if (CLASSIFIABLE_BASENAMES.has(basename)) return HASH_BASENAME_SOURCE_SYNTAX;
  return DOCUMENTATION_BASENAMES.has(basename) ? { ...syntax, classifiable: false } : syntax;
}

function initialMaskState(): SourceMaskState {
  return {
    blockClose: undefined,
    blockDepth: 0,
    blockOpen: undefined,
    escaped: false,
    heredocCursor: 0,
    heredocs: [],
    javaUnicodeBlock: false,
    lineBlockEnd: undefined,
    quote: undefined,
    quoteDoubledEscape: false,
    quoteEscapes: false,
    quoteMultiline: false,
    rawStringClose: undefined,
    regexCharacterClass: false,
    regexClosureScanFailures: 0,
    regexLiteral: false,
    templateStack: [],
    yamlBlockContentIndent: undefined,
    yamlBlockParentIndent: undefined,
  };
}

function mask(chars: string[], index: number): void {
  chars[index] = " ";
}

function maskRange(chars: string[], start: number, length: number): void {
  for (let offset = 0; offset < length; offset += 1) mask(chars, start + offset);
}

function previousWord(line: string, endIndex: number): string {
  let index = endIndex;
  while (index >= 0 && /[A-Za-z]/u.test(line.charAt(index))) index -= 1;
  return line.slice(index + 1, endIndex + 1);
}

const REGEX_PREFIX_WORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const MAX_FAILED_REGEX_CLOSURE_SCANS_PER_LINE = 8;

function hasClosingRegexDelimiter(
  line: string,
  slashIndex: number,
  state: SourceMaskState,
): boolean {
  if (state.regexClosureScanFailures >= MAX_FAILED_REGEX_CLOSURE_SCANS_PER_LINE) return false;
  let escaped = false;
  let characterClass = false;
  for (let index = slashIndex + 1; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "[") characterClass = true;
    else if (char === "]") characterClass = false;
    else if (char === "/" && !characterClass) return true;
  }
  state.regexClosureScanFailures += 1;
  return false;
}

function regexLiteralCanStart(line: string, slashIndex: number, state: SourceMaskState): boolean {
  if (!hasClosingRegexDelimiter(line, slashIndex, state)) return false;
  let index = slashIndex - 1;
  while (index >= 0 && /\s/u.test(line.charAt(index))) index -= 1;
  if (index < 0 || "=([{,:;!&|?<>".includes(line.charAt(index))) return true;
  return REGEX_PREFIX_WORDS.has(previousWord(line, index));
}

const JAVA_UNICODE_SLASH_RE = /\\u+002f/iy;
const JAVA_UNICODE_ASTERISK_RE = /\\u+002a/iy;

function javaTokenLength(
  line: string,
  index: number,
  literal: string,
  escaped: RegExp,
): number | undefined {
  if (line.charAt(index) === literal) return 1;
  escaped.lastIndex = index;
  const match = escaped.exec(line);
  return match?.index === index ? match[0].length : undefined;
}

function javaSlashLength(line: string, index: number): number | undefined {
  return javaTokenLength(line, index, "/", JAVA_UNICODE_SLASH_RE);
}

function javaAsteriskLength(line: string, index: number): number | undefined {
  return javaTokenLength(line, index, "*", JAVA_UNICODE_ASTERISK_RE);
}

function javaUnicodeLineCommentStarts(line: string, index: number, syntax: SourceSyntax): boolean {
  if (!syntax.javaUnicodeComments) return false;
  const first = javaSlashLength(line, index);
  return first !== undefined && javaSlashLength(line, index + first) !== undefined;
}

function vbRemCommentStarts(line: string, index: number, syntax: SourceSyntax): boolean {
  if (!syntax.vbComments || line.slice(index, index + 3).toLowerCase() !== "rem") return false;
  const previous = line.charAt(index - 1);
  const next = line.charAt(index + 3);
  return (index === 0 || /[\s:]/u.test(previous)) && (next.length === 0 || /\s/u.test(next));
}

function hashCommentStarts(line: string, index: number, syntax: SourceSyntax): boolean {
  return (
    syntax.hashComments &&
    line.charAt(index) === "#" &&
    (!syntax.hashAttributeException || line.charAt(index + 1) !== "[")
  );
}

function lineCommentStarts(line: string, index: number, syntax: SourceSyntax): boolean {
  return (
    (syntax.slashLineComments && line.startsWith("//", index)) ||
    javaUnicodeLineCommentStarts(line, index, syntax) ||
    hashCommentStarts(line, index, syntax) ||
    (syntax.dashComments && line.startsWith("--", index)) ||
    (syntax.vbComments && line.charAt(index) === "'") ||
    vbRemCommentStarts(line, index, syntax)
  );
}

interface BlockCommentDelimiter {
  readonly close: string;
  readonly javaUnicode: boolean;
  readonly open: string;
}

function javaUnicodeBlockDelimiter(
  line: string,
  index: number,
  syntax: SourceSyntax,
): BlockCommentDelimiter | undefined {
  if (!syntax.javaUnicodeComments) return undefined;
  const slash = javaSlashLength(line, index);
  if (slash === undefined) return undefined;
  const asterisk = javaAsteriskLength(line, index + slash);
  return asterisk === undefined
    ? undefined
    : {
        open: line.slice(index, index + slash + asterisk),
        close: "*/",
        javaUnicode: true,
      };
}

function javaUnicodeBlockCloseLength(line: string, index: number): number | undefined {
  const asterisk = javaAsteriskLength(line, index);
  if (asterisk === undefined) return undefined;
  const slash = javaSlashLength(line, index + asterisk);
  return slash === undefined ? undefined : asterisk + slash;
}

function luaLongBracketStart(
  line: string,
  index: number,
): { readonly close: string; readonly length: number } | undefined {
  if (line.charAt(index) !== "[") return undefined;
  let cursor = index + 1;
  while (line.charAt(cursor) === "=") cursor += 1;
  if (line.charAt(cursor) !== "[") return undefined;
  const equals = line.slice(index + 1, cursor);
  return { close: `]${equals}]`, length: cursor - index + 1 };
}

function luaLongBlockDelimiter(
  line: string,
  index: number,
  syntax: SourceSyntax,
): BlockCommentDelimiter | undefined {
  if (!syntax.luaLongComments || !line.startsWith("--", index)) return undefined;
  const start = luaLongBracketStart(line, index + 2);
  if (start === undefined) return undefined;
  return {
    open: line.slice(index, index + 2 + start.length),
    close: start.close,
    javaUnicode: false,
  };
}

function blockCommentDelimiter(
  line: string,
  index: number,
  syntax: SourceSyntax,
): BlockCommentDelimiter | undefined {
  const candidates: readonly (BlockCommentDelimiter | undefined)[] = [
    javaUnicodeBlockDelimiter(line, index, syntax),
    luaLongBlockDelimiter(line, index, syntax),
    syntax.slashBlockComments ? { open: "/*", close: "*/", javaUnicode: false } : undefined,
    syntax.fsharpComments ? { open: "(*", close: "*)", javaUnicode: false } : undefined,
    syntax.razorComments ? { open: "@*", close: "*@", javaUnicode: false } : undefined,
    syntax.htmlComments ? { open: "<!--", close: "-->", javaUnicode: false } : undefined,
  ];
  return candidates.find(
    (candidate) => candidate !== undefined && line.startsWith(candidate.open, index),
  );
}

function blockCloseLength(
  line: string,
  index: number,
  close: string,
  state: SourceMaskState,
): number | undefined {
  const javaClose = state.javaUnicodeBlock ? javaUnicodeBlockCloseLength(line, index) : undefined;
  if (javaClose !== undefined) return javaClose;
  return line.startsWith(close, index) ? close.length : undefined;
}

function advanceBlockComment(
  line: string,
  index: number,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  const close = state.blockClose;
  if (close === undefined) return undefined;
  const open = state.blockOpen ?? "";
  const nested = syntax.nestedSlashComments && line.startsWith(open, index);
  if (nested) {
    maskRange(code, index, open.length);
    maskRange(structural, index, open.length);
    state.blockDepth += 1;
    return index + open.length;
  }
  const closeLength = blockCloseLength(line, index, close, state);
  const length = closeLength ?? 1;
  maskRange(code, index, length);
  maskRange(structural, index, length);
  if (closeLength !== undefined) {
    state.blockDepth -= 1;
    if (state.blockDepth === 0) {
      state.blockClose = undefined;
      state.blockOpen = undefined;
      state.javaUnicodeBlock = false;
    }
  }
  return index + length;
}

function advanceRawString(
  line: string,
  index: number,
  structural: string[],
  state: SourceMaskState,
): number | undefined {
  const close = state.rawStringClose;
  if (close === undefined) return undefined;
  const closes = line.startsWith(close, index);
  const length = closes ? close.length : 1;
  maskRange(structural, index, length);
  if (closes) state.rawStringClose = undefined;
  return index + length;
}

function cppRawStringStart(
  line: string,
  index: number,
  syntax: SourceSyntax,
): { readonly close: string; readonly length: number } | undefined {
  if (!syntax.cppRawStrings || !line.startsWith('R"', index)) return undefined;
  const contentStart = line.indexOf("(", index + 2);
  if (contentStart < 0 || contentStart > index + 18) return undefined;
  const delimiter = line.slice(index + 2, contentStart);
  return { close: `)${delimiter}"`, length: contentStart - index + 1 };
}

function rustRawStringStart(
  line: string,
  index: number,
  syntax: SourceSyntax,
): { readonly close: string; readonly length: number } | undefined {
  if (!syntax.rustRawStrings) return undefined;
  const prefixLength = line.startsWith("br", index) ? 2 : line.charAt(index) === "r" ? 1 : 0;
  if (prefixLength === 0 || /[\p{ID_Continue}$]/u.test(line.charAt(index - 1))) return undefined;
  let cursor = index + prefixLength;
  while (line.charAt(cursor) === "#") cursor += 1;
  if (line.charAt(cursor) !== '"') return undefined;
  const hashes = line.slice(index + prefixLength, cursor);
  return { close: `"${hashes}`, length: cursor - index + 1 };
}

function luaLongStringStart(
  line: string,
  index: number,
  syntax: SourceSyntax,
): { readonly close: string; readonly length: number } | undefined {
  return syntax.luaLongComments ? luaLongBracketStart(line, index) : undefined;
}

function startRawString(
  line: string,
  index: number,
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  const start =
    cppRawStringStart(line, index, syntax) ??
    rustRawStringStart(line, index, syntax) ??
    luaLongStringStart(line, index, syntax);
  if (start === undefined) return undefined;
  state.rawStringClose = start.close;
  maskRange(structural, index, start.length);
  return index + start.length;
}

function activeTemplateFrame(state: SourceMaskState): TemplateLiteralFrame | undefined {
  return state.templateStack.at(-1);
}

function advanceTemplateText(
  line: string,
  index: number,
  structural: string[],
  state: SourceMaskState,
): number | undefined {
  const frame = activeTemplateFrame(state);
  if (frame === undefined || frame.expressionDepth > 0) return undefined;
  if (!frame.escaped && line.startsWith("${", index)) {
    maskRange(structural, index, 2);
    frame.expressionDepth = 1;
    return index + 2;
  }
  const char = line.charAt(index);
  mask(structural, index);
  if (frame.escaped) frame.escaped = false;
  else if (char === "\\") frame.escaped = true;
  else if (char === "`") state.templateStack.pop();
  return index + 1;
}

function advanceTemplateExpressionBoundary(
  line: string,
  index: number,
  state: SourceMaskState,
): number | undefined {
  const frame = activeTemplateFrame(state);
  if (frame === undefined || frame.expressionDepth === 0) return undefined;
  const char = line.charAt(index);
  if (char === "{") frame.expressionDepth += 1;
  else if (char === "}") frame.expressionDepth -= 1;
  else return undefined;
  return index + 1;
}

function startTemplateLiteral(
  line: string,
  index: number,
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  if (!syntax.templateLiterals || line.charAt(index) !== "`") return undefined;
  state.templateStack.push({ escaped: false, expressionDepth: 0 });
  mask(structural, index);
  return index + 1;
}

function doubledQuoteLength(
  line: string,
  index: number,
  quote: string,
  state: SourceMaskState,
): number | undefined {
  return state.quoteDoubledEscape && line.startsWith(`${quote}${quote}`, index)
    ? quote.length * 2
    : undefined;
}

function closeQuotedLiteral(state: SourceMaskState): void {
  state.quote = undefined;
  state.quoteDoubledEscape = false;
  state.quoteEscapes = false;
  state.quoteMultiline = false;
}

function updateQuotedLiteralState(
  line: string,
  index: number,
  quote: string,
  state: SourceMaskState,
): void {
  if (state.quoteEscapes && state.escaped) state.escaped = false;
  else if (state.quoteEscapes && line.charAt(index) === "\\") state.escaped = true;
  else if (line.startsWith(quote, index)) closeQuotedLiteral(state);
}

function advanceQuotedLiteral(
  line: string,
  index: number,
  structural: string[],
  state: SourceMaskState,
): number | undefined {
  const quote = state.quote;
  if (quote === undefined) return undefined;
  const doubled = doubledQuoteLength(line, index, quote, state);
  if (doubled !== undefined) {
    maskRange(structural, index, doubled);
    return index + doubled;
  }
  const multiline = quote.length >= 3;
  const length = multiline && line.startsWith(quote, index) ? quote.length : 1;
  maskRange(structural, index, length);
  updateQuotedLiteralState(line, index, quote, state);
  return index + length;
}

function advanceRegexLiteral(
  line: string,
  index: number,
  code: string[],
  structural: string[],
  state: SourceMaskState,
): number | undefined {
  if (!state.regexLiteral) return undefined;
  const char = line.charAt(index);
  mask(code, index);
  mask(structural, index);
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  else if (char === "[") state.regexCharacterClass = true;
  else if (char === "]") state.regexCharacterClass = false;
  else if (char === "/" && !state.regexCharacterClass) state.regexLiteral = false;
  return index + 1;
}

function repeatedDoubleQuoteAt(line: string, index: number): string | undefined {
  let end = index;
  while (line.charAt(end) === '"') end += 1;
  return end - index >= 3 ? line.slice(index, end) : undefined;
}

function tripleQuoteAt(line: string, index: number, syntax: SourceSyntax): string | undefined {
  if (!syntax.tripleQuotedStrings) return undefined;
  if (line.startsWith("'''", index)) return "'''";
  if (syntax.variableTripleQuoteDelimiter) return repeatedDoubleQuoteAt(line, index);
  return line.startsWith('"""', index) ? '"""' : undefined;
}

function startTripleQuotedLiteral(
  line: string,
  index: number,
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  const triple = tripleQuoteAt(line, index, syntax);
  if (triple === undefined) return undefined;
  state.quote = triple;
  state.quoteDoubledEscape = false;
  state.quoteEscapes = syntax.tripleQuoteEscapes;
  state.quoteMultiline = true;
  maskRange(structural, index, triple.length);
  return index + triple.length;
}

function csharpVerbatimQuoteStarts(line: string, index: number, syntax: SourceSyntax): boolean {
  if (!syntax.csharpVerbatimStrings || line.charAt(index) !== '"') return false;
  const previous = line.charAt(index - 1);
  return previous === "@" || (previous === "$" && line.charAt(index - 2) === "@");
}

function startCsharpVerbatimLiteral(
  line: string,
  index: number,
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  if (!csharpVerbatimQuoteStarts(line, index, syntax)) return undefined;
  state.quote = '"';
  state.quoteDoubledEscape = true;
  state.quoteEscapes = false;
  state.quoteMultiline = true;
  mask(structural, index);
  return index + 1;
}

function startOrdinaryLiteral(
  line: string,
  index: number,
  structural: string[],
  state: SourceMaskState,
): number | undefined {
  const char = line.charAt(index);
  if (char !== "'" && char !== '"' && char !== "`") return undefined;
  state.quote = char;
  state.quoteDoubledEscape = false;
  state.quoteEscapes = true;
  state.quoteMultiline = char === "`";
  state.escaped = false;
  mask(structural, index);
  return index + 1;
}

function startRegexLiteral(
  line: string,
  index: number,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  if (line.charAt(index) !== "/" || !syntax.regexLiterals) return undefined;
  if (!regexLiteralCanStart(line, index, state)) return undefined;
  state.regexLiteral = true;
  state.regexCharacterClass = false;
  state.escaped = false;
  mask(code, index);
  mask(structural, index);
  return index + 1;
}

function startLiteral(
  line: string,
  index: number,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  return (
    startTripleQuotedLiteral(line, index, structural, syntax, state) ??
    startRawString(line, index, structural, syntax, state) ??
    startCsharpVerbatimLiteral(line, index, structural, syntax, state) ??
    startTemplateLiteral(line, index, structural, syntax, state) ??
    startOrdinaryLiteral(line, index, structural, state) ??
    startRegexLiteral(line, index, code, structural, syntax, state)
  );
}

function advanceActiveMask(
  line: string,
  index: number,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): number | undefined {
  const block = advanceBlockComment(line, index, code, structural, syntax, state);
  if (block !== undefined) return block;
  const rawString = advanceRawString(line, index, structural, state);
  if (rawString !== undefined) return rawString;
  const template = advanceTemplateText(line, index, structural, state);
  if (template !== undefined) return template;
  const quote = advanceQuotedLiteral(line, index, structural, state);
  if (quote !== undefined) return quote;
  return advanceRegexLiteral(line, index, code, structural, state);
}

const PHP_HEREDOC_START_RE =
  /<<<\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/gu;
const SHELL_HEREDOC_START_RE =
  /<<(?!<)(-?)\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/gu;

function heredocDelimiter(match: RegExpMatchArray, php: boolean): string | undefined {
  return php ? (match[1] ?? match[2] ?? match[3]) : (match[2] ?? match[3] ?? match[4]);
}

function appendHeredocStarts(
  raw: string,
  structural: string,
  pattern: RegExp,
  php: boolean,
  state: SourceMaskState,
): void {
  pattern.lastIndex = 0;
  for (const match of raw.matchAll(pattern)) {
    const index = match.index;
    const marker = php ? "<<<" : "<<";
    const close = heredocDelimiter(match, php);
    if (close === undefined || !structural.startsWith(marker, index)) continue;
    const indentation = php ? "spaces" : match[1] === "-" ? "tabs" : "none";
    state.heredocs.push({ close, indentation });
  }
}

function queueHeredocStarts(
  raw: string,
  structural: string,
  syntax: SourceSyntax,
  state: SourceMaskState,
): void {
  if (syntax.phpHeredocs) {
    appendHeredocStarts(raw, structural, PHP_HEREDOC_START_RE, true, state);
  } else if (syntax.shellHeredocs) {
    appendHeredocStarts(raw, structural, SHELL_HEREDOC_START_RE, false, state);
  }
}

function heredocCloses(raw: string, delimiter: HeredocDelimiter): boolean {
  const candidate =
    delimiter.indentation === "spaces"
      ? raw.trimStart()
      : delimiter.indentation === "tabs"
        ? raw.replace(/^\t+/u, "")
        : raw;
  if (delimiter.indentation !== "spaces") return candidate === delimiter.close;
  const normalized = candidate.trimEnd();
  return normalized === delimiter.close || normalized === `${delimiter.close};`;
}

function heredocActive(raw: string, structural: string[], state: SourceMaskState): boolean {
  const delimiter = state.heredocs[state.heredocCursor];
  if (delimiter === undefined) return false;
  maskRange(structural, 0, raw.length);
  if (heredocCloses(raw, delimiter)) state.heredocCursor += 1;
  if (state.heredocCursor === state.heredocs.length) {
    state.heredocs = [];
    state.heredocCursor = 0;
  }
  return true;
}

function leadingSpaces(raw: string): number {
  let count = 0;
  while (raw.charAt(count) === " ") count += 1;
  return count;
}

function clearYamlBlockScalar(state: SourceMaskState): void {
  state.yamlBlockContentIndent = undefined;
  state.yamlBlockParentIndent = undefined;
}

function yamlBlockScalarActive(raw: string, structural: string[], state: SourceMaskState): boolean {
  const parentIndent = state.yamlBlockParentIndent;
  if (parentIndent === undefined) return false;
  if (raw.trim().length === 0) {
    maskRange(structural, 0, raw.length);
    return true;
  }
  const indent = leadingSpaces(raw);
  const contentIndent = state.yamlBlockContentIndent;
  if (contentIndent === undefined && indent > parentIndent) state.yamlBlockContentIndent = indent;
  else if (contentIndent === undefined || indent < contentIndent) {
    clearYamlBlockScalar(state);
    return false;
  }
  maskRange(structural, 0, raw.length);
  return true;
}

const YAML_BLOCK_SCALAR_HEADER_RE = /(?:^|:\s+|-\s+)[|>](?:([1-9])[+-]?|[+-]([1-9])?)?\s*$/u;

function startYamlBlockScalar(
  structural: string,
  syntax: SourceSyntax,
  state: SourceMaskState,
): void {
  if (!syntax.yamlBlockScalars) return;
  const match = YAML_BLOCK_SCALAR_HEADER_RE.exec(structural.trimEnd());
  if (match === null) return;
  const parentIndent = leadingSpaces(structural);
  const explicitIndent = Number(match[1] ?? match[2] ?? 0);
  state.yamlBlockParentIndent = parentIndent;
  state.yamlBlockContentIndent = explicitIndent > 0 ? parentIndent + explicitIndent : undefined;
}

function lineBlockCommentActive(
  raw: string,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): boolean {
  const normalized = raw.trim().toLowerCase();
  if (state.lineBlockEnd === undefined) {
    if (!syntax.rubyBlockComments || normalized !== "=begin") return false;
    state.lineBlockEnd = "=end";
  }
  maskRange(code, 0, raw.length);
  maskRange(structural, 0, raw.length);
  if (normalized === state.lineBlockEnd) state.lineBlockEnd = undefined;
  return true;
}

function scanLineMasks(
  raw: string,
  code: string[],
  structural: string[],
  syntax: SourceSyntax,
  state: SourceMaskState,
): void {
  let index = 0;
  while (index < raw.length) {
    const active = advanceActiveMask(raw, index, code, structural, syntax, state);
    if (active !== undefined) {
      index = active;
      continue;
    }
    const block = blockCommentDelimiter(raw, index, syntax);
    if (block !== undefined) {
      state.blockOpen = block.open;
      state.blockClose = block.close;
      state.blockDepth = 1;
      state.javaUnicodeBlock = block.javaUnicode;
      maskRange(code, index, block.open.length);
      maskRange(structural, index, block.open.length);
      index += block.open.length;
      continue;
    }
    if (lineCommentStarts(raw, index, syntax)) {
      maskRange(code, index, raw.length - index);
      maskRange(structural, index, raw.length - index);
      break;
    }
    const templateBoundary = advanceTemplateExpressionBoundary(raw, index, state);
    if (templateBoundary !== undefined) {
      index = templateBoundary;
      continue;
    }
    index = startLiteral(raw, index, code, structural, syntax, state) ?? index + 1;
  }
}

function resetLineMaskState(state: SourceMaskState): void {
  if (!state.quoteMultiline) state.quote = undefined;
  if (state.quote === undefined) {
    state.quoteDoubledEscape = false;
    state.quoteEscapes = false;
    state.quoteMultiline = false;
  }
  const template = activeTemplateFrame(state);
  if (template !== undefined) template.escaped = false;
  state.regexLiteral = false;
  state.regexCharacterClass = false;
  state.regexClosureScanFailures = 0;
  state.escaped = false;
}

function scanClassifiableLine(
  raw: string,
  syntax: SourceSyntax,
  state: SourceMaskState,
): RepositorySourceLine {
  // The scanner indexes with `charAt`/`startsWith`, whose offsets are UTF-16 code units. Keep the
  // mutable views in that same coordinate system so astral identifiers cannot shift comment masks.
  const code = raw.split("");
  const structural = raw.split("");
  const literalRegion =
    heredocActive(raw, structural, state) || yamlBlockScalarActive(raw, structural, state);
  if (!literalRegion && !lineBlockCommentActive(raw, code, structural, syntax, state)) {
    scanLineMasks(raw, code, structural, syntax, state);
    resetLineMaskState(state);
    const structuralLine = structural.join("");
    queueHeredocStarts(raw, structuralLine, syntax, state);
    startYamlBlockScalar(structuralLine, syntax, state);
  }
  return { raw, code: code.join(""), structural: structural.join("") };
}

export function repositorySourceLines(
  text: string,
  scopePath?: string,
): readonly RepositorySourceLine[] {
  const syntax = syntaxFor(scopePath);
  const lines = text.split(/\r?\n/u);
  if (!syntax.classifiable) {
    return lines.map((raw) => ({
      raw,
      code: " ".repeat(raw.length),
      structural: " ".repeat(raw.length),
    }));
  }
  const state = initialMaskState();
  return lines.map((line) => scanClassifiableLine(line, syntax, state));
}

export function repositoryStructuralLine(line: string): string {
  return repositorySourceLines(line)[0]?.structural ?? "";
}
