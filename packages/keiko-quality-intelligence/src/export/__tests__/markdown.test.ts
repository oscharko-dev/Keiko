// Markdown export adapter tests (Epic #711, Issue #720).
//
// Determinism is the load-bearing property: identical input must yield byte-identical output so the
// export bundle integrity hash is stable across runs. No timestamps, no random content.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToMarkdown } from "../adapters/markdown.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-md");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-md"),
    runId: RUN,
    targetAdapter: "markdown",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToMarkdown", () => {
  it("renders the candidate fields as a Markdown section", () => {
    const c = candidate("tc-1", "Login succeeds with valid credentials");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("# Quality Intelligence Export");
    expect(out).toContain("## Login succeeds with valid credentials");
    expect(out).toContain("**Priority:** P1");
    expect(out).toContain("User is logged in");
    expect(out).toContain("The record is saved");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToMarkdown(b, [c])).toBe(adaptToMarkdown(b, [c]));
  });

  it("sorts sections by candidate id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToMarkdown(bundle([z, a]), [z, a]);
    expect(out.indexOf("## Alpha")).toBeLessThan(out.indexOf("## Zulu"));
  });

  it("emits no ISO timestamp in the rendered body (fully deterministic)", () => {
    const c = candidate("tc-1", "A");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });
});
