import { isGitChangeSnapshotReference } from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import {
  PR_DESCRIPTION_SECTION_KEYS,
  PR_DESCRIPTION_LANGUAGES,
  prDescriptionArtifactEvidence,
  type PrDescriptionCandidate,
  type PrDescriptionCoverage,
  type PrDescriptionReason,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import { CancelledError } from "@oscharko-dev/keiko-security/errors/gateway";
import { findConfiguredCapability, selectConfiguredModel } from "../model-selection.js";
import {
  logErrorKind,
  logTimer,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogSink,
} from "../observability.js";
import {
  composeCancellationSignal,
  type QualityIntelligenceCancellationHandle,
} from "../qualityIntelligence/cancellation.js";
import {
  createBudget,
  remainingBudget,
  reserveBudget,
  type QualityIntelligenceBudgetState,
} from "../qualityIntelligence/budget.js";
import { prDescriptionChunks, validPrDescriptionSnapshot } from "./evidence.js";
import {
  buildPrDescriptionModelRequest,
  PR_DESCRIPTION_RESPONSE_SCHEMA_OMITTED_KEYWORD_COUNT,
  PR_DESCRIPTION_RESPONSE_SCHEMA_PROFILE,
  prDescriptionRequestCost,
  validatePrDescriptionResponse,
} from "./model.js";
import {
  buildPrDescriptionArtifact,
  emptyPrDescriptionCandidate,
  mergePrDescriptionCandidates,
} from "./render.js";
import {
  resolvePrDescriptionLimits,
  type PrDescriptionDeps,
  type PrDescriptionGenerationResult,
  type PrDescriptionLimits,
  type PrDescriptionRequest,
  type PrDescriptionResolvedSnapshot,
} from "./types.js";
import type { GatewayCallRequest } from "../gateway.js";
import type { ModelCapability, NormalizedResponse } from "../types.js";

interface Generation {
  readonly request: PrDescriptionRequest;
  readonly deps: PrDescriptionDeps;
  readonly resolved: PrDescriptionResolvedSnapshot;
  readonly limits: PrDescriptionLimits;
  readonly cancellation: QualityIntelligenceCancellationHandle;
  readonly log: ModelGatewayLogSink;
  readonly elapsed: () => number;
  readonly candidates: PrDescriptionCandidate[];
  readonly usages: NormalizedResponse["usage"][];
  modelId: string | undefined;
  budget: QualityIntelligenceBudgetState;
  calls: number;
  inputBytes: number;
  outputBytes: number;
  reason: PrDescriptionReason;
}

function validRequest(request: PrDescriptionRequest): boolean {
  return (
    isGitChangeSnapshotReference(request.snapshotReference) &&
    PR_DESCRIPTION_LANGUAGES.includes(request.language) &&
    /^[a-f0-9]{64}$/u.test(request.authority.authorityDigest) &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(request.authority.correlationId) &&
    (request.refinement === undefined ||
      (typeof request.refinement === "string" &&
        Buffer.byteLength(request.refinement, "utf8") <= 4_096))
  );
}

/** Settles promptly even if a foreign resolver/adapter ignores cancellation; listeners are removed. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new CancelledError("PR description generation cancelled");
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener("abort", aborted);
      reject(new CancelledError("PR description generation cancelled"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(
          error instanceof Error ? error : new TypeError("Invalid PR description provider failure"),
        );
      },
    );
  });
}

function cancellationReason(generation: Generation): PrDescriptionReason {
  return generation.cancellation.reasonKind() === "external" ? "cancelled" : "timeout";
}

function failedGenerationReason(
  cancellation: QualityIntelligenceCancellationHandle,
): PrDescriptionReason {
  if (!cancellation.signal.aborted) return "provider-failed";
  return cancellation.reasonKind() === "external" ? "cancelled" : "timeout";
}

function reserveCall(
  generation: Generation,
  call: GatewayCallRequest,
  capability: ModelCapability,
): boolean {
  const cost = prDescriptionRequestCost(call);
  if (
    generation.calls >= generation.limits.maxCalls ||
    cost.tokens > remainingBudget(generation.budget) ||
    cost.tokens > capability.contextWindow ||
    generation.inputBytes + cost.bytes > generation.limits.maxInputBytes ||
    generation.outputBytes >= generation.limits.maxOutputBytes
  ) {
    generation.reason = "budget-exhausted";
    return false;
  }
  generation.budget = reserveBudget(generation.budget, cost.tokens);
  generation.inputBytes += cost.bytes;
  generation.calls += 1;
  return true;
}

async function executeCall(
  generation: Generation,
  call: GatewayCallRequest,
  evidenceIds: readonly string[],
): Promise<boolean> {
  generation.log.write({
    category: "gateway",
    op: "pr-description.model.started",
    extra: {
      callCount: generation.calls,
      structuredOutput: call.responseFormat !== undefined,
      responseSchemaProfile:
        call.responseFormat === undefined ? "none" : PR_DESCRIPTION_RESPONSE_SCHEMA_PROFILE,
      responseSchemaOmittedKeywordCount:
        call.responseFormat === undefined
          ? 0
          : PR_DESCRIPTION_RESPONSE_SCHEMA_OMITTED_KEYWORD_COUNT,
      inputBytes: generation.inputBytes,
    },
  });
  try {
    const response = await abortable(
      generation.deps.gateway.chat(call),
      generation.cancellation.signal,
    );
    if (!(await authorityStillCurrent(generation))) {
      return rejectResponseAfterAuthorityChange(generation, call, response);
    }
    return acceptResponse(generation, call, response, evidenceIds);
  } catch (error) {
    generation.reason = generation.cancellation.signal.aborted
      ? cancellationReason(generation)
      : "provider-failed";
    generation.log.write({
      level: "warn",
      category: "gateway",
      op: "pr-description.model.failed",
      errorKind: logErrorKind(error),
      extra: {
        reason: generation.reason,
        callCount: generation.calls,
        ...generation.deps.errorEvidence?.(error),
      },
    });
    generation.candidates.length = 0;
    return false;
  }
}

function rejectResponseAfterAuthorityChange(
  generation: Generation,
  call: GatewayCallRequest,
  response: NormalizedResponse,
): false {
  generation.usages.push(response.usage);
  generation.modelId = call.modelId;
  generation.outputBytes += Buffer.byteLength(response.content, "utf8");
  generation.candidates.length = 0;
  generation.log.write({
    category: "gateway",
    op: "pr-description.model.completed",
    extra: {
      callCount: generation.calls,
      accepted: false,
      reason: generation.reason,
      outputBytes: generation.outputBytes,
    },
  });
  return false;
}

async function authorityStillCurrent(generation: Generation): Promise<boolean> {
  if (generation.cancellation.signal.aborted) {
    generation.reason = cancellationReason(generation);
    return false;
  }
  try {
    const authorized = await abortable(
      Promise.resolve(
        generation.deps.revalidateAuthority(
          generation.request.authority,
          generation.cancellation.signal,
        ),
      ),
      generation.cancellation.signal,
    );
    if (!authorized) generation.reason = "authority-denied";
    return authorized;
  } catch (error) {
    generation.reason =
      error instanceof CancelledError ? cancellationReason(generation) : "authority-denied";
    generation.log.write({
      level: "warn",
      category: "gateway",
      op: "pr-description.authority.revalidation.failed",
      errorKind: logErrorKind(error),
      extra: { reason: generation.reason, callCount: generation.calls },
    });
    return false;
  }
}

async function reserveAuthorizedCall(
  generation: Generation,
  call: GatewayCallRequest,
  capability: ModelCapability,
): Promise<boolean> {
  return (await authorityStillCurrent(generation)) && reserveCall(generation, call, capability);
}

function responseBudgetExceeded(call: GatewayCallRequest, response: NormalizedResponse): boolean {
  const { promptTokens, completionTokens } = response.usage;
  return (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0 ||
    completionTokens > (call.maxOutputTokens ?? 0) ||
    promptTokens + completionTokens > prDescriptionRequestCost(call).tokens
  );
}

function acceptResponse(
  generation: Generation,
  call: GatewayCallRequest,
  response: NormalizedResponse,
  evidenceIds: readonly string[],
): boolean {
  generation.usages.push(response.usage);
  generation.modelId = call.modelId;
  const validation = validatePrDescriptionResponse(
    response,
    evidenceIds,
    generation.limits.maxOutputBytes - generation.outputBytes,
  );
  generation.outputBytes += Buffer.byteLength(response.content, "utf8");
  if (response.modelId !== call.modelId) generation.reason = "invalid-model-output";
  else if (responseBudgetExceeded(call, response)) generation.reason = "budget-exhausted";
  else if (!validation.ok) generation.reason = validation.reason;
  else {
    generation.candidates.push(validation.value);
  }
  const accepted = generation.reason === "none";
  if (!accepted) generation.candidates.length = 0;
  generation.log.write({
    category: "gateway",
    op: "pr-description.model.completed",
    extra: {
      callCount: generation.calls,
      accepted,
      reason: generation.reason,
      outputBytes: generation.outputBytes,
    },
  });
  return accepted;
}

function aggregateUsage(
  generation: Generation,
): import("./types.js").PrDescriptionGenerationUsage | undefined {
  const first = generation.usages[0];
  if (first === undefined || generation.modelId === undefined) return undefined;
  return {
    modelId: generation.modelId,
    requestId: first.requestId,
    requestCount: generation.usages.length,
    promptTokens: generation.usages.reduce((total, usage) => total + usage.promptTokens, 0),
    completionTokens: generation.usages.reduce((total, usage) => total + usage.completionTokens, 0),
    latencyMs: generation.usages.reduce((total, usage) => total + usage.latencyMs, 0),
    costClass: first.costClass,
  };
}

async function generateCandidates(generation: Generation): Promise<void> {
  const modelId = selectConfiguredModel(generation.deps.config, { kind: "chat" });
  const capability =
    modelId === undefined ? undefined : findConfiguredCapability(generation.deps.config, modelId);
  if (capability === undefined) {
    generation.reason = "model-unavailable";
    return;
  }
  const outputTokens = Math.min(generation.limits.maxOutputTokens, capability.maxOutputTokens);
  if (outputTokens <= 0) {
    generation.reason = "budget-exhausted";
    return;
  }
  const chunks = prDescriptionChunks(generation.resolved.evidence, generation.limits.maxChunkBytes);
  if (chunks.length === 0 && generation.resolved.evidence.length > 0) {
    generation.reason = "budget-exhausted";
    return;
  }
  for (const chunk of chunks) {
    if (generation.cancellation.signal.aborted) {
      generation.reason = cancellationReason(generation);
      break;
    }
    const call = buildPrDescriptionModelRequest(
      generation.request,
      chunk,
      capability,
      outputTokens,
      generation.cancellation.signal,
    );
    if (!(await reserveAuthorizedCall(generation, call, capability))) break;
    if (
      !(await executeCall(
        generation,
        call,
        chunk.map((item) => item.evidenceId),
      ))
    )
      break;
  }
}

function coverageFor(
  generation: Generation,
  candidate: PrDescriptionCandidate,
): PrDescriptionCoverage {
  const represented = new Set(
    PR_DESCRIPTION_SECTION_KEYS.flatMap((key) =>
      candidate[key].flatMap((statement) => statement.evidenceIds),
    ),
  );
  return {
    snapshot: generation.resolved.snapshot.completeness,
    suppliedEvidenceCount: generation.resolved.evidence.length,
    processedEvidenceCount: represented.size,
    omittedEvidenceCount: generation.resolved.snapshot.entries.length - represented.size,
  };
}

function completeGeneration(generation: Generation): PrDescriptionGenerationResult {
  const candidate =
    generation.reason === "cancelled"
      ? emptyPrDescriptionCandidate()
      : mergePrDescriptionCandidates(generation.candidates);
  const coverage = coverageFor(generation, candidate);
  let outcome: "complete" | "partial" | "fallback" | "failed" = "complete";
  if (generation.reason === "cancelled") outcome = "failed";
  else if (generation.candidates.length === 0) outcome = "fallback";
  else if (coverage.omittedEvidenceCount > 0 || generation.resolved.snapshot.outcome === "partial")
    outcome = "partial";
  const artifact = buildPrDescriptionArtifact({
    snapshot: generation.resolved.snapshot,
    candidate,
    coverage,
    outcome,
    language: generation.request.language,
    reason: generation.reason,
    ...(generation.deps.branding === undefined ? {} : { branding: generation.deps.branding }),
  });
  generation.log.write({
    category: "gateway",
    op: "pr-description.generation.completed",
    durationMs: generation.elapsed(),
    extra: {
      ...prDescriptionArtifactEvidence(artifact),
      callCount: generation.calls,
      inputBytes: generation.inputBytes,
      outputBytes: generation.outputBytes,
    },
  });
  const usage = aggregateUsage(generation);
  return { status: "generated", artifact, ...(usage === undefined ? {} : { usage }) };
}

async function resolveAndGenerate(
  request: PrDescriptionRequest,
  deps: PrDescriptionDeps,
  limits: PrDescriptionLimits,
  cancellation: QualityIntelligenceCancellationHandle,
  log: ModelGatewayLogSink,
): Promise<PrDescriptionGenerationResult> {
  const resolved = await abortable(
    deps.resolveSnapshot(request.snapshotReference, cancellation.signal),
    cancellation.signal,
  );
  if (resolved === undefined) return { status: "unavailable", reason: "snapshot-unavailable" };
  if (!validPrDescriptionSnapshot(resolved, (deps.now ?? Date.now)()))
    return { status: "unavailable", reason: "invalid-snapshot" };
  const generation: Generation = {
    request,
    deps,
    resolved,
    limits,
    cancellation,
    log,
    elapsed: logTimer(),
    candidates: [],
    usages: [],
    modelId: undefined,
    budget: createBudget(limits.maxTokens),
    calls: 0,
    inputBytes: 0,
    outputBytes: 0,
    reason: "none",
  };
  log.write({
    category: "gateway",
    op: "pr-description.generation.started",
    extra: {
      snapshotDigest: resolved.snapshot.snapshotDigest,
      authorityDigest: request.authority.authorityDigest,
      evidenceCount: resolved.evidence.length,
    },
  });
  await generateCandidates(generation);
  if (generation.reason === "authority-denied") {
    return { status: "unavailable", reason: generation.reason };
  }
  return completeGeneration(generation);
}

/** Only a server-owned adapter supplies the admitted authority and snapshot resolver. No tools. */
export async function generatePrDescription(
  request: PrDescriptionRequest,
  deps: PrDescriptionDeps,
): Promise<PrDescriptionGenerationResult> {
  if (!validRequest(request)) return { status: "unavailable", reason: "invalid-request" };
  const log = withCorrelationId(resolveLogSink(deps.log), request.authority.correlationId);
  const limits = resolvePrDescriptionLimits(deps.limits);
  if (Object.values(limits).includes(0))
    return { status: "unavailable", reason: "budget-exhausted" };
  if (request.signal?.aborted === true) return { status: "unavailable", reason: "cancelled" };
  const cancellation = composeCancellationSignal(limits.timeoutMs, request.signal);
  try {
    const result = await resolveAndGenerate(request, deps, limits, cancellation, log);
    if (result.status === "unavailable")
      log.write({
        category: "gateway",
        op: "pr-description.generation.unavailable",
        extra: { reason: result.reason },
      });
    return result;
  } catch (error) {
    const reason = failedGenerationReason(cancellation);
    log.write({
      category: "gateway",
      op: "pr-description.generation.failed",
      errorKind: logErrorKind(error),
      extra: { reason, ...deps.errorEvidence?.(error) },
    });
    return { status: "unavailable", reason };
  } finally {
    cancellation.dispose();
  }
}
