// Prompt Enhancer workflow authority (Epic #1307, Issue #1314; ADR-0044 §1/§3/§4).
//
// This module owns the governed `analyze → plan → optimize → validate → evidence-record-input`
// lifecycle. It composes the deterministic, provider-neutral primitives shipped by #1309–#1313 into a
// single content-light wire response. The core run remains pure apart from SHA-256 hashing; callers
// that persist evidence supply the clock and store at their boundary.
//
// Model-Gateway routing (AC3). The enhancer never calls a live model — every primitive is
// deterministic and the Enhanced Prompt is provider-neutral. The optional `modelId` the caller intends
// to dispatch the result to downstream is resolved against the Model-Gateway config (a configured
// provider check); when no gateway config is present or the model is not a configured provider, the
// result still succeeds and `modelRouting` reports the degraded state (graceful handling). The enhancer
// itself is never blocked by an unavailable model.

import {
  analyzePrompt,
  asPromptEnhancementRequestId,
  normalizePromptDraft,
  validatePromptEnhancementRequest,
  PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type PromptEnhancementGroundingReadiness,
  type PromptEnhancementModelRouting,
  type PromptEnhancementRequest,
  type PromptEnhancementWireRequest,
  type PromptEnhancementWireResponse,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import {
  findConfiguredCapability,
  PromptEnhancer,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import type { PromptEnhancementRecordInput } from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";

// Thrown when the (server-built) domain request fails the #1309 structural validator. Carries only the
// deterministic, content-free validator messages (they never echo raw user input). The route maps it
// to a 400. Distinct from the wire-request validator so the route can report the originating gate.
export class PromptEnhancementInputError extends Error {
  public readonly errors: readonly string[];
  public constructor(errors: readonly string[]) {
    super("Prompt enhancement request failed domain validation.");
    this.name = "PromptEnhancementInputError";
    this.errors = errors;
  }
}

// Thrown when the caller disconnects before the enhancement completes. Carries no payload; the route
// maps it to a 499 (client closed request). Lets the deterministic pipeline cooperate with cancellation
// even though it never blocks on a model (AC: cancellation).
export class PromptEnhancementCancelledError extends Error {
  public constructor() {
    super("Prompt enhancement request was cancelled.");
    this.name = "PromptEnhancementCancelledError";
  }
}

export interface RunPromptEnhancementDeps {
  // The resolved Model-Gateway config, or undefined when none is configured. Used only to resolve the
  // optional downstream-dispatch model's readiness (AC3); never to dispatch.
  readonly gatewayConfig: GatewayConfig | undefined;
  // Optional cancellation signal (client disconnect). Checked at the bounded checkpoints below.
  readonly signal?: AbortSignal | undefined;
}

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new PromptEnhancementCancelledError();
  }
};

// Clamp the requested candidate count into [1, gateway MAX_CANDIDATE_COUNT]. The wire validator already
// bounded the value to [1, PROMPT_ENHANCEMENT_MAX_CANDIDATE_COUNT]; this additionally honors the
// gateway's own bound so the surface can never widen the optimization envelope.
const clampCandidateCount = (requested: number | undefined): number => {
  const base =
    requested === undefined || !Number.isInteger(requested) || requested < 1
      ? PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT
      : requested;
  return Math.min(base, PromptEnhancer.MAX_CANDIDATE_COUNT);
};

// A stable, content-free request id derived from the normalized draft + the request shaping options. A
// hash keeps the pipeline deterministic (identical request → identical id) and never embeds raw input,
// a path-traversal fragment, or a control character, so it passes the branded-id validator.
const deriveRequestId = (
  normalized: string,
  missingInformationStrategy: string,
  profilePreference: string,
  locale: string,
  hasConnectedContext: boolean | undefined,
  attachmentCount: number | undefined,
): string =>
  `pe-req-${sha256Hex(
    [
      normalized,
      missingInformationStrategy,
      profilePreference,
      locale,
      hasConnectedContext === undefined ? "" : String(hasConnectedContext),
      attachmentCount === undefined ? "" : String(attachmentCount),
    ].join("\u0000"),
  ).slice(0, 48)}`;

