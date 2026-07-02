// Discussion Intelligence contract for colleague-like discussion behavior (Epic #491, Issue #502,
// ADR-0065). This leaf module DEFINES the provider-neutral, text-first semantics that let Keiko run the
// five discussion modes (Challenge / Review / Decide / Brainstorm / Evidence-check), disagree
// professionally grounded in evidence + assumptions + uncertainty, surface confidence, and recover an
// interrupted spoken discussion turn without losing the active question or decision context.
//
// It is pure data + pure functions only — nothing performs IO, crypto, clock reads, randomness, or audio
// processing. No raw user / assistant text, transcript excerpt, credential, provider URL, or tool grant
// is ever a field on these types: every value that crosses a boundary is a closed enum, a bool, a bounded
// 0–1 float, an int, or a fixed content-free template string (the server renders these templates verbatim
// as an ADDITIVE block; `CONVERSATION_SYSTEM_PROMPT` stays immutable).
//
// Reuse, not a parallel stack (Issue #502 AC2): the citation / contradiction / grounding vocabulary is
// imported from `./prompt-enhancer.js`, and voice gating is derived from `./voice-transcript.js`'s
// `voiceTranscriptCaptureAllowed` rather than re-encoding the voice profile table. Discussion
// intelligence ITSELF is always available (text-first, AC1); the voice predicate only governs whether
// SPOKEN turns may drive it.
//
// `DISCUSSION_INTELLIGENCE_SCHEMA_VERSION` follows the same evolution rule as the sibling schema
// versions (ADR-0010 D2): a breaking change introduces a NEW literal rather than mutating "1", and it is
// INDEPENDENT of every other schema version. Leaf-package rule (ADR-0019 direction 1): no
// `@oscharko-dev/keiko-*` import may appear here; siblings are reached by relative path.

import type { VoiceProfile } from "./gateway.js";
import type {
  CitationDiscipline,
  ContradictionPolicy,
  GroundingDirective,
} from "./prompt-enhancer.js";
import { voiceTranscriptCaptureAllowed } from "./voice-transcript.js";

// ─── Schema version ───────────────────────────────────────────────────────────
export const DISCUSSION_INTELLIGENCE_SCHEMA_VERSION = "1" as const;

export function isDiscussionIntelligenceSchemaVersionSupported(version: unknown): boolean {
  return version === DISCUSSION_INTELLIGENCE_SCHEMA_VERSION;
}

// ─── Discussion modes ───────────────────────────────────────────────────────────
// The five colleague-like behaviors named in Issue #502. Text-first: every mode works in the `none`
// voice profile. `challenge`/`review`/`decide`/`evidence-check` are disagreement-capable (they mandate
// the full disagreement structure); `brainstorm` expands the option space and may relax uncertainty.
export type DiscussionMode = "challenge" | "review" | "decide" | "brainstorm" | "evidence-check";

export const DISCUSSION_MODES: readonly DiscussionMode[] = [
  "challenge",
  "review",
  "decide",
  "brainstorm",
  "evidence-check",
] as const;

export function isDiscussionMode(value: unknown): value is DiscussionMode {
  return typeof value === "string" && (DISCUSSION_MODES as readonly string[]).includes(value);
}

export function assertNeverDiscussionMode(value: never): never {
  throw new TypeError(`Unhandled DiscussionMode: ${JSON.stringify(value)}`);
}

// ─── Confidence level ─────────────────────────────────────────────────────────
// Bridges the design-system `.ai-conf[data-level]` widget (high fills 3 segments, medium 2, low 1).
// `confidenceLevelFromScore` maps a model-reported 0–1 confidence onto that three-segment scale.
export type ConfidenceLevel = "high" | "medium" | "low";

export const DISCUSSION_CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = [
  "high",
  "medium",
  "low",
] as const;

// Cut points (documented + tested): a non-finite or out-of-[0,1] score is guarded to `low` (the most
// cautious level — never overstate confidence). Within range: `< 1/3 → low`, `< 2/3 → medium`, else
// `high`. The boundaries 1/3 and 2/3 themselves round UP (1/3 is medium, 2/3 is high), matching the
// segment-fill thresholds.
const CONFIDENCE_LOW_CEILING = 1 / 3;
const CONFIDENCE_MEDIUM_CEILING = 2 / 3;

