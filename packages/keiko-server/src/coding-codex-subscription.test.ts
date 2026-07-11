import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleCodingCodexSubscriptionProfile,
  handleCodingCodexSubscriptionSetup,
} from "./coding-codex-subscription.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: "/private/user/.keiko/keiko-ui.db",
    ...overrides,
  };
}

function approvedRuntime(): Pick<UiHandlerDeps, "codexRuntimeAvailability"> {
  return { codexRuntimeAvailability: { isApprovedVerified: () => true } };
}

function req(body: unknown): RouteContext["req"] {
  const emitter = new EventEmitter() as RouteContext["req"];
  queueMicrotask(() => {
    emitter.emit("data", Buffer.from(JSON.stringify(body)));
    emitter.emit("end");
  });
  return emitter;
}

function ctx(body: unknown = {}): RouteContext {
  return {
    req: req(body),
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/codex-subscription/setup"),
  };
}

describe("coding Codex subscription profile routes", () => {
  it("reports a missing subscription profile without leaking CODEX_HOME or auth paths", () => {
    const result = handleCodingCodexSubscriptionProfile(ctx(), deps());

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "missing",
        modelSource: "chatgpt-codex-subscription-profile",
        runtimeSource: "codex-cli-adapter",
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
        runtimeBinarySources: ["managed-sidecar-runtime"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain("CODEX_HOME");
    expect(JSON.stringify(result)).not.toContain(".codex");
    expect(JSON.stringify(result)).not.toContain("/private/user");
  });

  it.each([
    ["connected", { CODEX_ACCESS_TOKEN: "secret-token" }],
    ["expired", { KEIKO_CODEX_AUTH_STATUS: "expired" }],
    ["revoked", { KEIKO_CODEX_AUTH_STATUS: "revoked" }],
    ["unsupported-headless", { KEIKO_CODEX_AUTH_STATUS: "unsupported-headless" }],
    ["failed-login", { KEIKO_CODEX_AUTH_STATUS: "failed-login" }],
  ] as const)("projects %s status without leaking credential material", (status, env) => {
    const result = handleCodingCodexSubscriptionProfile(ctx(), deps({ env, ...approvedRuntime() }));

    expect(result).toMatchObject({ status: 200, body: { status } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("refresh");
    expect(JSON.stringify(result)).not.toContain("auth.json");
  });

  it("fails closed when deployment policy disables subscription login", () => {
    const result = handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ env: { KEIKO_CODEX_SUBSCRIPTION_DISABLED: "1" }, ...approvedRuntime() }),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "disabled-by-deployment",
        deploymentPolicyDisabled: true,
      },
    });
  });

  it("returns a device-code setup plan without executing Codex or exposing paths", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "chatgpt-device-code" }),
      deps(approvedRuntime()),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        method: "chatgpt-device-code",
        commandLabel: "codex-login-device-auth",
        requiresSecretInput: false,
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain(".codex");
    expect(JSON.stringify(result)).not.toContain("/private/user");
    expect(JSON.stringify(result)).not.toContain("accessToken");
  });

  it("rejects access-token setup bodies that try to send the token to Keiko", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "codex-access-token", accessToken: "Bearer secret-token" }),
      deps(),
    );

    expect(result).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Codex subscription setup request is invalid.",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("blocks browser-login setup in unsupported headless environments", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "chatgpt-browser-login" }),
      deps({ env: { KEIKO_CODEX_HEADLESS: "1" }, ...approvedRuntime() }),
    );

    expect(result).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "CODEX_SUBSCRIPTION_UNAVAILABLE",
          message: "Codex subscription browser login is unavailable in this environment.",
        },
      },
    });
  });

  it("does not report connected from an access token without approved runtime provenance", () => {
    const result = handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ env: { CODEX_ACCESS_TOKEN: "secret-token" } }),
    );

    expect(result).toMatchObject({ status: 200, body: { status: "missing" } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each(["chatgpt-browser-login", "chatgpt-device-code", "codex-access-token"] as const)(
    "blocks %s setup until Codex redistribution is approved",
    async (method) => {
      const result = await handleCodingCodexSubscriptionSetup(ctx({ method }), deps());

      expect(result).toMatchObject({
        status: 409,
        body: { reasonCode: "redistribution-unapproved" },
      });
    },
  );
});
