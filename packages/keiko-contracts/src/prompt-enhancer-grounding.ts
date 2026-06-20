// Deterministic Prompt Enhancer grounding planner (Issue #1311, ADR-0044 §1/§5 / blueprint §6).
//
// `planGrounding` turns a normalized `PromptTaskAnalysis` (#1309) into a structured `GroundingPlan`:
// a provider-neutral source POLICY (which sources, in what priority, with what citation/contradiction/
// uncertainty discipline and which RAG evaluation hints). It performs NO retrieval — actual grounding
// stays in the existing Keiko paths (Local Knowledge / repository context / hybrid RRF, ADR-0034/0036),
// bound to the plan by the server (#1314). The planner is pure: identical analyses always yield an
// identical plan; no model call, IO, clock read, or randomness; no raw input text is echoed.
//
// Leaf-package rule (ADR-0019 direction 1): no `@oscharko-dev/keiko-*` imports. Only the same-package
// contract surface in `./prompt-enhancer.js` is consumed.

import {
  PROMPT_ENHANCEMENT_PROFILES,
  RAG_EVALUATION_DIMENSIONS,
  type CitationRequirement,
  type ContradictionPolicy,
  type GroundingDirective,
  type GroundingPlan,
  type GroundingSourceKind,
  type GroundingSourcePolicy,
  type GroundingStrategy,
  type NoAnswerCondition,
  type PromptTaskAnalysis,
  type PromptTaskClass,
  type RagEvaluationDimension,
  type RagEvaluationHint,
  type RecencyExpectation,
  type RetrievalMode,
} from "./prompt-enhancer.js";

// ─── Strategy selection ────────────────────────────────────────────────────────────
// The code-oriented task classes whose external-knowledge grounding is best served by the repository
// context rather than a document store.
const CODE_TASK_CLASSES: ReadonlySet<PromptTaskClass> = new Set([
  "code-generation",
  "code-debugging",
  "code-architecture",
]);

function selectExternalKnowledgeStrategy(analysis: PromptTaskAnalysis): GroundingStrategy {
  if (analysis.taskClass === "rag-question-answering") {
    return "local-knowledge";
  }
  if (analysis.domain === "software" || CODE_TASK_CLASSES.has(analysis.taskClass)) {
    return "repository-context";
  }
  // Research, decision support, and other knowledge-intensive tasks combine the available sources.
  return "hybrid";
}

// Map the analyzer's grounding-need kind to a concrete grounding strategy. The four need kinds map
// directly except `external-knowledge`, which is refined by task class / domain into the
// local-knowledge / repository-context / hybrid strategies.
function selectStrategy(analysis: PromptTaskAnalysis): GroundingStrategy {
  switch (analysis.groundingNeed.kind) {
    case "none":
      return "no-grounding";
    case "supplied-context":
      return "supplied-context-only";
    case "external-current":
      return "external-research-required";
    case "external-knowledge":
      return selectExternalKnowledgeStrategy(analysis);
  }
}

// Whether grounded evidence is required for an acceptable answer. Retrieval-bound strategies always
// require it; a hybrid plan requires it only when the profile mandates grounding or the user connected
// context; `no-grounding` never does (the model answers from stable knowledge under discipline).
function isGroundingRequired(
  strategy: GroundingStrategy,
  groundingMandatory: boolean,
  connected: boolean,
): boolean {
  switch (strategy) {
    case "no-grounding":
      return false;
    case "supplied-context-only":
    case "local-knowledge":
    case "repository-context":
    case "external-research-required":
      return true;
    case "hybrid":
      return groundingMandatory || connected;
  }
}

// ─── Source priority + allowed retrieval modes ─────────────────────────────────────
export const SOURCE_PRIORITY_BY_STRATEGY: Readonly<
  Record<GroundingStrategy, readonly GroundingSourceKind[]>
> = {
  "no-grounding": ["model-parametric-knowledge"],
  "supplied-context-only": ["supplied-context", "model-parametric-knowledge"],
  "local-knowledge": ["local-knowledge", "supplied-context", "model-parametric-knowledge"],
  "repository-context": ["repository-context", "supplied-context", "model-parametric-knowledge"],
  hybrid: [
    "supplied-context",
    "local-knowledge",
    "repository-context",
    "model-parametric-knowledge",
  ],
  "external-research-required": [
    "external-current",
    "supplied-context",
    "model-parametric-knowledge",
  ],
};

