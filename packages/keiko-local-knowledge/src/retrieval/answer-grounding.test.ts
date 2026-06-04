// Tests for the pure `validateAnswerGrounding` decision (Epic #189, Issue #199). One
// test per (policy × refs-present/empty) cell to exhaustively pin the truth table — a
// future schema change to `CapsuleAnswerGroundingPolicy` will surface as an unhandled
// branch (TS exhaustiveness) and an obviously-missing test case here.

import { describe, expect, it } from "vitest";

import type { RetrievalReference } from "@oscharko-dev/keiko-contracts";

import { validateAnswerGrounding } from "./answer-grounding.js";

const oneRef: RetrievalReference = {
  chunkId: "doc-1#unit-1#c0" as RetrievalReference["chunkId"],
  capsuleId: "cap-1" as RetrievalReference["capsuleId"],
  score: 0.42,
  citation: {
    chunkId: "doc-1#unit-1#c0" as RetrievalReference["citation"]["chunkId"],
    capsuleId: "cap-1" as RetrievalReference["citation"]["capsuleId"],
    sourceId: "src-1" as RetrievalReference["citation"]["sourceId"],
    documentId: "doc-1" as RetrievalReference["citation"]["documentId"],
    safeDisplayName: "sample.txt",
  },
};

describe("validateAnswerGrounding — require-citations", () => {
  it("rejects when references are empty", () => {
    const decision = validateAnswerGrounding([], "require-citations");
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("require-citations-rejected");
    expect(decision.noEvidence).toBe(true);
  });

  it("allows when references are present", () => {
    const decision = validateAnswerGrounding([oneRef], "require-citations");
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.noEvidence).toBe(false);
  });
});

describe("validateAnswerGrounding — require-citations-or-state-no-evidence", () => {
  it("allows but marks noEvidence when references are empty", () => {
    const decision = validateAnswerGrounding([], "require-citations-or-state-no-evidence");
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("no-evidence-stated");
    expect(decision.noEvidence).toBe(true);
  });

  it("allows and clears noEvidence when references are present", () => {
    const decision = validateAnswerGrounding([oneRef], "require-citations-or-state-no-evidence");
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.noEvidence).toBe(false);
  });
});

describe("validateAnswerGrounding — best-effort", () => {
  it("allows when references are empty but flags noEvidence so callers can adapt", () => {
    const decision = validateAnswerGrounding([], "best-effort");
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.noEvidence).toBe(true);
  });

  it("allows when references are present", () => {
    const decision = validateAnswerGrounding([oneRef], "best-effort");
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.noEvidence).toBe(false);
  });
});
