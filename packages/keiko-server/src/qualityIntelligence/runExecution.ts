// Quality Intelligence run execution orchestrator (Epic #270, Issue #273/#278/#279/#280).
//
// The single seam that turns a validated start-run request into a completed, persisted QI run:
// ingest sources → resolve a chat model + build the gateway-backed generation port → run the
// model-routed test-design workflow (which emits the QI run-event envelope, validates, and persists
// the manifest + candidate artifact). Route-agnostic: the caller supplies an event callback (wired
// to SSE) and an AbortSignal (wired to the run registry for cancellation).

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
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { createQiJudgePort } from "./judgePort.js";
import { selectModelForQiCapability } from "./modelSelection.js";

const PLAN_STAGES: readonly QI.QualityIntelligenceRunStage[] = Object.freeze([
  { name: "plan", descriptor: "qi:plan" },
  { name: "candidates", descriptor: "qi:model-generate" },
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
  readonly modelId: string;
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

  const ingestion = ingestInlineSources({ request, runId, registeredAt: input.registeredAt });
  const modelId = selectModelForQiCapability(deps, "qi:test-design", request.modelId);
  const generate = createQiGenerationPort(deps, modelId);
  const profile = resolveProfile(request.profileId);

  input.onAccepted({
    runId,
    requestedAt: input.registeredAt,
    sourceCount: ingestion.sourceSummaries.length,
    atomCount: ingestion.ingestedAtoms.length,
    modelId,
  });

  const plan: QI.QualityIntelligenceRunPlan = {
    id: QualityIntelligence.asQualityIntelligenceRunId(runId),
    requestedAt: input.registeredAt,
    plannerKind: "model-routed",
    stages: PLAN_STAGES,
  };

  return runQualityIntelligenceModelRoutedTestDesign(
    {
      plan,
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
  readonly modelId: string;
  readonly generate: ReturnType<typeof createQiGenerationPort>;
  readonly onEvent: (event: QI.QualityIntelligenceRunEvent) => void;
  readonly signal: AbortSignal;
}

function buildJudgePortIfAvailable(
  deps: UiHandlerDeps,
  modelId: string,
): ReturnType<typeof createQiJudgePort> | undefined {
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