export function confidenceLevelFromScore(score: number): ConfidenceLevel {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    return "low";
  }
  if (score < CONFIDENCE_LOW_CEILING) {
    return "low";
  }
  if (score < CONFIDENCE_MEDIUM_CEILING) {
    return "medium";
  }
  return "high";
}

// ─── Disagreement facets (AC3) ──────────────────────────────────────────────────
// The three things a professional disagreement must cover: the evidence behind the position, the
// assumptions it rests on, and the residual uncertainty. A disagreement-capable mode mandates all three.
export type DisagreementFacet = "evidence" | "assumptions" | "uncertainty";

export const DISAGREEMENT_FACETS: readonly DisagreementFacet[] = [
  "evidence",
  "assumptions",
  "uncertainty",
] as const;

// ─── Discussion directives ──────────────────────────────────────────────────────
// Closed vocabulary of directive labels rendered into the prompt. Each maps to a fixed content-free
// instruction template the server renders verbatim; the label never echoes raw input.
export type DiscussionDirective =
  | "state-position-then-evidence"
  | "challenge-stated-assumptions"
  | "surface-counter-evidence"
  | "list-explicit-assumptions"
  | "disclose-uncertainty-and-confidence"
  | "cite-evidence-or-state-none"
  | "offer-decision-with-tradeoffs"
  | "expand-option-space-before-converging"
  | "verify-claims-against-evidence"
  | "defer-to-user-on-unresolved-contradiction";

export const DISCUSSION_DIRECTIVES: readonly DiscussionDirective[] = [
  "state-position-then-evidence",
  "challenge-stated-assumptions",
  "surface-counter-evidence",
  "list-explicit-assumptions",
  "disclose-uncertainty-and-confidence",
  "cite-evidence-or-state-none",
  "offer-decision-with-tradeoffs",
  "expand-option-space-before-converging",
  "verify-claims-against-evidence",
  "defer-to-user-on-unresolved-contradiction",
] as const;

export function assertNeverDiscussionDirective(value: never): never {
  throw new TypeError(`Unhandled DiscussionDirective: ${JSON.stringify(value)}`);
}

// Fixed, content-free instruction templates. Bounded length; no raw input echo, no credential, provider
// URL, system prompt, or tool/secret/egress authority encodable here. Keyed by directive for totality.
export const DISCUSSION_DIRECTIVE_TEMPLATES: Readonly<Record<DiscussionDirective, string>> = {
  "state-position-then-evidence": "State your position first, then the evidence that supports it.",
  "challenge-stated-assumptions":
    "Identify and challenge the assumptions the stated position depends on.",
  "surface-counter-evidence":
    "Surface evidence that weighs against the position, not only evidence for it.",
  "list-explicit-assumptions":
    "List the explicit assumptions you are making before drawing a conclusion.",
  "disclose-uncertainty-and-confidence":
    "Disclose your remaining uncertainty and your confidence level for each claim.",
  "cite-evidence-or-state-none":
    "Cite the evidence for each claim, or state plainly that no evidence is available.",
  "offer-decision-with-tradeoffs":
    "Offer a recommended next action and lay out the trade-offs of each option.",
  "expand-option-space-before-converging":
    "Expand the range of options before converging on a single recommendation.",
  "verify-claims-against-evidence":
    "Verify each claim against the available evidence before accepting it.",
  "defer-to-user-on-unresolved-contradiction":
    "When a contradiction cannot be resolved from evidence, defer the decision to the user.",
} as const;

// Maps each directive to the disagreement facet(s) its template addresses (AC3). Keyed by directive for
// totality (a new directive without an entry is a compile error). A directive whose template is about
// the decision shape or deferral rather than a disagreement facet maps to the empty array. This is the
// machine-checkable bridge between a mode's rendered directives and the facets it mandates: the regression
// guard `discussionDirectivesCoverFacets` proves every mode's directives actually instruct the model on
// the facets the mode mandates (so e.g. an `evidence`-mandating mode cannot silently drop evidence from
// its rendered prompt).
export const DISCUSSION_DIRECTIVE_FACETS: Readonly<
  Record<DiscussionDirective, readonly DisagreementFacet[]>
