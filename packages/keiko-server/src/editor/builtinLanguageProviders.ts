import type {
  LanguageCompletionResult,
  LanguageDiagnostic,
  LanguageFormattingOptions,
  LanguageHoverResult,
  LanguageProviderDescriptor,
  LanguageRange,
  LanguageTextEdit,
} from "@oscharko-dev/keiko-contracts";
import type {
  LanguageDiagnosticsRaw,
  LanguageFormattingRaw,
  LanguageProvider,
  LanguageProviderContext,
  LanguageSymbolsRaw,
} from "./languageProvider.js";
import { computeLineStarts, spanToRange } from "./textOffsets.js";

const BUILTIN_FORMATTING_LANGUAGES = [
  "css",
  "scss",
  "less",
  "html",
  "yaml",
  "markdown",
] as const;

function fullDocumentEdit(text: string, newText: string): readonly LanguageTextEdit[] {
  if (newText === text) return [];
  const lineStarts = computeLineStarts(text);
  return [{ range: spanToRange(text, lineStarts, 0, text.length), newText }];
}

function ensureFinalNewline(text: string): string {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

function normalizeTrailingWhitespace(text: string): string {
  return ensureFinalNewline(text.replace(/[ \t]+$/gmu, ""));
}

function formatJson(text: string, options: LanguageFormattingOptions | undefined): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const spaces = options?.insertSpaces === false ? "\t" : options?.tabSize ?? 2;
    return `${JSON.stringify(parsed, null, spaces)}\n`;
  } catch {
    return null;
  }
}

function formatCssLike(text: string, options: LanguageFormattingOptions | undefined): string {
  const indentUnit = options?.insertSpaces === false ? "\t" : " ".repeat(options?.tabSize ?? 2);
  const tokens = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\{/gu, "{\n")
    .replace(/\}/gu, "\n}\n")
    .replace(/;/gu, ";\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let depth = 0;
  const out: string[] = [];
  for (const line of tokens) {
    if (line.startsWith("}")) depth = Math.max(0, depth - 1);
    out.push(`${indentUnit.repeat(depth)}${line}`);
    if (line.endsWith("{")) depth += 1;
  }
  return `${out.join("\n")}\n`;
}

function isHtmlClosingToken(line: string): boolean {
  return line.startsWith("</");
}

function isHtmlSelfClosingToken(line: string): boolean {
  return line.endsWith("/>") || line.startsWith("<!") || line.startsWith("<?");
}

function opensHtmlIndentScope(line: string): boolean {
  return /^<[^/!][^>]*>$/u.test(line) && !line.includes("</");
}

