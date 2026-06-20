// Prompt Enhancer wire contracts, task taxonomy, and analyzer-result shapes
// (Epic #1307, Issue #1309; governed by ADR-0044 and the prompt-enhancer architecture blueprint).
//
// This module is the single conceptual map for the Prompt Enhancer domain in the contracts leaf.
// It carries ONLY wire-safe, provider-neutral data and pure value tables. There is no IO, no clock
// read, no hashing, and no randomness here. The leaf-package rule (ADR-0019 direction 1) forbids any
// `@oscharko-dev/keiko-*` import; same-package relative imports (e.g. `./text-safety.js`) are allowed.
//
// Schema evolution follows the EVIDENCE_SCHEMA_VERSION / CONNECTED_CONTEXT_SCHEMA_VERSION rule
// (ADR-0010 D2): a breaking structural change introduces a NEW literal member rather than mutating
// "1", so persisted/streamed artefacts remain discriminable across versions.
//
// Trust boundary (ADR-0044 §5, AC5 of #1309): none of these shapes may encode a provider credential,
// a hidden system prompt, or a tool/secret/egress/patch authority grant. The Enhanced Prompt is data,
// never a capability grant. The `boundary.test.ts` style key-shape assertions in
// `prompt-enhancer-contracts.test.ts` pin this property.
//
// Scope discipline (Issue #1309). This module owns the contracts + taxonomy and the deterministic
// analyzer-result shape. Adjacent concerns are deliberately deferred to their owning issues and are
// NOT modelled here: machine-readable safety annotations and the validate-stage rule set (#1313),
// the retrieval plan and its readiness flag (#1311), candidate generation and scorecards (#1312),
// and the evidence manifest (#1313). The risk flags below are explainable, lexical analyzer signals
// only; the authoritative prompt-injection redaction patterns and secret/PII detectors live in
// `keiko-security` (#1313) and are not duplicated here.

import { stripUnsafeFormatChars } from "./text-safety.js";

// ─── Schema version ─────────────────────────────────────────────────────────────
export const PROMPT_ENHANCER_SCHEMA_VERSION = "1" as const;

// Upper bound on the number of characters the deterministic analyzer scans from a raw draft. Inputs
// longer than this are truncated before signal detection so analysis cost and output are bounded and
// deterministic regardless of draft size. Exported so callers and tests can reason about the bound.
export const PROMPT_ANALYSIS_MAX_SCAN_CHARS = 100_000 as const;

// Maximum length of a single clarification question or assumption statement the analyzer emits.
export const PROMPT_MISSING_CONTEXT_MAX_CHARS = 240 as const;

// ─── Branded ids ────────────────────────────────────────────────────────────────
// Phantom-property branding (the `local-knowledge.ts` / `qualityIntelligence/ids.ts` style): the
// brand carrier never lands at runtime, so values survive JSON round-trips, but a bare `string` is
// not assignable to a branded id without an explicit `asX(...)` construction step.
declare const PromptEnhancementRequestIdBrand: unique symbol;
declare const EnhancedPromptIdBrand: unique symbol;

export type PromptEnhancementRequestId = string & {
  readonly [PromptEnhancementRequestIdBrand]: true;
};
export type EnhancedPromptId = string & {
  readonly [EnhancedPromptIdBrand]: true;
};

const PROMPT_ENHANCER_ID_MAX_LENGTH = 256;
const PROMPT_ENHANCER_ID_FORBIDDEN_FRAGMENTS: readonly string[] = ["..", "/", "\\"];

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0 controls 0x00–0x1F, DEL 0x7F, C1 controls 0x80–0x9F.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
};

/**
 * Validate a candidate string is acceptable as a Prompt Enhancer branded id. Pure; returns a typed
 * reason on rejection. Rules mirror the QI / audit-ledger id discipline: non-empty after trim, no
 * surrounding whitespace, max length 256, NFKC-normalised, no control characters, no path-traversal
 * fragment. Exported for tests; production callers use the `asX` constructors.
 */
