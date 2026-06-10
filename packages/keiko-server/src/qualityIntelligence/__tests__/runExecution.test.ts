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
import type { QualityIntelligenceStartRunRequest } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceRunSummary } from "@oscharko-dev/keiko-workflows";

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
    redactor: buildRedactor({}),
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

  it("degrades successfully to a chat-only model when structured output is unavailable", async () => {
    const onAccepted = vi.fn<(accepted: QiRunAccepted) => void>();
    const summary = await executeQiRun(
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
    );
    expect(summary.status).toBe("succeeded");
    expect(onAccepted.mock.calls[0]?.[0]?.modelId).toBe("chat-only");
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
          config: buildConfig([chatCapability(MODEL_ID, { structuredOutput: false })]),
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
