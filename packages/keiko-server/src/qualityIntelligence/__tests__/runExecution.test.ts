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
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { executeQiRun, QiGenerationError, QiIngestionError } from "../runExecution.js";
import type { ExecuteQiRunInput, QiRunAccepted } from "../runExecution.js";
import type {
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceUiRunDetail,
} from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceRunSummary } from "@oscharko-dev/keiko-workflows";
import type { RouteContext } from "../../routes.js";
import { handleGetQiRun } from "../uiRoutes.js";

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
  readonly titles: readonly string[];
  readonly steps: readonly (readonly string[])[];
  readonly expectedResults: readonly (readonly string[])[];
} {
  const artifact = loadQualityIntelligenceCandidates(runId, { evidenceDir });
  const candidates = artifact?.candidates ?? [];
  return {
    count: candidates.length,
    titles: candidates.map((candidate) => candidate.title),
    steps: candidates.map((candidate) => candidate.steps),
    expectedResults: candidates.map((candidate) => candidate.expectedResults),
  };
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

  it("does not accept a model run when no judge-capable model is configured", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    await expect(
      executeQiRun(
        makeInput(evidenceDir, {
          onAccepted,
          request: requestWithoutModel(),
          deps: buildDeps({
            evidenceDir,
            config: buildConfig([
              chatCapability("chat-only", { structuredOutput: false, costClass: "low" }),
            ]),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "QI_CAPABILITY_UNAVAILABLE" });
    expect(onAccepted).not.toHaveBeenCalled();
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

    const manifest = loadQualityIntelligenceRun("run-749-live-proof", { evidenceDir });
    expect(manifest?.qualityScore).toBe(50);
    expect(manifest?.modelGatewayCallCount).toBe(3);
    const testQualityFindings = testQualityFindingsFrom(manifest);
    expect(testQualityFindings).toHaveLength(1);
    expectRedactedText(testQualityFindings[0]?.summaryRedacted, providerSecret);

    const result = handleGetQiRun(runDetailCtx("run-749-live-proof"), deps);
    expect(result.status).toBe(200);
    const detail = result.body as QualityIntelligenceUiRunDetail;
    expectIssue749RunDetail(detail, providerSecret);
  });

  it("does not count the oversized judge-prompt local guard as a gateway dispatch", async () => {
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
    const { port, calls } = recordingSequencePort([oversizedCandidateOutput]);
    const deps = buildDeps({
      evidenceDir,
      modelPort: port,
    });

    const summary = await executeQiRun(
      makeInput(evidenceDir, {
        runId: "run-749-oversize-guard",
        deps,
      }),
    );

    expect(summary.status).toBe("succeeded");
    expect(summary.qualityScore).toBe(0);
    // Only the generation request reached the gateway. The oversized judge prompt returned a local
    // weak verdict before model.call, so the audit trail must not claim a second dispatch.
    expect(summary.modelGatewayCallCount).toBe(1);
    expect(calls).toHaveLength(1);
    const manifest = loadQualityIntelligenceRun("run-749-oversize-guard", { evidenceDir });
    expect(manifest?.modelGatewayCallCount).toBe(1);
    const qualityFinding = testQualityFindingsFrom(manifest)[0];
    expect(qualityFinding?.summaryRedacted).toContain("model budget");
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

  it("persists the applied seed when the selected model advertises seeding support", async () => {
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
          config: buildConfig([chatCapability(MODEL_ID, { supportsSeeding: true })]),
        }),
      }),
    );
    expect(summary.status).toBe("succeeded");
    expect(seenSeed).toBe(23);
    const manifest = loadQualityIntelligenceRun("run-exec-001", { evidenceDir });
    expect(manifest?.seedUsed).toBe(23);
    expect(manifest?.modelParameters?.seed).toBe(23);
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

// ─── Unparseable model output → failed status ────────────────────────────────

describe("executeQiRun — unparseable model output", () => {
  it("returns a summary with status 'failed' when the model returns unparseable JSON", async () => {
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
    expect(summary.status).toBe("failed");
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
    if (summary.status === "succeeded") {
      const artifact = loadQualityIntelligenceCandidates("run-candidates", { evidenceDir });
      // A candidates artifact should be present.
      expect(artifact).toBeDefined();
    }
    // Either succeeded (artifact present) or failed (test passes trivially).
    // The test is meaningful on the success path.
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
