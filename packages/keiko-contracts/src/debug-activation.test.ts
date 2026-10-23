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

import { parseDebugActivationInput } from "./debug-activation.js";
import * as debugActivationPublic from "@oscharko-dev/keiko-contracts/runtime/debug-activation";

describe.each([
  ["source", parseDebugActivationInput],
  ["public", debugActivationPublic.parseDebugActivationInput],
] as const)(
  "3918 debug activation admitted constructor observations %s",
  (_surface, parseInput) => {
    it.each([
      ["adapterId", "node-typescript", "unsupported"],
      ["revision", 3, Number.NaN],
      ["productSupport", "supported", "unsupported-value"],
      ["deploymentPolicy", "allowed", "unsupported-value"],
      ["provisioning", "provisioned", "unsupported-value"],
      ["workspaceActivation", "enabled", "unsupported-value"],
    ] as const)("refuses an invalid constructor observation for %s", (field, initial, later) => {
      const value = input();
      let reads = 0;
      Object.defineProperty(value, field, {
        enumerable: true,
        get: (): unknown => (++reads === 1 ? initial : later),
      });
      expect(parseInput(value)).toEqual({
        ok: false,
        errors: ["activation input is invalid or contains unknown fields"],
      });
      expect(reads).toBe(2);
    });

    it("keeps the observed valid constructor value without freezing the input", () => {
      const value = input();
      let reads = 0;
      Object.defineProperty(value, "revision", {
        enumerable: true,
        get: (): number => (++reads === 1 ? 3 : 4),
      });
      const parsed = parseInput(value);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("healthy constructor observation was refused");
      expect(parsed.value.revision).toBe(4);
      expect(reads).toBe(2);
      expect(Object.isFrozen(value)).toBe(false);
    });
  },
);
