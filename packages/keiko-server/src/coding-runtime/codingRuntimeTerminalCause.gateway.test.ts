// F9 (#3873) end to end through the real coding sidecar gateway route: the route's own refusal or
// failure of a model call feeds the facts a failed run's settlement names its cause from — the
// runtime authority's prompt allowance and the event hub's last failed-call cause — composed exactly
// as production composes them. No OpenCode error text is read anywhere on this path.
import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayConfig,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  CircuitOpenError,
  ProviderError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";

import { mockRequest, mockResponse } from "../_support.js";
import { handleCodingSidecarGatewayChatCompletions } from "../coding-sidecar-gateway.js";
import {
  buildRedactor,
  codingSidecarGatewayEvidenceRecorder,
  type UiHandlerDeps,
} from "../deps.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { resetGatewayInstanceCacheForTests } from "../gateway-instance-cache.js";
import { resetCodingWorkbenchContextWindowProbesForTests } from "../gateway-readiness.js";
import type { RouteContext } from "../routes.js";
import { createRunRegistry } from "../runs.js";
import { createInMemoryUiStore } from "../store/index.js";
import { codingRuntimeTerminalFacts } from "./codingRuntimeControlPlane.js";
import { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import { classifyTerminalFailure } from "./codingRuntimeTerminalCause.js";
import { createInMemoryRuntimeCapabilityStore } from "./runtimeCapabilityStore.js";
import {
  CodingRuntimeAuthorityService,
  type CodingRuntimeTrustedContext,
} from "./runtimeAuthorityService.js";

// The orchestrator's run-id shape; the Authority Envelope admits only evidence-safe identifiers.
const RUN_ID = "run-38730001";
const NOW = new Date();
const ROOT = "/managed/project/task-f9";
const DIGEST = "a".repeat(64);

afterEach(() => {
  resetGatewayInstanceCacheForTests();
  resetCodingWorkbenchContextWindowProbesForTests();
});

function trustedContext(maxPromptTokens: number): CodingRuntimeTrustedContext {
  return {
    operatorId: "operator-1",
    taskId: "task-f9",
    projectId: "project-1",
    projectDigest: DIGEST,
    workspaceId: "workspace-1",
    workspaceRoot: ROOT,
    branchRef: "issue-3873",
    branchHeadDigest: DIGEST,
    branch: {
      baseRef: "dev",
      headRef: "issue-3873",
      allowDetachedHead: false,
      allowedPrefixes: ["issue-"],
    },
    deploymentCeiling: "autonomous-delivery",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "command-execution", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: { maxRuntimeMs: 600_000, maxToolCalls: 10, maxPromptTokens, maxPatchBytes: 65_536 },
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  };
}

/** A real runtime authority with one minted run whose cumulative allowance is `maxPromptTokens`. */
function mintedAuthority(maxPromptTokens: number): {
  readonly authority: CodingRuntimeAuthorityService;
  readonly capability: string;
} {
  const authority = new CodingRuntimeAuthorityService(
    new EditorAgentAuthorityRegistry(),
    () => RUN_ID,
    () => "nonce-1",
    undefined,
    createInMemoryRuntimeCapabilityStore({ nowMs: () => Date.now() }),
  );
  const context = trustedContext(maxPromptTokens);
  const intent = {
    schemaVersion: "1",
    requestId: "request-1",
    command: "start",
    taskIntent: "Fix the month bucketing",
    requestedMode: "supervised-coding",
    modelSource: "keiko-model-gateway",
  } as const;
  const nowIso = new Date().toISOString();
  const confirmation = authority.confirmStart(intent, context.taskId, context.operatorId, nowIso);
  const minted = authority.mintStart(intent, context, confirmation, nowIso);
  if (!minted.ok) throw new Error(`expected a minted run: ${minted.reason}`);
  return { authority, capability: minted.modelGatewayCapability };
}

function provider(): ModelProviderConfig {
  return {
    modelId: "azure-coding-model",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment",
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function capability(): ModelCapability {
  return {
    id: "azure-coding-model",
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
  };
}

function answer(): NormalizedResponse {
  return {
    modelId: "azure-coding-model",
    content: "assistant-content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "req-1",
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

type ChatOutcome = () => Promise<NormalizedResponse>;

function answered(): ChatOutcome {
  return () => Promise.resolve(answer());
}

function failing(error: Error): ChatOutcome {
  return () => Promise.reject(error);
}

/**
 * The sidecar route's dependencies around one minted run: the real authority books its prompt
 * tokens, the real hub receives its failed-call causes, and the evidence recorder production
 * composes clears a recovered failure. Each model call answers with the next scripted outcome.
 */
function gatewayDeps(
  minted: ReturnType<typeof mintedAuthority>,
  hub: CodingRuntimeEventHub,
  outcomes: readonly ChatOutcome[],
): UiHandlerDeps {
  const config: GatewayConfig = {
    providers: [provider()],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [capability()],
  };
  let call = 0;
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    codingSidecarGatewayChatFactory: () => () => {
      const next = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return next === undefined ? Promise.reject(new Error("no scripted outcome")) : next();
    },
    runtimeCapabilityAuthenticator: {
      authenticate: (value: string, audience: "model-gateway" | "tool-facade") =>
        value === minted.capability && audience === "model-gateway"
          ? { ok: true, binding: { runId: RUN_ID } }
          : { ok: false },
      reservePromptTokens: (value: string, promptTokens: number) =>
        minted.authority.reservePromptTokens(value, promptTokens),
      settlePromptTokens: (value: string, reserved: number, actual: number) =>
        minted.authority.settlePromptTokens(value, reserved, actual),
    },
    codingRuntimeOrchestrator: {
      getSnapshot: () => ({ state: "running", revision: 5 }),
    } as unknown as UiHandlerDeps["codingRuntimeOrchestrator"],
    codingRuntimeEventHub: hub,
    codingSidecarGatewayEvidenceAggregator: codingSidecarGatewayEvidenceRecorder(
      { observe: () => undefined },
      hub,
    ),
  };
}

function chatRequest(capabilityValue: string, content: string): RouteContext {
  const body = JSON.stringify({ messages: [{ role: "user", content }] });
  return {
    correlationId: undefined,
    req: mockRequest({
      method: "POST",
      url: "/api/coding-sidecar/gateway/chat/completions",
      body,
      headers: { authorization: `Bearer ${capabilityValue}` },
    }),
    res: mockResponse().res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

async function callGateway(
  minted: ReturnType<typeof mintedAuthority>,
  hub: CodingRuntimeEventHub,
  outcomes: readonly ChatOutcome[],
  content = "synthetic",
): Promise<unknown> {
  return handleCodingSidecarGatewayChatCompletions(
    chatRequest(minted.capability, content),
    gatewayDeps(minted, hub, outcomes),
  );
}

function terminalFailure(
  minted: ReturnType<typeof mintedAuthority>,
  hub: CodingRuntimeEventHub,
): ReturnType<typeof classifyTerminalFailure> {
  const facts = codingRuntimeTerminalFacts(hub, {
    promptAllowanceExhausted: (runId) => minted.authority.promptAllowanceExhausted(runId),
    envelopeDurationExhausted: (runId) => minted.authority.envelopeDurationExhausted(runId),
  });
  return classifyTerminalFailure(facts, RUN_ID);
}

describe("terminal model-call cause through the coding sidecar gateway route (F9)", () => {
  it("names the prompt allowance the route refused the call with, not an internal error", async () => {
    const minted = mintedAuthority(1);
    const hub = new CodingRuntimeEventHub();

    await expect(callGateway(minted, hub, [answered()])).resolves.toMatchObject({ status: 403 });

    expect(hub.lastModelCallFailure(RUN_ID)).toBe("turn-rejected");
    expect(terminalFailure(minted, hub)).toEqual({
      failureCode: "prompt-allowance-exhausted",
      basis: "prompt-allowance",
      modelCallFailure: "turn-rejected",
    });
  });

  it("names a provider the route could not reach as unavailable", async () => {
    const minted = mintedAuthority(200_000);
    const hub = new CodingRuntimeEventHub();

    await expect(
      callGateway(minted, hub, [failing(new TransportError("synthetic reset"))]),
    ).resolves.toMatchObject({ status: 503 });

    expect(terminalFailure(minted, hub)).toEqual({
      failureCode: "provider-unavailable",
      basis: "model-call-failure",
      modelCallFailure: "stream-incomplete",
    });
  });

  it("forgets a failed call once a later call of the run is answered", async () => {
    const minted = mintedAuthority(200_000);
    const hub = new CodingRuntimeEventHub();

    await callGateway(minted, hub, [failing(new TransportError("synthetic reset"))]);
    expect(hub.lastModelCallFailure(RUN_ID)).toBe("stream-incomplete");
    await expect(callGateway(minted, hub, [answered()])).resolves.toMatchObject({ status: 200 });

    expect(hub.lastModelCallFailure(RUN_ID)).toBeUndefined();
    expect(terminalFailure(minted, hub)).toEqual({
      failureCode: "runtime-failed",
      basis: "no-model-call-failure",
    });
  });

  // The missing gateway hook, pinned so its arrival is a deliberate change: the route reports an
  // unavailable provider (5xx past the outage window, an open breaker) as `provider-failed`, the
  // same code as a 4xx rejection. The run therefore defers to the failed turn's own sentence and
  // never calls it an internal error; telling unavailable from rejected needs a distinct gateway
  // cause for the unavailable class.
  it.each([
    ["a 5xx past the outage window", new ProviderError("synthetic unavailable", 503)],
    ["an open breaker", new CircuitOpenError("synthetic circuit open")],
    ["a 4xx rejection", new ProviderError("synthetic rejection", 400)],
  ])("defers %s to the cause the failed turn names", async (_label, error) => {
    const minted = mintedAuthority(200_000);
    const hub = new CodingRuntimeEventHub();

    await callGateway(minted, hub, [failing(error)]);

    expect(terminalFailure(minted, hub)).toEqual({
      failureCode: "model-turn-failed",
      basis: "model-call-failure",
      modelCallFailure: "provider-failed",
    });
  });
});
