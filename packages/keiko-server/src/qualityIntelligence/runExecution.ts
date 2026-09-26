// Quality Intelligence run execution orchestrator (Epic #270, Issue #273/#278/#279/#280).
//
// The single seam that turns a validated start-run request into a completed, persisted QI run:
// ingest sources → resolve a test-design generation strategy (structured model, chat-only model, or
// deterministic no-model baseline) → build the generation port → run the model-routed test-design
// workflow (which emits the QI run-event envelope, validates, and persists the manifest + candidate
// artifact). Route-agnostic: the caller supplies an event callback (wired to SSE) and an
// AbortSignal (wired to the run registry for cancellation).

import type {
  QualityIntelligence as QI,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceModelRouting,
} from "@oscharko-dev/keiko-contracts";
import * as QualityIntelligence from "@oscharko-dev/keiko-contracts/runtime/qualityIntelligence/index";
import {
  ALL_POLICY_PROFILES,
  regressionDefault,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { findConfiguredCapability } from "@oscharko-dev/keiko-model-gateway";
import {
  createNodeQualityIntelligenceLocalStore,
  recordQualityIntelligenceCandidates,
} from "@oscharko-dev/keiko-evidence";
import {
  runQualityIntelligenceModelRoutedTestDesign,
  type QualityIntelligenceRunSummary,
  type QualityIntelligenceModelRoutedTestDesignDeps,
} from "@oscharko-dev/keiko-workflows";
import { currentGatewayConfig, currentRedactionSecrets, type UiHandlerDeps } from "../deps.js";
import {
  ingestInlineSourcesAsync,
  type QiSourceSummary,
  type QiSkippedSource,
} from "./runIngestion.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";
import { extractQiDocumentText } from "./documentTextExtractor.js";
import { makeFigmaSnapshotLoader, makeFigmaVisionHintProvider } from "./figmaSnapshotAdapter.js";
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { tryCreateQiJudgePort, withQiJudgeStageFailure, type QiJudgePort } from "./judgePort.js";
import { resolveQiModelPolicy } from "./modelSelection.js";

// Mirrors the stages the model-routed workflow actually emits (descriptors.ts stageNames), so the
// run plan the UI renders matches the live stage:started/completed events — including the
// adversarial test-quality judge (Epic #736).
const PLAN_STAGES: readonly QI.QualityIntelligenceRunStage[] = Object.freeze([
  { name: "plan", descriptor: "qi:plan" },
  { name: "candidates", descriptor: "qi:model-generate" },
  { name: "judge", descriptor: "qi:judge" },
  { name: "coverage", descriptor: "qi:coverage" },
  { name: "validate", descriptor: "qi:validate" },
  { name: "finalize", descriptor: "qi:finalize" },
]);

function resolveProfile(profileId: string | undefined): PolicyProfile {
  if (profileId === undefined || profileId.trim().length === 0) return regressionDefault;
  return ALL_POLICY_PROFILES.find((p) => p.id === profileId) ?? regressionDefault;
}

export interface QiRunAccepted {
  readonly runId: string;
  readonly requestedAt: string;
  readonly sourceCount: number;
  readonly atomCount: number;
  readonly modelId?: string | undefined;
  readonly modelRouting?: QualityIntelligenceModelRouting | undefined;
  /** Sources dropped because the request exceeded the 16-source cap (Epic #729). */
  readonly droppedSourceCount: number;
  /** Connected sources skipped because they ingested to nothing usable (Epic #729 N+1 resilience). */
  readonly skippedSources: readonly QiSkippedSource[];
  /** Safe per-source ingestion notices; raw content never appears here. */
  readonly sourceSummaries: readonly QiSourceSummary[];
}

export interface ExecuteQiRunInput {
  readonly request: QualityIntelligenceStartRunRequest;
  readonly modelRouting?: QualityIntelligenceModelRouting | undefined;
  readonly runId: string;
  readonly deps: UiHandlerDeps;
  readonly registeredAt: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: QI.QualityIntelligenceRunEvent) => void;
  readonly onAccepted: (accepted: QiRunAccepted) => void;
}

