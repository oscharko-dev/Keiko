// Plain-text export adapter tests (Epic #711, Issue #720).
//
// Determinism is load-bearing: identical input -> byte-identical output (stable integrity hash).

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToPlainText } from "../adapters/plaintext.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-txt");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P2",
    riskClass: "regression",
    tags: ["smoke"],
    status: "proposed",
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-txt"),
    runId: RUN,
    targetAdapter: "plain-text",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToPlainText", () => {
  it("renders the candidate fields as a plain-text block", () => {
    const c = candidate("tc-1", "Login succeeds");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("Login succeeds");
    expect(out).toContain("P2");
    expect(out).toContain("User is logged in");
    expect(out).toContain("The record is saved");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToPlainText(b, [c])).toBe(adaptToPlainText(b, [c]));
  });

  it("orders candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToPlainText(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("emits no ISO timestamp in the rendered body", () => {
    const c = candidate("tc-1", "A");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });

  it("folds an embedded newline in a step so each step stays on one row", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["Open\nthe page", "Submit"],
    };
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("1. Open the page");
    expect(out).toContain("2. Submit");
    expect(out).not.toContain("\nthe page");
  });

  it("renders empty field lists as (none)", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      preconditions: [],
      steps: [],
      expectedResults: [],
      tags: [],
    };
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("Tags:       (none)");
    expect(out.match(/\(none\)/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it("introduces no provider URL, bearer token, or prompt scaffolding of its own", () => {
    const c = candidate("tc-1", "Plain redacted title");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/bearer\s|api[_-]?key|sk-[a-z0-9]/iu);
    expect(out).not.toMatch(/system prompt|you are an? /iu);
  });
});