> = {
  "state-position-then-evidence": ["evidence"],
  "challenge-stated-assumptions": ["assumptions"],
  "surface-counter-evidence": ["evidence"],
  "list-explicit-assumptions": ["assumptions"],
  "disclose-uncertainty-and-confidence": ["uncertainty"],
  "cite-evidence-or-state-none": ["evidence"],
  "offer-decision-with-tradeoffs": [],
  "expand-option-space-before-converging": [],
  "verify-claims-against-evidence": ["evidence"],
  "defer-to-user-on-unresolved-contradiction": [],
} as const;

// ─── Discussion mode plan ───────────────────────────────────────────────────────
// The per-mode behavioral plan. It reuses the prompt-enhancer citation / contradiction / grounding
// vocabulary (no parallel stack) and declares which disagreement facets the mode mandates and which
// directives it renders. The plan is data; the server renders it into the additive prompt block.
export interface DiscussionModePlan {
  readonly mode: DiscussionMode;
  readonly challengesAssumptions: boolean;
  readonly requiresExplicitAssumptions: boolean;
  readonly requiresUncertaintyDisclosure: boolean;
  readonly citationDiscipline: CitationDiscipline;
  readonly contradictionPolicy: ContradictionPolicy;
  readonly groundingDirectives: readonly GroundingDirective[];
  readonly producesDecisionRecommendation: boolean;
  readonly mandatedFacets: readonly DisagreementFacet[];
  readonly directives: readonly DiscussionDirective[];
}

// Frozen TOTAL table keyed by mode (a new mode without a plan is a compile error). Invariant enforced in
// tests: every disagreement-capable mode (challenge/review/decide/evidence-check) mandates ALL THREE
// `DISAGREEMENT_FACETS`; `brainstorm` relaxes uncertainty (it expands options rather than disagreeing).
export const DISCUSSION_MODE_PLANS: Readonly<Record<DiscussionMode, DiscussionModePlan>> = {
  challenge: {
    mode: "challenge",
    challengesAssumptions: true,
    requiresExplicitAssumptions: true,
    requiresUncertaintyDisclosure: true,
    citationDiscipline: "require-citations-or-state-no-evidence",
    contradictionPolicy: "disclose-and-defer",
    groundingDirectives: [
      "stay-within-evidence",
      "disclose-uncertainty",
      "separate-known-from-retrieved",
    ],
    producesDecisionRecommendation: false,
    mandatedFacets: ["evidence", "assumptions", "uncertainty"],
    directives: [
      "state-position-then-evidence",
      "challenge-stated-assumptions",
      "surface-counter-evidence",
      "list-explicit-assumptions",
      "disclose-uncertainty-and-confidence",
    ],
  },
  review: {
    mode: "review",
    challengesAssumptions: true,
    requiresExplicitAssumptions: true,
    requiresUncertaintyDisclosure: true,
    citationDiscipline: "require-citations-or-state-no-evidence",
    contradictionPolicy: "disclose-and-defer",
    groundingDirectives: [
      "attribute-claims-to-sources",
      "stay-within-evidence",
      "disclose-uncertainty",
    ],
    producesDecisionRecommendation: false,
    mandatedFacets: ["evidence", "assumptions", "uncertainty"],
    directives: [
      "verify-claims-against-evidence",
      "surface-counter-evidence",
      "list-explicit-assumptions",
      "disclose-uncertainty-and-confidence",
    ],
  },
  decide: {
    mode: "decide",
    challengesAssumptions: true,
    requiresExplicitAssumptions: true,
    requiresUncertaintyDisclosure: true,
    citationDiscipline: "require-citations-or-state-no-evidence",
    contradictionPolicy: "disclose-and-defer",
    groundingDirectives: ["stay-within-evidence", "disclose-uncertainty"],
    producesDecisionRecommendation: true,
    mandatedFacets: ["evidence", "assumptions", "uncertainty"],
    directives: [
      "cite-evidence-or-state-none",
      "list-explicit-assumptions",
      "offer-decision-with-tradeoffs",
      "disclose-uncertainty-and-confidence",
      "defer-to-user-on-unresolved-contradiction",
    ],
  },
  brainstorm: {
    mode: "brainstorm",
    challengesAssumptions: false,
    requiresExplicitAssumptions: true,
    requiresUncertaintyDisclosure: false,
    citationDiscipline: "best-effort",
    contradictionPolicy: "synthesize-with-caveats",
    groundingDirectives: ["separate-known-from-retrieved"],
    producesDecisionRecommendation: false,
    mandatedFacets: ["evidence", "assumptions"],
    directives: [
      "expand-option-space-before-converging",
      "state-position-then-evidence",
      "list-explicit-assumptions",
    ],
  },
  "evidence-check": {
    mode: "evidence-check",
    challengesAssumptions: true,
    requiresExplicitAssumptions: true,
    requiresUncertaintyDisclosure: true,
    citationDiscipline: "require-citations",
    contradictionPolicy: "disclose-and-defer",
    groundingDirectives: [
      "attribute-claims-to-sources",
      "do-not-fabricate-sources",
      "stay-within-evidence",
      "disclose-uncertainty",
    ],
    producesDecisionRecommendation: false,
    mandatedFacets: ["evidence", "assumptions", "uncertainty"],
    directives: [
      "verify-claims-against-evidence",
      "cite-evidence-or-state-none",
      "list-explicit-assumptions",
      "disclose-uncertainty-and-confidence",
    ],
  },
} as const;