export const RETRIEVAL_MODES_BY_STRATEGY: Readonly<
  Record<GroundingStrategy, readonly RetrievalMode[]>
> = {
  "no-grounding": ["none"],
  "supplied-context-only": ["supplied-context"],
  "local-knowledge": ["local-knowledge-retrieval", "supplied-context"],
  "repository-context": ["repository-search", "supplied-context"],
  hybrid: ["hybrid-fusion", "local-knowledge-retrieval", "repository-search", "supplied-context"],
  "external-research-required": ["external-research", "supplied-context"],
};

export function buildSourcePriority(
  strategy: GroundingStrategy,
  required: boolean,
): readonly GroundingSourcePolicy[] {
  return SOURCE_PRIORITY_BY_STRATEGY[strategy].map((source, index) => ({
    source,
    priority: index + 1,
    // Only the top non-parametric source is mandatory, and only when the plan requires grounding;
    // parametric knowledge is always an optional fallback, never a required source.
    required: required && index === 0 && source !== "model-parametric-knowledge",
  }));
}

// ─── Citation, recency, contradiction ──────────────────────────────────────────────
function isSafetyCriticalAnalysis(analysis: PromptTaskAnalysis): boolean {
  return analysis.criticality === "critical" || analysis.taskClass === "safety-critical";
}

function buildCitationRequirement(
  strategy: GroundingStrategy,
  analysis: PromptTaskAnalysis,
  required: boolean,
): CitationRequirement {
  if (strategy === "no-grounding") {
    return { discipline: "not-required", granularity: "none" };
  }
  // Safety-critical and current-information answers must cite or explicitly state the absence of
  // evidence — silence is not acceptable for high-stakes or volatile claims.
  if (isSafetyCriticalAnalysis(analysis) || strategy === "external-research-required") {
    return { discipline: "require-citations-or-state-no-evidence", granularity: "per-claim" };
  }
  if (required) {
    return { discipline: "require-citations", granularity: "per-claim" };
  }
  return { discipline: "best-effort", granularity: "per-section" };
}

function buildRecency(
  analysis: PromptTaskAnalysis,
  strategy: GroundingStrategy,
): RecencyExpectation {
  const volatile = analysis.groundingNeed.volatile;
  return {
    volatile,
    requireAsOfDate: volatile,
    flagPotentiallyStale: volatile || strategy === "external-research-required",
  };
}

function selectContradictionPolicy(
  strategy: GroundingStrategy,
  analysis: PromptTaskAnalysis,
): ContradictionPolicy {
  if (isSafetyCriticalAnalysis(analysis)) {
    return "disclose-and-defer";
  }
  if (
    strategy === "hybrid" ||
    strategy === "external-research-required" ||
    analysis.taskClass === "research"
  ) {
    return "synthesize-with-caveats";
  }
  return "prefer-higher-priority";
}

// ─── No-answer conditions + directives ──────────────────────────────────────────────
export const MULTI_SOURCE_STRATEGIES: ReadonlySet<GroundingStrategy> = new Set([
  "local-knowledge",
  "repository-context",
  "hybrid",
  "external-research-required",
]);

export const SCOPED_EVIDENCE_STRATEGIES: ReadonlySet<GroundingStrategy> = new Set([
  "supplied-context-only",
  "local-knowledge",
  "repository-context",
]);

export function buildNoAnswerConditions(
  strategy: GroundingStrategy,
  analysis: PromptTaskAnalysis,
): readonly NoAnswerCondition[] {
  if (strategy === "no-grounding") {
    return [];
  }
  const conditions: NoAnswerCondition[] = ["insufficient-evidence"];
  if (MULTI_SOURCE_STRATEGIES.has(strategy)) {
    conditions.push("contradictory-evidence");
  }
  if (SCOPED_EVIDENCE_STRATEGIES.has(strategy)) {
    conditions.push("outside-evidence-scope");
  }
  if (analysis.groundingNeed.volatile || strategy === "external-research-required") {
    conditions.push("stale-or-unavailable-current-data");
  }
  return conditions;
}