const resolveModelRouting = (
  request: PromptEnhancementWireRequest,
  config: GatewayConfig | undefined,
): PromptEnhancementModelRouting => {
  const requestedModelId = request.modelId;
  if (requestedModelId === undefined) {
    return { availability: "not-requested", reason: "no-model-requested" };
  }
  if (config === undefined) {
    return { availability: "unavailable", reason: "no-gateway-config", requestedModelId };
  }
  const isConfiguredProvider = config.providers.some(
    (provider) => provider.modelId === requestedModelId,
  );
  if (!isConfiguredProvider) {
    return { availability: "unavailable", reason: "model-not-configured", requestedModelId };
  }
  const resolved = findConfiguredCapability(config, requestedModelId);
  if (resolved?.kind !== "chat") {
    return { availability: "unavailable", reason: "model-not-chat-capable", requestedModelId };
  }
  return {
    availability: "available",
    reason: "model-available",
    requestedModelId,
    resolvedModelId: requestedModelId,
    costClass: resolved.costClass,
  };
};

const resolveGroundingReadiness = (
  request: PromptEnhancementWireRequest,
  required: boolean,
): PromptEnhancementGroundingReadiness => {
  if (!required) {
    return { status: "not-required", reason: "no-grounding-required" };
  }
  if (request.hasConnectedContext === true || (request.attachmentCount ?? 0) > 0) {
    return { status: "ready", reason: "connected-context-present" };
  }
  return {
    status: "unavailable",
    reason: "missing-concrete-scope",
    notice:
      "This prompt requires grounding, but no connected workspace scope or attachment was supplied.",
  };
};

const NOT_RECORDED_EVIDENCE = {
  status: "not-recorded",
  reason: "evidence-store-not-configured",
} as const;

/**
 * Run the governed, deterministic prompt enhancement pipeline and assemble the BFF wire response.
 * Pure apart from SHA-256 hashing. Throws `PromptEnhancementInputError` on domain-validation failure and
 * `PromptEnhancementCancelledError` if the caller disconnects.
 */
interface PreparedEnhancement {
  readonly analysis: ReturnType<typeof analyzePrompt>;
  readonly input: RawPromptInput;
  readonly inputFingerprintSha256: string;
}

// Normalize + guard the draft, mint the branded ids, build and re-validate the domain request, and run
// the deterministic analyzer. Throws PromptEnhancementInputError on an empty draft or domain-validation
// failure. Factored out of runPromptEnhancement to keep each function within the complexity/size bounds.
function prepareEnhancement(request: PromptEnhancementWireRequest): PreparedEnhancement {
  const missingInformationStrategy = request.missingInformationStrategy ?? "clarify";
  const normalized = normalizePromptDraft(request.text);
  // Self-contained guard so the reusable orchestrator never analyzes an empty draft even if a future
  // caller skips the wire validator. A draft empty after control-stripping + NFKC carries no signal.
  if (normalized.trim().length === 0) {
    throw new PromptEnhancementInputError(["request text must not be empty after normalization"]);
  }
  const inputFingerprintSha256 = sha256Hex(normalized);
  const requestId = asPromptEnhancementRequestId(
    deriveRequestId(
      normalized,
      missingInformationStrategy,
      request.profilePreference ?? "",
      request.locale ?? "",
      request.hasConnectedContext,
      request.attachmentCount,
    ),
  );
  const input: RawPromptInput = {
    text: request.text,
    ...(request.hasConnectedContext === undefined
      ? {}
      : { hasConnectedContext: request.hasConnectedContext }),
    ...(request.attachmentCount === undefined ? {} : { attachmentCount: request.attachmentCount }),
  };
  const domainRequest: PromptEnhancementRequest = {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    requestId,
    input,
    missingInformationStrategy,
    ...(request.profilePreference === undefined
      ? {}
      : { profilePreference: request.profilePreference }),
    ...(request.locale === undefined ? {} : { locale: request.locale }),
  };
  const validation = validatePromptEnhancementRequest(domainRequest);
  if (!validation.ok) {
    throw new PromptEnhancementInputError(validation.errors);
  }
  return { analysis: analyzePrompt(validation.value), input, inputFingerprintSha256 };
}

