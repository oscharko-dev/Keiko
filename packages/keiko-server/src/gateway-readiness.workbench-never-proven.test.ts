// #3578 (last residual): a configured chat model nobody had proven tool calling for stayed
// `no-tool-calling` behind every gateway that is not a recognised LiteLLM, because only the LiteLLM
// startup probe ever asked such a model for its forced tool-call proof. Opening the Workbench now
// asks for it through the same bounded automatic verification as an expired proof or a short window
// (`workbenchProbesNeeded`), whatever gateway serves the model.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import { codingWorkbenchModelEligibility } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleCodingSidecarGatewayProfile } from "./coding-sidecar-gateway.js";
import {
  codingWorkbenchProbesSettledForTests,
  ensureCodingWorkbenchContextWindows,
  resetCodingWorkbenchContextWindowProbesForTests,
} from "./gateway-readiness.js";
import { modelIdEvidence } from "./observability/model-id-evidence.js";
import type { ServerLogEvent } from "./observability/index.js";
import type { RouteContext } from "./routes.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const CHAT = "plain-chat";
const EMBEDDING = "plain-embedding";
const PROFILE_CORRELATION = "profile-read-3578";

const compositions: UiHandlerDeps[] = [];
const directories: string[] = [];
afterEach(async (): Promise<void> => {
  for (const deps of compositions.splice(0)) await deps.dispose?.();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  resetCodingWorkbenchContextWindowProbesForTests();
});

function provider(modelId: string): Record<string, unknown> {
  // No `tokenCounter: "litellm"`: a plain OpenAI-compatible endpoint, the shape of the residual.
  return {
    modelId,
    baseUrl: "https://gateway.example.invalid/v1",
    apiKey: "throwaway-key",
    timeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

function embeddingCapability(): ModelCapability {
  return {
    id: EMBEDDING,
    kind: "embedding",
    contextWindow: 8191,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured embedding endpoint",
    preferredUseCases: ["Embeddings"],
    knownLimitations: [],
  };
}

// A never-proven chat model: the default chat capability carries `toolCalling: false` and no
// proof. Its window is declared and large, so only the tool-calling proof is missing.
function neverProvenChat(): ModelCapability {
  return { ...createDefaultChatCapability(CHAT), contextWindow: 64_000, maxOutputTokens: 2000 };
}

function plainConfig(
  capabilities: readonly ModelCapability[],
): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig({
    providers: capabilities.map((capability) => provider(capability.id)),
    capabilities,
  });
}

interface Observed {
  readonly deps: UiHandlerDeps;
  readonly events: ServerLogEvent[];
}

async function observedDeps(config: ReturnType<typeof parseGatewayConfig>): Promise<Observed> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-never-proven-"));
  directories.push(dir);
  const events: ServerLogEvent[] = [];
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    env: {},
    uiDbPath: join(dir, "ui.db"),
    evidenceDir: join(dir, "evidence"),
    activityLog: {
      write: (event: ServerLogEvent): void => {
        events.push(event);
      },
    },
  });
  compositions.push(deps);
  deps.gatewayConfig?.set(config, true);
  // The startup chat check of a plain gateway runs and settles before the Workbench is opened.
  if (config.providers.some((candidate) => candidate.modelId === CHAT)) {
    await vi.waitFor(() => {
      expect(deps.gatewayConfig?.verifiedCapability(CHAT)?.fields.conversationReady).toBe(true);
    });
  }
  return { deps, events };
}

interface GatewayCall {
  readonly model: string;
  readonly tools: boolean;
}

type ToolAnswer = "calls" | "refuses";

interface StubbedGateway {
  readonly calls: GatewayCall[];
  readonly toolCalls: () => number;
  // Flipped after the startup chat check: every later request is answered 503, as a gateway at
  // peak load does. The probe then ends without a verdict.
  busy: boolean;
}

// The fake gateway answers a plain chat request normally and answers the forced tool-call request
// as the test chooses. No real network: the global fetch is the only egress the probes use.
function stubGateway(toolAnswer: ToolAnswer, gate?: Promise<void>): StubbedGateway {
  const calls: GatewayCall[] = [];
  const gateway: StubbedGateway = {
    calls,
    toolCalls: (): number => calls.filter((call) => call.tools).length,
    busy: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit) => {
      const raw = typeof init.body === "string" ? init.body : "{}";
      const tools = raw.includes("report_readiness");
      calls.push({ model: (JSON.parse(raw) as { model?: string }).model ?? "absent", tools });
      if (gateway.busy) return new Response("", { status: 503 });
      if (tools) await gate;
      if (tools && toolAnswer === "refuses") return new Response("", { status: 400 });
      return Response.json({
        choices: [
          {
            message: {
              content: "OK",
              ...(tools
                ? {
                    tool_calls: [
                      { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                    ],
                  }
                : {}),
            },
            finish_reason: "stop",
          },
        ],
      });
    }),
  );
  return gateway;
}

