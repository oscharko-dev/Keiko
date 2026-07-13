// Deterministic retrieval-intent classification for connected-context planning.
// This module is intentionally pure: no IO, no clock, no model calls.

import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { sortedStrings } from "@oscharko-dev/keiko-contracts";
import { ecosystemMetadataIntentPatterns } from "@oscharko-dev/keiko-workspace";

export type RetrievalIntent =
  | "project-metadata"
  | "repository-overview"
  | "targeted-code-search"
  | "diagnostic-search"
  | "clarification-needed";

export interface RetrievalIntentClassification {
  readonly intent: RetrievalIntent;
  readonly normalizedTerms: readonly string[];
}

interface IntentPattern {
  readonly term: string;
  readonly pattern: RegExp;
}

const BASIC_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "of",
  "in",
  "on",
  "at",
  "to",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "how",
  "why",
  "what",
  "which",
  "where",
  "when",
  "who",
  "das",
  "dass",
  "der",
  "die",
  "ein",
  "eine",
  "einer",
  "einem",
  "einen",
  "ist",
  "sind",
  "und",
  "oder",
  "welche",
  "welcher",
  "welches",
  "welchen",
  "wie",
  "wo",
  "wird",
  "werden",
  "zu",
]);

const PROJECT_METADATA_PATTERNS: readonly IntentPattern[] = [
  { term: "typescript", pattern: /\btype[\s_-]?script\b/iu },
  { term: "javascript", pattern: /\bjava[\s_-]?script\b/iu },
  { term: "node", pattern: /\bnode(?:\.js)?\b/iu },
  { term: "package-json", pattern: /\bpackage\.json\b/iu },
  { term: "package-manager", pattern: /\bpackage[\s_-]?manager\b/iu },
  { term: "package-manager", pattern: /\bpaket[\s_-]?manager\b/iu },
  { term: "tsconfig", pattern: /\btsconfig(?:\.[a-z0-9]+)?\b/iu },
  { term: "dependency", pattern: /\bdevdependencies\b|\bdependencies\b|\bdependency\b/iu },
  { term: "dependency", pattern: /\babhaengigkeit(?:en)?\b|\babhängigkeit(?:en)?\b/iu },
  { term: "script", pattern: /\bscripts?\b|\bskripte?\b/iu },
  { term: "version", pattern: /\bversion(?:en)?\b/iu },
  { term: "framework", pattern: /\bframeworks?\b/iu },
  { term: "test-runner", pattern: /\btest[\s_-]?runner\b|\btestumgebung\b/iu },
  { term: "build", pattern: /\bbuild\b|\bgebaut\b|\bbauen\b/iu },
  { term: "npm", pattern: /\bnpm\b/iu },
  { term: "pnpm", pattern: /\bpnpm\b/iu },
  { term: "yarn", pattern: /\byarn\b/iu },
  { term: "vite", pattern: /\bvite\b/iu },
  { term: "vitest", pattern: /\bvitest\b/iu },
  { term: "jest", pattern: /\bjest\b/iu },
  { term: "playwright", pattern: /\bplaywright\b/iu },
  { term: "cypress", pattern: /\bcypress\b/iu },
  { term: "nextjs", pattern: /\bnext(?:\.js)?\b/iu },
  { term: "react", pattern: /\breact\b/iu },
  { term: "eslint", pattern: /\beslint\b/iu },
  // Polyglot ecosystem routing is sourced from the shared registry so questions like "Which Java
  // version does this project use?" classify as project-metadata instead of generic code search.
  // The established JS/TS terms above stay in place for compatibility; registry duplicates are
  // harmless because matched terms are de-duplicated before classification.
  ...ecosystemMetadataIntentPatterns,
];