function formatHtml(text: string, options: LanguageFormattingOptions | undefined): string {
  const indentUnit = options?.insertSpaces === false ? "\t" : " ".repeat(options?.tabSize ?? 2);
  const tokens = text
    .replace(/\r\n?/gu, "\n")
    .replace(/>\s*</gu, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let depth = 0;
  const out: string[] = [];
  for (const line of tokens) {
    const closing = isHtmlClosingToken(line);
    if (closing) depth = Math.max(0, depth - 1);
    out.push(`${indentUnit.repeat(depth)}${line}`);
    if (!closing && !isHtmlSelfClosingToken(line) && opensHtmlIndentScope(line)) depth += 1;
  }
  return `${out.join("\n")}\n`;
}

function firstLineRange(text: string): LanguageRange {
  return spanToRange(text, computeLineStarts(text), 0, 0);
}

function jsonDiagnostics(ctx: LanguageProviderContext): LanguageDiagnosticsRaw {
  try {
    JSON.parse(ctx.overlayText);
    return { diagnostics: [], truncated: false };
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : "Invalid JSON.";
    const diagnostic: LanguageDiagnostic = {
      range: firstLineRange(ctx.overlayText),
      severity: "error",
      message,
      source: "json",
      code: "JSON_PARSE",
    };
    return { diagnostics: [diagnostic], truncated: false };
  }
}

function markdownSymbols(ctx: LanguageProviderContext): LanguageSymbolsRaw {
  const lineStarts = computeLineStarts(ctx.overlayText);
  const symbols = ctx.overlayText
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{1,6}\s+/u.test(line))
    .slice(0, ctx.limits.maxSymbols)
    .map(({ line, index }) => ({
      name: line.replace(/^#{1,6}\s+/u, "").trim().slice(0, ctx.limits.maxLabelChars),
      kind: "variable" as const,
      range: spanToRange(ctx.overlayText, lineStarts, lineStarts[index], line.length),
    }));
  return {
    symbols,
    truncated: symbols.length >= ctx.limits.maxSymbols,
  };
}

function jsonFormatting(ctx: LanguageProviderContext, options: LanguageFormattingOptions | undefined): LanguageFormattingRaw {
  const formatted = formatJson(ctx.overlayText, options);
  return {
    edits: formatted === null ? [] : fullDocumentEdit(ctx.overlayText, formatted),
    truncated: false,
  };
}

function genericFormatting(
  ctx: LanguageProviderContext,
  options: LanguageFormattingOptions | undefined,
): LanguageFormattingRaw {
  const formatted =
    ctx.languageId === "css" || ctx.languageId === "scss" || ctx.languageId === "less"
      ? formatCssLike(ctx.overlayText, options)
      : ctx.languageId === "html"
        ? formatHtml(ctx.overlayText, options)
        : normalizeTrailingWhitespace(ctx.overlayText);
  return { edits: fullDocumentEdit(ctx.overlayText, formatted), truncated: false };
}

const EMPTY_COMPLETIONS: LanguageCompletionResult = {
  items: [],
  isIncomplete: false,
  truncated: false,
};

const EMPTY_HOVER: LanguageHoverResult = { contents: null };

export function createJsonLanguageProvider(): LanguageProvider {
  const descriptor: LanguageProviderDescriptor = {
    id: "json",
    languages: ["json"],
    operations: ["diagnostics", "symbols", "formatting"],
    availability: "available",
  };
  return {
    descriptor,
    supports: (languageId): boolean => languageId === "json",
    getDiagnostics: jsonDiagnostics,
    getCompletions: () => EMPTY_COMPLETIONS,
    getHover: () => EMPTY_HOVER,
    getSymbols: markdownSymbols,
    getFormatting: jsonFormatting,
  };
}

export function createBuiltinTextLanguageProvider(): LanguageProvider {
  const languages = [...BUILTIN_FORMATTING_LANGUAGES];
  const descriptor: LanguageProviderDescriptor = {
    id: "builtin-text",
    languages,
    operations: ["symbols", "formatting"],
    availability: "available",
  };
  return {
    descriptor,
    supports: (languageId): boolean => languages.includes(languageId as (typeof BUILTIN_FORMATTING_LANGUAGES)[number]),
    getDiagnostics: () => ({ diagnostics: [], truncated: false }),
    getCompletions: () => EMPTY_COMPLETIONS,
    getHover: () => EMPTY_HOVER,
    getSymbols: markdownSymbols,
    getFormatting: genericFormatting,
  };
}

export function unavailableExternalLspDescriptors(): readonly LanguageProviderDescriptor[] {
  const unavailableReason = "No configured workspace-contained language server executable.";
  return [
    {
      id: "python-lsp",
      languages: ["python"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
    {
      id: "java-lsp",
      languages: ["java"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
    {
      id: "go-lsp",
      languages: ["go"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
    {
      id: "rust-lsp",
      languages: ["rust"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
    {
      id: "shell-lsp",
      languages: ["shell"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
    {
      id: "sql-lsp",
      languages: ["sql"],
      operations: ["diagnostics", "completion", "hover", "symbols", "formatting"],
      availability: "unavailable",
      unavailableReason,
    },
  ];
}