export const validatePromptEnhancerIdString = (
  value: unknown,
  kind: string,
): { ok: true } | { ok: false; reason: string } => {
  if (typeof value !== "string") {
    return { ok: false, reason: `${kind} must be a string` };
  }
  if (value.length === 0 || value.trim().length === 0) {
    return { ok: false, reason: `${kind} must not be empty or whitespace-only` };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: `${kind} must not have leading or trailing whitespace` };
  }
  if (value.length > PROMPT_ENHANCER_ID_MAX_LENGTH) {
    return {
      ok: false,
      reason: `${kind} exceeds max length ${String(PROMPT_ENHANCER_ID_MAX_LENGTH)}`,
    };
  }
  if (value.normalize("NFKC") !== value) {
    return { ok: false, reason: `${kind} must be NFKC-normalised` };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, reason: `${kind} contains control characters` };
  }
  if (PROMPT_ENHANCER_ID_FORBIDDEN_FRAGMENTS.some((fragment) => value.includes(fragment))) {
    return { ok: false, reason: `${kind} contains a forbidden path fragment` };
  }
  return { ok: true };
};

const constructPromptEnhancerId = (value: string, kind: string): string => {
  const result = validatePromptEnhancerIdString(value, kind);
  if (!result.ok) {
    throw new TypeError(`Invalid ${kind}: ${result.reason}`);
  }
  return value;
};

export const asPromptEnhancementRequestId = (value: string): PromptEnhancementRequestId =>
  constructPromptEnhancerId(value, "PromptEnhancementRequestId") as PromptEnhancementRequestId;

export const asEnhancedPromptId = (value: string): EnhancedPromptId =>
  constructPromptEnhancerId(value, "EnhancedPromptId") as EnhancedPromptId;

// ─── Task taxonomy (≥10 classes) ─────────────────────────────────────────────────
// A closed set covering every MVP bucket named in Issue #1309 (research, coding/debugging/
// architecture, data analysis, writing/editing, decision support, agentic tool task, RAG question
// answering, creative task, critical legal/medical/finance/security domain, prompt optimization/
// meta-prompting) plus a small number of generally useful classes (factual QA, summarization,
// structured extraction) that the blueprint enumerates and that have unambiguous lexical signals.
// `factual-qa` is the conservative default when no stronger class signal is present.
export type PromptTaskClass =
  | "factual-qa"
  | "research"
  | "rag-question-answering"
  | "summarization"
  | "structured-extraction"
  | "data-analysis"
  | "code-generation"
  | "code-debugging"
  | "code-architecture"
  | "writing-editing"
  | "creative-writing"
  | "decision-support"
  | "agentic-tool-use"
  | "prompt-optimization"
  | "safety-critical";

export const PROMPT_TASK_CLASSES: readonly PromptTaskClass[] = [
  "factual-qa",
  "research",
  "rag-question-answering",
  "summarization",
  "structured-extraction",
  "data-analysis",
  "code-generation",
  "code-debugging",
  "code-architecture",
  "writing-editing",
  "creative-writing",
  "decision-support",
  "agentic-tool-use",
  "prompt-optimization",
  "safety-critical",
] as const;

// ─── Domain ──────────────────────────────────────────────────────────────────────
export type PromptDomain =
  | "software"
  | "legal"
  | "medical"
  | "finance"
  | "security"
  | "data-science"
  | "science"
  | "business"
  | "education"
  | "creative"
  | "general";

export const PROMPT_DOMAINS: readonly PromptDomain[] = [
  "software",
  "legal",
  "medical",
  "finance",
  "security",
  "data-science",
  "science",
  "business",
  "education",
  "creative",
  "general",
] as const;

// The domains whose advice carries real-world legal, clinical, financial, or security consequence.
// Detecting any of these drives `criticality` to "critical" and raises the `safety-critical` task
// class and the `safety-critical-advice` risk flag.
export const SAFETY_CRITICAL_DOMAINS: readonly PromptDomain[] = [
  "legal",
  "medical",
  "finance",
  "security",
] as const;

export const isSafetyCriticalDomain = (domain: PromptDomain): boolean =>
  SAFETY_CRITICAL_DOMAINS.includes(domain);

// ─── Criticality ─────────────────────────────────────────────────────────────────
export type PromptCriticality = "low" | "standard" | "elevated" | "critical";

export const PROMPT_CRITICALITIES: readonly PromptCriticality[] = [
  "low",
  "standard",
  "elevated",
  "critical",
] as const;

