import { MAX_RECURSIVE_TEXT_FILE_BYTES } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
// Exploration plan factory and retrieval-ring composition (Epic #177, Issue #181).
// Consumes #178 contracts and #179 search-limits surface. Produces a JSON-safe ExplorationPlan
// BEFORE any retrieval work runs. Deterministic planId via node:crypto SHA-256. No IO, no
// network. Execution and persistence of plans land in #182/#183/#187.

import { createHash } from "node:crypto";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  validateSelectedScope,
  type ExplorationBudget,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
// The symbol-relation vocabulary is owned by keiko-workspace (repoSearchPolicy.ts), where the
// retrieval ranker applies the same source-over-prose bias to the same question shape. One
// definition, imported inward, so planner classification and candidate ranking cannot drift.
import { hasSymbolRelationshipQuery, type SearchLimits } from "@oscharko-dev/keiko-workspace";

import {
  extractAnchors,
  queryContextOutsideQuotes,
  queryShapeOutsideTargets,
  type SearchAnchor,
  type SearchAnchorKind,
} from "./anchors.js";
import {
  classifyRetrievalIntent,
  type RetrievalIntent,
  type RetrievalIntentClassification,
} from "./intent.js";
import {
  extractRetrievalChannels,
  extractPathReferences,
  searchReferenceAnchors,
  type SearchReference,
} from "./references.js";
import { parseDiagnosticTraceText } from "../bug-investigation/failure-parse.js";

// ─── Public types ─────────────────────────────────────────────────────────────

// The planner emits "ready" / "completed" / "budget-exhausted" / "clarification-needed" /
// "scope-invalid". Execution status ("running") is owned by the governor's separate
// GovernorState union — keeping it out of this surface avoids a misleading "running" plan
// state that the planner itself never produces.
export type ExplorationPlanState =
  "ready" | "completed" | "budget-exhausted" | "clarification-needed" | "scope-invalid";

export type RetrievalRingKind = "lexical" | "structural" | "git-history";

export interface RetrievalRing {
  readonly kind: RetrievalRingKind;
  readonly label: string;
  readonly anchorTerms: readonly string[];
  readonly references?: readonly SearchReference[];
  readonly effectiveIntent?: RetrievalIntent;
  readonly searchLimits: SearchLimits;
  readonly rationale: string;
}

export type ClarificationReason = "no-anchors" | "too-generic" | "scope-empty" | "scope-invalid";

export interface ClarificationPrompt {
  readonly reason: ClarificationReason;
  readonly suggestedQuestions: readonly string[];
  readonly minimumAnchorCount: number;
}

export interface ExplorationPlan {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  readonly planId: string;
  readonly state: ExplorationPlanState;
  readonly retrievalIntent: RetrievalIntent;
  readonly effectiveRetrievalIntent?: RetrievalIntent;
  readonly directEvidenceLookup: boolean;
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly references?: readonly SearchReference[];
  readonly targetDecision?: QueryTargetDecision;
  readonly rings: readonly RetrievalRing[];
  readonly budget: ExplorationBudget;
  readonly clarification: ClarificationPrompt | undefined;
  readonly createdAtMs: number;
}

export interface CreatePlanInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly budget?: ExplorationBudget;
  readonly maxAnchors?: number;
  readonly previousRetrievalIntent?: RetrievalIntent;
  readonly references?: readonly SearchReference[];
}

