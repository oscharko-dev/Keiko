// Integration tests for executeQiRun (Epic #270, Issue #273/#278/#279/#280).
//
// Uses a temp evidenceDir (real filesystem), a fake ModelPort that returns canned JSON,
// and identity redaction. Tests the happy-path contracts + all coded error cases.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  createNodeFigmaSnapshotStore,
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { executeQiRun, QiGenerationError, QiIngestionError } from "../runExecution.js";
import { QiJudgeError } from "../judgePort.js";
import type { CapsuleResolver } from "../capsuleAdapter.js";
import type { ExecuteQiRunInput, QiRunAccepted } from "../runExecution.js";
import type {
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceUiRunDetail,
} from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceRunSummary } from "@oscharko-dev/keiko-workflows";
import type { RouteContext } from "../../routes.js";
import { handleGetQiRun } from "../uiRoutes.js";
import { hashSnapshot } from "../figma/figmaSnapshotHash.js";

// ─── capsuleAdapter mock (item: close-handle leak) ───────────────────────────
// makeCapsuleResolver is mocked so tests can inject a fake resolver with a
// tracked close() spy without needing a real SQLite path. By default the mock
// returns undefined (matching real behaviour when uiDbPath is absent), so all
// other tests in this file are unaffected. vitest hoists vi.mock() calls before
// any imports regardless of source position, so placing them after imports here
// is safe and keeps import-order lint clean.
const mockMakeCapsuleResolver = vi.hoisted(() =>
  vi.fn<() => CapsuleResolver | undefined>(() => undefined),
);
vi.mock("../capsuleAdapter.js", async () => {
  const actual =
    await vi.importActual<typeof import("../capsuleAdapter.js")>("../capsuleAdapter.js");
  return { ...actual, makeCapsuleResolver: mockMakeCapsuleResolver };
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

/** A canned response that the model-routed workflow can parse as zero candidates (empty array). */
const EMPTY_CANDIDATES_JSON = JSON.stringify({ testCases: [] });
const COVERING_TWO_REQUIREMENTS_JSON = JSON.stringify({
  testCases: [
    {
      title: "Verify MFA is required before audit login access",
      preconditions: ["An audit user is registered."],
      steps: ["Attempt audit login without MFA."],
      expectedResults: ["Access is not granted before MFA verification."],
      priority: "P1",
      riskClass: "compliance",
      derivedFromEvidenceIndexes: [1],
      tags: ["audit-login"],
    },
    {
      title: "Verify transfer confirmation is shown before submission",
      preconditions: ["An audit transfer is ready for review."],
      steps: ["Attempt to submit the transfer."],
      expectedResults: ["A confirmation screen appears before funds are submitted."],
      priority: "P1",
      riskClass: "regression",
      derivedFromEvidenceIndexes: [2],
      tags: ["audit-transfer"],
    },
  ],
});

function usageMeta(promptTokens: number, completionTokens: number): NormalizedResponse["usage"] {
  return {
    requestId: "req-test",
    promptTokens,
    completionTokens,
    latencyMs: 1,
    costClass: "medium",
  };
}

/** Build a fake ModelPort that returns canned JSON content. */
function fakeChatPort(content: string): ModelPort {
  return {
    call: (_req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
      Promise.resolve({
        content,
        modelId: _req.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(100, 50),
      }),
  };
}

/** Build a fake ModelPort that returns unparseable text. */
function fakeUnparseablePort(): ModelPort {
  return {
    call: (_req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
      Promise.resolve({
        content: "NOT VALID JSON AT ALL @@##",
        modelId: _req.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(10, 5),
      }),
  };
}

function chatCapability(
  modelId: string,
  overrides: Partial<ModelCapability> = {},
): ModelCapability {
  return {
    id: modelId,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsResponseFormat: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

const MODEL_ID = "test-chat-model";

function buildConfig(
  modelIdOrCapabilities: string | readonly ModelCapability[] = MODEL_ID,
): ReturnType<typeof parseGatewayConfig> {
  const capabilities =
    typeof modelIdOrCapabilities === "string"
      ? [chatCapability(modelIdOrCapabilities)]
      : modelIdOrCapabilities;
  return parseGatewayConfig(
    {
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://fake.example.com/v1",
        apiKey: "fake-key",
        capability,
      })),
    },
    {},
  );
}

function buildConfigWithApiKey(
  capabilities: readonly ModelCapability[],
  apiKey: string,
): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(
    {
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://fake.example.com/v1",
        apiKey,
        capability,
      })),
    },
    {},
  );
}

function buildDeps(options: {
  evidenceDir: string;
  modelPort?: ModelPort;
  config?: ReturnType<typeof parseGatewayConfig> | undefined;
}): UiHandlerDeps {
  const config = options.config ?? buildConfig(MODEL_ID);
  const port = options.modelPort ?? fakeChatPort(EMPTY_CANDIDATES_JSON);
  return {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: (_modelId: string): ModelPort => port,
    store: createInMemoryUiStore(),
    evidenceDir: options.evidenceDir,
  };
}

const VALID_SOURCE = {
  kind: "requirements" as const,
  label: "Requirements",
  text: [
    "The system shall allow users to authenticate using email and password.",
    "The system shall display a validation error for malformed email addresses.",
    "The system shall lock the account after five consecutive failed login attempts.",
  ].join("\n"),
};

function makeRequest(
  overrides: Partial<QualityIntelligenceStartRunRequest> = {},
): QualityIntelligenceStartRunRequest {
  return {
    sources: [VALID_SOURCE],
    modelId: MODEL_ID,
    ...overrides,
  };
}

