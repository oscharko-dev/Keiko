import { describe, expect, it } from "vitest";

import { resolveDebugActivation } from "./debug-activation.js";

function input(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    adapterId: "node-typescript",
    revision: 3,
    productSupport: "supported",
    deploymentPolicy: "allowed",
    provisioning: "provisioned",
    workspaceActivation: "enabled",
    ...overrides,
  };
}

describe("resolveDebugActivation", () => {
  it.each([
    ["product unsupported", { productSupport: "unsupported" }, "disabled", "PRODUCT_UNSUPPORTED"],
    ["policy denied", { deploymentPolicy: "denied" }, "disabledByPolicy", "POLICY_DENIED"],
    [
      "policy unavailable",
      { deploymentPolicy: "unavailable" },
      "disabledByPolicy",
      "POLICY_UNAVAILABLE",
    ],
    ["workspace disabled", { workspaceActivation: "disabled" }, "disabled", "WORKSPACE_DISABLED"],
    ["workspace unset", { workspaceActivation: "unset" }, "disabled", "WORKSPACE_ACTIVATION_UNSET"],
    ["not provisioned", { provisioning: "notProvisioned" }, "notProvisioned", "NOT_PROVISIONED"],
    ["available", {}, "available", "AVAILABLE"],
  ] as const)(
    "resolves %s by the ordered static rule chain",
    (_name, overrides, state, reasonCode) => {
      expect(resolveDebugActivation(input(overrides))).toMatchObject({
        ok: true,
        state,
        reasonCode,
      });
    },
  );

  it("is off by default when the workspace opt-in is unset", () => {
    expect(resolveDebugActivation(input({ workspaceActivation: "unset" }))).toMatchObject({
      state: "disabled",
      reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    });
  });

  it("never throws or accepts malformed and unknown input", () => {
    expect(resolveDebugActivation(null)).toEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
    expect(resolveDebugActivation(input({ unknown: true }))).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });
});