export interface CreatePlanDeps {
  readonly nowMs?: () => number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ANCHORS = 8;

const RING_WEIGHTS: Readonly<Record<RetrievalRingKind, number>> = {
  lexical: 0.55,
  structural: 0.3,
  "git-history": 0.15,
};

// Lexical corpus traversal has no default file-count or elapsed-time cap. Cancellation and
// explicit caller deadlines remain authoritative; retained matches are bounded separately by the
// accepted byte/token capacity. Optional structural/history enrichment keeps a finite file slice.
// Scan breadth is independent of the excerpt budget that bounds evidence sent to the model.
const STRUCTURAL_SCAN_FILE_CEILING = 2048;
// Structural/history enrichment retains its existing bounded output. Lexical retained metadata
// is derived from the accepted byte/token capacity below, independently of corpus traversal.
const MATCH_RETURN_CEILING = 256;
const RING_LABELS: Readonly<Record<RetrievalRingKind, string>> = {
  lexical: "Lexical scan across the selected scope",
  structural: "Structural lookups around identifier and path anchors",
  "git-history": "Recent git-history signal across the workspace",
};

const RING_RATIONALES: Readonly<Record<RetrievalRingKind, string>> = {
  lexical:
    "Lexical anchors scan the selected scope; retained evidence is bounded by the accepted context capacity.",
  structural:
    "Identifier or path anchors warrant structural lookups so callers are reached without a full text scan.",
  "git-history":
    "Workspace-level queries benefit from recency signal because no sub-scope was preselected.",
};

const NO_ANCHOR_QUESTIONS: readonly string[] = [
  "Which file or symbol should I focus on?",
  "What error message did you see?",
  "Name a function or class to start from.",
];

const TOO_GENERIC_QUESTIONS: readonly string[] = [
  "Can you name the file, class, or function this should touch?",
  "Is there a recent error message or log line that anchors the question?",
];

const SCOPE_EMPTY_QUESTIONS: readonly string[] = [
  "Which folder or files within the workspace should I look at?",
  "Is this question about the whole workspace, or a specific module?",
];

const SCOPE_INVALID_QUESTIONS: readonly string[] = [
  "The selected scope did not validate; please reselect files or a directory.",
];

// ─── Budget slicing ───────────────────────────────────────────────────────────

function atLeastOne(value: number): number {
  return Math.max(1, Math.floor(value));
}

function ringMatchReturnLimit(kind: RetrievalRingKind, budget: ExplorationBudget): number {
  if (kind === "lexical") {
    // Each independently citable nonempty fact needs at least one excerpt byte and one input
    // token. This conservative finite capacity bounds retained metadata, not corpus traversal;
    // actual excerpts and prompt accounting still decide which evidence fits.
    return atLeastOne(Math.min(budget.excerptBytesMax, budget.modelInputTokensMax));
  }
  return atLeastOne(MATCH_RETURN_CEILING * RING_WEIGHTS[kind]);
}

/** Accepted default context capacity bounds retained results, independently of corpus size. */
export const DEFAULT_LEXICAL_MATCH_LIMIT = ringMatchReturnLimit(
  "lexical",
  DEFAULT_EXPLORATION_BUDGET,
);

function sliceLimits(
  budget: ExplorationBudget,
  weight: number,
  kind: RetrievalRingKind,
): SearchLimits {
  // Lexical traverses the entire eligible scope unless an explicit deadline or cancellation stops
  // it. Structural/history enrichment has a weighted finite file count. All rings keep per-file
  // byte eligibility and finite retained-match capacity; neither derives corpus breadth from the
  // excerpt grant. Final source reads enforce the separate accepted file/byte/token budgets.
  return {
    maxFilesScanned: kind === "lexical" ? null : atLeastOne(STRUCTURAL_SCAN_FILE_CEILING * weight),
    maxMatchesReturned: ringMatchReturnLimit(kind, budget),
    maxBytesPerFileScanned: MAX_RECURSIVE_TEXT_FILE_BYTES,
    elapsedMsMax: budget.elapsedMsMax === null ? null : atLeastOne(budget.elapsedMsMax * weight),
  };
}

// ─── Ring composition ─────────────────────────────────────────────────────────

function anchorTerms(anchors: readonly SearchAnchor[]): readonly string[] {
  return anchors.map((a) => a.term);
}

function hasKind(anchors: readonly SearchAnchor[], kind: SearchAnchorKind): boolean {
  return anchors.some((a) => a.kind === kind);
}

function buildRing(
  kind: RetrievalRingKind,
  anchors: readonly SearchAnchor[],
  budget: ExplorationBudget,
): RetrievalRing {
  return {
    kind,
    label: RING_LABELS[kind],
    anchorTerms: anchorTerms(anchors),
    searchLimits: sliceLimits(budget, RING_WEIGHTS[kind], kind),
    rationale: RING_RATIONALES[kind],
  };
}

const DIRECT_ROUTE_LOOKUP_RE =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[A-Za-z0-9:_?&=.%+*{}/-]{0,1024}[A-Za-z0-9_}/*-]/iu;
const QUERY_TERM_RE = /[\p{L}\p{N}_]+/gu;
const HISTORY_QUERY_TERMS: ReadonlySet<string> = new Set([
  "git",
  "history",
  "historie",
  "recent",
  "recency",
  "commit",
  "commits",
  "blame",
  "evolution",
  "introduced",
  "added",
  "modified",
  "modification",
  "modifications",
  "renamed",
  "removed",
  "authored",
  "zuletzt",
  "changed",
  "änderung",
  "änderungen",
  "geändert",
  "eingeführt",
  "hinzugefügt",
  "umbenannt",
  "entfernt",
  "verlauf",
]);
const DEFINITION_LOOKUP_TERMS: ReadonlySet<string> = new Set([
  "define",
  "defined",
  "defines",
  "definition",
  "declare",
  "declared",
  "declares",
  "declaration",
  "implement",
  "implemented",
  "implements",
  "implementation",
  "definieren",
  "definiert",
  "deklarieren",
  "deklariert",
  "implementieren",
  "implementiert",
]);
const ROUTE_TRAVERSAL_RE = /\b(?:handlers?|trace|traces|tracing|call[- ]?paths?|aufrufpfade?)\b/iu;
const IDENTIFIER_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/gu;
const TEST_IDENTIFIER_SUFFIX_RE = /(?:Test|Tests|Spec|Specs)$/u;
const DELIMITED_TEST_IDENTIFIER_SUFFIX_RE = /(?:^|[_$])(?:tests?|specs?)$/u;

function hasQueryTerm(text: string, terms: ReadonlySet<string>): boolean {
  return [...text.toLowerCase().matchAll(QUERY_TERM_RE)].some((match) => terms.has(match[0]));
}

function hasHistoryQuery(text: string): boolean {
  return [...queryContextOutsideQuotes(text).toLowerCase().matchAll(QUERY_TERM_RE)].some(
    (match) =>
      HISTORY_QUERY_TERMS.has(match[0]) ||
      /^histor(?:ical(?:ly)?|isch(?:e[nmrs]?)?)$/u.test(match[0]),
  );
}

function hasDefinitionLookup(text: string): boolean {
  return hasQueryTerm(queryContextOutsideQuotes(text), DEFINITION_LOOKUP_TERMS);
}

function hasSymbolRelation(text: string): boolean {
  return hasSymbolRelationshipQuery(queryContextOutsideQuotes(text));
}

function isTestIdentifier(text: string, normalizedSymbol: string): boolean {
  const sourceToken = [...text.matchAll(IDENTIFIER_TOKEN_RE)]
    .map((match) => match[0])
    .find((token) => token.toLowerCase() === normalizedSymbol.toLowerCase());
  return (
    sourceToken !== undefined &&
    (TEST_IDENTIFIER_SUFFIX_RE.test(sourceToken) ||
      DELIMITED_TEST_IDENTIFIER_SUFFIX_RE.test(sourceToken))
  );
}

function isDirectRouteLookup(query: RetrievalQuery): boolean {
  return (
    DIRECT_ROUTE_LOOKUP_RE.test(parseDiagnosticTraceText(query.text).questionText) &&
    !hasHistoryQuery(query.text) &&
    !hasSymbolRelation(query.text) &&
    !ROUTE_TRAVERSAL_RE.test(query.text)
  );
}

export function requiresRelationshipOrHistoryRings(query: RetrievalQuery): boolean {
  const prose = extractPathReferences(query.text).reduce(
    (text, reference) => text.split(reference.path).join(" "),
    query.text,
  );
  return (
    hasHistoryQuery(prose) ||
    hasSymbolRelation(prose) ||
    REQUESTED_TEST_RELATION_RE.test(queryContextOutsideQuotes(prose)) ||
    ROUTE_TRAVERSAL_RE.test(queryContextOutsideQuotes(prose))
  );
}

const DIRECT_DOCUMENT_REFERENCE_RE = /^(?:adr|rfc)-\d{3,6}$/iu;
const REQUESTED_TEST_RELATION_RE =
  /\b(?:tests?|testing|tested|specs?|integration|integrations|integrationstests?|testet|getestet)\b/iu;
export interface QueryTargetDecision {
  readonly kind: "literal-search" | "direct-fact" | "contextual";
  readonly targets: readonly SearchAnchor[];
  readonly definitionSymbol: string | undefined;
  readonly definitionRequested: boolean;
  /** A completely parsed query-only file request; unknown continuations cannot narrow discovery. */
  readonly namedFileOnly?: true;
  /** A completely parsed self-contained conversation or general-advice request, without source work. */
  readonly conversationOnly?: true;
}

