// EvalRunner (ADR-0012 D5/D6/D9/C5): runs the deterministic offline (or opt-in live) evaluation
// suite. For each fixture it materializes the workspace to a temp dir, builds a typed workflow input,
// injects a ScriptedModelPort (or live GatewayModelPort), a recording WorkspaceWriter, a deterministic
// fake SpawnFn (apply fixtures only), and a fixed clock/idSource so durations and run-ids are stable.
// It runs generateUnitTests / investigateBug UNCHANGED, persists a redacted EvidenceManifest through
// the #10 store, scores every dimension, aggregates the suite, and cleans up the temp dir. No
// network or live-model call is made in offline mode; no Date.now / Math.random touches a scored path.

import { createHash, randomUUID } from "node:crypto";
import { generateUnitTests } from "@oscharko-dev/keiko-workflows";
import { investigateBug } from "@oscharko-dev/keiko-workflows";
import {
  createNodeEvidenceStore,
  persistWorkflowEvidence,
  resolveEvidenceDir,
  type EvidenceStore,
  type WorkflowEventLike,
} from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { canonicalise, HARNESS_VERSION, type TaskType } from "@oscharko-dev/keiko-harness";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { createEvaluationModelProvider } from "./model-provider.js";
import { aggregateScorecard, scoreFixture, summarizeScorecard } from "./scorer.js";
import { checkSurfaceParity, type SurfaceParityDeps } from "./surface-parity.js";
import {
  buildBugInput,
  buildUnitTestInput,
  fakeSpawn,
  materializeFixture,
  recordingSink,
  recordingWriter,
  toScoringInput,
  type RecordingSink,
  type RecordingWriter,
} from "./runner-support.js";
import { isManifestValid } from "./manifest-check.js";
import { ALL_FIXTURES } from "./fixtures/index.js";
import {
  EVAL_SCORECARD_SCHEMA_VERSION,
  type EvalScorecard,
  type EvaluationFixture,
  type EvaluationMode,
  type FixtureRunResult,
  type LiveRunContext,
} from "./types.js";

// Factory + store seams so the CLI tests can drive fail-closed live config and capture evidence
// writes without real config or disk. Defaults compose the real audit store + gateway provider.
export interface EvalRunnerDeps {
  readonly modelProviderFactory?:
    | ((fixture: EvaluationFixture, mode: EvaluationMode, modelId: string) => ModelPort)
    | undefined;
  readonly store?: EvidenceStore | undefined;
  readonly env?: EnvSource | undefined;
  // Fixed wall-clock used for evaluatedAt and as the workflow `now` source (deterministic durations).
  readonly now?: (() => number) | undefined;
  // Fixed run-id source so persisted evidence filenames are stable across runs.
  readonly idSource?: (() => string) | undefined;
  // Higher-layer adapters used by the surface-parity check. Injected by the CLI so the evaluations
  // package does not reach up into keiko-cli or keiko-server on its own.
  readonly surfaceParity?: SurfaceParityDeps | undefined;
}

export interface EvalRunOptions {
  readonly mode: EvaluationMode;
  readonly fixtures: readonly EvaluationFixture[];
  // Overrides the model ID for all fixtures (live mode only); falls back to the fixture's modelId.
  readonly modelIdOverride?: string | undefined;
  readonly configPath?: string | undefined;
}

const FIXED_EVAL_EPOCH_MS = 1_700_000_000_000;

function fixtureModelId(fixture: EvaluationFixture, override: string | undefined): string {
  if (override !== undefined) {
    return override;
  }
  const fromInput = fixture.workflowInput.modelId;
  return typeof fromInput === "string" ? fromInput : "eval-model";
}

function resolveModelPort(
  fixture: EvaluationFixture,
  options: EvalRunOptions,
  deps: EvalRunnerDeps,
  modelId: string,
): ModelPort {
  if (deps.modelProviderFactory !== undefined) {
    return deps.modelProviderFactory(fixture, options.mode, modelId);
  }
  return createEvaluationModelProvider({
    mode: options.mode,
    transcript: fixture.mockTranscript,
    modelId,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });
}