export function discussionModePlan(mode: DiscussionMode): DiscussionModePlan {
  return DISCUSSION_MODE_PLANS[mode];
}

// AC3 regression guard: true iff the union of the disagreement facets addressed by the plan's rendered
// directives (via `DISCUSSION_DIRECTIVE_FACETS`) is a SUPERSET of the facets the plan mandates. In other
// words, every facet the mode promises to cover has at least one directive in the rendered prompt that
// instructs the model on it. A mandated facet with no covering directive — e.g. a `decide` plan that
// mandates `evidence` but renders no evidence directive — makes this return false.
export function discussionDirectivesCoverFacets(plan: DiscussionModePlan): boolean {
  const covered = new Set<DisagreementFacet>();
  for (const directive of plan.directives) {
    for (const facet of DISCUSSION_DIRECTIVE_FACETS[directive]) {
      covered.add(facet);
    }
  }
  return plan.mandatedFacets.every((facet) => covered.has(facet));
}

// ─── Capability gating (text-first + voice reuse, AC1/AC2) ───────────────────────
// Discussion intelligence is ALWAYS available as text; this predicate only governs whether SPOKEN turns
// may drive it. It reuses `voiceTranscriptCaptureAllowed` (the committed-transcript capability) so the
// gating cannot drift from the voice contract: true for `speech-to-text`/`full-realtime`, false for
// `none`/`speech-output` (playback-only). `none` keeps Keiko fully usable text-first (AC1).
export function voiceCanDriveDiscussion(profile: VoiceProfile): boolean {
  return voiceTranscriptCaptureAllowed(profile);
}

// ─── Interruption-recovery turn model (AC4) ──────────────────────────────────────
// `active`      — the discussion turn is in progress.
// `interrupted` — a barge-in / disconnect interrupted the spoken turn; context is preserved.
// `recovered`   — recovery restored the SAME mode/topicId/turnIndex (the no-context-loss proof).
// `resolved`    — the turn reached its end. Terminal.
export type DiscussionTurnStatus = "active" | "interrupted" | "recovered" | "resolved";

export const DISCUSSION_TURN_STATUSES: readonly DiscussionTurnStatus[] = [
  "active",
  "interrupted",
  "recovered",
  "resolved",
] as const;

// Legal state-changing transitions, keyed by status for totality. `active` may be interrupted or
// resolved directly; an `interrupted` turn recovers or resolves; a `recovered` turn may be interrupted
// again (repeated barge-in) or resolved; `resolved` is terminal.
export const DISCUSSION_TURN_STATUS_TRANSITIONS: Readonly<
  Record<DiscussionTurnStatus, readonly DiscussionTurnStatus[]>
> = {
  active: ["interrupted", "resolved"],
  interrupted: ["recovered", "resolved"],
  recovered: ["interrupted", "resolved"],
  resolved: [],
} as const;

