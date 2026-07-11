import { describe, expect, it } from "vitest";

import {
  MANAGED_LSP_ACTIVATION_REASON_CODES,
  MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
  MANAGED_LSP_EFFECTIVE_STATES,
  MANAGED_LSP_LANGUAGES,
  type ManagedLspActivationInput,
  parseManagedLspActivationStatus,
  resolveManagedLspActivation,
} from "./managed-lsp-activation.js";

function activeInput(): ManagedLspActivationInput {
  return {
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language: "python",
    configurationRevision: 7,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: "enabled",
    legacyEnvironment: "unset",
    negotiation: "negotiated",
    runtimeHealth: "healthy",
    restartRequired: false,
  };
}

function resolvedState(input: unknown): string {
  return resolveManagedLspActivation(input).state;
}

describe("managed LSP activation vocabulary", () => {
  it("pins frozen, closed language, state, and reason tables", () => {
    expect(MANAGED_LSP_ACTIVATION_SCHEMA_VERSION).toBe("1");
    expect(MANAGED_LSP_LANGUAGES).toStrictEqual(["python", "go", "shell", "java", "rust"]);
    expect(MANAGED_LSP_EFFECTIVE_STATES).toStrictEqual([
      "disabled",
      "disabledByPolicy",
      "notProvisioned",
      "available",
      "starting",
      "active",
      "degraded",
      "unhealthy",
      "restartRequired",
    ]);
    expect(MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("INVALID_INPUT");
    expect(MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("STATE_UNAVAILABLE");
    expect(Object.isFrozen(MANAGED_LSP_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(MANAGED_LSP_EFFECTIVE_STATES)).toBe(true);
    expect(Object.isFrozen(MANAGED_LSP_ACTIVATION_REASON_CODES)).toBe(true);
  });
});

describe("resolveManagedLspActivation", () => {
  it("resolves the healthy negotiated baseline to active", () => {
    expect(resolveManagedLspActivation(activeInput())).toStrictEqual({
      ok: true,
      schemaVersion: "1",
      language: "python",
      configurationRevision: 7,
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    });
  });

  it.each([
    ["product support", { productSupport: "unsupported" }, "disabled"],
    ["deployment policy", { deploymentPolicy: "denied" }, "disabledByPolicy"],
    ["legacy deployment ceiling", { legacyEnvironment: "disabled" }, "disabledByPolicy"],
    ["provisioning", { provisioning: "notProvisioned" }, "notProvisioned"],
    ["workspace setting", { workspaceActivation: "disabled" }, "disabled"],
    ["unset workspace setting", { workspaceActivation: "unset" }, "disabled"],
    ["not started", { negotiation: "notStarted" }, "available"],
    ["startup", { negotiation: "starting" }, "starting"],
    ["missing negotiated capability", { negotiation: "requiredCapabilityMissing" }, "degraded"],
    ["unknown health", { runtimeHealth: "unknown" }, "degraded"],
    ["degraded health", { runtimeHealth: "degraded" }, "degraded"],
    ["unhealthy runtime", { runtimeHealth: "unhealthy" }, "unhealthy"],
    ["pending restart", { restartRequired: true }, "restartRequired"],
  ] as const)("downgrades active for %s", (_label, change, expected) => {
    expect(resolvedState({ ...activeInput(), ...change })).toBe(expected);
  });

  it.each(["allowed", "denied"] as const)(
    "does not let legacy enablement or workspace settings widen %s policy",
    (deploymentPolicy) => {
      for (const workspaceActivation of ["unset", "disabled", "enabled"] as const) {
        for (const legacyEnvironment of ["unset", "disabled", "enabled"] as const) {
          const state = resolvedState({
            ...activeInput(),
            deploymentPolicy,
            workspaceActivation,
            legacyEnvironment,
          });
          const expected =
            deploymentPolicy === "denied" || legacyEnvironment === "disabled"
              ? "disabledByPolicy"
              : workspaceActivation === "enabled"
                ? "active"
                : "disabled";
          expect(state).toBe(expected);
        }
      }
    },
  );

  it("applies precedence deterministically from product support through health", () => {
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        productSupport: "unsupported",
        deploymentPolicy: "denied",
        provisioning: "notProvisioned",
        workspaceActivation: "disabled",
        runtimeHealth: "unhealthy",
      }),
    ).toMatchObject({ state: "disabled", reasonCode: "PRODUCT_UNSUPPORTED" });
    expect(
      resolveManagedLspActivation({
        ...activeInput(),
        deploymentPolicy: "denied",
        provisioning: "notProvisioned",
        workspaceActivation: "disabled",
      }),
    ).toMatchObject({ state: "disabledByPolicy", reasonCode: "POLICY_DENIED" });
  });

  it.each([
    null,
    {},
    { ...activeInput(), schemaVersion: "2" },
    { ...activeInput(), deploymentPolicy: "admin-override" },
    { ...activeInput(), workspaceActivation: "enabled", extra: true },
  ])("fails closed for malformed, unknown, or schema-skewed input", (input) => {
    expect(resolveManagedLspActivation(input)).toStrictEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });

  it("never throws when hostile property access fails", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("hostile ownKeys");
        },
      },
    );
    expect(() => resolveManagedLspActivation(hostile)).not.toThrow();
    expect(resolvedState(hostile)).toBe("disabled");
  });
});

describe("parseManagedLspActivationStatus", () => {
  it("accepts the content-free effective status and rejects extra content fields", () => {
    const status = resolveManagedLspActivation(activeInput());
    expect(parseManagedLspActivationStatus(status).ok).toBe(true);
    for (const field of ["path", "env", "source", "stderr", "command", "credential"]) {
      expect(parseManagedLspActivationStatus({ ...status, [field]: "SENTINEL_SECRET" }).ok).toBe(
        false,
      );
    }
  });

  it.each([
    ["active with denied policy", { policyResult: "denied" }],
    ["ACTIVE reason on disabled", { state: "disabled", reasonCode: "ACTIVE" }],
    ["policy reason without policy state", { state: "active", reasonCode: "POLICY_DENIED" }],
    ["healthy reason on unhealthy", { state: "unhealthy", reasonCode: "ACTIVE" }],
  ])("rejects internally inconsistent status: %s", (_label, change) => {
    const status = resolveManagedLspActivation(activeInput());
    expect(parseManagedLspActivationStatus({ ...status, ...change }).ok).toBe(false);
  });

  it("keeps SQL outside the exact five-language managed scope", () => {
    expect(resolveManagedLspActivation({ ...activeInput(), language: "sql" })).toStrictEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });
});