/**
 * A start-run request with NO explicit `modelId`, to exercise the model-resolution fallback
 * (`resolveQiTestDesignSelection`): with a configured provider it resolves by capability; with no
 * configured provider it falls back to the deterministic no-model baseline.
 */
function requestWithoutModel(): QualityIntelligenceStartRunRequest {
  return { sources: [VALID_SOURCE] };
}

function determinismAuditRequest(): QualityIntelligenceStartRunRequest {
  return {
    profileId: "regression-default",
    seed: 761,
    sources: [
      {
        kind: "requirements",
        label: "Determinism audit source",
        text: [
          "REQ-DETERMINISM-001: A payment approval screen must require a second approver for transfers above 10000 EUR.",
          "REQ-DETERMINISM-002: The approval screen must reject submission when the second approver is the same user as the requester.",
        ].join("\n"),
      },
    ],
  };
}

function nondeterministicPort(callCounter: { count: number }): ModelPort {
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> => {
      callCounter.count += 1;
      return Promise.resolve({
        content: JSON.stringify([
          {
            title: `Nondeterministic model output ${String(callCounter.count)}`,
            steps: ["Model-only step"],
            expectedResults: ["Model-only result"],
            derivedFromEvidenceIndexes: [1],
          },
        ]),
        modelId: request.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(100, 50),
      });
    },
  };
}

function sequencePort(contents: readonly string[]): ModelPort {
  let index = 0;
  return {
    call: (request: GatewayRequest): Promise<NormalizedResponse> => {
      const content = contents[Math.min(index, contents.length - 1)] ?? EMPTY_CANDIDATES_JSON;
      index += 1;
      return Promise.resolve({
        content,
        modelId: request.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(100, 50),
      });
    },
  };
}

function recordingSequencePort(contents: readonly string[]): {
  readonly port: ModelPort;
  readonly calls: GatewayRequest[];
} {
  let index = 0;
  const calls: GatewayRequest[] = [];
  const port: ModelPort = {
    call: (request: GatewayRequest): Promise<NormalizedResponse> => {
      calls.push(request);
      const content = contents[Math.min(index, contents.length - 1)] ?? EMPTY_CANDIDATES_JSON;
      index += 1;
      return Promise.resolve({
        content,
        modelId: request.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: usageMeta(100, 50),
      });
    },
  };
  return { port, calls };
}

function weakJudgeVerdictWithRationale(rationale: string): string {
  return JSON.stringify({
    dimensions: [
      { name: "verifiability", score: 10, rationale },
      { name: "atomicity", score: 20, rationale: "too broad" },
      { name: "determinism", score: 15, rationale: "timing-sensitive" },
      { name: "ac-fidelity", score: 10, rationale: "misses the acceptance criteria" },
    ],
    overallRationale: rationale,
  });
}

function strongJudgeVerdictWithRationale(rationale: string): string {
  return JSON.stringify({
    dimensions: [
      { name: "verifiability", score: 90, rationale },
      { name: "atomicity", score: 88, rationale: "single focused behavior" },
      { name: "determinism", score: 92, rationale: "deterministic observation" },
      { name: "ac-fidelity", score: 90, rationale: "matches the requirement" },
    ],
    overallRationale: rationale,
  });
}

function candidateProjection(
  runId: string,
  evidenceDir: string,
): {
  readonly count: number;
  readonly ids: readonly string[];
  readonly titles: readonly string[];
  readonly steps: readonly (readonly string[])[];
  readonly expectedResults: readonly (readonly string[])[];
} {
  const artifact = loadQualityIntelligenceCandidates(runId, { evidenceDir });
  const candidates = artifact?.candidates ?? [];
  return {
    count: candidates.length,
    ids: candidates.map((candidate) => candidate.id),
    titles: candidates.map((candidate) => candidate.title),
    steps: candidates.map((candidate) => candidate.steps),
    expectedResults: candidates.map((candidate) => candidate.expectedResults),
  };
}

function recordVisionSnapshot(dir: string): void {
  createNodeFigmaSnapshotStore(dir).record({
    runId: "snap-vision-1",
    provenance: {
      fileKey: "KEY",
      nodeId: "0:1",
      version: undefined,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
    integrityHash: hashSnapshot(1, undefined, [{ screenId: "s1", integrityHash: "h-vision" }]),
    screens: [
      {
        screenId: "s1",
        irJson: {
          id: "s1",
          name: "Visual login",
          root: {
            id: "s1-root",
            name: "Hero image",
            type: "FRAME",
            interactionHint: "container",
            text: "",
            imageFills: [{ imageRef: "img-1" }],
            children: [],
          },
        },
        integrityHash: "h-vision",
        image: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50]) },
      },
    ],
    skippedScreens: [],
    links: [],
    tokens: { colors: [], typography: [], spacing: [], radius: [] },
  });
}

function runDetailCtx(runId: string): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: { id: runId },
    url: new URL(`http://127.0.0.1/api/quality-intelligence/runs/${runId}`),
  };
}

function testQualityFindingsFrom(
  manifest: ReturnType<typeof loadQualityIntelligenceRun>,
): NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>["findings"] {
  return (manifest?.findings ?? []).filter((finding) => finding.kind === "test-quality");
}

function expectRedactedText(text: string | undefined, secret: string): void {
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain(secret);
}

