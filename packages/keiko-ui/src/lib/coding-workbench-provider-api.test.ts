import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCodingWorkbenchSidecarGatewayProfile,
  fetchCodingWorkbenchCodexSubscriptionProfile,
  prepareCodingWorkbenchCodexSubscriptionSetup,
} from "./coding-workbench-provider-api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchCodingWorkbenchSidecarGatewayProfile", () => {
  afterEach(() => {
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
