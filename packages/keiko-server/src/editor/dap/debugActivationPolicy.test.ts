import { describe, expect, it } from "vitest";

import { createDebugCapabilityGate, evaluateDebugActivation } from "./debugActivationPolicy.js";

const available = {
  schemaVersion: "1" as const,
  adapterId: "node-typescript" as const,
  revision: 3,
  productSupport: "supported" as const,
  deploymentPolicy: "allowed" as const,
  provisioning: "provisioned" as const,
  workspaceActivation: "enabled" as const,
};

describe("debug activation policy", () => {
  it("uses the closed contracts resolver and fails closed for hostile input", () => {
    expect(evaluateDebugActivation(available)).toMatchObject({
      state: "available",
      policyResult: "allowed",
    });
    expect(evaluateDebugActivation({ ...available, unexpected: true })).toEqual({
      ok: false,
      state: "disabled",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });

  it("publishes a derived resolution without retaining an activation flag", () => {
    const gate = createDebugCapabilityGate();
    const observed: string[] = [];
    const unsubscribe = gate.subscribe((value) =>
      observed.push(value.ok ? value.state : value.reasonCode),
    );

    const result = gate.publish(available);
    unsubscribe();

    expect(result).toMatchObject({ state: "available" });
    expect(observed).toEqual(["available"]);
  });
});
