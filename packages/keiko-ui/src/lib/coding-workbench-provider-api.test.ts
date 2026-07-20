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
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).resolves.toMatchObject({
      status: "available",
      modelAlias: "azure-coding-model",
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

  it("rejects an unknown unavailable reason so a stale enum stays observable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "unavailable", reason: "wat-is-this" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCodingWorkbenchSidecarGatewayProfile()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
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
});
