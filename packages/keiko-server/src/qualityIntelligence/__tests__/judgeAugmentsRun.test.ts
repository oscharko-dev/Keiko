// The judge-augments-never-fails contract at the server seam (0.3.0 release audit).
//
// modelRoutedTestDesign.ts documents the resilience contract for the adversarial test-quality
// judge: "the judge AUGMENTS generation and must never fail an otherwise successful run". The
// workflow honours it — `judge === undefined` simply yields an empty judge result and the run
// completes. The SERVER seam did not: a judge preflight failure threw QI_MODEL_PREFLIGHT_FAILED
// out of buildQiModelRoutingForRun (so POST /runs answered 400 and no run ever started), and a
// judge port that could not be constructed was rethrown as a QiGenerationError that terminated
// the run.
//
// These tests pin the contract at that seam: a judge-side failure DEGRADES the run's judgement —
// classified on `modelRouting.stageFailures` and on the judge preflight stage — and never destroys
// the run's result. A GENERATION failure stays fatal: a run that cannot generate has no result to
// preserve.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseGatewayConfig,
  type GatewayRequest,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type {
  EvidenceStore,
  QualityIntelligenceEvidenceManifest,
} from "@oscharko-dev/keiko-evidence";
import { loadQualityIntelligenceRun } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { buildQiModelRoutingForRun, QiModelPolicyError } from "../modelPolicyRoutes.js";
import { executeQiRun } from "../runExecution.js";

const emptyStore = (): EvidenceStore => ({
  put: () => "",
  list: () => [],
  get: () => undefined,
  delete: () => undefined,
});

function capability(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
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

function configWith(
  capabilities: readonly ModelCapability[],
): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(
    {
      providers: capabilities.map((model) => ({
        modelId: model.id,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret-key",
        capability: model,
      })),
      egress: { allowPrivateNetwork: true },
    },
    {},
  );
}

function depsWith(args: {
  readonly evidenceDir: string;
  readonly capabilities: readonly ModelCapability[];
  readonly modelPortFactory?: (modelId: string) => ModelPort | undefined;
}): UiHandlerDeps {
  const config = configWith(args.capabilities);
  return {
    config,
    configPresent: true,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    modelPortFactory: args.modelPortFactory ?? ((): undefined => undefined),
    store: createInMemoryUiStore(),
    evidenceDir: args.evidenceDir,
  };
}

let evidenceDir: string;

beforeEach(() => {
  evidenceDir = mkdtempSync(join(tmpdir(), "keiko-qi-judge-contract-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(evidenceDir, { recursive: true, force: true });
});

// A gateway that answers every request with the word "ok": the generation preflight only needs an
// answer, but the judge preflight parses the answer against the judge schema and therefore fails.
function stubPlainTextGateway(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ),
  );
}

describe("buildQiModelRoutingForRun — a judge preflight failure degrades, it does not block", () => {
  it("resolves routing instead of throwing when only the judge preflight fails", async () => {
    stubPlainTextGateway();
    const deps = depsWith({ evidenceDir, capabilities: [capability("dual-model")] });

    const routing = await buildQiModelRoutingForRun(deps, {
      modelPolicy: {
        policyVersion: 1,
        testDesignModelId: "dual-model",
        judgeModelId: "dual-model",
      },
    });

    expect(routing.preflight.generation?.status).toBe("passed");
    expect(routing.preflight.judge?.status).toBe("failed");
  });

  it("classifies the judge failure as a judge stage failure carrying a redacted reason", async () => {
    stubPlainTextGateway();
    const deps = depsWith({ evidenceDir, capabilities: [capability("dual-model")] });

    const routing = await buildQiModelRoutingForRun(deps, {
      modelPolicy: {
        policyVersion: 1,
        testDesignModelId: "dual-model",
        judgeModelId: "dual-model",
      },
    });

    const judgeFailures = (routing.stageFailures ?? []).filter((f) => f.stage === "judge");
    expect(judgeFailures).toHaveLength(1);
    expect(judgeFailures[0]?.reasonSummary).toContain("schema");
    // Redacted diagnostics only: never the provider endpoint or the key.
    expect(judgeFailures[0]?.reasonSummary).not.toContain("provider.invalid");
    expect(judgeFailures[0]?.reasonSummary).not.toContain("secret-key");
  });

  it("still fails the run when the GENERATION preflight fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(JSON.stringify({ error: { code: "forbidden" } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const deps = depsWith({ evidenceDir, capabilities: [capability("dual-model")] });

    await expect(
      buildQiModelRoutingForRun(deps, {
        modelPolicy: {
          policyVersion: 1,
          testDesignModelId: "dual-model",
          judgeModelId: "dual-model",
        },
      }),
    ).rejects.toMatchObject({ code: "QI_MODEL_PREFLIGHT_FAILED" });
    await expect(
      buildQiModelRoutingForRun(deps, {
        modelPolicy: {
          policyVersion: 1,
          testDesignModelId: "dual-model",
          judgeModelId: "dual-model",
        },
      }),
    ).rejects.toBeInstanceOf(QiModelPolicyError);
  });
});

