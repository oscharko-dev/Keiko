// Quality Center export adapter tests (Epic #711, Issue #722).
//
// The adapter is preview-only: it renders a deterministic dry-run mapping of approved candidates to
// a Quality Center work-item shape and states that a live write requires a configured connector. The
// 403 write-disabled guard lives in the route; this leaf only proves the preview is deterministic,
// structurally sound, and redaction-clean.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToQualityCenter } from "../adapters/qualityCenter.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-qc");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["Logged in"],
    steps: ["Open", "Submit"],
    expectedResults: ["Saved"],
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
    id: Q.asQualityIntelligenceExportBundleId("qi-export-qc"),
    runId: RUN,
    targetAdapter: "quality-center",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToQualityCenter", () => {
  it("renders a dry-run preview that names the connector requirement for a live write", () => {
    const c = candidate("tc-1", "Login succeeds");
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("Quality Center Export Preview");
    expect(out).toMatch(/dry-run preview\. Live export requires a configured connector/iu);
    expect(out).toContain("QC-0001 Login succeeds");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToQualityCenter(b, [c])).toBe(adaptToQualityCenter(b, [c]));
  });

  it("orders entries by candidate id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToQualityCenter(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("folds embedded newlines so each field stays on its own row", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "Title\nbreak"),
      steps: ["Open\nthe page", "Submit"],
    };
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("QC-0001 Title break");
    expect(out).toContain("Steps:        Open the page | Submit");
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
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).toContain("Tags:         (none)");
    expect(out).toContain("Steps:        (none)");
  });

  it("emits no ISO timestamp and no provider URL / token / prompt scaffolding", () => {
    const c = candidate("tc-1", "Plain redacted title");
    const out = adaptToQualityCenter(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/bearer\s|api[_-]?key|sk-[a-z0-9]/iu);
    expect(out).not.toMatch(/system prompt|you are an? /iu);
  });
});