// ─── Risk classes (lexical analyzer signals only) ────────────────────────────────
// Each risk class is a deterministic, explainable signal about what the task is asking for. These
// are data points surfaced for downstream human review and the #1313 validate stage; they do not
// reject or redact anything (that authority is #1313's). The authoritative prompt-injection pattern
// set and secret/PII detectors live in `keiko-security` and are intentionally not duplicated here.
export type PromptRiskClass =
  | "instruction-override-suspected"
  | "tool-authority-requested"
  | "egress-requested"
  | "safety-critical-advice";

export const PROMPT_RISK_CLASSES: readonly PromptRiskClass[] = [
  "instruction-override-suspected",
  "tool-authority-requested",
  "egress-requested",
  "safety-critical-advice",
] as const;

// ─── Grounding need ──────────────────────────────────────────────────────────────
// Distinguishes tasks answerable from the model's own capability, tasks that must consult the user's
// supplied/connected context, tasks needing external but stable knowledge, and tasks needing current
// or volatile external information (AC3).
export type GroundingNeedKind =
  | "none"
  | "supplied-context"
  | "external-knowledge"
  | "external-current";

export const GROUNDING_NEED_KINDS: readonly GroundingNeedKind[] = [
  "none",
  "supplied-context",
  "external-knowledge",
  "external-current",
] as const;

// Explainable, closed-vocabulary signal labels. These never echo raw input text.
export type GroundingSignal =
  | "temporal-recency-term"
  | "named-current-event"
  | "market-or-price"
  | "url-reference"
  | "supplied-context-reference"
  | "retrieval-cue"
  | "self-contained-task"
  | "no-external-signal";

export const GROUNDING_SIGNALS: readonly GroundingSignal[] = [
  "temporal-recency-term",
  "named-current-event",
  "market-or-price",
  "url-reference",
  "supplied-context-reference",
  "retrieval-cue",
  "self-contained-task",
  "no-external-signal",
] as const;

export interface GroundingNeed {
  readonly kind: GroundingNeedKind;
  // True when the task depends on time-sensitive or fast-changing information.
  readonly volatile: boolean;
  readonly signals: readonly GroundingSignal[];
}

// ─── Output schema descriptor ────────────────────────────────────────────────────
export type OutputFormat =
  | "prose"
  | "markdown"
  | "json"
  | "yaml"
  | "csv"
  | "table"
  | "list"
  | "code"
  | "unspecified";

export const PROMPT_OUTPUT_FORMATS: readonly OutputFormat[] = [
  "prose",
  "markdown",
  "json",
  "yaml",
  "csv",
  "table",
  "list",
  "code",
  "unspecified",
] as const;

// Closed vocabulary of detected output-shape hint labels (never raw input).
export type OutputFormatHint =
  | "explicit-json"
  | "explicit-yaml"
  | "explicit-csv"
  | "explicit-table"
  | "explicit-list"
  | "explicit-code"
  | "explicit-markdown"
  | "schema-keyword"
  | "no-format-signal";

export const OUTPUT_FORMAT_HINTS: readonly OutputFormatHint[] = [
  "explicit-json",
  "explicit-yaml",
  "explicit-csv",
  "explicit-table",
  "explicit-list",
  "explicit-code",
  "explicit-markdown",
  "schema-keyword",
  "no-format-signal",
] as const;

export interface OutputSchemaDescriptor {
  readonly format: OutputFormat;
  // True for machine-parseable formats (json/yaml/csv/table). Drives downstream schema enforcement.
  readonly structured: boolean;
  readonly hints: readonly OutputFormatHint[];
}

// ─── Missing context: clarification vs assumption (AC4) ──────────────────────────
export type MissingContextTopic =
  | "subject"
  | "scope"
  | "audience"
  | "output-format"
  | "constraints"
  | "data-source"
  | "success-criteria";

export const MISSING_CONTEXT_TOPICS: readonly MissingContextTopic[] = [
  "subject",
  "scope",
  "audience",
  "output-format",
  "constraints",
  "data-source",
  "success-criteria",
] as const;

export interface PromptClarification {
  readonly kind: "clarification";
  readonly topic: MissingContextTopic;
  // A bounded, control-free question. Generated from fixed templates; never echoes raw input.
  readonly question: string;
}