// ─── Judge port construction ─────────────────────────────────────────────────

const EMPTY_CANDIDATES_JSON = JSON.stringify({ testCases: [] });

function fakeChatPort(content: string): ModelPort {
  return {
    call: (req: GatewayRequest, _signal: AbortSignal): Promise<NormalizedResponse> =>
      Promise.resolve({
        content,
        modelId: req.modelId,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "req-test",
          promptTokens: 10,
          completionTokens: 5,
          latencyMs: 1,
          costClass: "medium",
        },
      }),
  };
}

const VALID_SOURCE = {
  kind: "requirements" as const,
  label: "Requirements",
  text:
    "Das System muss vor dem Audit-Login eine Mehrfaktor-Authentisierung verlangen. " +
    "Das System muss vor dem Absenden einer Ueberweisung eine Bestaetigung anzeigen.",
};

const GEN_MODEL = "gen-chat-only-judge-contract";
const JUDGE_MODEL = "judge-structured-judge-contract";

function judgeUnavailableDeps(): UiHandlerDeps {
  return depsWith({
    evidenceDir,
    capabilities: [
      capability(GEN_MODEL, { structuredOutput: false, streaming: false, toolCalling: false }),
      capability(JUDGE_MODEL),
    ],
    // A port exists for generation; the judge model has none, so createQiJudgePort throws
    // QI_JUDGE_MODEL_UNAVAILABLE.
    modelPortFactory: (modelId) =>
      modelId === GEN_MODEL ? fakeChatPort(EMPTY_CANDIDATES_JSON) : undefined,
  });
}

describe("executeQiRun — an unbuildable judge port degrades the run, it does not destroy it", () => {
  it("completes the run when the judge model has no gateway port", async () => {
    const summary = await executeQiRun({
      request: { sources: [VALID_SOURCE], modelId: GEN_MODEL },
      runId: "run-judge-unavailable-completes",
      deps: judgeUnavailableDeps(),
      registeredAt: "2026-07-01T10:00:00.000Z",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted: vi.fn(),
    });

    expect(summary.status).toBe("succeeded");
  });

  it("records the judge unavailability as a classified judge stage failure on the run", async () => {
    const runId = "run-judge-unavailable-recorded";
    await executeQiRun({
      request: { sources: [VALID_SOURCE], modelId: GEN_MODEL },
      runId,
      deps: judgeUnavailableDeps(),
      registeredAt: "2026-07-01T10:00:00.000Z",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted: vi.fn(),
    });

    const manifest: QualityIntelligenceEvidenceManifest | undefined = loadQualityIntelligenceRun(
      runId,
      { evidenceDir },
    );
    const judgeFailures = (manifest?.modelRouting?.stageFailures ?? []).filter(
      (failure) => failure.stage === "judge",
    );
    expect(judgeFailures).toHaveLength(1);
    expect(judgeFailures[0]?.reasonSummary).toContain("QI_JUDGE_MODEL_UNAVAILABLE");
  });

  it("reports the judge stage failure on the accepted routing so the UI can show it", async () => {
    const onAccepted = vi.fn();
    await executeQiRun({
      request: { sources: [VALID_SOURCE], modelId: GEN_MODEL },
      runId: "run-judge-unavailable-accepted",
      deps: judgeUnavailableDeps(),
      registeredAt: "2026-07-01T10:00:00.000Z",
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onAccepted,
    });

    const accepted = onAccepted.mock.calls[0]?.[0] as
      | { readonly modelRouting?: { readonly stageFailures?: readonly { stage: string }[] } }
      | undefined;
    expect(accepted?.modelRouting?.stageFailures?.some((f) => f.stage === "judge")).toBe(true);
  });
});