const REPOSITORY_OVERVIEW_PATTERNS: readonly IntentPattern[] = [
  { term: "architecture", pattern: /\barchitecture\b|\barchitektur\b/iu },
  { term: "overview", pattern: /\boverview\b|\bueberblick\b|\büberblick\b/iu },
  { term: "structure", pattern: /\bstructure\b|\bstruktur\b|\baufbau\b/iu },
  { term: "repository", pattern: /\brepository\b|\brepo\b|\bcodebase\b/iu },
  { term: "modules", pattern: /\bmodules?\b|\bmodule\b|\bpakete\b|\bpackages\b/iu },
  { term: "components", pattern: /\bcomponents?\b|\bkomponenten\b/iu },
];

const DIAGNOSTIC_PATTERNS: readonly IntentPattern[] = [
  { term: "error", pattern: /\berror\b|\bfehler\b|\bexception\b|\btraceback\b/iu },
  { term: "stacktrace", pattern: /\bstack[\s_-]?trace\b|\bstacktrace\b/iu },
  { term: "failure", pattern: /\bfail(?:ed|ing|ure)?\b|\bscheitert\b|\bkaputt\b/iu },
  { term: "broken", pattern: /\bbreak(?:s|ing)?\b|\bbroken\b|\bcrash(?:es|ed|ing)?\b/iu },
  { term: "bug", pattern: /\bbug\b|\bdefect\b|\bregression\b/iu },
  { term: "http-status", pattern: /\b[45]\d{2}\b|\bhttp\b/iu },
];

const TARGETED_CODE_PATTERNS: readonly IntentPattern[] = [
  { term: "path", pattern: /(?:[\w.-]+\/)+[\w.-]+/u },
  { term: "quoted", pattern: /"[^"\n]+"|'[^'\n]+'|`[^`\n]+`/u },
  { term: "identifier", pattern: /\b[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/u },
  { term: "symbol", pattern: /\b(function|class|interface|type|const|let|var)\s+[A-Za-z_]/iu },
];

function normalizeQueryText(queryText: string): string {
  return queryText.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchableTokens(normalized: string): readonly string[] {
  return (
    normalized
      .split(/[^a-z0-9_.-]+/u)
      .filter((token) => token.length >= 3 && !BASIC_STOP_WORDS.has(token))
      // `.`, `-` and `_` are kept inside tokens (so `package.json`/`tsconfig.base` survive), but a
      // token built only from those separators (e.g. `...`, `--`, `__`) is not searchable. Require at
      // least one alphanumeric character so a pure-punctuation prompt resolves to clarification-needed.
      .filter((token) => /[a-z0-9]/u.test(token))
  );
}

function matchedTerms(
  queryText: string,
  normalized: string,
  patterns: readonly IntentPattern[],
): readonly string[] {
  const terms = new Set<string>();
  for (const entry of patterns) {
    if (entry.pattern.test(queryText) || entry.pattern.test(normalized)) {
      terms.add(entry.term);
    }
  }
  return sortedStrings(terms);
}

function classifyByPatterns(
  queryText: string,
  normalized: string,
  patterns: readonly IntentPattern[],
  intent: RetrievalIntent,
): RetrievalIntentClassification | undefined {
  const terms = matchedTerms(queryText, normalized, patterns);
  return terms.length === 0 ? undefined : { intent, normalizedTerms: terms };
}

export function classifyRetrievalIntent(
  queryText: string,
  _scope?: SelectedScope,
): RetrievalIntentClassification {
  const trimmed = queryText.trim();
  const normalized = normalizeQueryText(trimmed);
  if (trimmed.length === 0 || searchableTokens(normalized).length === 0) {
    return { intent: "clarification-needed", normalizedTerms: [] };
  }

  return (
    classifyByPatterns(trimmed, normalized, DIAGNOSTIC_PATTERNS, "diagnostic-search") ??
    classifyByPatterns(trimmed, normalized, PROJECT_METADATA_PATTERNS, "project-metadata") ??
    classifyByPatterns(trimmed, normalized, TARGETED_CODE_PATTERNS, "targeted-code-search") ??
    classifyByPatterns(
      trimmed,
      normalized,
      REPOSITORY_OVERVIEW_PATTERNS,
      "repository-overview",
    ) ?? {
      intent: "targeted-code-search",
      normalizedTerms: searchableTokens(normalized).slice(0, 8),
    }
  );
}