interface ResolvedExecutionStrategy {
  readonly modelId?: string | undefined;
  readonly generate: ReturnType<typeof createQiGenerationPort>;
}

type QiIngestion = Awaited<ReturnType<typeof ingestInlineSourcesAsync>>;

function shouldUseBaselineGeneration(args: {
  readonly request: QualityIntelligenceStartRunRequest;
  readonly modelRouting: QualityIntelligenceModelRouting;
  readonly capabilitySupportsSeeding: boolean | undefined;
}): boolean {
  const selectedByDefault =
    args.request.modelId === undefined &&
    args.request.modelPolicy?.testDesignModelId === undefined &&
    args.modelRouting.requested.testDesignModelId === undefined;
  return (
    args.modelRouting.resolved.testDesignModelId === undefined ||
    (args.request.seed !== undefined &&
      selectedByDefault &&
      args.capabilitySupportsSeeding !== true)
  );
}

function resolveExecutionStrategy(
  deps: UiHandlerDeps,
  request: QualityIntelligenceStartRunRequest,
  modelRouting: QualityIntelligenceModelRouting,
  runId: string,
): ResolvedExecutionStrategy {
  const modelId = modelRouting.resolved.testDesignModelId;
  const config = currentGatewayConfig(deps);
  const capability =
    config !== undefined && modelId !== undefined
      ? findConfiguredCapability(config, modelId)
      : undefined;
  // Seeded runs without an explicit model are release evidence. If automatic routing would pick a
  // model that cannot apply the seed, prefer the deterministic structural baseline over
  // nondeterministic model/judge augmentation. Explicit model requests keep their existing
  // attribution contract and persist `seedUsed: null` when the model cannot apply the seed.
  if (modelId === undefined) {
    return {
      generate: createQiGenerationPort(deps, { kind: "baseline" }, runId),
    };
  }
  if (
    shouldUseBaselineGeneration({
      request,
      modelRouting,
      capabilitySupportsSeeding: capability?.supportsSeeding,
    })
  ) {
    return {
      generate: createQiGenerationPort(deps, { kind: "baseline" }, runId),
    };
  }
  return {
    modelId,
    generate: createQiGenerationPort(
      deps,
      {
        kind: "model",
        modelId,
        requestedSeed: request.seed,
      },
      runId,
    ),
  };
}

function buildExecutionRouting(input: ExecuteQiRunInput): QualityIntelligenceModelRouting {
  if (input.modelRouting !== undefined) return input.modelRouting;
  const resolution = resolveQiModelPolicy(input.deps, {
    ...(input.request.modelId !== undefined ? { modelId: input.request.modelId } : {}),
    ...(input.request.modelPolicy !== undefined ? { modelPolicy: input.request.modelPolicy } : {}),
  });
  const generation =
    resolution.resolved.testDesignModelId === undefined
      ? {
          stage: "generate" as const,
          status: "unavailable" as const,
          category: "unavailable" as const,
          message: "No compatible model is available for this stage.",
        }
      : {
          stage: "generate" as const,
          modelId: resolution.resolved.testDesignModelId,
          status: "not-run" as const,
          message: "Model routing was resolved without executing a preflight.",
        };
  const judge =
    resolution.resolved.judgeModelId === undefined
      ? {
          stage: "judge" as const,
          status: "unavailable" as const,
          category: "unavailable" as const,
          message: "No compatible model is available for this stage.",
        }
      : {
          stage: "judge" as const,
          modelId: resolution.resolved.judgeModelId,
          status: "not-run" as const,
          message: "Model routing was resolved without executing a preflight.",
        };
  return {
    policyVersion: 1,
    requested: resolution.requested,
    resolved: resolution.resolved,
    preflight: {
      status: generation.status === "unavailable" ? "unavailable" : "not-run",
      generation,
      judge,
    },
  };
}

