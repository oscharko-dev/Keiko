// Prompt Enhancer orchestration (Epic #1307, Issue #1314; ADR-0044 §1/§3/§4).
//
// #1314 owns the governed `analyze → plan → generate → score → validate` assembly at the server layer
// (there is deliberately no `keiko-workflows/promptEnhancer` module — see the ADR-0044 §1 reuse map and
// the #1313 placement). This module composes the deterministic, provider-neutral primitives already
// shipped by #1309–#1313 into a single content-light wire response. It is PURE: the only "IO" is a
// SHA-256 hash (a pure function); no clock, no randomness, no network, no model dispatch. The same
// function backs both the BFF route (#1314 server) and the CLI command (#1314 cli), so the two surfaces
// produce byte-identical enhancements (AC1 "one product surface and one developer-facing surface").
//
// Model-Gateway routing (AC3). The enhancer never calls a live model — every primitive is
// deterministic and the Enhanced Prompt is provider-neutral. The optional `modelId` the caller intends
// to dispatch the result to downstream is resolved against the Model-Gateway config (a configured
// provider check); when no gateway config is present or the model is not a configured provider, the
// result still succeeds and `modelRouting` reports the degraded state (graceful handling). The enhancer
// itself is never blocked by an unavailable model.

import {
  analyzePrompt,
  asEnhancedPromptId,
  asPromptEnhancementRequestId,
  normalizePromptDraft,
  validatePromptEnhancementRequest,
  PROMPT_ENHANCEMENT_DEFAULT_CANDIDATE_COUNT,
  PROMPT_ENHANCER_SCHEMA_VERSION,
  type EnhancedPrompt,
  type PromptCandidateRejection,
  type PromptCandidateScorecard,
  type PromptEnhancementModelRouting,
  type PromptEnhancementRequest,
  type PromptEnhancementWireRequest,
  type PromptEnhancementWireResponse,
  type RawPromptInput,
} from "@oscharko-dev/keiko-contracts";
import { PromptEnhancer, type GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
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
): string =>
  `pe-req-${sha256Hex(
    [normalized, missingInformationStrategy, profilePreference, locale].join("\u0000"),
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
  const resolved = config.capabilities?.find((entry) => entry.id === requestedModelId);
  return {
    availability: "available",
    reason: "model-available",
    requestedModelId,
    resolvedModelId: requestedModelId,
    ...(resolved === undefined ? {} : { costClass: resolved.costClass }),
  };
};

interface WinningEnhancement {
  readonly enhancedPrompt: EnhancedPrompt;
  readonly scorecards: readonly PromptCandidateScorecard[];
  readonly winnerCandidateId: string;
}

// Defensive fallback when candidate generation admits none (the baseline profile passes the safety
// floor in practice, so this is rarely reached): plan + generate + score a single primary candidate.
// `candidateId` is internally consistent with its own scorecard; it is never compared against the
// generated-candidate id format because the two code paths are mutually exclusive.
const buildFallbackWinner = (
  analysis: ReturnType<typeof analyzePrompt>,
  input: RawPromptInput,
  request: PromptEnhancementWireRequest,
  requestId: string,
): WinningEnhancement => {
  const plan = PromptEnhancer.planPromptEnhancement(analysis, {
    ...(request.profilePreference === undefined
      ? {}
      : { profilePreference: request.profilePreference }),
    missingInformationStrategy: request.missingInformationStrategy ?? "clarify",
  });
  const promptId = asEnhancedPromptId(`pe-${requestId}`);
  const enhancedPrompt = PromptEnhancer.generateEnhancedPrompt({ promptId, analysis, plan, input });
  const candidateId = `${requestId}::${plan.selectedProfile}`;
  const scorecard = PromptEnhancer.scorePromptCandidate({
    candidateId,
    profile: plan.selectedProfile,
    prompt: enhancedPrompt,
    plan,
    analysis,
  });
  return { enhancedPrompt, scorecards: [scorecard], winnerCandidateId: candidateId };
};

// Generate a slate of distinct candidates, score each with the deterministic critic, rank them, and
// return the winning candidate's full Enhanced Prompt plus the ranked scorecards. Falls back to a
// single primary candidate if generation admits none (defensive; the baseline profile always passes the
// safety floor in practice).
const selectWinner = (
  analysis: ReturnType<typeof analyzePrompt>,
  input: RawPromptInput,
  request: PromptEnhancementWireRequest,
  requestId: string,
): { winner: WinningEnhancement; rejected: readonly PromptCandidateRejection[] } => {
  const candidateCount = clampCandidateCount(request.candidateCount);
  const candidateSet = PromptEnhancer.generatePromptCandidates({
    analysis,
    input,
    candidateCount,
    ...(request.profilePreference === undefined
      ? {}
      : { profilePreference: request.profilePreference }),
  });
  const scorecards = candidateSet.candidates.map((candidate) =>
    PromptEnhancer.scorePromptCandidate({
      candidateId: candidate.candidateId,
      profile: candidate.profile,
      prompt: candidate.prompt,
      plan: candidate.plan,
      analysis,
    }),
  );
  const ranked = PromptEnhancer.rankCandidates(scorecards);
  const rejected: readonly PromptCandidateRejection[] = candidateSet.rejected.map((entry) => ({
    candidateId: entry.candidateId,
    profile: entry.profile,
    aggregateScore: null,
    reason: entry.reason,
  }));
  const winnerId = ranked[0]?.candidateId;
  const winnerCandidate = candidateSet.candidates.find(
    (candidate) => candidate.candidateId === winnerId,
  );
  if (winnerCandidate !== undefined) {
    return {
      winner: {
        enhancedPrompt: winnerCandidate.prompt,
        scorecards: ranked,
        winnerCandidateId: winnerCandidate.candidateId,
      },
      rejected,
    };
  }
  return { winner: buildFallbackWinner(analysis, input, request, requestId), rejected };
};

/**
 * Run the governed, deterministic prompt enhancement pipeline and assemble the BFF wire response.
 * Pure apart from SHA-256 hashing. Throws `PromptEnhancementInputError` on domain-validation failure and
 * `PromptEnhancementCancelledError` if the caller disconnects.
 */
interface PreparedEnhancement {
  readonly analysis: ReturnType<typeof analyzePrompt>;
  readonly input: RawPromptInput;
  readonly requestId: string;
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
  return { analysis: analyzePrompt(validation.value), input, requestId, inputFingerprintSha256 };
}

export function runPromptEnhancement(
  request: PromptEnhancementWireRequest,
  deps: RunPromptEnhancementDeps,
): PromptEnhancementWireResponse {
  throwIfCancelled(deps.signal);
  const { analysis, input, requestId, inputFingerprintSha256 } = prepareEnhancement(request);
  throwIfCancelled(deps.signal);
  const { winner, rejected } = selectWinner(analysis, input, request, requestId);
  throwIfCancelled(deps.signal);
  const safety = PromptEnhancer.assessPromptSafety({
    prompt: winner.enhancedPrompt,
    analysis,
    input,
  });
  const renderedPrompt = PromptEnhancer.renderEnhancedPromptText(winner.enhancedPrompt);
  return {
    schemaVersion: PROMPT_ENHANCER_SCHEMA_VERSION,
    promptId: winner.enhancedPrompt.promptId,
    inputFingerprintSha256,
    analysis,
    enhancedPrompt: winner.enhancedPrompt,
    renderedPrompt,
    candidates: {
      winnerCandidateId: winner.winnerCandidateId,
      scorecards: winner.scorecards,
      rejected,
    },
    safety,
    modelRouting: resolveModelRouting(request, deps.gatewayConfig),
  };
}