export function runPromptEnhancement(
  request: PromptEnhancementWireRequest,
  deps: RunPromptEnhancementDeps,
): PromptEnhancementWireResponse {
  throwIfCancelled(deps.signal);
  const { analysis, input, inputFingerprintSha256 } = prepareEnhancement(request);
  throwIfCancelled(deps.signal);
  const selection = PromptEnhancer.optimizePromptCandidates({
    analysis,
    input,
    bounds: { candidateCount: clampCandidateCount(request.candidateCount) },
    ...(request.profilePreference === undefined
      ? {}
      : { profilePreference: request.profilePreference }),
  });
  throwIfCancelled(deps.signal);
  const enhancedPrompt = selection.rankedPrompts[0];
  if (enhancedPrompt === undefined) {
    throw new Error("Prompt enhancement optimization produced no prompt.");
  }
  const renderedPrompt = PromptEnhancer.renderEnhancedPromptText(enhancedPrompt);
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    promptId: enhancedPrompt.promptId,
    inputFingerprintSha256,
    analysis,
    enhancedPrompt,
    renderedPrompt,
    candidates: {
      winnerCandidateId: selection.winner.candidateId,
      scorecards: selection.ranked,
      rejected: selection.rejected,
    },
    safety: selection.winnerSafetyAssessment,
    modelRouting: resolveModelRouting(request, deps.gatewayConfig),
    groundingReadiness: resolveGroundingReadiness(request, enhancedPrompt.groundingPlan.required),
    evidence: NOT_RECORDED_EVIDENCE,
  };
}

function evidenceStatus(
  decision: PromptEnhancementWireResponse["safety"]["decision"],
): PromptEnhancementRecordInput["status"] {
  if (decision === "accepted") return "validated";
  if (decision === "rejected") return "rejected";
  return "requires-human-review";
}

function evidenceCandidateRows(
  candidates: PromptEnhancementWireResponse["candidates"],
): PromptEnhancementRecordInput["candidateScores"] {
  return candidates.scorecards.map((scorecard) => ({
    candidateId: scorecard.candidateId,
    profile: scorecard.profile,
    aggregateScore: scorecard.aggregateScore,
    estimatedTokens: scorecard.estimatedTokens,
    selected: scorecard.candidateId === candidates.winnerCandidateId,
  }));
}

function evidenceModelMetadata(
  routing: PromptEnhancementWireResponse["modelRouting"],
  winnerProfile: string | undefined,
): PromptEnhancementRecordInput["modelMetadata"] {
  return {
    deterministic: true,
    ...(routing.resolvedModelId === undefined ? {} : { modelId: routing.resolvedModelId }),
    ...(winnerProfile === undefined ? {} : { profile: winnerProfile }),
  };
}

function runIdForEvidence(result: PromptEnhancementWireResponse, recordedAt: string): string {
  return `pe-run-${sha256Hex(
    [result.analysis.requestId, result.promptId, result.inputFingerprintSha256, recordedAt].join(
      "\u0000",
    ),
  ).slice(0, 32)}`;
}

export function buildPromptEnhancementRecordInput(options: {
  readonly rawInput: string;
  readonly result: PromptEnhancementWireResponse;
  readonly recordedAt: string;
}): PromptEnhancementRecordInput {
  const { rawInput, result, recordedAt } = options;
  const winnerProfile = result.candidates.scorecards.find(
    (scorecard) => scorecard.candidateId === result.candidates.winnerCandidateId,
  )?.profile;
  return {
    runId: runIdForEvidence(result, recordedAt),
    recordedAt,
    requestId: result.analysis.requestId,
    status: evidenceStatus(result.safety.decision),
    originalInput: rawInput,
    enhancedPromptId: result.promptId,
    enhancedPromptText: result.renderedPrompt,
    appliedSafetyRules: result.enhancedPrompt.safetyRules,
    appliedGroundingDirectives: result.enhancedPrompt.groundingPlan.directives,
    assumptions: result.analysis.missingContext.flatMap((item) =>
      item.kind === "assumption" ? [item.statement] : [],
    ),
    candidateScores: evidenceCandidateRows(result.candidates),
    safety: {
      decision: result.safety.decision,
      verificationStatus: result.safety.verificationStatus,
      requiresHumanReview: result.safety.requiresHumanReview,
      findingCodes: result.safety.findings.map((finding) => finding.code),
      leastPrivilege: result.safety.leastPrivilege,
    },
    modelMetadata: evidenceModelMetadata(result.modelRouting, winnerProfile),
  };
}
