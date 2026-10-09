// Deterministic retrieval-intent classification for connected-context planning.
// This module is intentionally pure: no IO, no clock, no model calls.

import { extractAnchors } from "./anchors.js";
import { parseDiagnosticTraceText } from "../bug-investigation/failure-parse.js";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { sortedStrings } from "@oscharko-dev/keiko-contracts/runtime/stable-order";
import {
  ecosystemMetadataIntentPatterns,
  requestedSourceInspectionExtensions,
} from "@oscharko-dev/keiko-workspace";

export type RetrievalIntent =
  | "project-metadata"
  | "repository-overview"
  | "targeted-code-search"
  | "diagnostic-search"
  | "conversational-follow-up"
  | "clarification-needed";

export interface RetrievalIntentClassification {
  readonly intent: RetrievalIntent;
  readonly effectiveIntent?: RetrievalIntent;
  readonly normalizedTerms: readonly string[];
}

export interface RetrievalIntentContext {
  readonly previousIntent?: RetrievalIntent | undefined;
  readonly referencePresent?: boolean | undefined;
}

const CONVERSATIONAL_FOLLOW_UP_RE =
  /\b(?:can\s+you\s+see\s+(?:it|them|the\s+file)|siehst\s+du\s+(?:sie|es|die\s+datei)|kannst\s+du\s+das|try\s+again|what\s+about\s+now|and\s+(?:now|then)|that\s+(?:file|one)|this\s+file|in\s+the\s+file|und\s+(?:nun|jetzt)|in\s+der\s+datei|diese[rn]?\s+datei|darin|dazu|weiter)\b/iu;

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
  {
    term: "manifest-inventory",
    pattern:
      /\b(?:(?:package|project|workspace)[\s_-]+manifests?|(?:paket|projekt|workspace)[\s_-]*manifeste?)\b/iu,
  },
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

// A manifest noun is also a source-domain term. Only a complete enumeration request selects
// the metadata route; validation, loading and mixed inventory/behavior questions keep code search.
const MANIFEST_INVENTORY_REQUESTS: readonly RegExp[] = [
  /^(?:(?:please\s+)?(?:list|enumerate|show)\s+(?:(?:all|the)\s+)?|(?:which|what)\s+)(?:package|project|workspace)[\s_-]+manifests?(?:\s+(?:defines?\s+(?:this|the|our)\s+(?:workspace|project)|(?:in|for|of)\s+(?:this|the|our)\s+(?:workspace|project)))?[.!?\s]*$/iu,
  /^(?:(?:bitte\s+)?(?:liste|zeige)\s+(?:(?:alle|die)\s+)?|welche\s+)(?:paket|projekt|workspace)[\s_-]*manifeste?(?:\s+(?:definier(?:en|t)\s+(?:dieses|das)\s+(?:workspace|projekt)|(?:in|f[üu]r)\s+(?:dieses|das)\s+(?:workspace|projekt)))?[.!?\s]*$/iu,
];

const REPOSITORY_OVERVIEW_PATTERNS: readonly IntentPattern[] = [
  {
    term: "orientation",
    pattern: /\bwas\s+(?:(?:kannst|konntest)\s+du\s+)?(?:siehst|sehen|erkennst|erkennen)\b/iu,
  },
  { term: "orientation", pattern: /\bwhat\s+(?:(?:can|do)\s+you\s+)?(?:see|notice|recognize)\b/iu },
  {
    term: "overview",
    pattern: /^(?:please\s+)?tell\s+me\s+everything[.!?\s]*$/iu,
  },
  {
    term: "overview",
    pattern: /^(?:bitte\s+)?(?:zeig|zeige|erklaere|erkläre)\s+mir\s+alles[.!?\s]*$/iu,
  },
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
  {
    term: "http-status",
    pattern: /\bhttp(?:\/\d(?:\.\d)?)?\s*(?:[:=-]\s*)?[45]\d{2}\b/iu,
  },
  {
    term: "http-status",
    pattern: /\b(?:response\s+)?status(?:\s+code)?\s*(?:[:=-]\s*)?[45]\d{2}\b/iu,
  },
];