const SEARCH_COMMANDS = new Set(["find", "search", "locate", "suche", "finde", "lokalisiere"]);
const SEARCH_MODIFIERS = new Set([
  "for",
  "nach",
  "recursively",
  "rekursiv",
  "the",
  "der",
  "die",
  "das",
  "den",
  "exact",
  "literal",
  "phrase",
  "identifier",
  "symbol",
  "kennung",
  "suchbegriff",
  "exakten",
  "exakte",
  "exakter",
  "exaktes",
  "wörtlichen",
  "wörtliche",
]);
const DEFINITION_GRAMMAR_WORDS = new Set([
  "is",
  "are",
  "do",
  "we",
  "ist",
  "sind",
  "wir",
  "the",
  "and",
  "und",
]);
const SHAPE_TOKEN_RE = /\0|[\p{L}\p{N}_$-]+/gu;
const ENGLISH_VALUE_REQUEST_RE =
  /^what\s+(?:value\s+is\s+documented\s+for|is\s+(?:the\s+)?value\s+of)\s+\0$/iu;
const GERMAN_VALUE_REQUEST_RE = /^welche\s+werte\s+stehen\s+zu\s+\0$/iu;
const GERMAN_INFORMATION_REQUEST_RE =
  /^welche\s+information\s+ist\s+(?:für\s+\0|dazu)\s+in\s+diesem\s+ordner\s+belegt$/iu;
const NAMED_FILE_COMMAND_RE =
  /^(?:please |bitte )?(?:read|show|open|explain|describe|summarize|inspect|lies|zeige|öffne|erkläre|beschreibe) (?:the |die |das |den )?\0(?: (?:and |und )?\0)*$/iu;
const NAMED_FILE_CONTAINED_REQUEST_RE =
  /^(?:please |bitte )?(?:explain|describe|summarize|erkläre|beschreibe) (.+) (?:in|within|from|aus) \0$/iu;