function profileContext(correlationId = PROFILE_CORRELATION): RouteContext {
  return { correlationId } as RouteContext;
}

function storedChat(deps: UiHandlerDeps): ModelCapability {
  const model = deps.gatewayConfig
    ?.current()
    ?.capabilities?.find((capability) => capability.id === CHAT);
  if (model === undefined) throw new TypeError("Expected the configured chat model.");
  return model;
}

function workbenchRuns(events: readonly ServerLogEvent[]): readonly ServerLogEvent[] {
  return events.filter(
    (event) =>
      event.op === "gateway.readiness.automatic.started" &&
      event.extra?.probeTrigger === "profile-read",
  );
}

describe("a never-proven chat model behind a plain gateway", () => {
  it("is probed when the Workbench profile is read and admitted once the probe proves tool calling", async () => {
    const gateway = stubGateway("calls");
    const { deps } = await observedDeps(plainConfig([neverProvenChat()]));
    expect(codingWorkbenchModelEligibility(storedChat(deps))).toBe("ineligible");
    expect(gateway.toolCalls()).toBe(0);

    const profile = await handleCodingSidecarGatewayProfile(profileContext(), deps);

    expect(gateway.toolCalls()).toBe(1);
    expect(profile.body).toMatchObject({ status: "available", modelAlias: CHAT });
    expect(storedChat(deps)).toMatchObject({
      toolCalling: true,
      toolCallingVerification: { status: "verified" },
    });
    expect(codingWorkbenchModelEligibility(storedChat(deps))).toBe("eligible");
  });

  it("stays ineligible with the truthful reason when the probe refutes tool calling, and is not probed again", async () => {
    const gateway = stubGateway("refuses");
    const { deps, events } = await observedDeps(plainConfig([neverProvenChat()]));

    const first = await handleCodingSidecarGatewayProfile(profileContext(), deps);
    await codingWorkbenchProbesSettledForTests();
    // A refused forced tool call may be retried in another request shape within the one probe.
    const requestsOfTheProbe = gateway.toolCalls();
    const second = await handleCodingSidecarGatewayProfile(
      profileContext("profile-read-again"),
      deps,
    );
    await codingWorkbenchProbesSettledForTests();

    expect(requestsOfTheProbe).toBeGreaterThan(0);
    expect(gateway.toolCalls()).toBe(requestsOfTheProbe);
    expect(workbenchRuns(events)).toHaveLength(1);
    expect(first.body).toEqual({ status: "unavailable", reason: "no-tool-calling" });
    expect(second.body).toEqual({ status: "unavailable", reason: "no-tool-calling" });
    expect(storedChat(deps)).toMatchObject({
      toolCalling: false,
      toolCallingVerification: { status: "unsupported" },
    });
    expect(codingWorkbenchModelEligibility(storedChat(deps))).toBe("ineligible");
  });

  it("is probed once however many profile reads arrive while the probe runs", async () => {
    let release: () => void = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = stubGateway("calls", gate);
    const { deps, events } = await observedDeps(plainConfig([neverProvenChat()]));

    const reads = [1, 2, 3].map((index) =>
      handleCodingSidecarGatewayProfile(profileContext(`profile-read-${String(index)}`), deps),
    );
    await vi.waitFor(() => {
      expect(gateway.toolCalls()).toBe(1);
    });
    release();
    await Promise.all(reads);
    await codingWorkbenchProbesSettledForTests();
    await handleCodingSidecarGatewayProfile(profileContext("profile-read-after"), deps);

    expect(gateway.toolCalls()).toBe(1);
    expect(workbenchRuns(events)).toHaveLength(1);
  });

  it("is not probed again inside the short cooldown of a probe the gateway never answered", async () => {
    const gateway = stubGateway("calls");
    const { deps, events } = await observedDeps(plainConfig([neverProvenChat()]));
    gateway.busy = true;

    const first = await handleCodingSidecarGatewayProfile(profileContext(), deps);
    await codingWorkbenchProbesSettledForTests();
    const callsOfTheProbe = gateway.calls.length;
    const second = await handleCodingSidecarGatewayProfile(
      profileContext("profile-read-again"),
      deps,
    );
    await codingWorkbenchProbesSettledForTests();

    expect(callsOfTheProbe).toBeGreaterThan(0);
    expect(gateway.calls).toHaveLength(callsOfTheProbe);
    expect(workbenchRuns(events)).toHaveLength(1);
    // No verdict yet: the model is neither admitted nor called unable, and the Workbench re-reads.
    expect(first.body).toEqual({ status: "unavailable", reason: "model-verification-pending" });
    expect(second.body).toEqual({ status: "unavailable", reason: "model-verification-pending" });
    expect(storedChat(deps).toolCallingVerification).toBeUndefined();
  });

  it("never probes a model that is not a chat model, and probes the chat model next to it", async () => {
    const gateway = stubGateway("calls");
    const { deps } = await observedDeps(plainConfig([neverProvenChat(), embeddingCapability()]));
    const callsBefore = gateway.calls.length;

    await handleCodingSidecarGatewayProfile(profileContext(), deps);
    await codingWorkbenchProbesSettledForTests();

    expect(gateway.toolCalls()).toBe(1);
    expect(gateway.calls.slice(callsBefore).map((call) => call.model)).not.toContain(EMBEDDING);
    expect(gateway.calls.map((call) => call.model)).not.toContain(EMBEDDING);
  });

  it("asks nothing of a gateway that serves no chat model at all", async () => {
    const gateway = stubGateway("calls");
    const { deps } = await observedDeps(plainConfig([embeddingCapability()]));

    await ensureCodingWorkbenchContextWindows(deps, undefined, PROFILE_CORRELATION);
    await codingWorkbenchProbesSettledForTests();

    expect(gateway.calls).toEqual([]);
  });

  it("records the request on the existing automatic run, body-free and under the read's correlation", async () => {
    stubGateway("calls");
    const { deps, events } = await observedDeps(plainConfig([neverProvenChat()]));

    await handleCodingSidecarGatewayProfile(profileContext(), deps);

    const [started] = workbenchRuns(events);
    expect(started).toMatchObject({
      op: "gateway.readiness.automatic.started",
      correlationId: PROFILE_CORRELATION,
      extra: {
        modelIdDigest: modelIdEvidence(CHAT).modelIdDigest,
        probeCount: 2,
        probeBasis: "never-proven",
        probeTrigger: "profile-read",
      },
    });
    const startedLine = expectActivityLogProof(
      "gateway.readiness.automatic.started.line",
      formatActivityLogProofLine(started ?? {}),
    );
    expect(startedLine).toMatchObject({
      correlationId: PROFILE_CORRELATION,
      probeBasis: "never-proven",
      probeTrigger: "profile-read",
    });
    const completed = events.find(
      (event) =>
        event.op === "gateway.readiness.automatic.completed" &&
        event.correlationId === PROFILE_CORRELATION,
    );
    expect(completed?.extra).toMatchObject({ overallStatus: "ready", probeCount: 2 });
    expect(JSON.stringify([started, completed])).not.toContain(CHAT);
  });
});

