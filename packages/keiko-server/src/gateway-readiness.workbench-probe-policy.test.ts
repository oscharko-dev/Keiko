// #3591 (1.1.7): the field customer's LiteLLM/vLLM gateway answers slowly at peak load. The
// automatic Workbench probes used to run with the setup default timeout (30 s) and a timed-out
// long-context probe held the six-hour re-probe cooldown, so one slow answer locked the Coding
// Workbench out with no operator remedy but a restart. These pin the repaired policy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { GatewayConfig, ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
import type { GatewayReadinessProbeResult } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  LONG_CONTEXT_PROBE_TIMEOUT_FLOOR_MS,
  WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS,
  WORKBENCH_PROBE_TIMEOUT_FLOOR_MS,
  codingWorkbenchProbesSettledForTests,
  ensureCodingWorkbenchContextWindows,
  isCodingWorkbenchProbePending,
  probeInconclusive,
  probeProvider,
  resetCodingWorkbenchContextWindowProbesForTests,
} from "./gateway-readiness.js";
import type { UiHandlerDeps } from "./deps.js";

function provider(timeoutMs: number): ModelProviderConfig {
  return {
    modelId: "hosted-chat",
    baseUrl: "https://siu.llm.intern/v1",
    apiKey: "k",
    timeoutMs,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

describe("probeProvider — probe timeout floors", () => {
  it("raises the long-context probe to its floor regardless of purpose", () => {
    expect(probeProvider(provider(30_000), "long_context", undefined).timeoutMs).toBe(
      LONG_CONTEXT_PROBE_TIMEOUT_FLOOR_MS,
    );
    expect(
      probeProvider(provider(30_000), "long_context", { purpose: "coding-workbench-auto" })
        .timeoutMs,
    ).toBe(LONG_CONTEXT_PROBE_TIMEOUT_FLOOR_MS);
  });

  it("raises every automatic Workbench probe to the Workbench floor", () => {
    expect(
      probeProvider(provider(30_000), "tool_calling", { purpose: "coding-workbench-auto" })
        .timeoutMs,
    ).toBe(WORKBENCH_PROBE_TIMEOUT_FLOOR_MS);
  });

  it("keeps a configured timeout that already clears the floor, and the same object", () => {
    const generous = provider(LONG_CONTEXT_PROBE_TIMEOUT_FLOOR_MS + 1);
    expect(probeProvider(generous, "long_context", undefined)).toBe(generous);
  });

  it("leaves an operator-started chat probe on the configured timeout", () => {
    expect(probeProvider(provider(30_000), "chat", undefined).timeoutMs).toBe(30_000);
  });
});

describe("probeInconclusive", () => {
  const failed = (warning?: string): GatewayReadinessProbeResult => ({
    name: "long_context",
    status: "failed",
    latencyMs: 1,
    evidence: "synthetic",
    ...(warning === undefined ? {} : { warning }),
  });

  it("recognises only the module's own timeout and unreachable sentences", () => {
    expect(probeInconclusive(failed("The probe timed out before the provider answered."))).toBe(
      true,
    );
    expect(probeInconclusive(failed("The provider could not be reached for this probe."))).toBe(
      true,
    );
    expect(
      probeInconclusive(
        failed("The provider could not complete this probe. Chat configuration was not changed."),
      ),
    ).toBe(false);
    expect(probeInconclusive(failed())).toBe(false);
    expect(
      probeInconclusive({
        ...failed("The probe timed out before the provider answered."),
        status: "passed",
      }),
    ).toBe(false);
  });
});

// A deps shape with ONE configured chat model whose gateway declared no token limits (the 4,096
// placeholder), a verified tool-call proof (so only the long-context probe is needed) and a fake
// transport whose behaviour each test chooses. Generation is unique per call so the module-level
// probe map never collides across tests.
let nextGeneration = 500;
function workbenchDeps(answer: () => Promise<Response>): {
  readonly deps: UiHandlerDeps;
  readonly calls: () => number;
} {
  const generation = (nextGeneration += 1);
  let calls = 0;
  const providerConfig = provider(30_000);
  const capability = {
    id: "hosted-chat",
    kind: "chat",
    contextWindow: 4_096,
    maxOutputTokens: 0,
    toolCalling: true,
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "synthetic",
    },
    structuredOutput: false,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "synthetic",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
  };
  const config = { providers: [providerConfig], capabilities: [capability] };
  const deps = {
    gatewayConfig: {
      storagePath: "/dev/null",
      current: () => config,
      present: () => true,
      set: () => undefined,
      generation: () => generation,
      verification: () => "verified",
      recordVerification: () => undefined,
      verifiedCapability: () => undefined,
      recordVerifiedCapability: () => undefined,
      clearVerifiedCapability: () => false,
    },
    redactor: (value: unknown): unknown => value,
    gatewayReadinessFetch: (): Promise<Response> => {
      calls += 1;
      return answer();
    },
  } as unknown as UiHandlerDeps;
  return { deps, calls: () => calls };
}

describe("automatic Workbench probes — inconclusive runs are retried soon", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetCodingWorkbenchContextWindowProbesForTests();
  });

  it("re-probes one minute after a probe the gateway never answered, not six hours later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { deps, calls } = workbenchDeps(() => Promise.reject(new TimeoutError("synthetic")));

    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);

    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);

    vi.advanceTimersByTime(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS);
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(2);
  });

  it("treats an unreachable gateway like a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { deps, calls } = workbenchDeps(() =>
      Promise.reject(new TransportError("synthetic unreachable")),
    );
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    vi.advanceTimersByTime(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS);
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(2);
  });

  it("keeps the long cooldown for a probe the gateway answered and refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { deps, calls } = workbenchDeps(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "context length exceeded" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);
    vi.advanceTimersByTime(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS * 10);
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);
  });

  // Review of #3591: a Workbench that re-reads its profile only while the verification is open
  // must not stop after an inconclusive probe — the server retries after a minute, and only a
  // verdict from the gateway closes the verification.
  it("keeps the verification open after an inconclusive probe until the gateway answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    let answers = 0;
    const { deps, calls } = workbenchDeps(() => {
      answers += 1;
      return answers === 1
        ? Promise.reject(new TimeoutError("synthetic"))
        : Promise.resolve(
            new Response(JSON.stringify({ error: { message: "refused" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
          );
    });
    const config = deps.gatewayConfig?.current();
    if (config === undefined) throw new Error("config missing");

    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);
    expect(isCodingWorkbenchProbePending(config, "hosted-chat")).toBe(true);

    vi.advanceTimersByTime(WORKBENCH_INCONCLUSIVE_REPROBE_COOLDOWN_MS);
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(2);
    expect(isCodingWorkbenchProbePending(config, "hosted-chat")).toBe(false);
  });

  it("reports the probe as pending while it runs and settled afterwards", async () => {
    let release: (() => void) | undefined;
    const { deps } = workbenchDeps(
      () =>
        new Promise<Response>((resolve) => {
          release = (): void => {
            resolve(
              new Response(JSON.stringify({ error: { message: "refused" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
            );
          };
        }),
    );
    const config = deps.gatewayConfig?.current();
    if (config === undefined) throw new Error("config missing");
    const read = ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    expect(isCodingWorkbenchProbePending(config, "hosted-chat")).toBe(true);
    release?.();
    await read;
    await codingWorkbenchProbesSettledForTests();
    expect(isCodingWorkbenchProbePending(config, "hosted-chat")).toBe(false);
    expect(isCodingWorkbenchProbePending(config, "never-probed")).toBe(false);
  });

  it("gives an operator who raised the timeout a fresh attempt at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { deps, calls } = workbenchDeps(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "refused" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(1);
    const current = deps.gatewayConfig?.current();
    if (current === undefined) throw new Error("config missing");
    const raised: GatewayConfig = {
      ...current,
      providers: current.providers.map((entry) => ({ ...entry, timeoutMs: 120_000 })),
    };
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("holder missing");
    holder.current = (): GatewayConfig => raised;
    await ensureCodingWorkbenchContextWindows(deps, "hosted-chat");
    await codingWorkbenchProbesSettledForTests();
    expect(calls()).toBe(2);
  });
});
