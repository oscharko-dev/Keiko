import { describe, expect, it } from "vitest";

import {
  declaredPortableRuntimeLane,
  evaluationAttestationDeclaredNegative,
  platformCheckKeys,
} from "./portableRuntimeLane.js";

const MACOS_CHECKS = {
  developerIdVerified: false,
  notarizationVerified: false,
  stapleVerified: false,
  assessmentVerified: false,
};

function evaluationSigning(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verificationPolicy: "evaluation",
    verificationStatus: "evaluation-unqualified",
    verificationReasonCodes: ["evaluation-artifact", "evaluation-unsigned-allowed"],
    signatureVerified: false,
    notarizationVerified: false,
    verificationChecks: { ...MACOS_CHECKS },
    ...overrides,
  };
}

describe("portable runtime lane vocabulary", () => {
  it("resolves only the two exact declared pairs and fails closed on everything else", () => {
    expect(
      declaredPortableRuntimeLane({
        verificationPolicy: "production",
        verificationStatus: "verified-production",
      }),
    ).toBe("release-qualified");
    expect(
      declaredPortableRuntimeLane({
        verificationPolicy: "evaluation",
        verificationStatus: "evaluation-unqualified",
      }),
    ).toBe("evaluation-unqualified");
  });

  it.each([
    // The default output of a plain staging run; nothing may promote it by accident.
    ["staging", { verificationPolicy: "staging", verificationStatus: "unverified-staging" }],
    // Every routine CI pull-request artifact carries this lane.
    [
      "pull-request",
      { verificationPolicy: "development", verificationStatus: "unsigned-non-production" },
    ],
    [
      "pull-request-policy",
      { verificationPolicy: "pull-request", verificationStatus: "unsigned-non-production" },
    ],
    // A valid policy paired with a foreign status is a mismatch, not a lane.
    [
      "evaluation-policy-production-status",
      { verificationPolicy: "evaluation", verificationStatus: "verified-production" },
    ],
    [
      "production-policy-evaluation-status",
      { verificationPolicy: "production", verificationStatus: "evaluation-unqualified" },
    ],
    ["policy-only", { verificationPolicy: "evaluation" }],
    ["status-only", { verificationStatus: "evaluation-unqualified" }],
    ["empty", {}],
  ])("refuses the %s declaration", (_name, security) => {
    expect(declaredPortableRuntimeLane(security)).toBeUndefined();
  });

  it("refuses an absent security block", () => {
    expect(declaredPortableRuntimeLane(undefined)).toBeUndefined();
  });

  it("keeps one per-target platform-check key list", () => {
    expect(platformCheckKeys("windows-x64")).toEqual([
      "publisherChainVerified",
      "timestampVerified",
    ]);
    for (const target of ["macos-arm64", "macos-x64"] as const) {
      expect(platformCheckKeys(target)).toEqual([
        "developerIdVerified",
        "notarizationVerified",
        "stapleVerified",
        "assessmentVerified",
      ]);
    }
  });
});

describe("evaluation attestation must be declared negative", () => {
  it("accepts a block whose platform proof is present and false", () => {
    expect(
      evaluationAttestationDeclaredNegative(evaluationSigning(), "macos-arm64", {
        requireReasonCodes: true,
        requirePolicy: true,
      }),
    ).toBe(true);
  });

  // A half-truthful mix is not a lane: any single asserted platform proof is a refusal.
  it.each([
    ["signatureVerified", { signatureVerified: true }],
    ["notarizationVerified", { notarizationVerified: true }],
    [
      "one platform check true",
      { verificationChecks: { ...MACOS_CHECKS, developerIdVerified: true } },
    ],
    ["a missing platform check", { verificationChecks: { developerIdVerified: false } }],
    ["absent verificationChecks", { verificationChecks: undefined }],
    ["verificationChecks as an array", { verificationChecks: [] }],
    ["a missing reason code", { verificationReasonCodes: ["evaluation-artifact"] }],
    ["no reason codes", { verificationReasonCodes: [] }],
    ["reason codes that are not an array", { verificationReasonCodes: "evaluation-artifact" }],
    ["a foreign policy", { verificationPolicy: "staging" }],
    ["a foreign status", { verificationStatus: "unverified-staging" }],
  ])("refuses %s", (_name, overrides) => {
    expect(
      evaluationAttestationDeclaredNegative(evaluationSigning(overrides), "macos-arm64", {
        requireReasonCodes: true,
        requirePolicy: true,
      }),
    ).toBe(false);
  });

  it("refuses an absent block", () => {
    expect(
      evaluationAttestationDeclaredNegative(undefined, "windows-x64", {
        requireReasonCodes: true,
        requirePolicy: true,
      }),
    ).toBe(false);
  });

  it("checks the target's own key list, not the other platform's", () => {
    const windowsShaped = evaluationSigning({
      verificationChecks: { publisherChainVerified: false, timestampVerified: false },
    });
    expect(
      evaluationAttestationDeclaredNegative(windowsShaped, "windows-x64", {
        requireReasonCodes: true,
        requirePolicy: true,
      }),
    ).toBe(true);
    expect(
      evaluationAttestationDeclaredNegative(windowsShaped, "macos-arm64", {
        requireReasonCodes: true,
        requirePolicy: true,
      }),
    ).toBe(false);
  });

  // The 5-key native-helper signing shape carries a status but no policy, reason codes or checks.
  it("evaluates the helper signing shape on its status and its two booleans only", () => {
    const helperSigning = {
      signatureKind: "authenticode",
      verificationStatus: "evaluation-unqualified",
      signatureVerified: false,
      notarizationRequired: false,
      notarizationVerified: false,
    };
    const options = { requireReasonCodes: false, requirePolicy: false } as const;
    expect(evaluationAttestationDeclaredNegative(helperSigning, "windows-x64", options)).toBe(true);
    expect(
      evaluationAttestationDeclaredNegative(
        { ...helperSigning, signatureVerified: true },
        "windows-x64",
        options,
      ),
    ).toBe(false);
    expect(
      evaluationAttestationDeclaredNegative(
        { ...helperSigning, verificationStatus: "unverified-staging" },
        "windows-x64",
        options,
      ),
    ).toBe(false);
  });
});
