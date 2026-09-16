import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCodingWorkbenchSidecarGatewayProfile,
  fetchCodingWorkbenchCodexSubscriptionProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./coding-workbench-provider-api";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  GATEWAY_MODEL_READINESS_UPDATED_EVENT,
} from "@/app/components/desktop/widgets/shared/gatewaySetupBus";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchCodingWorkbenchSidecarGatewayProfile", () => {
  afterEach(() => {
    window.dispatchEvent(new CustomEvent(GATEWAY_CONFIG_UPDATED_EVENT));
    vi.unstubAllGlobals();
  });

  it("accepts a valid sidecar gateway profile response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "available",
        profileId: "coding-safe-openai-compatible",
        modelAlias: "azure-coding-model",
        localEndpointPath: "/api/coding-sidecar/gateway",
        supportsStreaming: false,
        supportsToolCalling: true,
        runMetadata: {
          maxPromptTokens: 128_000,
          maxOutputTokens: 4_096,
          maxInputMessages: 64,
          maxRequestBytes: 64_000,
        },
        verification: "verified",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject({
      status: "available",
      modelAlias: "azure-coding-model",
      verification: "verified",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-sidecar/gateway/profile",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("automatically verifies an unproven coding model and returns the refreshed profile", async () => {
    const readinessUpdated = vi.fn();
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
    const available = {
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "coding-chat",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
      runMetadata: {
        maxPromptTokens: 128_000,
        maxOutputTokens: 4_096,
        maxInputMessages: 64,
        maxRequestBytes: 64_000,
      },
      verification: "verified",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "unavailable", reason: "no-tool-calling" }))
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            {
              id: "coding-chat",
              kind: "chat",
              contextWindow: 128_000,
              maxOutputTokens: 4_096,
              toolCalling: false,
              structuredOutput: true,
              streaming: true,
              supportsImageInput: false,
              supportsDocumentInput: false,
              workflowEligible: true,
              costClass: "medium",
              latencyClass: "standard",
              throughputHint: "configured gateway",
              preferredUseCases: ["Coding"],
              knownLimitations: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          modelId: "coding-chat",
          checkedAt: "2026-09-15T05:30:00.000Z",
          overallStatus: "ready",
          probes: [
            { name: "chat", status: "passed", latencyMs: 10, evidence: "Chat answered." },
            {
              name: "tool_calling",
              status: "passed",
              latencyMs: 12,
              evidence: "Tool calling answered.",
            },
          ],
          verifiedCapabilities: { toolCalling: true },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(available));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject(available);
    window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/gateway/readiness",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          modelId: "coding-chat",
          options: { probes: ["tool_calling"], purpose: "coding-workbench-auto" },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/coding-sidecar/gateway/profile",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(readinessUpdated).toHaveBeenCalledOnce();
  });

  it("tries configured coding candidates in deterministic cost order until one verifies", async () => {
    const readinessUpdated = vi.fn();
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
    const capability = (id: string, costClass: "medium" | "high"): Record<string, unknown> => ({
      id,
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: false,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass,
      latencyClass: "standard",
      throughputHint: "configured gateway",
      preferredUseCases: ["Coding"],
      knownLimitations: [],
    });
    const report = (modelId: string, passed: boolean): Record<string, unknown> => ({
      modelId,
      checkedAt: "2026-09-15T05:30:00.000Z",
      overallStatus: passed ? "ready" : "failed",
      probes: [
        {
          name: "tool_calling",
          status: passed ? "passed" : "unsupported",
          latencyMs: 12,
          evidence: "Readiness classification.",
        },
      ],
      verifiedCapabilities: { toolCalling: passed },
    });
    const available = {
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "coding-high",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
      runMetadata: {
        maxPromptTokens: 128_000,
        maxOutputTokens: 4_096,
        maxInputMessages: 64,
        maxRequestBytes: 64_000,
      },
      verification: "verified",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ status: "unavailable", reason: "tool-calling-unverified" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          models: [capability("coding-high", "high"), capability("coding-low", "medium")],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(report("coding-low", false)))
      .mockResolvedValueOnce(jsonResponse(report("coding-high", true)))
      .mockResolvedValueOnce(jsonResponse(available));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject(available);
    const readinessBodies = fetchMock.mock.calls
      .filter(([path]) => path === "/api/gateway/readiness")
      .map(
        ([_path, init]) => JSON.parse(String((init as RequestInit).body)) as { modelId: string },
      );

    expect(readinessBodies.map((body) => body.modelId)).toEqual(["coding-low", "coding-high"]);
    expect(readinessUpdated).toHaveBeenCalledOnce();
    window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
  });

  // #3506 review — `recoverUnverifiedGatewayProfile` now wraps each best-effort recovery step
  // (`/api/models`, `requestAutomaticReadiness`, and the final sidecar re-read) in try/catch and
  // returns the caller's known-good `{ status: "unavailable", reason }` on any failure so a
  // transient sidecar or model-catalog hiccup cannot break Coding Workbench startup. The invariant
  // these cases still protect is the mutation guard: a malformed `/api/models` body must never let
  // the readiness POST fire on an unverified candidate.
  it.each([
    ["non-array model list", { models: "coding-chat" }],
    ["non-object capability", { models: [null] }],
    [
      "non-string use case",
      {
        models: [
          {
            id: "coding-chat",
            kind: "chat",
            workflowEligible: true,
            costClass: "medium",
            preferredUseCases: ["Coding", { injected: true }],
          },
        ],
      },
    ],
  ] as const)("fails closed on a %s before issuing a readiness mutation", async (_name, models) => {
    const unavailable = { status: "unavailable", reason: "tool-calling-unverified" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(models));
    vi.stubGlobal("fetch", fetchMock);

    // A malformed `/api/models` body is caught inside `recoverUnverifiedGatewayProfile`; the caller
    // receives the original known-good unavailable profile from `readSidecarGatewayProfile()`.
    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toEqual(unavailable);
    // The load-bearing invariant: no readiness mutation was issued on an unverified candidate.
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/gateway/readiness")).toBe(false);
  });

  it("does not publish a refresh loop and cools down after every candidate fails", async () => {
    const readinessUpdated = vi.fn();
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
    const unavailable = { status: "unavailable", reason: "no-tool-calling" };
    const models = {
      models: [
        {
          id: "coding-chat-failed",
          kind: "chat",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          toolCalling: false,
          structuredOutput: true,
          streaming: true,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: true,
          costClass: "medium",
          latencyClass: "standard",
          throughputHint: "configured gateway",
          preferredUseCases: ["Coding"],
          knownLimitations: [],
        },
      ],
    };
    const failed = {
      modelId: "coding-chat-failed",
      checkedAt: "2026-09-15T05:30:00.000Z",
      overallStatus: "failed",
      probes: [
        {
          name: "tool_calling",
          status: "unsupported",
          latencyMs: 12,
          evidence: "Tool calling was not accepted.",
        },
      ],
      verifiedCapabilities: { toolCalling: false },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(models))
      .mockResolvedValueOnce(jsonResponse(failed))
      .mockResolvedValueOnce(jsonResponse(unavailable))
      .mockResolvedValueOnce(jsonResponse(models));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toEqual(unavailable);
    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toEqual(unavailable);

    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/gateway/readiness")).toHaveLength(
      1,
    );
    expect(readinessUpdated).not.toHaveBeenCalled();
    window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessUpdated);
  });

  // A `/api/gateway/readiness` transport failure — network error, non-2xx response, or a payload
  // that fails validation — must not reject `fetchCodingWorkbenchSidecarGatewayProfile()`. The
  // Coding Workbench needs the original unavailable profile so its UI stays functional; the
  // cooldown bounds the retry so a flaky gateway cannot melt the client.
  it.each([
    ["network error", (): Promise<Response> => Promise.reject(new TypeError("network down"))],
    [
      "non-2xx response",
      (): Promise<Response> => Promise.resolve(new Response("{}", { status: 502 })),
    ],
    [
      "invalid JSON body",
      (): Promise<Response> =>
        Promise.resolve(
          new Response("<html>oops</html>", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    ],
    [
      "malformed readiness report",
      (): Promise<Response> =>
        Promise.resolve(
          jsonResponse({
            checkedAt: "2026-09-15T05:30:00.000Z",
            overallStatus: "ready",
            probes: "not-an-array",
            verifiedCapabilities: { toolCalling: true },
          }),
        ),
    ],
  ] as const)(
    "preserves the unavailable profile when automatic readiness fails with a %s",
    async (_name, readinessResponse) => {
      const unavailable = { status: "unavailable", reason: "no-tool-calling" };
      const models = {
        models: [
          {
            id: "coding-chat",
            kind: "chat",
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            toolCalling: false,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: true,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "configured gateway",
            preferredUseCases: ["Coding"],
            knownLimitations: [],
          },
        ],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const path = String(input);
        if (path === "/api/coding-sidecar/gateway/profile") {
          return Promise.resolve(jsonResponse(unavailable));
        }
        if (path === "/api/models") return Promise.resolve(jsonResponse(models));
        if (path === "/api/gateway/readiness") return readinessResponse();
        return Promise.reject(new TypeError(`Unexpected request: ${path}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toEqual(unavailable);
    },
  );

  it("rejects malformed sidecar gateway profile responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "available",
        profileId: "coding-safe-openai-compatible",
        modelAlias: "azure-coding-model",
        localEndpointPath: "/api/coding-sidecar/gateway",
        supportsStreaming: false,
        supportsToolCalling: true,
        runMetadata: {
          maxPromptTokens: 128_000,
          maxOutputTokens: 4_096,
          maxInputMessages: "64",
          maxRequestBytes: 64_000,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  // F-01: the Workbench renders this field to say whether a live probe confirmed the source. A BFF
  // that omits it, or reports a word outside the vocabulary, must fail the contract rather than be
  // quietly defaulted — the caller would otherwise be free to read "no field" as healthy.
  it("rejects an available profile that carries no probe outcome", async () => {
    const profile = {
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
      runMetadata: {
        maxPromptTokens: 128_000,
        maxOutputTokens: 4_096,
        maxInputMessages: 64,
        maxRequestBytes: 64_000,
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(profile)));
    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ...profile, verification: "probably-fine" })),
    );
    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("rejects an unknown unavailable reason so a stale enum stays observable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "unavailable", reason: "wat-is-this" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
    });
  });

  it("accepts an allow-listed unavailable reason without demanding availability fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "unavailable", reason: "missing-config" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject({
      status: "unavailable",
      reason: "missing-config",
    });
  });

  // #3390 closeout: the readiness dimension appended for a profile whose derived
  // `maxPromptTokens` cannot survive one real gateway call (epic #3384).
  it("accepts the appended model-context-window-insufficient reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "unavailable",
        reason: "model-context-window-insufficient",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject({
      status: "unavailable",
      reason: "model-context-window-insufficient",
    });
  });

  // PR #3452 (F73): if no structurally eligible coding model exists to re-probe, the original
  // unavailable reason remains visible instead of being mislabelled "non-coding-capable".
  it("preserves tool-calling-unverified when automatic verification has no candidate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ status: "unavailable", reason: "tool-calling-unverified" }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject({
      status: "unavailable",
      reason: "tool-calling-unverified",
    });
  });

  it("rejects a non-object top-level response so the isObjectRecord guard fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("not an object")));

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("rejects an unknown top-level status so the enum guard fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "half-open" })));

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("collects every per-field reason when an available profile is wrong-typed everywhere", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: "available",
          profileId: 42,
          modelAlias: null,
          localEndpointPath: true,
          supportsStreaming: "yes",
          supportsToolCalling: 1,
          runMetadata: "not-an-object",
        }),
      ),
    );

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });
});

function codexSubscriptionProfileFixture(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status: "connected",
    authMethod: "chatgpt-device-code",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    runtimeBinarySources: ["managed-sidecar-runtime"],
    supportsBrowserLogin: true,
    supportsDeviceCode: true,
    supportsAccessToken: true,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function codexSetupPlanFixture(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    method: "chatgpt-browser-login",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    credentialStore: "keyring",
    stateScope: "os-credential-store",
    stateRoot: "os-credential-store",
    usesGlobalCodexHome: false,
    commandLabel: "codex-login",
    requiresSecretInput: false,
  };
}

describe("fetchCodingWorkbenchCodexSubscriptionProfile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the profile envelope on a valid response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(codexSubscriptionProfileFixture()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchCodexSubscriptionProfile()).resolves.toMatchObject({
      status: "connected",
      modelSource: "chatgpt-codex-subscription-profile",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/codex-subscription/profile",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("rejects malformed codex subscription responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: "1" })));

    await expect(fetchCodingWorkbenchCodexSubscriptionProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("rejects a null top-level response so the contract guard fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(null)));

    await expect(fetchCodingWorkbenchCodexSubscriptionProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });
});

describe("prepareCodingWorkbenchCodexSubscriptionSetup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the auth method and validates the setup plan response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(codexSetupPlanFixture()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareCodingWorkbenchCodexSubscriptionSetup("chatgpt-browser-login"),
    ).resolves.toMatchObject({ method: "chatgpt-browser-login" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/coding-workbench/codex-subscription/setup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ method: "chatgpt-browser-login" }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("fails closed when the setup plan envelope is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: "1" })));

    await expect(
      prepareCodingWorkbenchCodexSubscriptionSetup("chatgpt-browser-login"),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });

  it("rejects a non-object setup plan response so the contract guard fails closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

    await expect(
      prepareCodingWorkbenchCodexSubscriptionSetup("chatgpt-browser-login"),
    ).rejects.toMatchObject({ code: "CONTRACT_VALIDATION_FAILED", status: 502 });
  });
});