interface RunDeps {
  readonly model: ModelPort;
  readonly writer: RecordingWriter;
  readonly sink: RecordingSink;
  readonly spawn: SpawnFn | undefined;
  readonly now: () => number;
  readonly idSource: () => string;
}

const WORKFLOW_TASK_TYPES: Readonly<Record<EvaluationFixture["workflowKind"], TaskType>> = {
  "unit-tests": "generate-unit-tests",
  "bug-investigation": "investigate-bug",
};

async function runWorkflow(
  fixture: EvaluationFixture,
  workspaceRoot: string,
  modelId: string,
  deps: RunDeps,
): Promise<Record<string, unknown>> {
  const common = {
    model: deps.model,
    writer: deps.writer,
    sink: deps.sink,
    now: deps.now,
    idSource: deps.idSource,
    ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
  };
  if (fixture.workflowKind === "unit-tests") {
    const report = await generateUnitTests(
      buildUnitTestInput(fixture, workspaceRoot, modelId),
      common,
    );
    return report as unknown as Record<string, unknown>;
  }
  const report = await investigateBug(buildBugInput(fixture, workspaceRoot, modelId), common);
  return report as unknown as Record<string, unknown>;
}

function persistAndCheck(
  fixture: EvaluationFixture,
  report: Record<string, unknown>,
  store: EvidenceStore,
  env: EnvSource,
  runId: string,
  workspaceRoot: string,
  modelId: string,
  events: readonly WorkflowEventLike[],
  startedAt: number,
  finishedAt: number,
): { readonly manifestValid: boolean; readonly evidenceRef: string } {
  const status = typeof report.status === "string" ? report.status : "failed";
  const evidence = persistWorkflowEvidence(
    {
      runId,
      fingerprint: evalFingerprint(fixture, workspaceRoot, modelId),
      modelId: typeof report.modelId === "string" ? report.modelId : "eval-model",
      kind: fixture.workflowKind,
      status: status === "rejected" || status === "failed" ? "failed" : "completed",
      startedAt,
      finishedAt,
      workspaceRoot,
    },
    report,
    events,
    { store, env, costClassResolver: resolveCostClass },
  );
  const raw = store.get(runId);
  return {
    manifestValid: raw !== undefined && isManifestValid(raw),
    evidenceRef: evidence.evidenceLocation,
  };
}