function expectIssue749RunDetail(
  detail: QualityIntelligenceUiRunDetail,
  providerSecret: string,
): void {
  expect(detail.qualityScore).toBe(50);
  const flagged = detail.candidates.filter((candidate) => candidate.weakTestFlag !== undefined);
  expect(flagged).toHaveLength(1);
  expect(flagged[0]?.title).toBe("Verify transfer confirmation is shown before submission");
  expectRedactedText(flagged[0]?.weakTestFlag?.rationale, providerSecret);
  const unflagged = detail.candidates.find(
    (candidate) => candidate.title === "Verify MFA is required before audit login access",
  );
  expect(unflagged?.weakTestFlag).toBeUndefined();
}

function expectSeededBaselineManifest(runId: string, evidenceDir: string): void {
  const manifest = loadQualityIntelligenceRun(runId, { evidenceDir });
  expect(manifest).toBeDefined();
  expect(manifest?.modelId).toBeUndefined();
  expect(manifest?.seedUsed).toBeUndefined();
}

function makeInput(
  evidenceDir: string,
  overrides: Partial<ExecuteQiRunInput> = {},
): ExecuteQiRunInput {
  const deps = buildDeps({ evidenceDir });
  const controller = new AbortController();
  return {
    request: makeRequest(),
    runId: "run-exec-001",
    deps,
    registeredAt: "2026-06-01T10:00:00.000Z",
    signal: controller.signal,
    onEvent: vi.fn(),
    onAccepted: vi.fn(),
    ...overrides,
  };
}

async function runQi(input: ExecuteQiRunInput): Promise<QualityIntelligenceRunSummary> {
  return executeQiRun(input);
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-run-exec-"));
});

afterEach(() => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("executeQiRun — happy path", () => {
  it("onAccepted fires once with the correct sourceCount", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(makeInput(evidenceDir, { onAccepted }));
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted.mock.calls[0]?.[0]?.sourceCount).toBe(1);
  });

  it("onAccepted fires with atomCount > 0 for valid text", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(makeInput(evidenceDir, { onAccepted }));
    expect(onAccepted.mock.calls[0]?.[0]?.atomCount).toBeGreaterThan(0);
  });

  it("onAccepted fires with the resolved modelId", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(makeInput(evidenceDir, { onAccepted }));
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe(MODEL_ID);
  });

  it("persists a manifest in the evidenceDir qi/ subdirectory", async () => {
    const summary = await runQi(makeInput(evidenceDir));
    // A terminal run persists its manifest; it must be loadable from the evidence dir afterwards.
    const loaded = loadQualityIntelligenceRun("run-exec-001", { evidenceDir });
    expect(loaded).toBeDefined();
    expect(summary.runId).toBe("run-exec-001");
  });

  it("returns a run summary with a runId field", async () => {
    const summary = await runQi(makeInput(evidenceDir));
    expect(typeof summary.runId).toBe("string");
    expect((summary.runId as string).length).toBeGreaterThan(0);
  });

  it("persists one coverage row per requirement atom from a multi-requirement local file", async () => {
    const sourceDir = join(evidenceDir, "source");
    mkdirSync(sourceDir);
    writeFileSync(
      join(sourceDir, "requirements.md"),
      [
        "REQ-DRIFT-001: The audit login flow must require multi-factor verification before account access is granted.",
        "REQ-DRIFT-002: The audit transfer flow must show a confirmation screen before funds are submitted.",
      ].join("\n"),
      "utf8",
    );
    await runQi(
      makeInput(evidenceDir, {
        request: makeRequest({
          sources: [{ kind: "workspace", label: "Drift fixture", path: sourceDir }],
          modelId: MODEL_ID,
        }),
        deps: buildDeps({
          evidenceDir,
          modelPort: fakeChatPort(COVERING_TWO_REQUIREMENTS_JSON),
        }),
      }),
    );

    const manifest = loadQualityIntelligenceRun("run-exec-001", { evidenceDir });
    const matrix = manifest?.coverageMatrix ?? [];
    expect(matrix).toHaveLength(2);
    expect(matrix.map((row) => row.status)).toEqual(["covered", "covered"]);
    expect(matrix.map((row) => row.requirementExcerptRedacted ?? "")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("REQ-DRIFT-001"),
        expect.stringContaining("REQ-DRIFT-002"),
      ]),
    );
  });
});

// ─── Model selection: resolveQiTestDesignSelection ──────────────────────────