const TARGETED_CODE_PATTERNS: readonly IntentPattern[] = [
  // A repository path always has at least one "segment/segment" boundary; any successful match of
  // the old `(?:[\w.-]+/)+[\w.-]+` shape necessarily contains such a boundary (the last group
  // iteration's mandatory "/" is always flanked by a path-char before and after it), and any such
  // boundary trivially satisfies that old pattern too. The 3-char window is the exact same test
  // without the unbounded-quantifier-plus-unanchored-scan shape that made the old form quadratic
  // on inputs with no "/" at all (each of the O(n) scan start positions cost O(n) to disprove).
  { term: "path", pattern: /[\w.-]\/[\w.-]/u },
  { term: "quoted", pattern: /"[^"\n]+"|'[^'\n]+'|`[^`\n]+`/u },
  // Excluding uppercase letters from the leading run (disjoint from the required `[A-Z]`) removes
  // the ambiguous overlap between the two classes, but that alone is NOT enough: `$` is included in
  // both runs' character classes while NOT being a `\w` character for `\b` purposes. A string built
  // from alternating word/`$` characters (e.g. `"a$".repeat(n)`) therefore has a `\b` boundary before
  // every "a", giving O(n) independent match-start positions; with unbounded `*` quantifiers, each
  // failing start position costs O(remaining length) to disprove (the leading run greedily consumes
  // the rest of the string, including further "$"s, before backtracking char-by-char looking for an
  // `[A-Z]` that never appears), so the whole scan is O(n^2). Bounding each run's length caps the
  // backtracking cost per start position to a constant, making the total scan O(n) regardless of how
  // many `\b`-satisfying start positions the input contains. 300 characters per run (600+ for the
  // whole identifier) is far beyond any realistic source-code identifier, so no legitimate match is
  // lost; it only removes the unbounded blow-up on adversarial input.
  { term: "identifier", pattern: /\b[A-Za-z_$][a-z0-9_$]{0,300}[A-Z][\w$]{0,300}\b/u },
  { term: "symbol", pattern: /\b(function|class|interface|type|const|let|var)\s+[A-Z_]/iu },
];

function normalizeQueryText(queryText: string): string {
  return queryText.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchableTokens(normalized: string): readonly string[] {
  return (
    normalized
      .split(/[^\p{L}\p{N}_.-]+/u)
      .filter((token) => token.length >= 3 && !BASIC_STOP_WORDS.has(token))
      // `.`, `-` and `_` are kept inside tokens (so `package.json`/`tsconfig.base` survive), but a
      // token built only from those separators (e.g. `...`, `--`, `__`) is not searchable. Require at
      // least one Unicode letter or number so a pure-punctuation prompt resolves to clarification,
      // while non-Latin repository questions still reach the language-agnostic retrieval fallback.
      .filter((token) => /[\p{L}\p{N}]/u.test(token))
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

function classifyShortTarget(text: string): RetrievalIntentClassification {
  const concrete = extractAnchors({ text, maxAnchors: 1 }).anchors[0];
  return concrete !== undefined &&
    concrete.kind !== "literal" &&
    /[\p{L}\p{N}]/u.test(concrete.term)
    ? { intent: "targeted-code-search", normalizedTerms: [concrete.term] }
    : { intent: "clarification-needed", normalizedTerms: [] };
}

function hasConcreteSourceTarget(text: string): boolean {
  return extractAnchors({ text, maxAnchors: text.length }).anchors.some(
    (anchor) => anchor.kind === "path" || anchor.kind === "quoted" || anchor.kind === "identifier",
  );
}

function canInheritRetrievalIntent(text: string, context: RetrievalIntentContext): boolean {
  if (
    context.previousIntent !== "diagnostic-search" &&
    context.previousIntent !== "targeted-code-search"
  )
    return false;
  const orientation =
    context.referencePresent === true &&
    matchedTerms(text, normalizeQueryText(text), REPOSITORY_OVERVIEW_PATTERNS).includes(
      "orientation",
    );
  if (!CONVERSATIONAL_FOLLOW_UP_RE.test(text) && !orientation) return false;
  return !hasConcreteSourceTarget(text);
}

function classifyProjectMetadata(
  text: string,
  normalized: string,
): RetrievalIntentClassification | undefined {
  const matched = matchedTerms(text, normalized, PROJECT_METADATA_PATTERNS);
  const terms =
    matched.includes("manifest-inventory") &&
    !MANIFEST_INVENTORY_REQUESTS.some((pattern) => pattern.test(text))
      ? matched.filter((term) => term !== "manifest-inventory")
      : matched;
  return terms.length === 0 ? undefined : { intent: "project-metadata", normalizedTerms: terms };
}

export function classifyRetrievalIntent(
  queryText: string,
  _scope?: SelectedScope,
  context: RetrievalIntentContext = {},
): RetrievalIntentClassification {
  const trace = parseDiagnosticTraceText(queryText);
  const trimmed = trace.questionText.trim();
  const normalized = normalizeQueryText(trimmed);
  if (trace.detected) return { intent: "diagnostic-search", normalizedTerms: ["stacktrace"] };
  if (canInheritRetrievalIntent(trimmed, context)) {
    return {
      intent: "conversational-follow-up",
      effectiveIntent: context.previousIntent ?? "targeted-code-search",
      normalizedTerms: searchableTokens(normalized).slice(0, 8),
    };
  }

  if (trimmed.length === 0) return { intent: "clarification-needed", normalizedTerms: [] };
  if (searchableTokens(normalized).length === 0) {
    return classifyShortTarget(trimmed);
  }

  return classifyRequestedIntent(trimmed, normalized);
}

function classifyRequestedIntent(
  trimmed: string,
  normalized: string,
): RetrievalIntentClassification {
  return (
    classifyByPatterns(trimmed, normalized, DIAGNOSTIC_PATTERNS, "diagnostic-search") ??
    (requestedSourceInspectionExtensions(trimmed).length > 0
      ? {
          intent: "targeted-code-search",
          normalizedTerms: searchableTokens(normalized).slice(0, 8),
        }
      : undefined) ??
    classifyProjectMetadata(trimmed, normalized) ??
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