function evalFingerprint(
  fixture: EvaluationFixture,
  workspaceRoot: string,
  modelId: string,
): string {
  const taskType = WORKFLOW_TASK_TYPES[fixture.workflowKind];
  const input =
    fixture.workflowKind === "unit-tests"
      ? buildUnitTestInput(fixture, workspaceRoot, modelId)
      : buildBugInput(fixture, workspaceRoot, modelId);
  const canonical = canonicalise({
    taskType,
    taskInput: { taskType, input },
    modelId,
    workingDirectory: workspaceRoot,
    dryRun: fixture.apply !== true,
    harnessVersion: HARNESS_VERSION,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function buildFixtureRunResult(
  fixture: EvaluationFixture,
  report: Record<string, unknown>,
  writer: RecordingWriter,
  manifestValid: boolean,
  mode: EvaluationMode,
): FixtureRunResult {
  const scoring = toScoringInput(report, writer.writeCount(), manifestValid, mode);
  return {
    fixtureName: fixture.name,
    workflowKind: fixture.workflowKind,
    durationMs: typeof report.durationMs === "number" ? report.durationMs : 0,
    dimensionResults: scoreFixture(fixture, scoring),
    report,
  };
}

async function runFixture(
  fixture: EvaluationFixture,
  options: EvalRunOptions,
  deps: EvalRunnerDeps,
  store: EvidenceStore,
): Promise<{ readonly result: FixtureRunResult; readonly evidenceRef: string }> {
  const modelId = fixtureModelId(fixture, options.modelIdOverride);
  const workspace = materializeFixture(fixture);
  const writer = recordingWriter();
  const sink = recordingSink();
  const now = deps.now ?? ((): number => FIXED_EVAL_EPOCH_MS);
  // Use the injectable idSource to generate the evidence runId. When no idSource is injected (real
  // CLI), randomUUID makes each run unique so repeat runs don't collide in the #10 O_EXCL store.
  // Tests inject a fixed idSource for deterministic evidence filenames.
  const idSource = deps.idSource ?? randomUUID;
  const runId = idSource();
  try {
    const startedAt = now();
    const report = await runWorkflow(fixture, workspace.root, modelId, {
      model: resolveModelPort(fixture, options, deps, modelId),
      writer,
      sink,
      spawn: fixture.apply === true ? fakeSpawn(0, "ok") : undefined,
      now,
      idSource,
    });
    const finishedAt = now();
    const { manifestValid, evidenceRef } = persistAndCheck(
      fixture,
      report,
      store,
      deps.env ?? {},
      runId,
      workspace.root,
      modelId,
      sink.events(),
      startedAt,
      finishedAt,
    );
    return {
      result: buildFixtureRunResult(fixture, report, writer, manifestValid, options.mode),
      evidenceRef,
    };
  } finally {
    workspace.cleanup();
  }
}

function emptyEvidenceStore(deps: EvalRunnerDeps): EvidenceStore {
  return deps.store ?? createNodeEvidenceStore(resolveEvidenceDir(undefined, deps.env));
}

function liveContext(
  options: EvalRunOptions,
  evidenceRefs: readonly string[],
): LiveRunContext | undefined {
  if (options.mode !== "live") {
    return undefined;
  }
  const modelId = options.modelIdOverride ?? options.fixtures[0]?.workflowInput.modelId;
  return {
    modelId: typeof modelId === "string" ? modelId : "live-model",
    // No secrets: identifies the run by model only; apiKey/baseUrl are NEVER serialized here.
    configDescriptor: `live evaluation (${String(options.fixtures.length)} fixtures)`,
    evidenceRefs,
  };
}

function requireSurfaceParityDeps(deps: EvalRunnerDeps): SurfaceParityDeps {
  if (deps.surfaceParity === undefined) {
    throw new Error(
      "runEvaluationSuite requires injected surfaceParity adapters for CLI and BFF contract checks.",
    );
  }
  return deps.surfaceParity;
}

export async function runEvaluationSuite(
  options: EvalRunOptions,
  deps: EvalRunnerDeps = {},
): Promise<EvalScorecard> {
  const store = emptyEvidenceStore(deps);
  const evaluatedAt = new Date(deps.now?.() ?? FIXED_EVAL_EPOCH_MS).toISOString();
  const fixtureResults: FixtureRunResult[] = [];
  const evidenceRefs: string[] = [];
  for (const fixture of options.fixtures) {
    const fixtureRun = await runFixture(fixture, options, deps, store);
    fixtureResults.push(fixtureRun.result);
    evidenceRefs.push(fixtureRun.evidenceRef);
  }
  const dimensions = aggregateScorecard(fixtureResults);
  const surfaceParity = await checkSurfaceParity(requireSurfaceParityDeps(deps));
  const live = liveContext(options, evidenceRefs);
  return {
    schemaVersion: EVAL_SCORECARD_SCHEMA_VERSION,
    evaluatedAt,
    mode: options.mode,
    ...(live === undefined ? {} : { liveRunContext: live }),
    dimensions,
    surfaceParity,
    fixtureResults,
    summary: summarizeScorecard(fixtureResults, dimensions, surfaceParity, options.mode),
  };
}

export { ALL_FIXTURES };