describe("executeQiRun — model selection", () => {
  it("uses the explicitly requested model when modelId is provided", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(
      makeInput(evidenceDir, { onAccepted, request: makeRequest({ modelId: MODEL_ID }) }),
    );
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe(MODEL_ID);
  });

  it("does not claim a passed preflight when no precomputed model routing is supplied", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(
      makeInput(evidenceDir, { onAccepted, request: makeRequest({ modelId: MODEL_ID }) }),
    );
    const modelRouting = onAccepted.mock.calls[0]?.[0]?.modelRouting;
    expect(modelRouting?.preflight.status).toBe("not-run");
    expect(modelRouting?.preflight.generation).toMatchObject({
      stage: "generate",
      modelId: MODEL_ID,
      status: "not-run",
    });
    expect(modelRouting?.preflight.judge).toMatchObject({
      stage: "judge",
      modelId: MODEL_ID,
      status: "not-run",
    });
  });

  it("prefers a structured-output chat model when modelId is omitted", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const input = makeInput(evidenceDir, {
      onAccepted,
      request: requestWithoutModel(),
      deps: buildDeps({
        evidenceDir,
        config: buildConfig([
          chatCapability("cheap-chat-only", { structuredOutput: false, costClass: "low" }),
          chatCapability("preferred-structured", { structuredOutput: true, costClass: "medium" }),
        ]),
      }),
    });
    await executeQiRun(input);
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe("preferred-structured");
  });

  it("accepts an automatic chat-only model run and skips an unavailable judge", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const { port, calls } = recordingSequencePort([COVERING_TWO_REQUIREMENTS_JSON]);
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-chat-only-no-judge",
        onAccepted,
        request: requestWithoutModel(),
        deps: buildDeps({
          evidenceDir,
          modelPort: port,
          config: buildConfig([
            chatCapability("chat-only", {
              structuredOutput: false,
              supportsResponseFormat: false,
              costClass: "low",
            }),
          ]),
        }),
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBeNull();
    expect(summary.modelGatewayCallCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("chat-only");
    expect(calls[0]?.responseFormat).toBeUndefined();
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.topP).toBe(1);
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe("chat-only");
    const manifest = loadQualityIntelligenceRun("run-chat-only-no-judge", { evidenceDir });
    expect(manifest?.qualityScore).toBeNull();
    expect(manifest?.modelParameters).toEqual({
      temperature: 0,
      topP: 1,
      responseFormatEnforced: false,
    });
    expect(testQualityFindingsFrom(manifest)).toHaveLength(0);
  });

  it("can use an explicit chat-only generation model with a separate judge-capable model", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        onAccepted,
        request: makeRequest({ modelId: "chat-only" }),
        deps: buildDeps({
          evidenceDir,
          config: buildConfig([
            chatCapability("chat-only", { structuredOutput: false, costClass: "low" }),
            chatCapability("judge-structured", { structuredOutput: true, costClass: "medium" }),
          ]),
        }),
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe("chat-only");
  });

  it("redacts configured provider secrets from persisted judge rationales", async () => {
    const providerSecret = "literal-provider-secret-qi-judge-747";
    const judgeVerdict = weakJudgeVerdictWithRationale(
      `The candidate is unverifiable and echoed ${providerSecret}.`,
    );
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        deps: buildDeps({
          evidenceDir,
          config: buildConfigWithApiKey([chatCapability(MODEL_ID)], providerSecret),
          modelPort: sequencePort([COVERING_TWO_REQUIREMENTS_JSON, judgeVerdict, judgeVerdict]),
        }),
      }),
    );
    expect(summary.status).toBe("succeeded");
    const manifest = loadQualityIntelligenceRun("run-exec-001", { evidenceDir });
    const testQualityFindings = testQualityFindingsFrom(manifest);
    expect(testQualityFindings).toHaveLength(2);
    const persisted = JSON.stringify(testQualityFindings);
    expect(persisted).not.toContain(providerSecret);
    expect(persisted).toContain("[REDACTED]");
  });

  // eslint-disable-next-line complexity
  it("proves Issue #749 end to end: weak judge rationale lowers quality score and reaches run detail redacted", async () => {
    const providerSecret = "literal-provider-secret-qi-judge-749";
    const weakRationale = `The candidate is unverifiable, misses the acceptance criteria, and echoed ${providerSecret}.`;
    const { port, calls } = recordingSequencePort([
      COVERING_TWO_REQUIREMENTS_JSON,
      strongJudgeVerdictWithRationale("The candidate has a deterministic observable assertion."),
      weakJudgeVerdictWithRationale(weakRationale),
    ]);
    const deps = buildDeps({
      evidenceDir,
      config: buildConfigWithApiKey([chatCapability(MODEL_ID)], providerSecret),
      modelPort: port,
    });

    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-749-live-proof",
        deps,
      }),
    );

    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(50);
    expect(summary.modelGatewayCallCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.topP).toBe(1);
    expect(calls[1]?.temperature).toBe(0);
    expect(calls[1]?.topP).toBeUndefined();

    const manifest = loadQualityIntelligenceRun("run-749-live-proof", { evidenceDir });
    expect(manifest?.qualityScore).toBe(50);
    expect(manifest?.modelGatewayCallCount).toBe(3);
    expect(manifest?.modelParameters?.temperature).toBe(0);
    expect(manifest?.modelParameters?.topP).toBe(1);
    expect(manifest?.modelParameters?.judgeTemperature).toBe(0);
    expect(manifest?.modelParameters?.judgeSeedUsed).toBe(false);
    const testQualityFindings = testQualityFindingsFrom(manifest);
    expect(testQualityFindings).toHaveLength(1);
    expectRedactedText(testQualityFindings[0]?.summaryRedacted, providerSecret);

    const result = handleGetQiRun(runDetailCtx("run-749-live-proof"), deps);
    expect(result.status).toBe(200);
    const detail = result.body as QualityIntelligenceUiRunDetail;
    expectIssue749RunDetail(detail, providerSecret);
  });

  // eslint-disable-next-line complexity
  it("uses the run seed for a seed-capable judge and records it in modelParameters", async () => {
    const { port, calls } = recordingSequencePort([
      COVERING_TWO_REQUIREMENTS_JSON,
      strongJudgeVerdictWithRationale("The candidate is deterministic."),
      strongJudgeVerdictWithRationale("The candidate remains deterministic."),
    ]);
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-seeded-judge",
        request: makeRequest({ seed: 31 }),
        deps: buildDeps({
          evidenceDir,
          config: buildConfig([chatCapability(MODEL_ID, { supportsSeeding: true })]),
          modelPort: port,
        }),
      }),
    );

    expect(summary.status).toBe("succeeded");
    expect(calls.map((call) => call.seed)).toEqual([31, 31, 31]);
    expect(calls[1]?.temperature).toBe(0);
    expect(calls[2]?.temperature).toBe(0);
    const manifest = loadQualityIntelligenceRun("run-seeded-judge", { evidenceDir });
    expect(manifest?.seedUsed).toBe(31);
    expect(manifest?.modelParameters?.seed).toBe(31);
    expect(manifest?.modelParameters?.temperature).toBe(0);
    expect(manifest?.modelParameters?.topP).toBe(1);
    expect(manifest?.modelParameters?.judgeTemperature).toBe(0);
    expect(manifest?.modelParameters?.judgeSeedUsed).toBe(true);
    expect(manifest?.modelParameters?.judgeSeed).toBe(31);
  });

  it("bounds oversized model candidates before judging and counts the bounded judge dispatch", async () => {
    const judgeRationale = "bounded candidate remains too broad after parser truncation";
    const oversizedCandidateOutput = JSON.stringify({
      testCases: [
        {
          title: "Exercise an intentionally oversized candidate",
          preconditions: ["A generated test contains an oversized body."],
          steps: ["x".repeat(512_000)],
          expectedResults: ["The judge should classify the local guard outcome as weak."],
          priority: "P1",
          riskClass: "compliance",
          derivedFromEvidenceIndexes: [1],
          tags: ["oversize-judge"],
        },
      ],
    });
    const { port, calls } = recordingSequencePort([
      oversizedCandidateOutput,
      weakJudgeVerdictWithRationale(judgeRationale),
    ]);
    const deps = buildDeps({
      evidenceDir,
      modelPort: port,
      config: buildConfig([
        chatCapability("loose-generation", { supportsResponseFormat: false }),
        chatCapability("judge-json", { supportsResponseFormat: true }),
      ]),
    });

    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-749-oversize-guard",
        request: makeRequest({ modelId: "loose-generation" }),
        deps,
      }),
    );

    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(0);
    // The parser bounds the oversized generated step before persistence/judging, so the judge prompt
    // now stays under the local prompt guard and the bounded judge dispatch is counted.
    expect(summary.modelGatewayCallCount).toBe(2);
    expect(calls).toHaveLength(2);
    const projection = candidateProjection("run-749-oversize-guard", evidenceDir);
    const generatedStep = projection.steps.flat().find((step) => step.startsWith("xxx"));
    expect(generatedStep).toBeDefined();
    expect(generatedStep?.length).toBeLessThanOrEqual(1000);
    const manifest = loadQualityIntelligenceRun("run-749-oversize-guard", { evidenceDir });
    expect(manifest?.modelGatewayCallCount).toBe(2);
    const qualityFinding = testQualityFindingsFrom(manifest)[0];
    expect(qualityFinding?.summaryRedacted).toContain(judgeRationale);
  });

  it("counts capability-routed Figma vision calls in run evidence", async () => {
    recordVisionSnapshot(evidenceDir);
    const { port, calls } = recordingSequencePort([
      JSON.stringify(["The primary CTA appears visually disabled"]),
      COVERING_TWO_REQUIREMENTS_JSON,
    ]);
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-figma-vision-counted",
        request: makeRequest({
          modelId: "chat-only",
          sources: [
            { kind: "figma-snapshot", label: "Vision snapshot", snapshotRunId: "snap-vision-1" },
          ],
        }),
        deps: buildDeps({
          evidenceDir,
          modelPort: port,
          config: buildConfig([
            chatCapability("chat-only", { structuredOutput: false, costClass: "medium" }),
            chatCapability("vision-low", {
              structuredOutput: false,
              supportsImageInput: true,
              costClass: "low",
            }),
          ]),
        }),
      }),
    );

    expect(summary.status).toBe("succeeded");
    expect(calls.map((call) => call.modelId)).toEqual(["vision-low", "chat-only"]);
    expect(summary.modelGatewayCallCount).toBe(2);
    const manifest = loadQualityIntelligenceRun("run-figma-vision-counted", { evidenceDir });
    expect(manifest?.modelGatewayCallCount).toBe(2);
  });

  it("starts a deterministic baseline when no model is configured", async () => {
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (_id: string): undefined => undefined,
      store: createInMemoryUiStore(),
      evidenceDir,
    };
    const controller = new AbortController();
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const summary = await executeQiRun({
      request: requestWithoutModel(),
      runId: "run-no-model",
      deps,
      registeredAt: "2026-06-01T10:00:00.000Z",
      signal: controller.signal,
      onEvent: vi.fn(),
      onAccepted,
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBeNull();
    expect(summary.modelGatewayCallCount).toBe(0);
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBeUndefined();
    const manifest = loadQualityIntelligenceRun("run-no-model", { evidenceDir });
    expect(manifest?.modelId).toBeUndefined();
    expect(manifest?.seedUsed).toBeUndefined();
    expect(manifest?.modelParameters).toBeUndefined();
  });
});