function buildAccepted(
  input: ExecuteQiRunInput,
  ingestion: QiIngestion,
  modelId: string | undefined,
  modelRouting: QualityIntelligenceModelRouting,
): QiRunAccepted {
  return {
    runId: input.runId,
    requestedAt: input.registeredAt,
    sourceCount: ingestion.sourceSummaries.length,
    atomCount: ingestion.ingestedAtoms.length,
    ...(modelId !== undefined ? { modelId } : {}),
    modelRouting,
    droppedSourceCount: ingestion.droppedSourceCount,
    skippedSources: ingestion.skippedSources,
    sourceSummaries: ingestion.sourceSummaries,
  };
}

function buildRunPlan(input: ExecuteQiRunInput): QI.QualityIntelligenceRunPlan {
  return {
    id: QualityIntelligence.asQualityIntelligenceRunId(input.runId),
    requestedAt: input.registeredAt,
    plannerKind: "model-routed",
    stages: PLAN_STAGES,
  };
}

/**
 * Execute a QI run end to end. Throws `QiIngestionError` / `QiGenerationError` (safe, coded) when
 * the request cannot start; otherwise returns the run summary after the workflow reaches a terminal
 * state. `onAccepted` fires once, after ingestion + model/judge resolution succeed and before
 * generation.
 */