const NAMED_FILE_SUBJECT_REQUEST_RE =
  /^(?:please |bitte )?(?:explain|describe|erkläre|beschreibe) (?:how|wie) \0 (.+)$/iu;
const INDEPENDENT_REQUEST_GRAMMAR_RE =
  /\b(?:as well as|along with|alongside|together with|and|or|but|while|whilst|whereas|also|besides|plus|then|instead|otherwise|what|which|where|who|how|why|und|oder|aber|während|außerdem|zudem|zusätzlich|auch|dann|sowie|was|welche|wo|wie|warum)\b/iu;
const REQUEST_COMMAND_RE =
  /\b(?:read|show|open|explain|describe|summarize|inspect|find|search|locate)(?:s|ed|ing)?\b|\b(?:lies|zeige|öffne|erkläre|erklären|erklärst|beschreibe|beschreiben|suche|finde)\b/iu;

function boundNamedFilePredicate(text: string): boolean {
  return (
    text.length > 0 &&
    !text.includes("\0") &&
    !INDEPENDENT_REQUEST_GRAMMAR_RE.test(text) &&
    !REQUEST_COMMAND_RE.test(text)
  );
}

function isNamedFileClause(words: readonly string[]): boolean {
  if (!words.includes("\0")) return false;
  if (words.length === 1) return true;
  const clause = words.join(" ");
  if (NAMED_FILE_COMMAND_RE.test(clause) || isSearchClause(words) || isFactClause(words))
    return true;
  const contained = NAMED_FILE_CONTAINED_REQUEST_RE.exec(clause)?.[1];
  const subject = NAMED_FILE_SUBJECT_REQUEST_RE.exec(clause)?.[1];
  const predicate = contained ?? subject;
  return predicate !== undefined && boundNamedFilePredicate(predicate);
}

function namedFileRequestShape(query: RetrievalQuery): string | undefined {
  const references = extractRetrievalChannels(query.text, query.text.length).references.filter(
    (reference) => reference.origin === "query",
  );
  if (references.length === 0 || !references.every((reference) => reference.path.includes("/")))
    return undefined;
  const shape = references
    .reduce(
      (text, reference) => text.replaceAll(reference.path.toLowerCase(), "\0"),
      query.text.toLowerCase(),
    )
    .replace(/\0(?::\d{1,9}){1,2}/gu, "\0");
  if (extractPathReferences(shape).length > 0) return undefined;
  return shape;
}