export interface PromptAssumption {
  readonly kind: "assumption";
  readonly topic: MissingContextTopic;
  // A bounded, control-free explicit assumption. Generated from fixed templates; never echoes input.
  readonly statement: string;
}

export type ClarificationOrAssumption = PromptClarification | PromptAssumption;

// How the request wants missing information represented (AC4): surface clarification questions to the
// user, or proceed with explicit, stated assumptions.
export type MissingInformationStrategy = "clarify" | "assume";

export const MISSING_INFORMATION_STRATEGIES: readonly MissingInformationStrategy[] = [
  "clarify",
  "assume",
] as const;

// ─── Classification explainability ───────────────────────────────────────────────
export type PromptSignalStrength = "strong" | "moderate" | "weak";

export const PROMPT_SIGNAL_STRENGTHS: readonly PromptSignalStrength[] = [
  "strong",
  "moderate",
  "weak",
] as const;

export type PromptSignalDimension =
  | "task-class"
  | "domain"
  | "grounding"
  | "output"
  | "risk"
  | "missing-context";

export const PROMPT_SIGNAL_DIMENSIONS: readonly PromptSignalDimension[] = [
  "task-class",
  "domain",
  "grounding",
  "output",
  "risk",
  "missing-context",
] as const;

// A machine-readable record of which deterministic detector fired. `code` is a fixed internal label
// from the detector vocabulary, never raw input — the analysis stays content-light by construction.
export interface PromptClassificationSignal {
  readonly dimension: PromptSignalDimension;
  readonly code: string;
}

// ─── Profiles (metadata only; execution params owned by #1310) ───────────────────
export type PromptEnhancementProfileId =
  | "fast"
  | "precise"
  | "research"
  | "creative"
  | "technical"
  | "safety-critical"
  | "agentic";

export const PROMPT_ENHANCEMENT_PROFILE_IDS: readonly PromptEnhancementProfileId[] = [
  "fast",
  "precise",
  "research",
  "creative",
  "technical",
  "safety-critical",
  "agentic",
] as const;

// Provider-neutral profile metadata. Deliberately excludes model-execution parameters (temperature,
// token budget, model identity) — those are gateway concerns owned by #1310 and must not appear on a
// wire contract. This shape only describes governance posture and output expectations.
export interface PromptEnhancementProfile {
  readonly id: PromptEnhancementProfileId;
  readonly description: string;
  // Whether a grounded retrieval plan is mandatory for tasks selecting this profile (#1311 binds it).
  readonly groundingMandatory: boolean;
  // Whether model-assisted refinement is disallowed (the analysis stays purely deterministic).
  readonly deterministicAnalysisOnly: boolean;
  readonly preferredOutputModes: readonly OutputFormat[];
  // Upper bound on clarifications surfaced when the request strategy is "clarify".
  readonly maxClarifications: number;
}

export const PROMPT_ENHANCEMENT_PROFILES: Readonly<
  Record<PromptEnhancementProfileId, PromptEnhancementProfile>
> = {
  fast: {
    id: "fast",
    description: "Low-latency enhancement for simple, self-contained tasks.",
    groundingMandatory: false,
    deterministicAnalysisOnly: true,
    preferredOutputModes: ["prose", "markdown"],
    maxClarifications: 1,
  },
  precise: {
    id: "precise",
    description: "Accuracy-first enhancement for factual and decision-support tasks.",
    groundingMandatory: false,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["markdown", "list"],
    maxClarifications: 3,
  },
  research: {
    id: "research",
    description: "Grounded, citation-oriented enhancement for research and deep-research tasks.",
    groundingMandatory: true,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["markdown", "list"],
    maxClarifications: 3,
  },
  creative: {
    id: "creative",
    description: "Expressive enhancement for creative writing and ideation tasks.",
    groundingMandatory: false,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["prose", "markdown"],
    maxClarifications: 2,
  },
  technical: {
    id: "technical",
    description: "Structure-first enhancement for coding, data, and extraction tasks.",
    groundingMandatory: false,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["code", "json", "markdown"],
    maxClarifications: 3,
  },
  "safety-critical": {
    id: "safety-critical",
    description:
      "Cautious, grounded enhancement for legal, medical, financial, or security-sensitive tasks.",
    groundingMandatory: true,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["markdown", "list"],
    maxClarifications: 4,
  },
  agentic: {
    id: "agentic",
    description:
      "Tool-aware enhancement for agentic tasks; authority stays behind governed handoff.",
    groundingMandatory: false,
    deterministicAnalysisOnly: false,
    preferredOutputModes: ["markdown", "json"],
    maxClarifications: 3,
  },
};