// The same rule serves the file-configured gateway of the issue: the loader strips a proof that
// aged out, and the stripped model is a verification target, not a model that cannot call tools.
describe("a file-configured chat model whose tool-calling proof aged out", () => {
  const AGE_MS = 25 * 60 * 60 * 1_000;

  function agedProofConfig(): ReturnType<typeof parseGatewayConfig> {
    const configProvider = provider(CHAT);
    const raw = parseGatewayConfig({ providers: [configProvider], capabilities: [] });
    const [loadedProvider] = raw.providers;
    if (loadedProvider === undefined) throw new TypeError("Expected the configured provider.");
    return parseGatewayConfig({
      providers: [configProvider],
      capabilities: [
        {
          ...neverProvenChat(),
          toolCalling: true,
          toolCallingVerification: {
            status: "verified",
            checkedAt: new Date(Date.now() - AGE_MS).toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(loadedProvider),
          },
        },
      ],
    });
  }

  it("is renewed by the Workbench profile read with no manual readiness run", async () => {
    const gateway = stubGateway("calls");
    const { deps } = await observedDeps(agedProofConfig());
    // The loader refuses tools on the aged proof; only a renewed proof may admit them.
    expect(storedChat(deps).toolCalling).toBe(false);
    expect(gateway.toolCalls()).toBe(0);

    const profile = await handleCodingSidecarGatewayProfile(profileContext(), deps);

    expect(gateway.toolCalls()).toBe(1);
    expect(profile.body).toMatchObject({ status: "available", modelAlias: CHAT });
    expect(codingWorkbenchModelEligibility(storedChat(deps))).toBe("eligible");
  });
});

describe("the subscription and policy guard", () => {
  it.each([
    {
      label: "a subscription model source",
      override: (deps: UiHandlerDeps): UiHandlerDeps => ({
        ...deps,
        codingSidecarGatewayModelSourceResolver: (): "chatgpt-codex-subscription-profile" =>
          "chatgpt-codex-subscription-profile",
      }),
      reason: "subscription-source",
    },
    {
      label: "a deployment policy that disables the sidecar",
      override: (deps: UiHandlerDeps): UiHandlerDeps => ({
        ...deps,
        env: { ...deps.env, KEIKO_CODING_SIDECAR_DISABLED: "true" },
      }),
      reason: "deployment-policy-disabled",
    },
  ])("probes nothing under $label", async ({ override, reason }) => {
    const gateway = stubGateway("calls");
    const { deps } = await observedDeps(plainConfig([neverProvenChat()]));
    const callsBefore = gateway.calls.length;

    const profile = await handleCodingSidecarGatewayProfile(profileContext(), override(deps));
    await codingWorkbenchProbesSettledForTests();

    expect(profile.body).toEqual({ status: "unavailable", reason });
    expect(gateway.calls).toHaveLength(callsBefore);
  });
});