function namedFileClauseDecision(clause: string): boolean | undefined {
  const projected = queryShapeOutsideTargets(clause, [{ term: "\0", kind: "path", weight: 1 }]);
  if (/[`"']/u.test(projected)) return false;
  const fragments = projected.includes("\0") ? projected.split(",") : [projected];
  const decisions = fragments.map(namedFileWordsDecision);
  if (decisions.includes(false)) return false;
  return decisions.includes(true) ? true : undefined;
}

function namedFileWordsDecision(clause: string): boolean | undefined {
  const words = shapeWords(queryContextOutsideQuotes(clause));
  return words.length === 0 ? undefined : isNamedFileClause(words);
}

function namedFileOnlyRequest(query: RetrievalQuery): boolean {
  if (query.kind !== "natural-language") return false;
  const shape = namedFileRequestShape(query);
  if (shape === undefined) return false;
  const clauses = shape.split(/[.!?;\n&]/u).map(namedFileClauseDecision);
  return clauses.includes(true) && !clauses.includes(false);
}

const ACKNOWLEDGEMENT_REQUEST_RE =
  /^(?:(?:please|bitte)\s+)?(?:(?:briefly|kurz)\s+)?(?:acknowledge|confirm(?:\s+receipt\s+of)?|bestätige(?:\s+den\s+erhalt\s+von)?)\s+(?:these|this|my|our|the|diese|diesen|dieses|meine|unsere)\s+(?:working\s+)?(?:preferences?|notes?|context|message|information|präferenzen|notizen|nachricht|informationen)(?:\s+in\s+(?:no\s+more\s+than\s+)?[\p{L}\d-]+\s+words)?$/iu;
const SUPPLIED_CONTEXT_RE =
  /^(?:my|our|this|these|meine|unsere|dies|diese)\b[^.!?;\n]*\b(?:is|are|ist|sind)\b/iu;
const ACKNOWLEDGEMENT_OUTPUT_RE =
  /^(?:(?:please|bitte)\s+)?(?:do\s+not\s+repeat\s+(?:the|this|these)\s+(?:note|notes|message|context)|wiederhole\s+(?:die|diese)\s+(?:notiz|notizen|nachricht)\s+nicht)$/iu;
const INDEPENDENT_CONTEXT_COMMAND_RE =
  /\b(?:then|also|please|while|dann|außerdem|bitte|während)\s+(?:explain|read|show|find|search|describe|erkläre|lies|zeige|suche|beschreibe)\b/iu;

function suppliedContextClause(clause: string, index: number): boolean {
  if (INDEPENDENT_CONTEXT_COMMAND_RE.test(clause)) return false;
  if (SUPPLIED_CONTEXT_RE.test(clause)) return true;
  // A supplied personal heading may be a fragment rather than an asserted source fact.
  if (/^(?:my|our|meine|unsere)\s+[\p{L}\d -]+$/iu.test(clause))
    return !REQUEST_COMMAND_RE.test(clause) && !INDEPENDENT_REQUEST_GRAMMAR_RE.test(clause);
  // A neutral initial heading supplies context; it cannot authorize an instruction or question.
  return (
    index === 0 &&
    /^[\p{L}\d][\p{L}\d -]*$/u.test(clause) &&
    !REQUEST_COMMAND_RE.test(clause) &&
    !INDEPENDENT_REQUEST_GRAMMAR_RE.test(clause)
  );
}

const GENERAL_ADVICE_REQUEST_RE =
  /^(?:(?:please|bitte)\s+)?(?:(?:suggest|give|provide|recommend)\s+(?:a\s+)?(?:(?:short|brief|concise)\s+)?general\s+(?:process|method|approach|guidance|advice|principles)|(?:gib|empfiehl|beschreibe)\s+(?:(?:eine|einen)\s+)?(?:kurze[nr]?\s+)?allgemeine[nr]?\s+(?:vorgehensweise|methode|ansatz|hinweise))(?:,\s*(?:under|below|within|unter)\s+\d{1,6}\s+(?:words|wörtern|worte))?$/iu;
const GENERAL_ADVICE_QUESTION_RE =
  /^(?:how\s+(?:should|could|can)\s+(?:a|an|one|we)|wie\s+(?:sollte|könnte|kann)\s+(?:man|wir|ein|eine))\s+[\p{L}\p{N} ,()-]+$/iu;
const SOURCE_CONSTRAINED_ADVICE_RE =
  /\b(?:according\s+to|as\s+(?:specified|documented)\s+in|based\s+on|laut|gemäß)\b|\b(?:this|these|that|those|the|our|my)\s+(?:(?:attached|connected|selected|supplied)\s+)?(?:sources?|manuals?|documents?|files?|folders?|repositor(?:y|ies)|evidence)\b|\b(?:dieses?|diese[nr]?|das|die|der|unser[e]?|mein[e]?)\s+(?:(?:verbundenen?|ausgewählten?|angehängten?)\s+)?(?:handbuch|handbücher|quellen?|dateien?|ordner|dokumente?|repository)\b/iu;

function generalAdviceRequest(clauses: readonly string[]): boolean {
  if (clauses.length !== 2 || !GENERAL_ADVICE_REQUEST_RE.test(clauses[1] ?? "")) return false;
  const question = clauses[0] ?? "";
  return (
    GENERAL_ADVICE_QUESTION_RE.test(question) &&
    !INDEPENDENT_CONTEXT_COMMAND_RE.test(question) &&
    !SOURCE_CONSTRAINED_ADVICE_RE.test(question)
  );
}

function suppliedContextRequest(clauses: readonly string[]): boolean {
  const acknowledgement = clauses.findIndex((clause) => ACKNOWLEDGEMENT_REQUEST_RE.test(clause));
  if (acknowledgement < 0) return false;
  return clauses.every((clause, index) =>
    index < acknowledgement
      ? suppliedContextClause(clause, index)
      : index === acknowledgement || ACKNOWLEDGEMENT_OUTPUT_RE.test(clause),
  );
}

function conversationOnlyRequest(query: RetrievalQuery, anchors: readonly SearchAnchor[]): boolean {
  if (query.kind !== "natural-language" || anchors.some((anchor) => anchor.kind !== "literal"))
    return false;
  if (parseDiagnosticTraceText(query.text).detected || /[`"']/u.test(query.text)) return false;
  const clauses = queryContextOutsideQuotes(query.text)
    .split(/[.!?;\n]+/u)
    .map((clause) => clause.trim().replace(/[,\s]+$/u, ""))
    .filter(Boolean);
  return (
    generalAdviceRequest(clauses) || (!query.text.includes("?") && suppliedContextRequest(clauses))
  );
}

function requestContentTargets(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
): readonly SearchAnchor[] {
  const original = query.text.toLowerCase();
  return anchors.filter(
    (anchor) =>
      (anchor.kind === "quoted" || (anchor.kind === "identifier" && anchor.weight >= 0.85)) &&
      original.includes(anchor.term),
  );
}

function shapeWords(text: string): readonly string[] {
  return [...text.toLowerCase().matchAll(SHAPE_TOKEN_RE)].map((match) => match[0]);
}

function isSearchClause(words: readonly string[]): boolean {
  const start = words[0] === "please" || words[0] === "bitte" ? 1 : 0;
  if (!SEARCH_COMMANDS.has(words[start] ?? "")) return false;
  const target = words.indexOf("\0", start + 1);
  const targetWords = literalTargetWords(words.slice(target));
  return (
    target > start &&
    words.slice(start + 1, target).every((word) => SEARCH_MODIFIERS.has(word)) &&
    targetWords.every((word) => word === "\0" || ["and", "und", "or", "oder"].includes(word))
  );
}

function literalTargetWords(words: readonly string[]): readonly string[] {
  if (words.slice(-3).join(" ") === "and its value") return words.slice(0, -3);
  if (["exactly", "exakt", "wörtlich"].includes(words.at(-1) ?? "")) return words.slice(0, -1);
  return words;
}

function isDefinitionClause(words: readonly string[]): boolean {
  return (
    (words[0] === "where" || words[0] === "wo") &&
    words.includes("\0") &&
    words.some((word) => DEFINITION_LOOKUP_TERMS.has(word)) &&
    words
      .slice(1)
      .every(
        (word) =>
          word === "\0" || DEFINITION_LOOKUP_TERMS.has(word) || DEFINITION_GRAMMAR_WORDS.has(word),
      )
  );
}

function isFactClause(words: readonly string[]): boolean {
  const clause = words.join(" ");
  return (
    isDefinitionClause(words) ||
    isCompoundDefinitionFact(words) ||
    ENGLISH_VALUE_REQUEST_RE.test(clause) ||
    GERMAN_VALUE_REQUEST_RE.test(clause) ||
    GERMAN_INFORMATION_REQUEST_RE.test(clause)
  );
}

function isCompoundDefinitionFact(words: readonly string[]): boolean {
  const separator = words.lastIndexOf("and");
  if (separator < 0 || !isDefinitionClause(words.slice(0, separator))) return false;
  const returnedValue = words.slice(separator + 1).join(" ");
  return (
    /^what values? do (?:they|\0(?: and \0)*) return$/iu.test(returnedValue) ||
    /^what does \0 return$/iu.test(returnedValue)
  );
}

function positiveRequestKind(shape: string): QueryTargetDecision["kind"] {
  const clauses = shape
    .split(/[.!?:;]+/u)
    .map(shapeWords)
    .filter((words) => words.length > 0);
  if (
    clauses.length === 0 ||
    clauses.some(
      (words) =>
        !isSearchClause(words) &&
        !isFactClause(words) &&
        !(words.length === 1 && words[0] === "\0"),
    )
  )
    return "contextual";
  if (clauses.some(isSearchClause)) return "literal-search";
  return clauses.some(isFactClause) ? "direct-fact" : "contextual";
}

/** Only fully parsed positive request shapes authorize narrowing; all unknown prose stays broad. */
function definitionTarget(
  query: RetrievalQuery,
  kind: QueryTargetDecision["kind"],
  targets: readonly SearchAnchor[],
  definitionRequested: boolean,
): string | undefined {
  if (kind === "contextual" || query.kind === "exact-symbol" || !definitionRequested)
    return undefined;
  const identifiers = targets.filter((anchor) => anchor.kind === "identifier");
  const symbol = identifiers[0]?.term;
  return identifiers.length === 1 && symbol !== undefined && !isTestIdentifier(query.text, symbol)
    ? symbol
    : undefined;
}

export function resolveQueryTargetDecision(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  maxTargets = query.text.length,
): QueryTargetDecision {
  // Inspect the full question, but never certify a literal-only request after target clipping.
  const requested = extractAnchors({ text: query.text, maxAnchors: maxTargets });
  const strongTargets = requestContentTargets(query, requested.anchors);
  const possibleTargets =
    strongTargets.length > 0
      ? strongTargets
      : anchors.filter((anchor) => anchor.kind === "literal" && /^\d+$/u.test(anchor.term));
  let kind: QueryTargetDecision["kind"] = "contextual";
  if (query.kind === "exact-symbol") kind = "literal-search";
  else if (!requested.truncated && possibleTargets.length > 0)
    kind = positiveRequestKind(queryShapeOutsideTargets(query.text, possibleTargets));
  const targets = kind === "literal-search" ? possibleTargets : strongTargets;
  const definitionRequested = hasDefinitionLookup(query.text);
  return {
    kind,
    targets,
    definitionSymbol: definitionTarget(query, kind, targets, definitionRequested),
    definitionRequested,
    ...(namedFileOnlyRequest(query) ? { namedFileOnly: true } : {}),
    ...(conversationOnlyRequest(query, requested.anchors) ? { conversationOnly: true } : {}),
  };
}

// Direct named evidence needs definition/document discovery, while requested relationships and
// diagnostics retain their structural/history routing. The single-symbol narrowing API below
// remains separate so a multi-target question cannot accidentally become a one-symbol query.
export function isDirectEvidenceLookup(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  decision = resolveQueryTargetDecision(query, anchors),
): boolean {
  if (requiresRelationshipOrHistoryRings(query) || decision.kind === "contextual") return false;
  const targets = anchors.filter(
    (anchor) =>
      (anchor.kind === "identifier" || anchor.kind === "quoted") &&
      anchor.weight >= 0.85 &&
      /^[a-z_$][a-z0-9_$-]*$/iu.test(anchor.term),
  );
  if (targets.length === 0) return false;
  return hasDefinitionLookup(query.text)
    ? targets.every((anchor) => !isTestIdentifier(query.text, anchor.term))
    : targets.every((anchor) => DIRECT_DOCUMENT_REFERENCE_RE.test(anchor.term));
}

export function directDefinitionSymbol(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  decision = resolveQueryTargetDecision(query, anchors),
): string | undefined {
  const symbol = decision.definitionSymbol;
  return anchors.some(
    (anchor) => anchor.kind === "identifier" && anchor.weight >= 0.85 && anchor.term === symbol,
  )
    ? symbol
    : undefined;
}

interface PlannedRings {
  readonly rings: readonly RetrievalRing[];
  readonly directEvidenceLookup: boolean;
}

function composeRings(
  anchors: readonly SearchAnchor[],
  scope: SelectedScope,
  query: RetrievalQuery,
  budget: ExplorationBudget,
  targetDecision: QueryTargetDecision,
): PlannedRings {
  const rings: RetrievalRing[] = [buildRing("lexical", anchors, budget)];
  const directLookup =
    isDirectRouteLookup(query) || isDirectEvidenceLookup(query, anchors, targetDecision);
  if (!directLookup && (hasKind(anchors, "identifier") || hasKind(anchors, "path"))) {
    rings.push(buildRing("structural", anchors, budget));
  }
  if (
    !directLookup &&
    (scope.relativePaths.length === 0 || requiresRelationshipOrHistoryRings(query))
  ) {
    rings.push(buildRing("git-history", anchors, budget));
  }
  return { rings, directEvidenceLookup: directLookup };
}

// ─── Clarification helpers ────────────────────────────────────────────────────

function maxAnchorWeight(anchors: readonly SearchAnchor[]): number {
  let max = 0;
  for (const a of anchors) {
    if (a.weight > max) {
      max = a.weight;
    }
  }
  return max;
}

function buildClarification(
  reason: ClarificationReason,
  suggestedQuestions: readonly string[],
  minimumAnchorCount: number,
): ClarificationPrompt {
  return { reason, suggestedQuestions, minimumAnchorCount };
}

interface ClarificationDecision {
  readonly state: ExplorationPlanState;
  readonly clarification: ClarificationPrompt | undefined;
}

function decideClarification(
  anchors: readonly SearchAnchor[],
  scope: SelectedScope,
  intent: RetrievalIntent,
): ClarificationDecision {
  if (anchors.length === 0 || intent === "clarification-needed") {
    return {
      state: "clarification-needed",
      clarification: buildClarification("no-anchors", NO_ANCHOR_QUESTIONS, 1),
    };
  }
  // An explicit connection is the human-selected search boundary, including a whole repository.
  // Precision controls ranking, not permission to read. The governor still bounds every scan.
  if (scope.explicitConnection === true) {
    return { state: "ready", clarification: undefined };
  }
  // Threshold is <= literal weight so a prompt yielding only `literal` anchors (weight 0.5,
  // i.e. no quoted/path/identifier signal) requests clarification before any retrieval runs.
  if (maxAnchorWeight(anchors) <= 0.5) {
    return {
      state: "clarification-needed",
      clarification: buildClarification("too-generic", TOO_GENERIC_QUESTIONS, 1),
    };
  }
  if (scope.relativePaths.length === 0 && anchors.length < 2) {
    return {
      state: "clarification-needed",
      clarification: buildClarification("scope-empty", SCOPE_EMPTY_QUESTIONS, 2),
    };
  }
  return { state: "ready", clarification: undefined };
}

function plannedRequestDecision(
  target: QueryTargetDecision,
  references: readonly SearchReference[],
  classification: RetrievalIntentClassification,
  anchors: readonly SearchAnchor[],
  scope: SelectedScope,
): { classification: RetrievalIntentClassification; decision: ClarificationDecision } {
  if (target.conversationOnly === true && references.length === 0) {
    return {
      classification: { intent: "clarification-needed", normalizedTerms: [] },
      decision: {
        state: "clarification-needed",
        clarification: buildClarification("too-generic", TOO_GENERIC_QUESTIONS, 1),
      },
    };
  }
  return { classification, decision: decideClarification(anchors, scope, classification.intent) };
}

// ─── Plan ID derivation ───────────────────────────────────────────────────────

interface PlanSeed {
  readonly scopeId: string;
  readonly queryKind: string;
  readonly queryText: string;
  readonly retrievalIntent: RetrievalIntent;
  readonly anchorTerms: readonly string[];
  readonly references?: readonly SearchReference[];
  readonly effectiveIntent?: RetrievalIntent;
  readonly ringKinds: readonly string[];
}

function canonicalize(seed: PlanSeed): string {
  // JSON.stringify with sorted keys via explicit ordering — never relies on object key order.
  const parts: unknown[] = [
    seed.scopeId,
    seed.queryKind,
    seed.queryText,
    seed.retrievalIntent,
    [...seed.anchorTerms].sort(compareStrings),
    [...seed.ringKinds].sort(compareStrings),
  ];
  if ((seed.references?.length ?? 0) > 0 || seed.effectiveIntent !== undefined) {
    parts.push(
      seed.effectiveIntent ?? seed.retrievalIntent,
      seed.references
        ?.map((reference) => [reference.path, reference.line ?? null, reference.origin])
        .sort((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b))) ?? [],
    );
  }
  return JSON.stringify(parts);
}

function derivePlanId(seed: PlanSeed): string {
  const hash = createHash("sha256").update(canonicalize(seed)).digest("hex");
  return `pl-${hash.slice(0, 16)}`;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

interface ResolvedInputs {
  readonly budget: ExplorationBudget;
  readonly maxAnchors: number;
  readonly nowMs: () => number;
}

function resolveInputs(input: CreatePlanInput, deps: CreatePlanDeps | undefined): ResolvedInputs {
  return {
    budget: input.budget ?? DEFAULT_EXPLORATION_BUDGET,
    maxAnchors: input.maxAnchors ?? DEFAULT_MAX_ANCHORS,
    nowMs: deps?.nowMs ?? Date.now,
  };
}

function buildScopeInvalidPlan(
  input: CreatePlanInput,
  resolved: ResolvedInputs,
  classification: RetrievalIntentClassification,
): ExplorationPlan {
  const clarification = buildClarification("scope-invalid", SCOPE_INVALID_QUESTIONS, 0);
  const seed: PlanSeed = {
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    retrievalIntent: classification.intent,
    anchorTerms: [],
    ringKinds: [],
  };
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    planId: derivePlanId(seed),
    state: "scope-invalid",
    retrievalIntent: classification.intent,
    directEvidenceLookup: false,
    scope: input.scope,
    query: input.query,
    anchors: [],
    rings: [],
    budget: resolved.budget,
    clarification,
    createdAtMs: resolved.nowMs(),
  };
}

function readyPlanSeed(
  input: CreatePlanInput,
  classification: RetrievalIntentClassification,
  anchors: readonly SearchAnchor[],
  references: readonly SearchReference[],
  rings: readonly RetrievalRing[],
): PlanSeed {
  return {
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    retrievalIntent: classification.intent,
    anchorTerms: anchors.map((anchor) => anchor.term),
    references,
    ...(classification.effectiveIntent === undefined
      ? {}
      : { effectiveIntent: classification.effectiveIntent }),
    ringKinds: rings.map((ring) => ring.kind),
  };
}

export function createExplorationPlan(
  input: CreatePlanInput,
  deps?: CreatePlanDeps,
): ExplorationPlan {
  const resolved = resolveInputs(input, deps);
  const classification = classifyRetrievalIntent(input.query.text, input.scope, {
    previousIntent: input.previousRetrievalIntent,
    referencePresent: (input.references?.length ?? 0) > 0,
  });
  const scopeResult = validateSelectedScope(input.scope);
  if (!scopeResult.ok) {
    return buildScopeInvalidPlan(input, resolved, classification);
  }
  return buildSelectedScopePlan(input, resolved, classification);
}

function buildSelectedScopePlan(
  input: CreatePlanInput,
  resolved: ResolvedInputs,
  classification: RetrievalIntentClassification,
): ExplorationPlan {
  const extraction = extractRetrievalChannels(
    input.query.text,
    resolved.maxAnchors,
    input.references,
  );
  const searchAnchors = [...extraction.anchors, ...searchReferenceAnchors(extraction.references)];
  const targetDecision = resolveQueryTargetDecision(input.query, searchAnchors, input.maxAnchors);
  const { classification: plannedClassification, decision } = plannedRequestDecision(
    targetDecision,
    extraction.references,
    classification,
    searchAnchors,
    input.scope,
  );
  const { rings, directEvidenceLookup } =
    decision.state === "ready"
      ? composeRings(searchAnchors, input.scope, input.query, resolved.budget, targetDecision)
      : { rings: [], directEvidenceLookup: false };
  const seed = readyPlanSeed(
    input,
    plannedClassification,
    searchAnchors,
    extraction.references,
    rings,
  );
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    planId: derivePlanId(seed),
    state: decision.state,
    retrievalIntent: plannedClassification.intent,
    ...(plannedClassification.effectiveIntent === undefined
      ? {}
      : { effectiveRetrievalIntent: plannedClassification.effectiveIntent }),
    directEvidenceLookup,
    scope: input.scope,
    query: input.query,
    anchors: extraction.anchors,
    references: extraction.references,
    targetDecision,
    rings,
    budget: resolved.budget,
    clarification: decision.clarification,
    createdAtMs: resolved.nowMs(),
  };
}