export function isDiscussionTurnStatus(value: unknown): value is DiscussionTurnStatus {
  return (
    typeof value === "string" && (DISCUSSION_TURN_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransitionDiscussionTurnStatus(
  from: DiscussionTurnStatus,
  to: DiscussionTurnStatus,
): boolean {
  return DISCUSSION_TURN_STATUS_TRANSITIONS[from].includes(to);
}

export function assertNeverDiscussionTurnStatus(value: never): never {
  throw new TypeError(`Unhandled DiscussionTurnStatus: ${JSON.stringify(value)}`);
}

// ─── topicId validation (opaque bounded safe-text id) ────────────────────────────
// `topicId` is the open-question / decision identity — NEVER raw text. It is validated like the
// prompt-enhancer branded ids (non-empty after trim, no surrounding whitespace, NFKC-normalised, no
// control characters, ≤256, no path-traversal fragment) with a small LOCAL validator (the leaf rule
// permits importing the prompt-enhancer one, but a local validator keeps this module self-contained and
// avoids coupling the discussion identity to the enhancer's id brand).
const DISCUSSION_TOPIC_ID_MAX_LENGTH = 256;
const DISCUSSION_TOPIC_ID_FORBIDDEN_FRAGMENTS: readonly string[] = ["..", "/", "\\"];

function topicIdHasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0 controls 0x00–0x1F, DEL 0x7F, C1 controls 0x80–0x9F.
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

// Collects ALL reasons a candidate topicId is invalid (accumulating, never throws). Empty array = valid.
export function discussionTopicIdReasons(value: unknown): readonly string[] {
  const reasons: string[] = [];
  if (typeof value !== "string") {
    return ["topicId: must be a string"];
  }
  if (value.length === 0 || value.trim().length === 0) {
    reasons.push("topicId: must not be empty or whitespace-only");
  }
  if (value.length > 0 && value !== value.trim()) {
    reasons.push("topicId: must not have surrounding whitespace");
  }
  if (value.length > DISCUSSION_TOPIC_ID_MAX_LENGTH) {
    reasons.push("topicId: exceeds max length 256");
  }
  if (value.normalize("NFKC") !== value) {
    reasons.push("topicId: must be NFKC-normalised");
  }
  if (topicIdHasControlCharacter(value)) {
    reasons.push("topicId: contains control characters");
  }
  if (DISCUSSION_TOPIC_ID_FORBIDDEN_FRAGMENTS.some((fragment) => value.includes(fragment))) {
    reasons.push("topicId: contains a forbidden path fragment");
  }
  return reasons;
}

export function isValidDiscussionTopicId(value: unknown): value is string {
  return discussionTopicIdReasons(value).length === 0;
}

// ─── Discussion turn context ──────────────────────────────────────────────────
// Content-free turn identity. `topicId` is the opaque question/decision id; `turnIndex` is the
// monotonic turn position. No raw text field exists here by design.
export interface DiscussionTurnContext {
  readonly schemaVersion: typeof DISCUSSION_INTELLIGENCE_SCHEMA_VERSION;
  readonly mode: DiscussionMode;
  readonly topicId: string;
  readonly turnIndex: number;
  readonly status: DiscussionTurnStatus;
}

// Pure constructor. Throws on an invalid topicId or a non-integer/negative turnIndex (boundary input),
// keeping every constructed context well-formed; the transition helpers below never throw.
export function beginDiscussionTurn(
  mode: DiscussionMode,
  topicId: string,
  turnIndex: number,
): DiscussionTurnContext {
  const reasons = discussionTopicIdReasons(topicId);
  if (reasons.length > 0) {
    throw new TypeError(`Invalid discussion topicId: ${reasons.join("; ")}`);
  }
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new TypeError(`Invalid discussion turnIndex: ${JSON.stringify(turnIndex)}`);
  }
  return {
    schemaVersion: DISCUSSION_INTELLIGENCE_SCHEMA_VERSION,
    mode,
    topicId,
    turnIndex,
    status: "active",
  };
}

// Returns a NEW context at the target status, preserving mode/topicId/turnIndex, when the transition is
// legal; otherwise returns the input unchanged (the voice-transcript "snapshot, never throw" posture).
function transitionDiscussionTurn(
  ctx: DiscussionTurnContext,
  to: DiscussionTurnStatus,
): DiscussionTurnContext {
  if (!canTransitionDiscussionTurnStatus(ctx.status, to)) {
    return ctx;
  }
  return { ...ctx, status: to };
}

// AC4 load-bearing helpers. interrupt: active→interrupted; recover: interrupted→recovered with
// mode/topicId/turnIndex UNCHANGED (the no-context-loss proof); resolve: →resolved.
export function applyDiscussionInterruption(ctx: DiscussionTurnContext): DiscussionTurnContext {
  return transitionDiscussionTurn(ctx, "interrupted");
}

export function applyDiscussionRecovery(ctx: DiscussionTurnContext): DiscussionTurnContext {
  return transitionDiscussionTurn(ctx, "recovered");
}

export function resolveDiscussionTurn(ctx: DiscussionTurnContext): DiscussionTurnContext {
  return transitionDiscussionTurn(ctx, "resolved");
}

// ─── Content-free turn summary (for #503 / #504 consumers) ───────────────────────
export interface DiscussionTurnSummary {
  readonly mode: DiscussionMode;
  readonly status: DiscussionTurnStatus;
  readonly turnIndex: number;
  readonly mandatedFacetCount: number;
  readonly confidence?: ConfidenceLevel;
}

// Counts + enums only; never any topicId or text. An optional confidence score maps to a level via
// `confidenceLevelFromScore`; when omitted the summary carries no confidence.
export function summarizeDiscussionTurn(
  ctx: DiscussionTurnContext,
  confidenceScore?: number,
): DiscussionTurnSummary {
  const base: DiscussionTurnSummary = {
    mode: ctx.mode,
    status: ctx.status,
    turnIndex: ctx.turnIndex,
    mandatedFacetCount: DISCUSSION_MODE_PLANS[ctx.mode].mandatedFacets.length,
  };
  if (confidenceScore === undefined) {
    return base;
  }
  return { ...base, confidence: confidenceLevelFromScore(confidenceScore) };
}

// ─── Validators (accumulating, never throw) ──────────────────────────────────────
export type DiscussionValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

function buildDiscussionResult(reasons: readonly string[]): DiscussionValidationResult {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateDiscussionTurnContext(value: unknown): DiscussionValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["context: must be an object"] };
  }
  const reasons: string[] = [];
  if (!isDiscussionIntelligenceSchemaVersionSupported(value.schemaVersion)) {
    reasons.push("schemaVersion: unsupported");
  }
  if (!isDiscussionMode(value.mode)) {
    reasons.push("mode: unknown discussion mode");
  }
  for (const reason of discussionTopicIdReasons(value.topicId)) {
    reasons.push(reason);
  }
  const turnIndex = value.turnIndex;
  if (typeof turnIndex !== "number" || !Number.isInteger(turnIndex) || turnIndex < 0) {
    reasons.push("turnIndex: must be a non-negative integer");
  }
  if (!isDiscussionTurnStatus(value.status)) {
    reasons.push("status: unknown turn status");
  }
  return buildDiscussionResult(reasons);
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function validateModePlanFacets(mode: DiscussionMode, value: unknown, reasons: string[]): void {
  const disagreementCapable = mode !== "brainstorm";
  const mandated = readStringArray(value);
  for (const facet of DISAGREEMENT_FACETS) {
    if (disagreementCapable && !mandated.includes(facet)) {
      reasons.push(`mandatedFacets: ${mode} must mandate ${facet}`);
    }
  }
}

function validateModePlanDirectives(value: unknown, reasons: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push("directives: must not be empty");
    return;
  }
  for (const directive of value) {
    if (
      typeof directive !== "string" ||
      !(DISCUSSION_DIRECTIVES as readonly string[]).includes(directive)
    ) {
      reasons.push(`directives: unknown directive ${JSON.stringify(directive)}`);
    }
  }
}

export function validateDiscussionModePlan(value: unknown): DiscussionValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["plan: must be an object"] };
  }
  const mode = value.mode;
  if (!isDiscussionMode(mode)) {
    return { ok: false, reasons: ["mode: unknown discussion mode"] };
  }
  const reasons: string[] = [];
  const canonical = DISCUSSION_MODE_PLANS[mode];
  validateModePlanFacets(mode, value.mandatedFacets, reasons);
  validateModePlanDirectives(value.directives, reasons);
  if (value.producesDecisionRecommendation !== canonical.producesDecisionRecommendation) {
    reasons.push("producesDecisionRecommendation: disagrees with canonical plan");
  }
  return buildDiscussionResult(reasons);
}
