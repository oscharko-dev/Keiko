// Quality Intelligence run execution orchestrator (Epic #270, Issue #273/#278/#279/#280).
//
// The single seam that turns a validated start-run request into a completed, persisted QI run:
// ingest sources → resolve a test-design generation strategy (structured model, chat-only model, or
// deterministic no-model baseline) → build the generation port → run the model-routed test-design
// workflow (which emits the QI run-event envelope, validates, and persists the manifest + candidate
// artifact). Route-agnostic: the caller supplies an event callback (wired to SSE) and an
// AbortSignal (wired to the run registry for cancellation).

import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  ALL_POLICY_PROFILES,
  regressionDefault,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import {
  createNodeQualityIntelligenceLocalStore,
  recordQualityIntelligenceCandidates,
} from "@oscharko-dev/keiko-evidence";
import {
  runQualityIntelligenceModelRoutedTestDesign,
  type QualityIntelligenceRunSummary,
  type QualityIntelligenceModelRoutedTestDesignDeps,
} from "@oscharko-dev/keiko-workflows";
import type { QualityIntelligenceStartRunRequest } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { ingestInlineSources, QiIngestionError } from "./runIngestion.js";
import type { QiSkippedSource } from "./runIngestion.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";
import { makeFigmaSnapshotLoader, makeFigmaVisionHintProvider } from "./figmaSnapshotAdapter.js";
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { createQiJudgePort } from "./judgePort.js";
import { resolveQiTestDesignSelection } from "./modelSelection.js";

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
  /** Sources dropped because the request exceeded the 16-source cap (Epic #729). */
  readonly droppedSourceCount: number;
  /** Connected sources skipped because they ingested to nothing usable (Epic #729 N+1 resilience). */
  readonly skippedSources: readonly QiSkippedSource[];
}

export interface ExecuteQiRunInput {
  readonly request: QualityIntelligenceStartRunRequest;
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

function resolveExecutionStrategy(
  deps: UiHandlerDeps,
  request: QualityIntelligenceStartRunRequest,
): ResolvedExecutionStrategy {
  const selection = resolveQiTestDesignSelection(deps, request.modelId);
  if (selection.kind === "model") {
    return {
      modelId: selection.modelId,
      generate: createQiGenerationPort(deps, {
        kind: "model",
        modelId: selection.modelId,
        requestedSeed: request.seed,
      }),
    };
  }
  return {
    generate: createQiGenerationPort(deps, { kind: "baseline" }),
  };
}

function buildAccepted(
  input: ExecuteQiRunInput,
  ingestion: ReturnType<typeof ingestInlineSources>,
  modelId: string | undefined,
): QiRunAccepted {
  return {
    runId: input.runId,
    requestedAt: input.registeredAt,
    sourceCount: ingestion.sourceSummaries.length,
    atomCount: ingestion.ingestedAtoms.length,
    ...(modelId !== undefined ? { modelId } : {}),
    droppedSourceCount: ingestion.droppedSourceCount,
    skippedSources: ingestion.skippedSources,
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
 * state. `onAccepted` fires once, after ingestion + model resolution succeed and before generation.
 */
export async function executeQiRun(
  input: ExecuteQiRunInput,
): Promise<QualityIntelligenceRunSummary> {
  const { deps, runId, request } = input;
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    throw new QiGenerationError("QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }

  const ingestion = ingestInlineSources({
    request,
    runId,
    registeredAt: input.registeredAt,
    capsuleResolver: makeCapsuleResolver(deps),
    figmaSnapshotLoader: makeFigmaSnapshotLoader(deps),
    figmaVision: makeFigmaVisionHintProvider(deps),
  });
  const { modelId, generate } = resolveExecutionStrategy(deps, request);
  const profile = resolveProfile(request.profileId);

  input.onAccepted(buildAccepted(input, ingestion, modelId));

  return runQualityIntelligenceModelRoutedTestDesign(
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
      generate,
      onEvent: input.onEvent,
      signal: input.signal,
    }),
  );
}

interface WorkflowDepsInput {
  readonly deps: UiHandlerDeps;
  readonly runId: string;
  readonly evidenceDir: string;
  readonly modelId?: string | undefined;
  readonly generate: ReturnType<typeof createQiGenerationPort>;
  readonly onEvent: (event: QI.QualityIntelligenceRunEvent) => void;
  readonly signal: AbortSignal;
}

function buildJudgePortIfAvailable(
  deps: UiHandlerDeps,
  modelId: string | undefined,
): ReturnType<typeof createQiJudgePort> | undefined {
  if (modelId === undefined) return undefined;
  try {
    return createQiJudgePort(deps, modelId);
  } catch {
    // Judge port creation failures are non-fatal: the judge stage is optional.
    return undefined;
  }
}

function buildWorkflowDeps(args: WorkflowDepsInput): QualityIntelligenceModelRoutedTestDesignDeps {
  const { runId, evidenceDir } = args;
  const redact = args.deps.redactor;
  return {
    sink: { emit: args.onEvent },
    evidenceStore: createNodeQualityIntelligenceLocalStore(evidenceDir),
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
    judge: buildJudgePortIfAvailable(args.deps, args.modelId),
    signal: args.signal,
  };
}

export { QiIngestionError, QiGenerationError };