describe("executeQiRun — seed persistence", () => {
  it("routes seeded requests to the deterministic baseline when the selected model cannot apply seeds", async () => {
    const callCounter = { count: 0 };
    const request = determinismAuditRequest();
    const deps = buildDeps({ evidenceDir, modelPort: nondeterministicPort(callCounter) });

    const first = await executeQiRun(
      makeInput(evidenceDir, {
        request,
        runId: "run-seeded-baseline-a",
        deps,
      }),
    );
    const second = await executeQiRun(
      makeInput(evidenceDir, {
        request,
        runId: "run-seeded-baseline-b",
        deps,
      }),
    );

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(callCounter.count).toBe(0);
    expect(first.modelGatewayCallCount).toBe(0);
    expect(second.modelGatewayCallCount).toBe(0);
    expect(first.qualityScore).toBeNull();
    expect(second.qualityScore).toBeNull();
    expectSeededBaselineManifest("run-seeded-baseline-a", evidenceDir);
    expectSeededBaselineManifest("run-seeded-baseline-b", evidenceDir);

    const firstManifest = loadQualityIntelligenceRun("run-seeded-baseline-a", { evidenceDir });
    const secondManifest = loadQualityIntelligenceRun("run-seeded-baseline-b", { evidenceDir });
    expect(firstManifest?.totals).toEqual(secondManifest?.totals);

    const firstProjection = candidateProjection("run-seeded-baseline-a", evidenceDir);
    const secondProjection = candidateProjection("run-seeded-baseline-b", evidenceDir);
    expect(firstProjection.count).toBeGreaterThan(0);
    expect(firstProjection.titles).toEqual(secondProjection.titles);
    expect(firstProjection.steps).toEqual(secondProjection.steps);
    expect(firstProjection.expectedResults).toEqual(secondProjection.expectedResults);
  });

  // Exercises the LEFT disjunct of the seed guard (selection.kind === "baseline") in
  // resolveExecutionStrategy: a seeded request with no model id AND no configured provider resolves to
  // the deterministic baseline. The other seed-baseline test reaches the guard via the RIGHT disjunct
  // (a configured model that cannot seed), so without this case the baseline disjunct is mutation-blind.
  it("routes a seeded request to the deterministic baseline when no model is configured", async () => {
    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (_id: string): undefined => undefined,
      store: createInMemoryUiStore(),
      evidenceDir,
    };
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        request: determinismAuditRequest(),
        runId: "run-seeded-no-config",
        deps,
        onAccepted,
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(summary.modelGatewayCallCount).toBe(0);
    expect(summary.qualityScore).toBeNull();
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBeUndefined();
    expectSeededBaselineManifest("run-seeded-no-config", evidenceDir);
  });

  it("reproduces seeded output when the selected model advertises seeding support", async () => {
    const seenSeeds: (number | undefined)[] = [];
    const port: ModelPort = {
      call: (request: GatewayRequest): Promise<NormalizedResponse> => {
        seenSeeds.push(request.seed);
        return Promise.resolve({
          content: COVERING_TWO_REQUIREMENTS_JSON,
          modelId: request.modelId,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: usageMeta(100, 50),
        });
      },
    };
    const deps = buildDeps({
      evidenceDir,
      modelPort: port,
      config: buildConfig([
        chatCapability("seeded-chat-only", {
          structuredOutput: false,
          supportsSeeding: true,
        }),
      ]),
    });
    const request = { ...determinismAuditRequest(), seed: 23 };
    const first = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-seeded-supported-a",
        request,
        deps,
      }),
    );
    const second = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-seeded-supported-b",
        request,
        deps,
      }),
    );

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(seenSeeds).toEqual([23, 23]);
    expect(first.modelGatewayCallCount).toBe(1);
    expect(second.modelGatewayCallCount).toBe(1);

    const firstProjection = candidateProjection("run-seeded-supported-a", evidenceDir);
    const secondProjection = candidateProjection("run-seeded-supported-b", evidenceDir);
    expect(firstProjection.count).toBeGreaterThan(0);
    expect(firstProjection).toEqual(secondProjection);

    const firstManifest = loadQualityIntelligenceRun("run-seeded-supported-a", { evidenceDir });
    const secondManifest = loadQualityIntelligenceRun("run-seeded-supported-b", { evidenceDir });
    expect(firstManifest?.modelId).toBe("seeded-chat-only");
    expect(secondManifest?.modelId).toBe("seeded-chat-only");
    expect(firstManifest?.seedUsed).toBe(23);
    expect(secondManifest?.seedUsed).toBe(23);
    expect(firstManifest?.modelParameters?.seed).toBe(23);
    expect(secondManifest?.modelParameters?.seed).toBe(23);
  });

  it("persists seedUsed=null when a model run did not apply the requested seed", async () => {
    let seenSeed: number | undefined;
    const port: ModelPort = {
      call: (request: GatewayRequest): Promise<NormalizedResponse> => {
        seenSeed = request.seed;
        return Promise.resolve({
          content: EMPTY_CANDIDATES_JSON,
          modelId: request.modelId,
          finishReason: "stop",
          toolCalls: [],
          structuredOutput: null,
          usage: usageMeta(100, 50),
        });
      },
    };
    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        request: makeRequest({ seed: 23 }),
        deps: buildDeps({
          evidenceDir,
          modelPort: port,
          config: buildConfig([
            chatCapability(MODEL_ID, { structuredOutput: false }),
            chatCapability("judge-structured", { structuredOutput: true }),
          ]),
        }),
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(seenSeed).toBeUndefined();
    const manifest = loadQualityIntelligenceRun("run-exec-001", { evidenceDir });
    expect(manifest?.seedUsed).toBeNull();
    expect(manifest?.modelParameters?.seed).toBeUndefined();
  });
});

