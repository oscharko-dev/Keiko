import { describe, expect, it } from "vitest";

import type {
  ManagedLspActivationInput,
  ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";
import { evaluateManagedLspActivation } from "./managedLspPolicy.js";

function input(overrides: Partial<ManagedLspActivationInput> = {}): ManagedLspActivationInput {
  return {
    schemaVersion: "1",
    language: "python",
    configurationRevision: 4,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: "enabled",
    legacyEnvironment: "enabled",
    negotiation: "negotiated",
    runtimeHealth: "healthy",
    restartRequired: false,
    ...overrides,
  };
}

describe("managed LSP activation policy", () => {
  it.each([
    [{ productSupport: "unsupported" }, "disabled", "PRODUCT_UNSUPPORTED"],
    [{ deploymentPolicy: "denied" }, "disabledByPolicy", "POLICY_DENIED"],
    [{ legacyEnvironment: "disabled" }, "disabledByPolicy", "LEGACY_ENV_DISABLED"],
    [{ provisioning: "notProvisioned" }, "notProvisioned", "NOT_PROVISIONED"],
    [{ workspaceActivation: "disabled" }, "disabled", "WORKSPACE_DISABLED"],
    [{ workspaceActivation: "unset" }, "disabled", "WORKSPACE_ACTIVATION_UNSET"],
    [{ negotiation: "notStarted" }, "available", "AVAILABLE"],
    [{ negotiation: "starting" }, "starting", "STARTING"],
    [{ negotiation: "requiredCapabilityMissing" }, "degraded", "NEGOTIATED_CAPABILITY_MISSING"],
    [{ runtimeHealth: "unknown" }, "degraded", "RUNTIME_HEALTH_UNKNOWN"],
    [{ runtimeHealth: "degraded" }, "degraded", "RUNTIME_DEGRADED"],
    [{ runtimeHealth: "unhealthy" }, "unhealthy", "RUNTIME_UNHEALTHY"],
    [{ restartRequired: true }, "restartRequired", "RESTART_REQUIRED"],
    [{}, "active", "ACTIVE"],
  ] as const)("applies %j before lower-precedence inputs", (override, state, reasonCode) => {
    expect(evaluateManagedLspActivation(input(override))).toMatchObject({ state, reasonCode });
  });

  it("proves policy denial wins over every legacy, workspace, provisioning, and runtime combination", () => {
    for (const legacyEnvironment of ["enabled", "disabled", "unset"] as const) {
      for (const workspaceActivation of ["enabled", "disabled", "unset"] as const) {
        for (const provisioning of ["provisioned", "notProvisioned"] as const) {
          for (const runtimeHealth of ["healthy", "degraded", "unhealthy", "unknown"] as const) {
            expect(
              evaluateManagedLspActivation(
                input({
                  deploymentPolicy: "denied",
                  legacyEnvironment,
                  workspaceActivation,
                  provisioning,
                  runtimeHealth,
                }),
              ),
            ).toMatchObject({ state: "disabledByPolicy", reasonCode: "POLICY_DENIED" });
          }
        }
      }
    }
  });

  it("fails closed for unreadable state without inspecting a configuration", () => {
    const sentinel = { runtimeId: "SENTINEL_SECRET" } as unknown as ManagedLspRuntimeConfiguration;
    expect(evaluateManagedLspActivation(sentinel)).toEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });
});