export async function executeQiRun(
  input: ExecuteQiRunInput,
): Promise<QualityIntelligenceRunSummary> {
  const evidenceDir = input.deps.evidenceDir;
  if (evidenceDir === undefined) {
    throw new QiGenerationError("QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  // The capsule resolver owns a SQLite handle; close it in a finally so a thrown ingestion/generation
  // never leaks it. The run body is extracted so this entrypoint stays within the line budget.
  const capsuleResolver = makeCapsuleResolver(input.deps);
  try {
    return await runResolvedQi(input, evidenceDir, capsuleResolver);
  } finally {
    capsuleResolver?.close();
  }
}

/**
 * Ingest the request's sources, counting the model-gateway calls the ingestion itself made (figma
 * vision hints) so the run's audited call total starts from the true figure.
 */
async function ingestForRun(
  input: ExecuteQiRunInput,
  capsuleResolver: ReturnType<typeof makeCapsuleResolver>,
): Promise<{ readonly ingestion: QiIngestion; readonly gatewayCallCount: number }> {
  const { deps, runId, request } = input;
  let gatewayCallCount = 0;
  const ingestion = await ingestInlineSourcesAsync({
    request,
    runId,
    registeredAt: input.registeredAt,
    capsuleResolver,
    figmaSnapshotLoader: makeFigmaSnapshotLoader(deps),
    figmaVision: makeFigmaVisionHintProvider(deps, undefined, {
      onGatewayCallAttempt: () => {
        gatewayCallCount += 1;
      },
    }),
    documentTextExtractor: extractQiDocumentText,
    signal: input.signal,
  });
  return { ingestion, gatewayCallCount };
}

async function runResolvedQi(
  input: ExecuteQiRunInput,
  evidenceDir: string,
  capsuleResolver: ReturnType<typeof makeCapsuleResolver>,
): Promise<QualityIntelligenceRunSummary> {
  const { deps, runId, request } = input;
  const requestedRouting = buildExecutionRouting(input);
  const { ingestion, gatewayCallCount } = await ingestForRun(input, capsuleResolver);
  const { modelId, generate } = resolveExecutionStrategy(deps, request, requestedRouting, runId);
  const resolvedJudge = resolveJudgeForModelRun(
    deps,
    requestedRouting.resolved.judgeModelId,
    request.seed,
    runId,
  );
  // The routing the run actually executes under carries the judge degradation, so `onAccepted`,
  // the persisted manifest, and the terminal `done` frame all report the same classified failure.
  const modelRouting = withQiJudgeStageFailure(requestedRouting, resolvedJudge.stageFailureReason);
  const profile = resolveProfile(request.profileId);

  input.onAccepted(buildAccepted(input, ingestion, modelId, modelRouting));

  return await runQualityIntelligenceModelRoutedTestDesign(
    {
      plan: buildRunPlan(input),
      envelopes: ingestion.envelopes,
      ingestedAtoms: ingestion.ingestedAtoms,
      provenanceRefs: ingestion.provenanceRefs,
      profile,
    },
    buildWorkflowDeps({
      deps,
      runId,
      evidenceDir,
      modelId,
      modelRouting,
      initialModelGatewayCallCount: gatewayCallCount,
      generate,
      judge: resolvedJudge.judge,
      onEvent: input.onEvent,
      signal: input.signal,
      retentionPolicyId: QualityIntelligence.resolveQualityIntelligenceRetentionPolicyId(
        request.retentionPolicyId,
      ),
    }),
  );
}

interface WorkflowDepsInput {
  readonly deps: UiHandlerDeps;
  readonly runId: string;
  readonly evidenceDir: string;
  readonly modelId?: string | undefined;
  readonly modelRouting?: QualityIntelligenceModelRouting | undefined;
  readonly initialModelGatewayCallCount?: number | undefined;
  readonly generate: ReturnType<typeof createQiGenerationPort>;
  readonly judge?: QiJudgePort | undefined;
  readonly onEvent: (event: QI.QualityIntelligenceRunEvent) => void;
  readonly signal: AbortSignal;
  readonly retentionPolicyId: QI.QualityIntelligenceRetentionPolicyId;
}

interface ResolvedJudge {
  readonly judge?: QiJudgePort | undefined;
  /** Redaction-safe reason the judge stage degraded; absent when a judge port was built. */
  readonly stageFailureReason?: string | undefined;
}

/**
 * Resolve the judge port for a model-backed run.
 *
 * The judge AUGMENTS generation and must never fail an otherwise successful run (the resilience
 * contract on `runJudgeStage` in keiko-workflows). This used to rethrow a `QiJudgeError` as a
 * `QiGenerationError`, which terminated the run over an OPTIONAL stage — and mislabelled a judge
 * fault as a generation fault. Now the failure is classified and returned so the caller records it
 * on the routing; the workflow's `judge === undefined` path then completes the run with an empty
 * judge result, exactly as it does when no judge model is configured at all.
 */
function resolveJudgeForModelRun(
  deps: UiHandlerDeps,
  judgeModelId: string | undefined,
  requestedSeed: number | undefined,
  correlationId: string,
): ResolvedJudge {
  if (judgeModelId === undefined) return {};
  const outcome = tryCreateQiJudgePort(deps, judgeModelId, { requestedSeed, correlationId });
  return outcome.available
    ? { judge: outcome.port }
    : { stageFailureReason: outcome.reasonSummary };
}

function buildWorkflowDeps(args: WorkflowDepsInput): QualityIntelligenceModelRoutedTestDesignDeps {
  const { runId, evidenceDir } = args;
  const redact = args.deps.redactor;
  return {
    sink: { emit: args.onEvent },
    evidenceStore: createNodeQualityIntelligenceLocalStore(evidenceDir),
    initialModelGatewayCallCount: args.initialModelGatewayCallCount,
    modelRouting: args.modelRouting,
    retentionPolicyId: args.retentionPolicyId,
    candidatesSink: {
      record: (candidates, generatedAt): void => {
        recordQualityIntelligenceCandidates({
          runId,
          generatedAt,
          candidates,
          evidenceDir,
          redact,
        });
      },
    },
    generate: args.generate,
    judge: args.judge,
    redaction: { additionalSecrets: currentRedactionSecrets(args.deps) },
    signal: args.signal,
  };
}

export { QiIngestionError } from "./runIngestion.js";
export { QiGenerationError };
