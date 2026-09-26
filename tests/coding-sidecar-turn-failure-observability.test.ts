// #3593: a Coding Workbench turn the model provider refuses is never silent. The provider behind a
// LiteLLM OpenAI-compatible route answers 400 to the first turn. The run gets one closed-code event,
// and the persisted Activity Log, reconstructed by `keiko support analyze`'s own analyzer, shows the
// failed turn in the run's timeline, with the diagnostic's Keiko-code frames and without a byte of
// the provider's text.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderError,
  type GatewayConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

import { analyzeLogText, findTimeline } from "../packages/keiko-cli/src/support-analyze.js";
import { mockRequest, mockResponse } from "../packages/keiko-server/src/_support.js";
import { CodingRuntimeEventHub } from "../packages/keiko-server/src/coding-runtime/codingRuntimeEventHub.js";
import { handleCodingSidecarGatewayChatCompletions } from "../packages/keiko-server/src/coding-sidecar-gateway.js";
import { buildRedactor, type UiHandlerDeps } from "../packages/keiko-server/src/deps.js";
import { resetServerLogger } from "../packages/keiko-server/src/observability/index.js";
import type { RouteContext } from "../packages/keiko-server/src/routes.js";
import { createRunRegistry } from "../packages/keiko-server/src/runs.js";
import { createInMemoryUiStore } from "../packages/keiko-server/src/store/index.js";
import { readPersistedActivityLog } from "./support/activity-log-proof.js";

const RUN_ID = "run-turn-failure-observability";
const REQUEST_ID = "request-turn-failure-observability";
const CAPABILITY = "gateway-capability-material-0000000001";
const PROVIDER_TEXT = "SENTINEL_PROVIDER_REFUSAL_TEXT";
const PROMPT_TEXT = "SENTINEL_USER_PROMPT_TEXT";

function litellmRoute(): GatewayConfig {
  return {
    providers: [
      {
        modelId: "litellm-coding-model",
        baseUrl: "https://litellm.example/v1",
        apiKey: "litellm-secret",
        apiKeyHeaderName: "x-litellm-key",
        endpointStyle: "openai-compatible",
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: "litellm-coding-model",
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: "test-fingerprint",
        },
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "coding-sidecar",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
}

function refusingRouteDeps(eventHub: CodingRuntimeEventHub): UiHandlerDeps {
  return {
    config: litellmRoute(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    codingSidecarGatewayChatFactory: () => (): Promise<NormalizedResponse> =>
      Promise.reject(new ProviderError(PROVIDER_TEXT, 400)),
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade") =>
        capability === CAPABILITY && audience === "model-gateway"
          ? { ok: true, binding: { runId: RUN_ID } }
          : { ok: false },
      reservePromptTokens: () => ({ ok: true, runId: RUN_ID }),
    },
    codingRuntimeEventHub: eventHub,
    codingRuntimeOrchestrator: {
      getSnapshot: () => ({ state: "running", revision: 2 }),
    } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
  };
}

function firstTurn(): RouteContext {
  return {
    correlationId: REQUEST_ID,
    req: mockRequest({
      method: "POST",
      url: "/api/coding-sidecar/gateway/chat/completions",
      body: JSON.stringify({ messages: [{ role: "user", content: PROMPT_TEXT }] }),
      headers: { authorization: `Bearer ${CAPABILITY}` },
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

describe("coding sidecar turn failure support reconstruction", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-turn-failure-observability-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("shows a provider 400 on the first turn in the run's support timeline", async () => {
    const eventHub = new CodingRuntimeEventHub();

    await handleCodingSidecarGatewayChatCompletions(firstTurn(), refusingRouteDeps(eventHub));
    resetServerLogger();

    const replay = eventHub.replay(RUN_ID);
    expect(replay.ok && replay.events).toEqual([
      expect.objectContaining({ eventKind: "failure-redacted", failureCode: "provider-failed" }),
    ]);
    const serialized = readPersistedActivityLog(stateDir);
    const timeline = findTimeline(analyzeLogText(serialized), RUN_ID);
    const ops = timeline?.lines.map((line) => line.op) ?? [];
    expect(ops).toContain("coding-sidecar.gateway.turn-failed");
    expect(ops).toContain("server.diagnostic.failure");
    expect(
      timeline?.lines.find((line) => line.op === "coding-sidecar.gateway.turn-failed"),
    ).toMatchObject({
      parentCorrelationId: RUN_ID,
      extra: { failureCode: "provider-failed", published: true },
    });
    const diagnostic = timeline?.lines.find((line) => line.op === "server.diagnostic.failure");
    expect(diagnostic?.frames).toEqual(
      expect.arrayContaining([expect.stringMatching(/^packages\/keiko-server\//u)]),
    );
    expect(serialized).not.toContain(PROVIDER_TEXT);
    expect(serialized).not.toContain(PROMPT_TEXT);
    expect(serialized).not.toContain("litellm-secret");
  });
});
