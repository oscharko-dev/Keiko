import { describe, expect, it } from "vitest";

import {
  UNVERIFIED_GATEWAY,
  gatewayVerificationContradictsReadiness,
  gatewayVerificationFromProbeOutcome,
  isGatewayVerificationState,
} from "./gateway-verification.js";

describe("gateway verification vocabulary", () => {
  it("never projects a healthy state without a probe outcome", () => {
    expect(UNVERIFIED_GATEWAY).toBe("unverified");
    expect(isGatewayVerificationState(UNVERIFIED_GATEWAY)).toBe(true);
  });

  it("projects each probe outcome onto its verification state", () => {
    expect(gatewayVerificationFromProbeOutcome("ready")).toBe("verified");
    expect(gatewayVerificationFromProbeOutcome("partial")).toBe("partial");
    expect(gatewayVerificationFromProbeOutcome("failed")).toBe("failed");
  });

  it("rejects every value that is not a verification state", () => {
    for (const value of [
      "ready",
      "healthy",
      "",
      "VERIFIED",
      undefined,
      null,
      0,
      1,
      true,
      {},
      [],
      { state: "verified" },
    ]) {
      expect(isGatewayVerificationState(value)).toBe(false);
    }
    for (const value of ["verified", "partial", "failed", "unverified"]) {
      expect(isGatewayVerificationState(value)).toBe(true);
    }
  });

  it("treats only a failed probe as a contradiction of the configuration", () => {
    expect(gatewayVerificationContradictsReadiness("failed")).toBe(true);
    expect(gatewayVerificationContradictsReadiness("verified")).toBe(false);
    expect(gatewayVerificationContradictsReadiness("partial")).toBe(false);
    // Absence of evidence is labelled, not treated as a failure — surfaces must be able to tell
    // "the operator has not checked yet" apart from "the check said no".
    expect(gatewayVerificationContradictsReadiness("unverified")).toBe(false);
  });
});
