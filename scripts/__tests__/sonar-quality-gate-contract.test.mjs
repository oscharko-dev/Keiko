import { describe, expect, it } from "vitest";

import {
  KEIKO_GATE_CONDITIONS,
  KEIKO_GATE_ID,
  KEIKO_GATE_NAME,
  KEIKO_REPOSITORY_GATE_CONTRACT,
  countAwareRateFailures,
  gateContractFailures,
} from "../sonar-quality-gate-contract.mjs";

describe("Sonar Free-plan gate contract", () => {
  it("pins every repository-enforced condition in one immutable contract", () => {
    expect(KEIKO_REPOSITORY_GATE_CONTRACT).toEqual({
      nativeGateStatus: "OK",
      newCodeCoverageMinimum: 85,
      newCodeDuplicationMaximum: 3,
      newCodeHotspotReviewMinimum: 100,
      newViolationsMaximum: 0,
      overallHotspotReviewMinimum: 100,
      unresolvedPullRequestIssuesMaximum: 0,
    });
  });
  it("accepts the exact dormant Keiko gate independent of condition order", () => {
    expect(
      gateContractFailures({
        conditions: [...KEIKO_GATE_CONDITIONS].reverse(),
        id: Number(KEIKO_GATE_ID),
        name: KEIKO_GATE_NAME,
      }),
    ).toEqual([]);
  });

  it("rejects missing, renamed, and condition-drifted gates", () => {
    expect(gateContractFailures(undefined)).toEqual(["Keiko Banking Grade definition is missing."]);
    expect(gateContractFailures({ conditions: [], id: "other", name: "Other" })).toEqual([
      "Keiko Banking Grade identity does not match the governed contract.",
      "Keiko Banking Grade conditions drifted from the repository contract.",
    ]);
  });

  it("uses explicit applicability counts for missing-rate semantics", () => {
    const base = { label: "Coverage", violates: (value) => value < 85 };
    expect(countAwareRateFailures({ ...base, count: undefined, rate: undefined })).toEqual([
      "Coverage applicability count is missing.",
    ]);
    expect(countAwareRateFailures({ ...base, count: 0, rate: undefined })).toEqual([]);
    expect(countAwareRateFailures({ ...base, count: 2, rate: undefined })).toEqual([
      "Coverage rate is missing despite a positive applicability count.",
    ]);
    expect(countAwareRateFailures({ ...base, count: 2, rate: 85 })).toEqual([]);
    expect(countAwareRateFailures({ ...base, count: 2, rate: 84.9 })).toEqual([
      "Coverage condition failed at 84.9%.",
    ]);
    expect(countAwareRateFailures({ ...base, count: -1, rate: 85 })).toEqual([
      "Coverage applicability count is invalid.",
    ]);
    expect(countAwareRateFailures({ ...base, count: 2, rate: 101 })).toEqual([
      "Coverage rate is invalid.",
    ]);
  });
});