// ─── Error: missing evidenceDir ───────────────────────────────────────────────

describe("executeQiRun — QI_NO_EVIDENCE_DIR", () => {
  it("throws QiGenerationError with code QI_NO_EVIDENCE_DIR when evidenceDir is undefined", async () => {
    const deps: UiHandlerDeps = {
      config: buildConfig(MODEL_ID),
      configPresent: true,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (_id: string): ModelPort => fakeChatPort(EMPTY_CANDIDATES_JSON),
      store: createInMemoryUiStore(),
      evidenceDir: undefined, // <— missing
    };
    const controller = new AbortController();
    try {
      await executeQiRun({
        request: makeRequest(),
        runId: "run-no-dir",
        deps,
        registeredAt: "2026-06-01T10:00:00.000Z",
        signal: controller.signal,
        onEvent: vi.fn(),
        onAccepted: vi.fn(),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiGenerationError);
      expect((err as QiGenerationError).code).toBe("QI_NO_EVIDENCE_DIR");
    }
  });
});

// ─── Error: ingestion failures propagate ────────────────────────────────────

describe("executeQiRun — ingestion error propagation", () => {
  it("throws QiIngestionError QI_NO_SOURCES when sources array is empty", async () => {
    const controller = new AbortController();
    try {
      await executeQiRun({
        request: { sources: [] },
        runId: "run-empty-src",
        deps: buildDeps({ evidenceDir }),
        registeredAt: "2026-06-01T10:00:00.000Z",
        signal: controller.signal,
        onEvent: vi.fn(),
        onAccepted: vi.fn(),
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QiIngestionError);
      expect((err as QiIngestionError).code).toBe("QI_NO_SOURCES");
    }
  });

  it("onAccepted does NOT fire when ingestion fails", async () => {
    const onAccepted = vi.fn();
    const controller = new AbortController();
    try {
      await executeQiRun({
        request: { sources: [] },
        runId: "run-empty-src-2",
        deps: buildDeps({ evidenceDir }),
        registeredAt: "2026-06-01T10:00:00.000Z",
        signal: controller.signal,
        onEvent: vi.fn(),
        onAccepted,
      });
    } catch {
      // expected
    }
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

// ─── Unparseable model output → degraded baseline status ─────────────────────

describe("executeQiRun — unparseable model output", () => {
  it("degrades to a succeeded baseline run with a visible reason when the model returns unparseable JSON", async () => {
    // QI-DEG-01: schema-invalid model output is recovered by falling back to the deterministic
    // baseline (the product contract: deliver baseline test cases rather than hard-failing), but
    // the degradation MUST stay visible — the run succeeds AND carries a bounded reasonSummary the
    // BFF surfaces on the terminal `done` frame as degraded.
    const deps = buildDeps({ evidenceDir, modelPort: fakeUnparseablePort() });
    const controller = new AbortController();
    const summary = await runQi({
      request: makeRequest(),
      runId: "run-bad-output",
      deps,
      registeredAt: "2026-06-01T10:00:00.000Z",
      signal: controller.signal,
      onEvent: vi.fn(),
      onAccepted: vi.fn(),
    });
    expect(summary.status).toBe("succeeded");
    expect(summary.reasonSummary).toBe("qi-error: QI_MODEL_SCHEMA_VIOLATION");
  });
});

// ─── Candidate artifact is persisted ────────────────────────────────────────

describe("executeQiRun — candidate artifact persistence", () => {
  it("persists a candidate artifact for a succeeded run (even with zero candidates)", async () => {
    const deps = buildDeps({ evidenceDir, modelPort: fakeChatPort(EMPTY_CANDIDATES_JSON) });
    const controller = new AbortController();
    const summary = await runQi({
      request: makeRequest(),
      runId: "run-candidates",
      deps,
      registeredAt: "2026-06-01T10:00:00.000Z",
      signal: controller.signal,
      onEvent: vi.fn(),
      onAccepted: vi.fn(),
    });
    expect(summary.status).toBe("succeeded");
    const artifact = loadQualityIntelligenceCandidates("run-candidates", { evidenceDir });
    // A candidates artifact must be present for a succeeded run.
    expect(artifact).toBeDefined();
  });
});

// ─── Coverage-notice propagation to the accepted frame (Epic #729) ───────────────

describe("executeQiRun — N+1 coverage propagation", () => {
  it("propagates droppedSourceCount to onAccepted when >16 sources are submitted", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const sources = Array.from({ length: 17 }, (_, i) => ({
      kind: "requirements" as const,
      label: `S${String(i)}`,
      text: `The system shall satisfy requirement ${String(i)} for coverage precisely.`,
    }));
    await executeQiRun(makeInput(evidenceDir, { onAccepted, request: makeRequest({ sources }) }));
    expect(onAccepted.mock.calls[0]?.[0]?.droppedSourceCount).toBe(1);
  });

  it("propagates skippedSources to onAccepted while the healthy source still runs", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(
      makeInput(evidenceDir, {
        onAccepted,
        request: makeRequest({
          sources: [VALID_SOURCE, { kind: "requirements", label: "Blank", text: "   \n\t " }],
        }),
      }),
    );
    const accepted = onAccepted.mock.calls[0]?.[0];
    expect(accepted?.sourceCount).toBe(1);
    expect(accepted?.skippedSources.map((s) => s.code)).toEqual(["QI_SOURCE_EMPTY"]);
    expect(accepted?.skippedSources.map((s) => s.label)).toEqual(["Blank"]);
  });

  it("reports zero dropped and no skipped sources on the happy path", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await executeQiRun(makeInput(evidenceDir, { onAccepted }));
    expect(onAccepted.mock.calls[0]?.[0]?.droppedSourceCount).toBe(0);
    expect(onAccepted.mock.calls[0]?.[0]?.skippedSources).toEqual([]);
  });
});

// ─── TEST 4 — GAP-T2: QiJudgeError → QiGenerationError conversion (~:217) ────
//
// buildJudgePortForModelRun (~:207) wraps createQiJudgePort in a try/catch.  When
// createQiJudgePort throws QiJudgeError (e.g. QI_JUDGE_MODEL_UNAVAILABLE because
// modelPortFactory returns undefined for the judge model), the catch block converts it
// to QiGenerationError with the SAME error code.  Without that conversion the raw
// QiJudgeError propagates out of executeQiRun and callers (route handlers) would see an
// untyped, uncoded error — breaking structured error handling.
//
// Setup: configure deps with a modelPortFactory that returns a real ModelPort for the
// GENERATION model (so ingestion + generation succeed), but returns undefined for the
// JUDGE model (so createQiJudgePort throws QI_JUDGE_MODEL_UNAVAILABLE).
// Because resolveModelForQiCapability for qi:judge-logic requires structuredOutput=true
// we give the generation model structuredOutput=false (chat-only) so the judge selection
// picks the SECOND model that has structuredOutput=true but gets undefined from the factory.
//
// RED-verify: mutate the catch block at :219 from
//   `throw new QiGenerationError(error.code, error.message)`
// to
//   `throw error`
// → executeQiRun rejects with QiJudgeError instead of QiGenerationError
// → `expect(err).toBeInstanceOf(QiGenerationError)` fails. Restore → green.
describe("executeQiRun — QiJudgeError from createQiJudgePort converts to QiGenerationError (GAP-T2)", () => {
  it("wraps QI_JUDGE_MODEL_UNAVAILABLE as QiGenerationError when modelPortFactory returns undefined for the judge model", async () => {
    // Generation model: chat-only (structuredOutput=false, workflowEligible=true).
    // Judge model:      structured-output capable (structuredOutput=true, workflowEligible=true).
    // modelPortFactory returns a real port ONLY for the generation model; returns undefined for
    // the judge model → createQiJudgePort throws QiJudgeError("QI_JUDGE_MODEL_UNAVAILABLE", …).
    const GEN_MODEL = "gen-chat-only-for-gap-t2";
    const JUDGE_MODEL = "judge-structured-for-gap-t2";

    const genCapability: ModelCapability = {
      id: GEN_MODEL,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: false,
      structuredOutput: false, // chat-only — eligible for generation but not judge
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass: "low",
      latencyClass: "standard",
      throughputHint: "test",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };
    const judgeCapability: ModelCapability = {
      id: JUDGE_MODEL,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true, // qi:judge-logic requires structured output
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      supportsResponseFormat: true,
      workflowEligible: true,
      costClass: "medium",
      latencyClass: "standard",
      throughputHint: "test",
      preferredUseCases: ["Chat"],
      knownLimitations: [],
    };

    const config = buildConfig([genCapability, judgeCapability]);
    // modelPortFactory: real port for GEN_MODEL, undefined for JUDGE_MODEL.
    const gapT2Deps: UiHandlerDeps = {
      config,
      configPresent: true,
      evidenceStore: emptyStore(),
      env: {},
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      modelPortFactory: (modelId: string): ModelPort | undefined => {
        if (modelId === GEN_MODEL) return fakeChatPort(EMPTY_CANDIDATES_JSON);
        return undefined; // judge model → QiJudgeError("QI_JUDGE_MODEL_UNAVAILABLE")
      },
      store: createInMemoryUiStore(),
      evidenceDir,
    };

    const controller = new AbortController();
    try {
      await executeQiRun({
        request: { sources: [VALID_SOURCE], modelId: GEN_MODEL },
        runId: "run-gap-t2-judge-unavail",
        deps: gapT2Deps,
        registeredAt: "2026-06-01T10:00:00.000Z",
        signal: controller.signal,
        onEvent: vi.fn(),
        onAccepted: vi.fn(),
      });
      expect.fail("expected executeQiRun to throw");
    } catch (err) {
      // Must be QiGenerationError (the converted type), NOT the raw QiJudgeError.
      expect(err).toBeInstanceOf(QiGenerationError);
      expect(err).not.toBeInstanceOf(QiJudgeError);
      expect((err as QiGenerationError).code).toBe("QI_JUDGE_MODEL_UNAVAILABLE");
    }
  });
});

// ─── CapsuleResolver.close() is called in executeQiRun's finally block ───────
//
// RED: before the finally block was added, close() was never called → the assertion
//   `expect(closeSpy).toHaveBeenCalledTimes(1)` fails (call count = 0).
// GREEN: the finally block calls `capsuleResolver?.close()` unconditionally after
//   the workflow completes → close() is called exactly once.
//
// The mock returns a fake resolver whose close() is a vi.fn() spy; the default
// mock returns undefined (matching real behaviour for deps without uiDbPath), so
// all other tests in this file are unaffected by the top-level vi.mock.
describe("executeQiRun — capsule resolver handle is closed in finally block", () => {
  afterEach(() => {
    mockMakeCapsuleResolver.mockReset();
    mockMakeCapsuleResolver.mockImplementation(() => undefined);
  });

  it("calls close() on the capsule resolver exactly once after a succeeded run", async () => {
    const closeSpy = vi.fn<() => void>();
    const fakeResolver: CapsuleResolver = {
      capsule: (): readonly never[] => [],
      capsuleSet: (): readonly never[] => [],
      close: closeSpy,
    };
    mockMakeCapsuleResolver.mockReturnValue(fakeResolver);

    await executeQiRun(makeInput(evidenceDir));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("calls close() on the capsule resolver exactly once even when the run fails", async () => {
    const closeSpy = vi.fn<() => void>();
    const fakeResolver: CapsuleResolver = {
      capsule: (): readonly never[] => [],
      capsuleSet: (): readonly never[] => [],
      close: closeSpy,
    };
    mockMakeCapsuleResolver.mockReturnValue(fakeResolver);

    // fakeUnparseablePort() degrades to a succeeded baseline run (not a throw), so the capsule
    // resolver must still be closed exactly once on the non-throwing terminal path.
    await executeQiRun(
      makeInput(evidenceDir, {
        deps: buildDeps({ evidenceDir, modelPort: fakeUnparseablePort() }),
      }),
    );

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