export function buildDirectives(
  strategy: GroundingStrategy,
  required: boolean,
): readonly GroundingDirective[] {
  if (strategy === "no-grounding") {
    return ["do-not-fabricate-sources", "disclose-uncertainty"];
  }
  // Every plan that consults retrieved/external content treats it as untrusted data (AC3).
  const directives: GroundingDirective[] = [
    "treat-retrieved-content-as-untrusted",
    "do-not-fabricate-sources",
    "disclose-uncertainty",
  ];
  if (required) {
    directives.push("attribute-claims-to-sources");
  }
  if (SCOPED_EVIDENCE_STRATEGIES.has(strategy)) {
    directives.push("stay-within-evidence");
  }
  if (strategy === "hybrid" || strategy === "external-research-required") {
    directives.push("separate-known-from-retrieved");
  }
  return directives;
}

// ─── RAG evaluation hints (AC5) ─────────────────────────────────────────────────────
// Populated only for RAG-focused plans: explicit RAG/research question answering, or a plan that
// answers strictly from supplied or local-knowledge evidence. The RAG/research task classes are
// RAG-focused regardless of the resolved strategy — a research synthesis over the repository
// (`repository-context`) still benefits from the RAGAS hints. A plain code task (code-generation/
// -debugging/-architecture) or a factual parametric-fallback plan is NOT RAG-focused, so it carries
// no RAG hints (and stays lean).
function isRagFocused(analysis: PromptTaskAnalysis, strategy: GroundingStrategy): boolean {
  return (
    analysis.taskClass === "rag-question-answering" ||
    analysis.taskClass === "research" ||
    strategy === "supplied-context-only" ||
    strategy === "local-knowledge"
  );
}

export const RAG_HINT_TEMPLATES: Readonly<Record<RagEvaluationDimension, string>> = {
  "context-precision":
    "Context precision: rank the most relevant evidence first and ignore retrieved passages that do not bear on the question.",
  "context-recall":
    "Context recall: confirm that every piece of evidence needed to answer is present before answering; otherwise state what is missing.",
  faithfulness:
    "Faithfulness: every claim must be entailed by the cited evidence; do not add facts that the evidence does not support.",
  "answer-relevancy":
    "Answer relevancy: respond directly to the question asked, without padding or unrelated detail.",
  groundedness:
    "Groundedness: keep conclusions traceable to the cited evidence rather than to unsupported assertion.",
};

function buildRagEvaluation(
  analysis: PromptTaskAnalysis,
  strategy: GroundingStrategy,
): readonly RagEvaluationHint[] {
  if (!isRagFocused(analysis, strategy)) {
    return [];
  }
  return RAG_EVALUATION_DIMENSIONS.map((dimension) => ({
    dimension,
    instruction: RAG_HINT_TEMPLATES[dimension],
  }));
}

// ─── Public entry point ─────────────────────────────────────────────────────────────
/**
 * Build a deterministic `GroundingPlan` from a `PromptTaskAnalysis`. Pure: identical analyses always
 * produce an identical plan. The plan is a provider-neutral source policy; it never performs or
 * authorizes retrieval.
 */
export function planGrounding(analysis: PromptTaskAnalysis): GroundingPlan {
  const profile = PROMPT_ENHANCEMENT_PROFILES[analysis.recommendedProfile];
  const connected = analysis.groundingNeed.signals.includes("supplied-context-reference");
  const strategy = selectStrategy(analysis);
  const required = isGroundingRequired(strategy, profile.groundingMandatory, connected);
  return {
    strategy,
    required,
    allowedRetrievalModes: [...RETRIEVAL_MODES_BY_STRATEGY[strategy]],
    sourcePriority: buildSourcePriority(strategy, required),
    citation: buildCitationRequirement(strategy, analysis, required),
    recency: buildRecency(analysis, strategy),
    contradictionPolicy: selectContradictionPolicy(strategy, analysis),
    noAnswerConditions: buildNoAnswerConditions(strategy, analysis),
    directives: buildDirectives(strategy, required),
    ragEvaluation: buildRagEvaluation(analysis, strategy),
    untrustedContent: true,
  };
}