// ─── Raw input + request ─────────────────────────────────────────────────────────
// The untrusted user draft plus optional, non-content context references. `text` is treated as
// untrusted evidence everywhere downstream. No credential, provider, or tool-authority field exists
// here by design (AC5).
export interface RawPromptInput {
  readonly text: string;
  // True when the user explicitly connected workspace scope, files, or attachments to the request.
  // Drives the grounding-need classification between "supplied-context" and external needs (AC3).
  readonly hasConnectedContext?: boolean | undefined;
  // Count of attached references, if any. Bounded metadata only; never the attachment content.
  readonly attachmentCount?: number | undefined;
}

export interface PromptEnhancementRequest {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  readonly requestId: PromptEnhancementRequestId;
  readonly input: RawPromptInput;
  readonly missingInformationStrategy: MissingInformationStrategy;
  // Optional caller hint; the analyzer still recommends a profile deterministically and records both.
  readonly profilePreference?: PromptEnhancementProfileId | undefined;
  // BCP-47-ish locale tag, bounded and validated as safe text when present. Informational only.
  readonly locale?: string | undefined;
}

// ─── Analyzer result (the deterministic normalized analysis) ─────────────────────
export interface PromptTaskAnalysis {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  readonly requestId: PromptEnhancementRequestId;
  readonly taskClass: PromptTaskClass;
  readonly taskClassConfidence: PromptSignalStrength;
  readonly domain: PromptDomain;
  readonly criticality: PromptCriticality;
  readonly groundingNeed: GroundingNeed;
  readonly outputSchema: OutputSchemaDescriptor;
  readonly missingContext: readonly ClarificationOrAssumption[];
  readonly riskFlags: readonly PromptRiskClass[];
  readonly recommendedProfile: PromptEnhancementProfileId;
  // Bounded length of the normalized draft (post strip + truncation). Metadata only; never the text.
  readonly normalizedInputLength: number;
  // The deterministic detectors that fired, for explainability. Content-light by construction.
  readonly signals: readonly PromptClassificationSignal[];
}

// ─── Enhanced Prompt (structured artefact shape; generated by #1310, not here) ───
// Provider-neutral structure rendered to ChatMessage[] only at dispatch time. #1309 fixes the shape
// and a structural validator; the generator that produces instances is #1310. By construction this
// shape carries no tool grant, secret, egress, or patch authority — `safetyRules` and `constraints`
// are plain descriptive guidance strings, not capability tokens (AC5, ADR-0044 §5).
export interface EnhancedPrompt {
  readonly schemaVersion: typeof PROMPT_ENHANCER_SCHEMA_VERSION;
  readonly promptId: EnhancedPromptId;
  readonly role: string;
  readonly goal: string;
  readonly context: readonly string[];
  readonly input: string;
  readonly taskDecomposition: readonly string[];
  readonly constraints: readonly string[];
  readonly groundingRules: readonly string[];
  readonly outputSchema: OutputSchemaDescriptor;
  readonly qualityCriteria: readonly string[];
  readonly uncertaintyHandling: readonly string[];
  readonly safetyRules: readonly string[];
}

// ─── Exhaustiveness helper ───────────────────────────────────────────────────────
// Compile-time guard: a future PromptTaskClass member with no switch arm forces a type error at the
// call site (the value is `never` only when every member is handled). Throws if reached at runtime.
export function assertNeverTaskClass(value: never): never {
  throw new TypeError(`Unhandled PromptTaskClass: ${String(value)}`);
}

// Normalize a raw draft for deterministic analysis: strip Trojan-source/control code points, NFKC
// normalize, and truncate to the scan bound. Shared by the analyzer and exposed for callers that
// need the same bounded view. Pure.
export function normalizePromptDraft(text: string): string {
  const stripped = stripUnsafeFormatChars(text).normalize("NFKC");
  return stripped.length > PROMPT_ANALYSIS_MAX_SCAN_CHARS
    ? stripped.slice(0, PROMPT_ANALYSIS_MAX_SCAN_CHARS)
    : stripped;
}
