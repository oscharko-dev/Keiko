// Language recognition and enclosing-header detection for the review diff package (Issue #4134).
//
// Port of PR-Agent v0.49.0 (MIT) language prioritization (`language_handler.py`) and dynamic
// context (`git_patch_processing.py`, `max_extra_lines_before_dynamic_context`). PR-Agent finds the
// enclosing header through the provider's hunk section text; Keiko reads no repository attribute
// (in-tree `.gitattributes` are neutralized) and recognizes headers itself, for the seven languages
// the review supports, with a token check rather than a backtracking regular expression.

import type { ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import { reviewPathBasename } from "./paths.js";

const EXTENSION_LANGUAGES: Readonly<Record<string, ReviewDiffLanguage>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  java: "java",
  go: "go",
  cs: "csharp",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  xml: "xml",
};

/** The language a path's file name names; `other` when none is recognized. */
export function reviewDiffLanguage(path: string): ReviewDiffLanguage {
  const name = reviewPathBasename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "other";
  return EXTENSION_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "other";
}

// A header is at most one source line; longer lines are never treated as one.
const MAX_HEADER_CHARS = 400;

const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "for",
  "foreach",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "try",
  "finally",
  "return",
  "throw",
  "new",
  "await",
  "yield",
  "using",
  "lock",
  "when",
  "with",
  "typeof",
  "sizeof",
  "synchronized",
]);

const C_FAMILY_MODIFIERS: ReadonlySet<string> = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "final",
  "abstract",
  "sealed",
  "virtual",
  "override",
  "async",
  "partial",
  "readonly",
  "unsafe",
  "extern",
  "native",
  "default",
  "strictfp",
  "export",
  "declare",
  "get",
  "set",
]);

const KOTLIN_MODIFIERS: ReadonlySet<string> = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "open",
  "abstract",
  "override",
  "final",
  "suspend",
  "inline",
  "data",
  "sealed",
  "enum",
  "annotation",
  "inner",
  "operator",
  "infix",
  "tailrec",
  "external",
  "actual",
  "expect",
  "companion",
  "value",
]);

const DECLARATION_KEYWORDS: Readonly<Partial<Record<ReviewDiffLanguage, ReadonlySet<string>>>> = {
  typescript: new Set(["function", "function*", "class", "interface", "enum", "namespace"]),
  javascript: new Set(["function", "function*", "class"]),
  java: new Set(["class", "interface", "enum", "record", "@interface"]),
  csharp: new Set(["class", "interface", "enum", "struct", "record", "namespace"]),
  kotlin: new Set(["fun", "class", "interface", "object"]),
  go: new Set(["func", "type"]),
  python: new Set(["def", "class"]),
};

function withoutModifiers(words: readonly string[], modifiers: ReadonlySet<string>): string[] {
  let index = 0;
  while (index < words.length - 1 && modifiers.has(words[index] ?? "")) index += 1;
  return words.slice(index);
}

const IDENTIFIER = /^[A-Za-z_$#@][\w$]*$/u;

// `name(...) {` or `Type name(...) {` with no assignment before the parenthesis and no control
// keyword: a method or function body opening on this line.
function isCallableSignature(trimmed: string, words: readonly string[]): boolean {
  const paren = trimmed.indexOf("(");
  if (paren <= 0 || !trimmed.endsWith("{") || trimmed.includes(";")) return false;
  const before = trimmed.slice(0, paren).trim();
  if (before.includes("=") || before.length === 0) return false;
  const name = before.split(/\s+/u).at(-1)?.replace(/<.*$/u, "") ?? "";
  if (!IDENTIFIER.test(name)) return false;
  return !words.some((word) => CONTROL_KEYWORDS.has(word.replace(/\(.*$/u, "")));
}

// `const name = (...) =>`, `const name = function`, `const name = async (...) =>`.
function isFunctionValuedBinding(words: readonly string[], trimmed: string): boolean {
  if (!["const", "let", "var"].includes(words[0] ?? "")) return false;
  const assignment = trimmed.indexOf("=");
  if (assignment === -1) return false;
  const value = trimmed.slice(assignment + 1).trimStart();
  return value.startsWith("function") || value.startsWith("async") || trimmed.includes("=>");
}

function firstWords(trimmed: string, modifiers: ReadonlySet<string>): string[] {
  return withoutModifiers(trimmed.split(/\s+/u), modifiers);
}

function isScriptHeader(language: ReviewDiffLanguage, trimmed: string): boolean {
  const words = firstWords(trimmed, C_FAMILY_MODIFIERS);
  if (DECLARATION_KEYWORDS[language]?.has(words[0] ?? "") === true) return true;
  return isFunctionValuedBinding(words, trimmed) || isCallableSignature(trimmed, words);
}

function isCFamilyHeader(language: ReviewDiffLanguage, trimmed: string): boolean {
  const words = firstWords(trimmed, C_FAMILY_MODIFIERS);
  if (words.some((word) => DECLARATION_KEYWORDS[language]?.has(word) === true)) {
    return !trimmed.includes(";") && !trimmed.includes("=");
  }
  return isCallableSignature(trimmed, words);
}

function isKeywordHeader(language: ReviewDiffLanguage, trimmed: string): boolean {
  const modifiers = language === "kotlin" ? KOTLIN_MODIFIERS : new Set(["async"]);
  const words = firstWords(trimmed, modifiers);
  return DECLARATION_KEYWORDS[language]?.has(words[0] ?? "") === true;
}

/**
 * Whether a source line opens an enclosing function, method or class in one of the supported
 * languages (TypeScript, JavaScript, Python, Java, Go, C#, Kotlin). Every other language has no
 * dynamic context.
 */
export function isEnclosingHeader(language: ReviewDiffLanguage, line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADER_CHARS) return false;
  switch (language) {
    case "typescript":
    case "javascript":
      return isScriptHeader(language, trimmed);
    case "java":
    case "csharp":
      return isCFamilyHeader(language, trimmed);
    case "python":
    case "go":
    case "kotlin":
      return isKeywordHeader(language, trimmed);
    default:
      return false;
  }
}
